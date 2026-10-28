/**
 * Workflow runner: a dependency-ordered graph of ordinary managed sub-agent runs.
 *
 * The rule this module exists for is "dispatch the next node the moment its
 * prerequisites settle, without waking the parent model". Each node is started
 * through the same dispatcher a `subagent` call uses — same lifecycle ownership, same
 * admission, same isolation, same durable checkpoint — and is `quiet`, meaning
 * it reports into this graph instead of sending its own completion message.
 * The parent is woken exactly once, with the graph's summary.
 *
 * Failure is contained by the graph, not the session: a failed node blocks only
 * its dependents, independent branches keep running, and the summary states
 * what completed, what failed, and what never ran. Nodes do not retry and do not
 * resume — main finishes incomplete work from their retained evidence, exactly
 * as for a failed one-shot run.
 */

import { randomUUID } from "node:crypto";
import { isFailedResult, getResultError, getResultOutput, truncateResultOutput, writeResultArtifact, type SingleResult } from "../execution/spawn.ts";
import { formatDuration, formatTaskSummary, monitor, runWaitLabel } from "../presentation/monitor.ts";
import { perModelTotals, type CompletionMessageItem } from "../lifecycle/completion.ts";
import { findPendingWorkflowPhase, type SubagentRuntime } from "../lifecycle/runtime.ts";
import type { StartBackgroundInternal } from "../lifecycle/thread-shared.ts";
import { stopThreads } from "../lifecycle/stop.ts";
import { findDuplicateDispatch } from "../delegation/prompt.ts";
import { defaultPhaseId, renderNodeTask, UPSTREAM_OUTPUT_MAX_CHARS, type CompiledWorkflow, type UpstreamOutput } from "./plan.ts";
import {
	readWorkflowRecords,
	removeWorkflowRecord,
	upsertWorkflowRecord,
	workflowRecordIdentity,
	type RecordedNodeState,
	type WorkflowRecord,
} from "./durable.ts";
import type { WorkflowNodeRun, WorkflowRun, WorkflowRunState } from "./state.ts";
import type { PhaseScope } from "../delegation/phase-scope.ts";
import { buildAcceptanceBrief, parseAcceptanceVerdict, WORKFLOW_ACCEPTANCE_AGENT, WORKFLOW_ACCEPTANCE_ID } from "./acceptance.ts";

/** Lines of one node's answer inlined into the graph summary. The complete text
 * of every node is always written to a single workflow artifact, so nothing is
 * lost and nothing is delivered twice. */
export const NODE_SUMMARY_LINES = 12;

export interface WorkflowRunDeps {
	runtime: SubagentRuntime;
	startBackground: StartBackgroundInternal;
	/** Isolation the graph wants for a node, resolved against the live catalog. */
	resolveIsolation: (agentName: string) => "shared" | "worktree";
	/** Project-scoped results directory for the full workflow report. */
	resultsRoot: string;
	notify: (message: string, kind: "info" | "warning" | "error") => void;
}

export interface WorkflowHandle {
	run: WorkflowRun;
	/** Resolves after the graph settles and its summary is delivered. */
	done: Promise<WorkflowRun>;
}

interface RunContext extends WorkflowRunDeps {
	run: WorkflowRun;
	wake: () => void;
	waitForWake: () => Promise<void>;
}

function nodeById(run: WorkflowRun, id: string): WorkflowNodeRun | undefined {
	return run.nodes.find((node) => node.id === id);
}

function terminalFailure(state: WorkflowNodeStateUnion): boolean {
	return state === "failed" || state === "blocked" || state === "stopped";
}

type WorkflowNodeStateUnion = WorkflowNodeRun["state"];

function describeError(result: SingleResult): string | undefined {
	return getResultError(result)?.trim() || undefined;
}

/** Upstream fact view passed to a dependent node's brief. */
function upstreamView(node: WorkflowNodeRun): UpstreamOutput {
	const result = node.result;
	const output = result ? getResultOutput(result) : "";
	return {
		status: node.state === "completed" ? "completed" : node.state === "failed" ? "failed" : node.state === "blocked" ? "blocked" : "stopped",
		output,
		...(node.runId !== undefined ? { runId: node.runId } : {}),
		...(node.error ? { error: node.error } : {}),
		...(result?.resultFile ? { resultFile: result.resultFile } : {}),
	};
}

/** Resolve once the run reports a terminal result, or once it stops existing. */
function waitForNodeSettlement(
	runtime: SubagentRuntime,
	runId: number,
	signal: AbortSignal,
): Promise<SingleResult | undefined> {
	const already = runtime.settledRuns.get(runId);
	if (already) return Promise.resolve(already);
	return new Promise((resolve) => {
		let done = false;
		let unsubscribe: (() => void) | undefined;
		const cleanup = (): void => {
			unsubscribe?.();
			signal.removeEventListener("abort", onAbort);
			runtime.settledListeners.get(runId)?.delete(onSettled);
		};
		const finish = (result: SingleResult | undefined): void => {
			if (done) return;
			done = true;
			cleanup();
			resolve(result);
		};
		const onSettled = (result: SingleResult): void => finish(result);
		const onAbort = (): void => finish(undefined);
		const listeners = runtime.settledListeners.get(runId) ?? new Set<(result: SingleResult) => void>();
		runtime.settledListeners.set(runId, listeners);
		listeners.add(onSettled);
		unsubscribe = monitor.subscribe(() => {
			const settled = runtime.settledRuns.get(runId);
			if (settled) {
				finish(settled);
				return;
			}
			if (monitor.findRun(runId)) return;
			// Removal is followed synchronously by registerRunResult on the normal
			// path; a cancelled run never registers one, so fall back to whatever
			// the thread recorded before giving up on this node.
			setTimeout(() => {
				finish(runtime.settledRuns.get(runId) ?? runtime.threads.get(runId)?.lastResult);
			}, 0);
		});
		if (signal.aborted) finish(undefined);
		else signal.addEventListener("abort", onAbort, { once: true });
	});
}

function canDispatch(ctx: RunContext): boolean {
	return ctx.run.state === "running" && !ctx.run.controller.signal.aborted && ctx.runtime.sessionActive;
}

async function dispatchNode(ctx: RunContext, node: WorkflowNodeRun): Promise<void> {
	const { run } = ctx;
	if (!canDispatch(ctx)) return;
	node.state = "running";
	node.startedAt = Date.now();
	let task: string;
	if (node.kind === "acceptance") {
		node.evidenceFile = writeResultArtifact(formatWorkflowReport(run), `workflow-${run.slug}-acceptance-evidence`, ctx.resultsRoot);
		task = buildAcceptanceBrief(run, node.evidenceFile);
	} else {
		const upstream = new Map<string, UpstreamOutput>();
		for (const dependency of node.ancestors) {
			const upstreamNode = nodeById(run, dependency);
			if (upstreamNode) upstream.set(dependency, upstreamView(upstreamNode));
		}
		task = renderNodeTask(node.task, upstream);
	}
	let started: SingleResult;
	try {
		started = await ctx.startBackground(node.agent, task, node.cwd, node.isolation ?? ctx.resolveIsolation(node.agent), {
			phaseId: node.phaseId,
			scope: node.scope,
			automaticIsolation: node.isolation === undefined,
			deliveryRoute: "background",
			quiet: true,
			workflow: { workflowId: run.id, name: run.name, nodeId: node.id },
		});
	} catch (error) {
		node.state = "failed";
		node.error = `dispatch crashed: ${error instanceof Error ? error.message : String(error)}`;
		node.endedAt = Date.now();
		return;
	}
	if (started.runId === undefined || started.exitCode !== -1) {
		// A rejected start (unknown agent, duplicate phase, overlapping scope,
		// worktree admission) never allocated a run; its text is the reason.
		node.state = "failed";
		node.error = getResultOutput(started).trim() || getResultError(started) || "the node could not start";
		node.result = started;
		node.endedAt = Date.now();
		return;
	}
	node.runId = started.runId;
	node.durableRunId = ctx.runtime.threads.get(started.runId)?.durableId;
	await checkpoint(ctx);
	if (run.state === "stopped") await stopThreads(ctx.runtime, [started.runId], run.stopReason);
	const result = await waitForNodeSettlement(ctx.runtime, started.runId, run.controller.signal);
	node.endedAt = Date.now();
	node.result = result;
	if (result && (node.kind === "acceptance" || getResultOutput(result).length > UPSTREAM_OUTPUT_MAX_CHARS) && !result.resultFile) {
		try {
			result.resultFile = writeResultArtifact(getResultOutput(result), `workflow-${run.slug}-${node.id}`, ctx.resultsRoot);
		} catch {
			/* The dependent brief explicitly reports an unavailable full answer. */
		}
	}
	if (run.state !== "running" || run.controller.signal.aborted || !ctx.runtime.sessionActive) {
		if (node.kind !== "acceptance" && result && !isFailedResult(result)) { node.state = "completed"; return; }
		node.state = "stopped";
		node.error ??= run.stopReason ?? "workflow stopped";
		return;
	}
	if (!result) {
		node.state = "stopped";
		node.error = "the run ended without reporting a result";
		return;
	}
	if (isFailedResult(result)) {
		node.state = "failed";
		node.error = describeError(result) ?? "the run failed";
		ctx.notify(
			`✗ workflow ${run.name} · node ${node.id} (${node.agent}) failed: ${formatTaskSummary(node.error, 200, false)}`,
			"error",
		);
		return;
	}
	if (node.kind === "acceptance") {
		const review = parseAcceptanceVerdict(getResultOutput(result));
		if (review.verdict !== "PASS") {
			node.state = "failed";
			node.error = review.error ?? "Required acceptance rejected the integrated outcome (WORKFLOW_ACCEPTANCE: FAIL). Read the review result for blockers and limitations.";
			ctx.notify(`✗ workflow ${run.name} · required acceptance rejected: ${formatTaskSummary(node.error, 200, false)}`, "error");
			return;
		}
	}
	node.state = "completed";
}

/** Blocked nodes are reported, not silently skipped: a graph that never ran a
 * node must say why. */
function blockDependents(run: WorkflowRun): boolean {
	let changed = false;
	for (const node of run.nodes) {
		if (node.state !== "pending" || node.kind === "acceptance") continue;
		const broken = node.dependsOn.find((dependency) => {
			const state = nodeById(run, dependency)?.state;
			return state !== undefined && terminalFailure(state);
		});
		if (!broken) continue;
		node.state = "blocked";
		node.error = `dependency "${broken}" did not complete; this node never ran`;
		changed = true;
	}
	return changed;
}

async function checkpoint(ctx: RunContext): Promise<void> {
	if (ctx.runtime.sessionActive) monitor.updateWorkflow(ctx.run);
	if (ctx.run.state !== "running") return;
	await upsertWorkflowRecord(ctx.runtime.configPath, workflowRecord(ctx.run, "running")).catch(() => undefined);
}

async function drive(ctx: RunContext): Promise<void> {
	const { run } = ctx;
	const inFlight = new Set<Promise<void>>();
	await checkpoint(ctx);
	while (run.state === "running") {
		if (!ctx.runtime.sessionActive) {
			await persistInterruptedWorkflows(ctx.runtime);
			break;
		}
		while (blockDependents(run)) { /* Propagate through any author order. */ }
		const ready = run.nodes.filter(
			(node) =>
				node.state === "pending" &&
				node.dependsOn.every((dependency) => {
					const state = nodeById(run, dependency)?.state;
					return node.kind === "acceptance"
						? state !== undefined && state !== "pending" && state !== "running"
						: state === "completed";
				}),
		);
		for (const node of ready) {
			if (!canDispatch(ctx)) break;
			// dispatchNode marks the node running synchronously, so the next pass
			// cannot start it twice.
			const task = dispatchNode(ctx, node).catch((error: unknown) => {
				node.state = "failed";
				node.error = error instanceof Error ? error.message : String(error);
				node.endedAt = Date.now();
			}).finally(async () => {
				await checkpoint(ctx);
				inFlight.delete(task);
				ctx.wake();
			});
			inFlight.add(task);
		}
		if (run.state !== "running") break;
		const running = run.nodes.some((node) => node.state === "running");
		if (!running && run.nodes.every((node) => node.state !== "pending")) break;
		// Nothing can start until a running node settles (or a node that was just
		// marked blocked frees the pass); wait for one wake-up instead of polling.
		await ctx.waitForWake();
	}
	await Promise.all(inFlight);
	await settle(ctx);
}

function stateLabel(state: WorkflowRunState): string {
	switch (state) {
		case "completed":
			return "completed";
		case "failed":
			return "finished with failures";
		case "stopped":
			return "stopped";
		case "interrupted":
			return "interrupted";
		default:
			return "running";
	}
}

function nodeStateWord(node: Pick<WorkflowNodeRun, "kind" | "state">): string {
	if (node.kind === "acceptance") {
		return `required acceptance ${node.state === "completed" ? "accepted" : node.state === "failed" ? "rejected" : node.state}`;
	}
	return node.state === "blocked" ? "never ran (blocked)" : node.state;
}

/** One line per node: what ran, what it cost in wall-clock, and why it failed. */
export function formatNodeLine(node: WorkflowNodeRun): string {
	const parts = [`${node.id} (${node.agent}) ${nodeStateWord(node)}`];
	if (node.runId !== undefined) parts.push(`run #${node.runId}`);
	if (node.startedAt !== undefined) {
		parts.push(formatDuration((node.endedAt ?? Date.now()) - node.startedAt));
	}
	if (node.error && node.state !== "completed") {
		parts.push(`error: ${formatTaskSummary(node.error, 220, false)}`);
	}
	if (node.state === "pending" && node.dependsOn.length > 0) {
		parts.push(`waiting for ${node.dependsOn.join(", ")}`);
	}
	return `- ${parts.join(" · ")}`;
}

function completedCount(run: WorkflowRun): number {
	return run.nodes.filter((node) => node.state === "completed").length;
}

/** Full markdown report: every node's line and every node's complete answer. */
export function formatWorkflowReport(run: WorkflowRun): string {
	const lines = [
		`# Workflow ${run.name} — ${stateLabel(run.state)}`,
		"",
		...(run.description ? [run.description, ""] : []),
		`Nodes: ${completedCount(run)} of ${run.nodes.length} completed`,
		...(run.stopReason ? [`Stop reason: ${run.stopReason}`] : []),
		"",
		...run.nodes.map(formatNodeLine),
	];
	for (const node of run.nodes) {
		const output = node.result ? getResultOutput(node.result).trim() : "";
		lines.push("", `## ${node.id} (${node.agent}) — ${nodeStateWord(node)}`, "");
		lines.push(`Phase: ${node.phaseId}`, `Working directory: ${node.cwd}`, `Dependencies: ${node.dependsOn.join(", ") || "none"}`);
		if (node.scope) lines.push(`Declared scope: ${JSON.stringify(node.scope)}`);
		if (node.result?.integrationStatus) lines.push(`Integration: ${node.result.integrationStatus}`);
		lines.push(`Task / done condition:\n${node.task}`, "");
		lines.push(output || "(no answer recorded)");
		if (node.error) lines.push("", `Error: ${node.error}`);
		for (const [label, path] of [["Acceptance evidence report", node.evidenceFile], ["Full result", node.result?.resultFile], ["Retained worktree", node.result?.integrationWorktreePath], ["Retained patch", node.result?.integrationPatchPath]]) {
			if (path) lines.push(`${label}: ${path}`);
		}
	}
	return lines.join("\n");
}

/** Lines of one node's answer inlined into the completion message. */
function inlineNodeAnswer(node: WorkflowNodeRun): { text: string; truncated: boolean } {
	const output = node.result ? getResultOutput(node.result) : "";
	if (!output.trim()) return { text: "", truncated: false };
	const clipped = truncateResultOutput(output, NODE_SUMMARY_LINES);
	return { text: clipped.text.trim(), truncated: clipped.truncated };
}

/** The parent's one handoff for the whole graph. */
export function formatWorkflowSummary(run: WorkflowRun, resultsRoot?: string): string {
	const completed = completedCount(run);
	const failed = run.nodes.filter((node) => node.state === "failed").length;
	const blocked = run.nodes.filter((node) => node.state === "blocked").length;
	const stopped = run.nodes.filter((node) => node.state === "stopped").length;
	const counts = [
		`${completed}/${run.nodes.length} completed`,
		...(failed > 0 ? [`${failed} failed`] : []),
		...(blocked > 0 ? [`${blocked} never ran`] : []),
		...(stopped > 0 ? [`${stopped} stopped`] : []),
	].join(", ");
	const lines = [
		`### workflow ${run.name} ${stateLabel(run.state)} (${counts})`,
		...(run.description ? [run.description] : []),
		...(run.stopReason ? [`Stop reason: ${run.stopReason}`] : []),
		"",
		...run.nodes.map(formatNodeLine),
	];

	const answers: string[] = [];
	let anyTruncated = false;
	for (const node of run.nodes) {
		const inline = inlineNodeAnswer(node);
		if (!inline.text) continue;
		if (inline.truncated) anyTruncated = true;
		answers.push(`#### ${node.id} (${node.agent})${node.kind === "acceptance" ? " — required acceptance review" : ""}`, inline.text, "");
		if (node.kind === "acceptance" && node.result?.resultFile) answers.push(`Full acceptance review: ${node.result.resultFile}`, "");
	}
	if (answers.length > 0) {
		lines.push("", "Node answers:", "", ...answers);
	}
	if (anyTruncated && resultsRoot) {
		try {
			const reportPath = writeResultArtifact(formatWorkflowReport(run), `workflow-${run.slug}`, resultsRoot);
			lines.push(`⚠ Some node answers are clipped here. Read the complete report, including every node's full answer: ${reportPath}`);
		} catch (error) {
			lines.push(`⚠ The full report could not be written: ${error instanceof Error ? error.message : String(error)}. Inspect retained run evidence before relying on clipped answers.`);
		}
	}
	const totals = perModelTotals(
		run.nodes
			.filter((node): node is WorkflowNodeRun & { result: SingleResult } => node.result !== undefined)
			.map((node) => ({ agent: node.agent, block: "", usage: node.result.usage, model: node.result.model })),
	);
	if (totals) lines.push("", `Totals: ${run.nodes.length} nodes · ${totals}`);
	if (failed > 0 || blocked > 0 || stopped > 0) {
		lines.push(
			"",
			"Main owns the rest: inspect what failed or never ran, reuse the partial edits and artifacts those runs retained, then finish the work and run the project's own gate. Do not re-dispatch a phase this graph already owns.",
		);
	}
	return lines.join("\n");
}

function workflowRecord(run: WorkflowRun, state: WorkflowRecord["state"]): WorkflowRecord {
	run.durableId ??= randomUUID();
	return {
		durableId: run.durableId,
		workflowId: run.id,
		name: run.name,
		...(run.description ? { description: run.description } : {}),
		cwd: run.cwd,
		state,
		startedAt: run.startedAt,
		updatedAt: Date.now(),
		...(run.stopReason ? { stopReason: run.stopReason } : {}),
		nodes: run.nodes.map((node) => ({
			id: node.id,
			agent: node.agent,
			task: node.task,
			dependsOn: [...node.dependsOn],
			...(node.kind ? { kind: node.kind } : {}),
			...(node.evidenceFile ? { evidenceFile: node.evidenceFile } : {}),
			...(node.result?.resultFile ? { resultFile: node.result.resultFile } : {}),
			state: node.state as RecordedNodeState,
			...(node.runId !== undefined ? { runId: node.runId } : {}),
			...(node.durableRunId ? { durableRunId: node.durableRunId } : {}),
			...(node.error ? { error: node.error } : {}),
		})),
	};
}

async function settle(ctx: RunContext): Promise<void> {
	const { run, runtime } = ctx;
	// A graph interrupted by session teardown keeps the record the teardown wrote:
	// it is the evidence the next session explains, not a settled run.
	const interrupted = run.state === "interrupted";
	if (run.state === "running") {
		const accepted = run.nodes.some((node) => node.kind === "acceptance" && node.state === "completed");
		run.state = !accepted || run.nodes.some((node) => node.state !== "completed") ? "failed" : "completed";
	}
	run.endedAt ??= Date.now();
	if (runtime.sessionActive) monitor.updateWorkflow(run);
	if (!interrupted && run.durableId) await removeWorkflowRecord(runtime.configPath, run.durableId, run.cwd).catch(() => undefined);
	if (!runtime.sessionActive) return;
	const item: CompletionMessageItem = {
		agent: `workflow:${run.name}`,
		block: formatWorkflowSummary(run, ctx.resultsRoot),
	};
	// No usage on the item: the summary carries its own per-model tally, and a
	// group total would merge different models' spend into one number.
	runtime.sendCompletionGroup([item]);
}

/** A phase a live or retained thread already owns. */
export interface OwnedPhase {
	nodeId: string;
	phaseId: string;
	runId?: number;
	workflowId?: number;
	ownerNodeId?: string;
	agent: string;
	state: string;
}

/**
 * Phases this session already owns, checked before the graph starts.
 *
 * A phase is owned by the parent session, not by one graph: an interrupted or
 * settled owner keeps its claim until it is retired. Checking every node up
 * front turns "the first node failed and the rest never ran" into one message
 * that names the owners and the way out, at the cost of no child process.
 */
export function findOwnedPhases(runtime: SubagentRuntime, workflow: CompiledWorkflow): OwnedPhase[] {
	const owned: OwnedPhase[] = [];
	for (const node of workflow.nodes) {
		const phaseId = node.phaseId ?? defaultPhaseId(workflow, node);
		const duplicate = findDuplicateDispatch(runtime.threads.values(), node.task, node.cwd, phaseId);
		if (!duplicate) {
			const pending = findPendingWorkflowPhase(runtime, node.task, node.cwd, phaseId);
			if (pending) owned.push({ nodeId: node.id, phaseId, workflowId: pending.workflowId, ownerNodeId: pending.nodeId, agent: pending.agent, state: "pending" });
			continue;
		}
		owned.push({
			nodeId: node.id,
			phaseId,
			runId: duplicate.source.id,
			agent: duplicate.source.agentName,
			state: duplicate.source.lifecycleOperation === "settle" ? "settling" : duplicate.source.state,
		});
	}
	return owned;
}

/** Start a compiled graph. Nodes dispatch as their prerequisites settle. */
export function startWorkflow(deps: WorkflowRunDeps, workflow: CompiledWorkflow): WorkflowHandle {
	const work = workflow.nodes.filter((node) => node.kind !== "acceptance");
	const reviews = workflow.nodes.filter((node) => node.kind === "acceptance");
	const review = reviews[0];
	if (reviews.length !== 1 || !review || review.id !== WORKFLOW_ACCEPTANCE_ID || review.agent !== WORKFLOW_ACCEPTANCE_AGENT ||
		review.cwd !== workflow.cwd || review.isolation !== "shared" || review.scope ||
		review.dependsOn.length !== work.length || work.some((node) => !review.dependsOn.includes(node.id))) {
		throw new Error("A workflow requires exactly one compiler-owned independent acceptance node covering all authored work.");
	}
	const runtime = deps.runtime;
	const durableId = randomUUID();
	const run: WorkflowRun = {
		durableId,
		id: runtime.reserveWorkflowId(),
		name: workflow.name,
		slug: workflow.slug,
		...(workflow.description ? { description: workflow.description } : {}),
		cwd: workflow.cwd,
		state: "running",
		startedAt: Date.now(),
		controller: new AbortController(),
		nodes: workflow.nodes.map((node) => ({
			id: node.id,
			...(node.kind ? { kind: node.kind } : {}),
			agent: node.agent,
			task: node.task,
			dependsOn: [...node.dependsOn],
			ancestors: [...node.ancestors],
			...(node.isolation ? { isolation: node.isolation } : {}),
			phaseId: node.phaseId ?? defaultPhaseId(workflow, node),
			...(node.scope ? { scope: node.scope } : {}),
			cwd: node.cwd,
			state: "pending",
		})),
	};
	runtime.workflows.set(run.id, run);
	runtime.workflowRecordIds.set(durableId, run.id);

	let wakeRequested = false;
	let wakeResolver: (() => void) | undefined;
	const ctx: RunContext = {
		...deps,
		run,
		wake: () => {
			if (wakeResolver) {
				const resolve = wakeResolver;
				wakeResolver = undefined;
				resolve();
			} else {
				wakeRequested = true;
			}
		},
		waitForWake: async () => {
			if (wakeRequested) {
				wakeRequested = false;
				return;
			}
			await new Promise<void>((resolve) => {
				wakeResolver = resolve;
			});
		},
	};

	// Declared writer overlap inside the graph was rejected at compile time; the
	// dispatcher still runs its own admission per node, so a node that conflicts
	// with unrelated live work fails alone instead of poisoning the graph.
	const done = drive(ctx).then(
		() => run,
		(error: unknown) => {
			run.state = "failed";
			run.endedAt = Date.now();
			run.stopReason = error instanceof Error ? error.message : String(error);
			deps.notify(`✗ workflow ${run.name} crashed: ${run.stopReason}`, "error");
			void removeWorkflowRecord(runtime.configPath, durableId, run.cwd).catch(() => undefined);
			return run;
		},
	);
	run.done = done;
	return { run, done };
}

/** Stop a graph: no new node starts, running nodes are cancelled, and the
 * summary still reports what had already completed. */
export async function stopWorkflow(
	runtime: SubagentRuntime,
	run: WorkflowRun,
	reason = "Stopped by subagent_stop.",
): Promise<number[]> {
	if (run.state !== "running" && run.state !== "interrupted") return [];
	run.state = "stopped";
	run.stopReason = reason;
	for (const node of run.nodes) {
		if (node.state !== "pending") continue;
		node.state = "stopped";
		node.error = "stopped before it started";
	}
	monitor.updateWorkflow(run);
	const cancelled = run.nodes.flatMap((node) => node.state === "running" && node.runId !== undefined ? [node.runId] : []);
	// The same stop owner as the control tool finalizes worktrees before the
	// graph publishes its summary. A late dispatch stops itself on allocation.
	await stopThreads(runtime, cancelled, reason);
	run.controller.abort();
	return cancelled;
}

/** Persist the shape of every graph still running when the session ends, so the
 * next session explains what was in flight instead of showing loose threads. */
export async function persistInterruptedWorkflows(runtime: SubagentRuntime): Promise<void> {
	const live = [...runtime.workflows.values()].filter((run) => run.state === "running");
	await Promise.all(
		live.map(async (run) => {
			run.state = "interrupted";
			run.endedAt = Date.now();
			run.stopReason ??= "the parent session ended before this workflow settled";
			monitor.updateWorkflow(run);
			await upsertWorkflowRecord(runtime.configPath, workflowRecord(run, "interrupted")).catch(() => undefined);
			// Wake the runner's waiters so the graph unwinds instead of holding a
			// promise past shutdown; settle() keeps the record and skips delivery.
			run.controller.abort();
		}),
	);
}

export interface RetainedWorkflow {
	id: number;
	durableId: string;
	name: string;
	state: WorkflowRecord["state"];
	stopReason?: string;
	updatedAt: number;
	nodes: Array<WorkflowRecord["nodes"][number] & { originalRunId?: number }>;
}

/** Reconcile persisted identities with this window's ids. Never attach an old
 * node to an unrelated run merely because their display numbers match. */
export async function readRetainedWorkflows(runtime: SubagentRuntime, cwd: string): Promise<RetainedWorkflow[]> {
	const records = await readWorkflowRecords(runtime.configPath, cwd);
	for (const record of records) runtime.ensureWorkflowIdAbove(record.workflowId);
	const threadsByIdentity = new Map([...runtime.threads.values()].filter((thread) => thread.durableId)
		.map((thread) => [thread.durableId!, thread.id]));
	const allocated = new Set([...runtime.workflowRecordIds.values(), ...runtime.workflows.keys()]);
	return records.map((record) => {
		const durableId = workflowRecordIdentity(record);
		let id = runtime.workflowRecordIds.get(durableId);
		if (id === undefined) {
			id = allocated.has(record.workflowId) ? runtime.reserveWorkflowId() : record.workflowId;
			runtime.workflowRecordIds.set(durableId, id);
			allocated.add(id);
		}
		return {
			id, durableId, name: record.name,
			state: record.state === "running" ? "interrupted" : record.state,
			...(record.stopReason ? { stopReason: record.stopReason } : {}),
			updatedAt: record.updatedAt,
			nodes: record.nodes.map((node) => {
				const { runId: originalRunId, ...facts } = node;
				const runId = node.durableRunId ? threadsByIdentity.get(node.durableRunId) : undefined;
				return { ...facts, ...(runId === undefined
					? originalRunId === undefined ? {} : { originalRunId }
					: { runId }) };
			}),
		};
	});
}

/** Status-facing projection of a live or settled graph. */
export interface WorkflowStatusView {
	id: number;
	name: string;
	state: WorkflowRunState;
	description?: string;
	stopReason?: string;
	cwd: string;
	startedAt: number;
	endedAt?: number;
	nodes: Array<{
		id: string;
		kind?: "acceptance";
		evidenceFile?: string;
		resultFile?: string;
		agent: string;
		state: WorkflowNodeRun["state"];
		task: string;
		phaseId: string;
		scope?: PhaseScope;
		cwd: string;
		runId?: number;
		waitingFor?: string[];
		error?: string;
		activity?: string;
		elapsedMs?: number;
	}>;
}

export function workflowStatus(run: WorkflowRun): WorkflowStatusView {
	return {
		id: run.id,
		name: run.name,
		state: run.state,
		...(run.description ? { description: run.description } : {}),
		...(run.stopReason ? { stopReason: run.stopReason } : {}),
		cwd: run.cwd,
		startedAt: run.startedAt,
		...(run.endedAt !== undefined ? { endedAt: run.endedAt } : {}),
		nodes: run.nodes.map((node) => {
			const live = node.runId === undefined ? undefined : monitor.findRun(node.runId);
			return {
				id: node.id,
				...(node.kind ? { kind: node.kind } : {}),
				...(node.evidenceFile ? { evidenceFile: node.evidenceFile } : {}),
				...(node.result?.resultFile ? { resultFile: node.result.resultFile } : {}),
				agent: node.agent,
				state: node.state,
				task: formatTaskSummary(node.task, 160, false),
				phaseId: node.phaseId,
				scope: node.scope,
				cwd: node.cwd,
				...(node.runId !== undefined ? { runId: node.runId } : {}),
				...(node.state === "pending" && node.dependsOn.length > 0 ? { waitingFor: [...node.dependsOn] } : {}),
				...(node.error ? { error: node.error } : {}),
				...(live?.status === "queued" ? { activity: runWaitLabel(live) } : live?.integrationStatus === "finalizing" ? { activity: "integrating worktree" } : live?.activity ? { activity: live.activity } : {}),
				...(node.startedAt !== undefined ? { elapsedMs: (node.endedAt ?? Date.now()) - node.startedAt } : {}),
			};
		}),
	};
}

/** Multi-line text view used by `subagent_status`. */
export function formatWorkflowStatus(run: WorkflowRun): string[] {
	const view = workflowStatus(run);
	const lines = [
		`workflow #${view.id} ${view.name} · ${stateLabel(view.state)} · ${completedCount(run)}/${run.nodes.length} completed · ${formatDuration((view.endedAt ?? Date.now()) - view.startedAt)}`,
	];
	if (view.description) lines.push(`  ${view.description}`);
	if (view.stopReason) lines.push(`  stop reason: ${formatTaskSummary(view.stopReason, 200, false)}`);
	for (const node of view.nodes) {
		const parts = [`${node.id} (${node.agent}) ${nodeStateWord(node)}`];
		if (node.runId !== undefined) parts.push(`run #${node.runId}`);
		if (node.waitingFor) parts.push(`waiting for ${node.waitingFor.join(", ")}`);
		if (node.elapsedMs !== undefined) parts.push(formatDuration(node.elapsedMs));
		if (node.activity) parts.push(node.activity);
		if (node.error) parts.push(`error: ${formatTaskSummary(node.error, 200, false)}`);
		lines.push(`  - ${parts.join(" · ")}`);
		lines.push(`    phase: ${node.phaseId} · task: ${node.task}`);
		if (node.scope) lines.push(`    scope: ${JSON.stringify(node.scope)}`);
	}
	return lines;
}

/** Multi-line view of a graph retained from a previous session. */
export function formatRetainedWorkflow(record: RetainedWorkflow): string[] {
	const done = record.nodes.filter((node) => node.state === "completed").length;
	const age = formatDuration(Date.now() - record.updatedAt);
	const lines = [
		"workflow #" + record.id + " " + record.name + " · " + record.state + " (retained) · " +
			done + "/" + record.nodes.length + " completed · updated " + age + " ago",
	];
	if (record.stopReason) lines.push("  stop reason: " + formatTaskSummary(record.stopReason, 200, false));
	for (const node of record.nodes) {
		const parts = [node.id + " (" + node.agent + ") " + nodeStateWord(node)];
		if (node.runId !== undefined) parts.push("run #" + node.runId);
		else if (node.originalRunId !== undefined) parts.push("original run #" + node.originalRunId + " (not restored in this window)");
		if (node.dependsOn.length > 0) parts.push("after " + node.dependsOn.join(", "));
		if (node.error) parts.push("error: " + formatTaskSummary(node.error, 160, false));
		if (node.evidenceFile) parts.push("acceptance evidence: " + node.evidenceFile);
		if (node.resultFile) parts.push("full result: " + node.resultFile);
		lines.push("  - " + parts.join(" · "));
	}
	lines.push("  A retained graph is not resumed automatically: main finishes the unfinished nodes from their run evidence.");
	return lines;
}
