/**
 * Workflow definition discovery.
 *
 * A graph can be declared inline in the tool call or saved as a file so it can
 * be reviewed, versioned, and re-run. Files are read from three scopes with the
 * same override rule as agents — builtin < user < project, where the same name
 * wins at the higher scope:
 *
 *   builtin : <package>/workflows              (shipped templates)
 *   user    : <agentDir>/workflows             (~/.pi/agent/workflows)
 *   project : <cwd...>/.pi/workflows           (nearest, walking up)
 *
 * Two file shapes are accepted: a JSON document, and Markdown with a `json`
 * fenced block holding the plan (so a template can explain itself in prose and
 * keep the graph machine-readable).
 */

import { type Dirent, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_DIR_NAME, getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import type { WorkflowPlanInput } from "./plan.ts";

/** Which workflow directories discovery reads. Same precedence as the templates
 * they ship with: project > user > built-in for the same name. */
export type WorkflowScope = "user" | "project" | "both";

export type WorkflowSource = "builtin" | "user" | "project";

export interface WorkflowDefinition {
	name: string;
	description?: string;
	plan: WorkflowPlanInput;
	filePath: string;
	source: WorkflowSource;
}

const here = dirname(fileURLToPath(import.meta.url));
/** <package>/workflows — templates shipped with this extension. */
export const BUILTIN_WORKFLOWS_DIR = join(here, "..", "..", "workflows");

function isDirectory(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

function findNearestProjectWorkflowsDir(cwd: string): string | null {
	let current = cwd;
	while (true) {
		const candidate = join(current, CONFIG_DIR_NAME, "workflows");
		if (isDirectory(candidate)) return candidate;
		const parent = dirname(current);
		if (parent === current) return null;
		current = parent;
	}
}

/** Accept either the full plan object or a bare node array. */
function asPlan(value: unknown, fallbackName: string): WorkflowPlanInput | undefined {
	const raw = Array.isArray(value) ? { nodes: value } : value;
	if (!raw || typeof raw !== "object") return undefined;
	const record = raw as Record<string, unknown>;
	if (!Array.isArray(record.nodes)) return undefined;
	return {
		name: typeof record.name === "string" && record.name.trim() ? record.name.trim() : fallbackName,
		...(typeof record.description === "string" && record.description.trim()
			? { description: record.description.trim() }
			: {}),
		// The compiler validates every field; never sanitize away dependencies.
		nodes: record.nodes as WorkflowPlanInput["nodes"],
	};
}

function fencedJson(body: string): string | undefined {
	const match = /^[ \t]*```json[ \t]*\r?\n([\s\S]*?)^[ \t]*```/mu.exec(body);
	return match?.[1];
}

/** Read one definition file. Returns an error string instead of throwing so a
 * broken file in a shared directory cannot hide the rest of the catalog. */
export function readWorkflowFile(
	filePath: string,
	source: WorkflowSource,
): { definition?: WorkflowDefinition; error?: string } {
	const fallbackName = basename(filePath).replace(/\.(json|md)$/iu, "");
	let content: string;
	try {
		content = readFileSync(filePath, "utf8");
	} catch (error) {
		return { error: `${filePath}: ${error instanceof Error ? error.message : String(error)}` };
	}
	if (/\.json$/iu.test(filePath)) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(content);
		} catch (error) {
			return { error: `${filePath}: invalid JSON (${error instanceof Error ? error.message : String(error)})` };
		}
		const plan = asPlan(parsed, fallbackName);
		if (!plan) return { error: `${filePath}: expected { name?, description?, nodes: [{ id, agent, task, dependsOn? }] }.` };
		return { definition: { name: plan.name ?? fallbackName, ...(plan.description ? { description: plan.description } : {}), plan, filePath, source } };
	}
	const { frontmatter, body } = parseFrontmatter<Record<string, string>>(content);
	const json = fencedJson(body);
	if (json === undefined) return { error: `${filePath}: a Markdown workflow needs a \`\`\`json fenced block holding the plan.` };
	let parsed: unknown;
	try {
		parsed = JSON.parse(json);
	} catch (error) {
		return { error: `${filePath}: invalid JSON in the fenced block (${error instanceof Error ? error.message : String(error)})` };
	}
	const name = typeof frontmatter.name === "string" && frontmatter.name.trim() ? frontmatter.name.trim() : fallbackName;
	const plan = asPlan(parsed, name);
	if (!plan) return { error: `${filePath}: expected a plan object or a node array in the fenced block.` };
	const description = typeof frontmatter.description === "string" && frontmatter.description.trim()
		? frontmatter.description.trim()
		: plan.description;
	return {
		definition: { name: plan.name ?? name, ...(description ? { description } : {}), plan, filePath, source },
	};
}

function loadDefinitionsFromDir(dir: string, source: WorkflowSource): WorkflowDefinition[] {
	if (!existsSync(dir)) return [];
	let entries: Dirent[];
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return [];
	}
	const definitions: WorkflowDefinition[] = [];
	for (const entry of entries) {
		if (!/\.(?:json|md)$/iu.test(entry.name)) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;
		const { definition } = readWorkflowFile(join(dir, entry.name), source);
		if (definition) definitions.push(definition);
	}
	return definitions;
}

export interface DiscoverWorkflowsOptions {
	scope?: WorkflowScope;
	projectTrusted?: boolean;
	builtinDir?: string;
}

/**
 * Every workflow definition visible from `cwd`, merged with project > user >
 * builtin precedence for the same name and sorted by name.
 */
export function discoverWorkflows(cwd: string, options: DiscoverWorkflowsOptions = {}): WorkflowDefinition[] {
	const scope = options.scope ?? "both";
	const projectDir = findNearestProjectWorkflowsDir(cwd);
	const builtin = loadDefinitionsFromDir(options.builtinDir ?? BUILTIN_WORKFLOWS_DIR, "builtin");
	const user = scope === "project" ? [] : loadDefinitionsFromDir(join(getAgentDir(), "workflows"), "user");
	const project =
		scope === "user" || !projectDir || options.projectTrusted !== true
			? []
			: loadDefinitionsFromDir(projectDir, "project");

	const byName = new Map<string, WorkflowDefinition>();
	for (const definition of builtin) byName.set(definition.name, definition);
	for (const definition of user) byName.set(definition.name, definition);
	for (const definition of project) byName.set(definition.name, definition);
	return [...byName.values()].sort((left, right) => left.name.localeCompare(right.name));
}

/** Resolve a name or file path to a definition; error text names what is available. */
export function resolveWorkflowDefinition(
	cwd: string,
	request: { name?: string; path?: string },
	options: DiscoverWorkflowsOptions = {},
): { definition?: WorkflowDefinition; error?: string } {
	if (request.name?.trim() && request.path?.trim()) return { error: "provide a workflow name or file path, not both." };
	if (request.path) {
		if (options.projectTrusted !== true) return { error: "workflow files require a trusted project." };
		const filePath = resolve(cwd, request.path);
		if (!existsSync(filePath)) return { error: `workflow file not found: ${filePath}` };
		const read = readWorkflowFile(filePath, "project");
		if (read.error) return { error: read.error };
		return read;
	}
	const name = request.name?.trim();
	if (!name) return { error: "provide either inline nodes, a workflow name, or a workflow file path." };
	const available = discoverWorkflows(cwd, options);
	const match = available.find((definition) => definition.name.toLowerCase() === name.toLowerCase());
	if (!match) {
		const names = available.map((definition) => definition.name).join(", ");
		return { error: `no workflow named "${name}". Available: ${names || "none"}. Save one under .pi/workflows/ or ~/.pi/agent/workflows/.` };
	}
	return { definition: match };
}
