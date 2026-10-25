/**
 * Workflow graph contract: authoring input, compile-time validation, and the
 * dependency-ordered task template a node's brief is rendered from.
 *
 * A workflow is a DAG of ordinary sub-agent phases. Compilation is deliberately
 * strict and happens before anything starts: unique node ids, existing
 * dependencies, no cycles, resolvable result placeholders, and no declared
 * writer overlap between nodes that could run at the same time. An invalid
 * graph therefore costs zero child processes.
 */

import { resolve } from "node:path";
import {
	findPhaseScopeOverlap,
	normalizePhaseId,
	normalizePhaseScope,
	PHASE_ID_MAX_LENGTH,
	PHASE_ID_PATTERN_SOURCE,
	type PhaseScope,
	type PhaseScopeInput,
} from "../delegation/phase-scope.ts";
import type { IsolationMode } from "../isolation/worktree.ts";

/** Nodes per graph. A workflow pays for one model session per node, so this is
 * a guard against a graph nobody will read, not a concurrency limit. */
export const WORKFLOW_NODE_LIMIT = 24;

export const WORKFLOW_NODE_ID_MAX_LENGTH = 40;
const WORKFLOW_NODE_ID_PATTERN = /^[A-Za-z][A-Za-z0-9._-]*$/u;
const WORKFLOW_NAME_MAX_LENGTH = 60;

/** How much of an upstream node's answer is interpolated into a downstream
 * brief: enough to act on, bounded so a wide graph cannot push its whole
 * transcript through prompts. The rest stays in that node's result artifact. */
export const UPSTREAM_OUTPUT_MAX_CHARS = 6_000;

export interface WorkflowNodeInput {
	/** Stable node id, referenced by `dependsOn` and by result placeholders. */
	id: string;
	agent: string;
	/** Brief for this node. `{{id}}` interpolates an upstream node's answer;
	 * `{{id.status}}`, `{{id.runId}}`, and `{{id.error}}` interpolate facts. */
	task: string;
	dependsOn?: string[];
	phaseId?: string;
	scope?: PhaseScopeInput;
	cwd?: string;
	isolation?: IsolationMode;
}

export interface WorkflowPlanInput {
	name?: string;
	description?: string;
	nodes: WorkflowNodeInput[];
}

export interface CompiledWorkflowNode {
	id: string;
	index: number;
	agent: string;
	task: string;
	/** Direct prerequisites, in author order. */
	dependsOn: string[];
	/** Every transitive prerequisite; used for placeholder and scope checks. */
	ancestors: string[];
	/** Declared phase id, or the workflow-derived default assigned at dispatch. */
	phaseId?: string;
	scope?: PhaseScope;
	/** Absolute working directory resolved from the compile-time caller cwd. */
	cwd: string;
	isolation?: IsolationMode;
}

export interface CompiledWorkflow {
	/** Display name: the workflow definition's name or a derived label. */
	name: string;
	/** Identifier-safe form used for derived phase ids. */
	slug: string;
	description?: string;
	/** Caller-facing directory the graph was compiled against. */
	cwd: string;
	nodes: CompiledWorkflowNode[];
}

/** Placeholder syntax accepted in a node's task. */
const PLACEHOLDER = /\{\{\s*([^{}]+?)\s*\}\}/gu;
const FACT_SUFFIXES = [".status", ".runId", ".error"] as const;
type PlaceholderFact = "output" | "status" | "runId" | "error";

function singleLine(value: string): string {
	return value.replace(/\s+/gu, " ").trim();
}

/** Identifier-safe slug for derived phase ids. */
function slugify(name: string): string {
	const slug = singleLine(name)
		.toLowerCase()
		.replace(/[^a-z0-9]+/gu, "-")
		.replace(/^-+|-+$/gu, "")
		.slice(0, 32)
		.replace(/-+$/gu, "");
	return slug || "workflow";
}

function normalizeWorkflowName(raw: string | undefined, fallback: string): string {
	const name = raw === undefined ? "" : singleLine(raw);
	const chosen = name || singleLine(fallback);
	if (chosen.length === 0) throw new Error("workflow name must be non-blank.");
	if (chosen.length > WORKFLOW_NAME_MAX_LENGTH) {
		throw new Error(`workflow name must be at most ${WORKFLOW_NAME_MAX_LENGTH} characters.`);
	}
	return chosen;
}

function splitPlaceholder(token: string): { id: string; fact: PlaceholderFact } {
	for (const suffix of FACT_SUFFIXES) {
		if (token.endsWith(suffix) && token.length > suffix.length) {
			return { id: token.slice(0, -suffix.length), fact: suffix.slice(1) as PlaceholderFact };
		}
	}
	return { id: token, fact: "output" };
}

/** Resolve `dependsOn` transitively. Returns the ancestors of every node. */
function resolveAncestors(ids: readonly string[], direct: Map<string, string[]>): Map<string, string[]> {
	const memo = new Map<string, string[]>();
	const visiting = new Set<string>();
	const walk = (id: string): string[] => {
		const cached = memo.get(id);
		if (cached) return cached;
		if (visiting.has(id)) throw new Error(`dependency cycle through node "${id}".`);
		visiting.add(id);
		const collected = new Set<string>();
		for (const dependency of direct.get(id) ?? []) {
			collected.add(dependency);
			for (const ancestor of walk(dependency)) collected.add(ancestor);
		}
		visiting.delete(id);
		const list = [...collected];
		memo.set(id, list);
		return list;
	};
	for (const id of ids) walk(id);
	return memo;
}

function validatePhaseId(node: WorkflowNodeInput, label: string): string | undefined {
	try {
		return normalizePhaseId(node.phaseId);
	} catch (error) {
		throw new Error(`${label}.phaseId: ${error instanceof Error ? error.message : String(error)}`);
	}
}

/**
 * Compile an authored plan into a runnable graph. Every problem is reported at
 * once, so fixing a graph does not take one round-trip per mistake.
 */
export function compileWorkflow(
	input: WorkflowPlanInput,
	callerCwd: string,
	knownAgents: readonly string[],
	options: { fallbackName?: string } = {},
): CompiledWorkflow {
	const problems: string[] = [];
	const rawNodes = Array.isArray(input.nodes) ? input.nodes : [];
	if (rawNodes.length === 0) throw new Error("a workflow needs at least one node.");
	if (rawNodes.length > WORKFLOW_NODE_LIMIT) {
		throw new Error(`a workflow may declare at most ${WORKFLOW_NODE_LIMIT} nodes (got ${rawNodes.length}); split it into sequential workflows instead.`);
	}

	let name: string;
	try {
		name = normalizeWorkflowName(input.name, options.fallbackName ?? "workflow");
	} catch (error) {
		throw new Error(error instanceof Error ? error.message : String(error));
	}

	const ids: string[] = [];
	const seenIds = new Set<string>();
	for (const [index, node] of rawNodes.entries()) {
		const label = `nodes[${index}]`;
		const id = typeof node?.id === "string" ? node.id.trim() : "";
		if (!WORKFLOW_NODE_ID_PATTERN.test(id) || id.length > WORKFLOW_NODE_ID_MAX_LENGTH) {
			problems.push(
				`${label}.id must be 1-${WORKFLOW_NODE_ID_MAX_LENGTH} characters of ASCII letters, numbers, or ._- starting with a letter ("${id}").`,
			);
			continue;
		}
		if (seenIds.has(id)) {
			problems.push(`${label}.id "${id}" is declared twice; node ids identify results and dependencies.`);
			continue;
		}
		seenIds.add(id);
		ids.push(id);
	}

	const direct = new Map<string, string[]>();
	for (const [index, node] of rawNodes.entries()) {
		const label = `nodes[${index}]`;
		if (typeof node?.agent !== "string" || !knownAgents.includes(node.agent.trim())) {
			problems.push(`${label}.agent "${String(node?.agent)}" is not an enabled agent (available: ${knownAgents.join(", ") || "none"}).`);
		}
		if (typeof node?.task !== "string" || node.task.trim().length === 0) {
			problems.push(`${label}.task must be a non-blank brief.`);
		}
		const dependsOn = node?.dependsOn ?? [];
		if (!Array.isArray(dependsOn)) {
			problems.push(`${label}.dependsOn must be an array of node ids.`);
			continue;
		}
		const unique: string[] = [];
		for (const dependency of dependsOn) {
			const dep = typeof dependency === "string" ? dependency.trim() : "";
			if (!seenIds.has(dep)) {
				problems.push(`${label}.dependsOn references unknown node "${dep}".`);
				continue;
			}
			if (dep === node.id) {
				problems.push(`${label} depends on itself.`);
				continue;
			}
			if (!unique.includes(dep)) unique.push(dep);
		}
		direct.set(node.id, unique);
	}
	if (problems.length > 0) throw new Error(problems.join("\n"));

	let ancestors: Map<string, string[]>;
	try {
		ancestors = resolveAncestors(ids, direct);
	} catch (error) {
		throw new Error(error instanceof Error ? error.message : String(error));
	}

	const nodes: CompiledWorkflowNode[] = [];
	for (const [index, node] of rawNodes.entries()) {
		const label = `nodes[${index}] ("${node.id}")`;
		const nodeAncestors = ancestors.get(node.id) ?? [];
		const ancestorSet = new Set(nodeAncestors);
		for (const match of node.task.matchAll(PLACEHOLDER)) {
			const { id, fact } = splitPlaceholder(match[1]?.trim() ?? "");
			if (!ancestorSet.has(id)) {
				problems.push(
					`${label}.task references {{${match[1]?.trim()}}} but "${id}" is not a declared dependency (${fact === "output" ? "answer" : fact} placeholders may only read a node this one waits for).`,
				);
			}
		}
		const cwd = resolve(callerCwd, node.cwd ?? ".");
		let scope: PhaseScope | undefined;
		try {
			scope = normalizePhaseScope(node.scope, cwd);
		} catch (error) {
			problems.push(`${label}.scope: ${error instanceof Error ? error.message : String(error)}`);
		}
		const phaseId = validatePhaseId(node, label);
		nodes.push({
			id: node.id,
			index,
			agent: node.agent.trim(),
			task: node.task,
			dependsOn: [...(direct.get(node.id) ?? [])],
			ancestors: nodeAncestors,
			...(phaseId ? { phaseId } : {}),
			...(scope ? { scope } : {}),
			cwd,
			...(node.isolation ? { isolation: node.isolation } : {}),
		});
	}

	// Only order-independent nodes can contend for the same files. Two nodes
	// with a dependency edge are serialized by the graph itself, so their
	// shared scope is intentional (a fix then its own test file).
	for (let leftIndex = 0; leftIndex < nodes.length; leftIndex++) {
		const left = nodes[leftIndex]!;
		if (!left.scope) continue;
		for (let rightIndex = leftIndex + 1; rightIndex < nodes.length; rightIndex++) {
			const right = nodes[rightIndex]!;
			if (!right.scope) continue;
			if (left.ancestors.includes(right.id) || right.ancestors.includes(left.id)) continue;
			const overlap = findPhaseScopeOverlap(left.scope, right.scope);
			if (overlap) {
				problems.push(
					`nodes "${left.id}" and "${right.id}" declare overlapping writer scope (${overlap.left} vs ${overlap.right}) without a dependency ordering them; give one node the whole scope or add dependsOn.`,
				);
			}
		}
	}

	if (problems.length > 0) throw new Error(problems.join("\n"));

	return {
		name,
		slug: slugify(name),
		...(input.description && singleLine(input.description)
			? { description: singleLine(input.description) }
			: {}),
		cwd: resolve(callerCwd),
		nodes,
	};
}

/** What a settled node hands its dependents. */
export interface UpstreamOutput {
	status: "completed" | "failed" | "blocked" | "stopped";
	output: string;
	runId?: number;
	error?: string;
}

function boundOutput(output: string): string {
	if (output.length <= UPSTREAM_OUTPUT_MAX_CHARS) return output;
	return `${output.slice(0, UPSTREAM_OUTPUT_MAX_CHARS)}\n… (answer truncated at ${UPSTREAM_OUTPUT_MAX_CHARS} characters; read that node's full result from its own run)`;
}

/** Render a node's brief, substituting facts from the nodes it waited for. */
export function renderNodeTask(task: string, upstream: ReadonlyMap<string, UpstreamOutput>): string {
	return task.replace(PLACEHOLDER, (whole, rawToken: string) => {
		const { id, fact } = splitPlaceholder(rawToken.trim());
		const view = upstream.get(id);
		if (!view) return whole;
		switch (fact) {
			case "status":
				return view.status;
			case "runId":
				return view.runId === undefined ? "unknown" : `#${view.runId}`;
			case "error":
				return view.error?.trim() || "(no error reported)";
			default:
				return view.output.trim() || "(no output)";
		}
	});
}

/** Default phase id for a node, kept inside the phase-id contract. */
export function defaultPhaseId(workflow: CompiledWorkflow, node: CompiledWorkflowNode): string {
	const candidate = `${workflow.slug}.${node.id}`;
	if (candidate.length <= PHASE_ID_MAX_LENGTH && new RegExp(PHASE_ID_PATTERN_SOURCE, "u").test(candidate)) return candidate;
	return `${workflow.slug.slice(0, PHASE_ID_MAX_LENGTH - node.id.length - 1)}.${node.id}`.slice(0, PHASE_ID_MAX_LENGTH);
}
