/**
 * Pure formatting/result helpers shared by the subagent tool and the lookup
 * tools (subagent_wait/status): usage rendering, completion blocks, synthetic
 * result constructors, and run-id matching.
 */

import type { AgentConfig } from "./agents.ts";
import { formatTaskSummary } from "./monitor.ts";
import { emptyUsage } from "./rpc-run.ts";
import {
	getResultOutput,
	isFailedResult,
	truncateResultOutput,
	writeResultArtifact,
	type SingleResult,
	type UsageStats,
} from "./spawn.ts";

export function queuedResult(agent: AgentConfig, task: string, thinking?: string): SingleResult {
	return {
		agent: agent.name,
		task,
		exitCode: -1,
		messages: [],
		stderr: "",
		usage: emptyUsage(),
		model: agent.model,
		...(thinking ? { thinking } : {}),
	};
}

export function failedStartResult(agentName: string, task: string, errorMessage: string): SingleResult {
	return {
		agent: agentName,
		task,
		exitCode: 1,
		messages: [],
		stderr: errorMessage,
		usage: emptyUsage(),
		errorMessage,
		dispatchFailed: true,
	};
}

/** Failed result for a background task that crashed with an exception (spawn
 * infra, delivery API, ...) instead of returning a normal result. */
export function dispatchFailedResult(agent: AgentConfig, task: string, error: unknown, thinking?: string): SingleResult {
	const errorMessage = error instanceof Error ? error.message : String(error);
	return {
		...queuedResult(agent, task, thinking),
		exitCode: 1,
		stderr: errorMessage,
		stopReason: "error",
		errorMessage,
		dispatchFailed: true,
	};
}

function formatTokens(count: number): string {
	if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
	if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k`;
	return String(count);
}

export function formatUsage(usage: UsageStats): string {
	const parts: string[] = [];
	if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	return parts.join(" ");
}

export interface CompletionFormatOptions {
	/** Include individual failed-tool errors. Reserved for explicit status lookup. */
	failedToolDetails?: boolean;
}

export function formatCompletionBlock(
	result: SingleResult,
	maxResultLines: number,
	cwd?: string,
	options: CompletionFormatOptions = {},
): string {
	const failed = isFailedResult(result);
	const failedTools = result.failedTools ?? [];
	const status = failed
		? "failed"
		: options.failedToolDetails && failedTools.length > 0
			? `completed with ${failedTools.length} failed tool call${failedTools.length === 1 ? "" : "s"}`
			: "completed";
	const usage = formatUsage(result.usage);
	const output = getResultOutput(result);
	const { text, truncated } = truncateResultOutput(output, maxResultLines);
	const fallbackNote = result.modelFallbackFrom
		? ` (selected model ${result.modelFallbackFrom} failed → main ${result.model ?? "dynamic default"})`
		: "";
	const startupRetryNote = result.startupRetries
		? ` (recovered after ${result.startupRetries} startup retr${result.startupRetries === 1 ? "y" : "ies"} — concurrent pi startup race)`
		: "";
	const relations = [
		result.forkedFromRunId !== undefined ? `forked from #${result.forkedFromRunId}` : undefined,
		(result.forkChildRunIds?.length ?? 0) > 0 ? `fork children ${result.forkChildRunIds!.map((id) => `#${id}`).join(", ")}` : undefined,
	].filter((value): value is string => Boolean(value));
	const relationNote = relations.length > 0 ? ` · ${relations.join(" · ")}` : "";
	const runNote = result.runId !== undefined ? ` · run #${result.runId}` : "";
	const lines = [`### [${result.agent}] ${status}${usage ? ` (${usage})` : ""}${fallbackNote}${startupRetryNote}${runNote}`, "", `Task: ${formatTaskSummary(result.task, 80, false)}`, ""];
	if (result.isolation === "worktree") {
		const isolation =
			result.integrationStatus === "integrated"
				? "worktree · changes integrated into the original working tree"
				: result.integrationStatus === "no_changes"
					? "worktree · no changes; temporary worktree removed"
					: result.integrationStatus === "retained"
						? result.integrationApplied
							? "worktree · changes applied, but cleanup failed; recovery artifacts retained"
							: "worktree · integration failed; recovery artifacts retained"
						: "worktree · isolated";
		lines.push(`Isolation: ${isolation}${relationNote}`);
		if (result.integrationWorktreePath) lines.push(`Retained worktree: ${result.integrationWorktreePath}`);
		if (result.integrationPatchPath) lines.push(`Retained patch: ${result.integrationPatchPath}`);
		if (result.integrationError) lines.push(`Integration error: ${result.integrationError}`);
		lines.push("");
	} else if (relations.length > 0) {
		lines.push(`Relation: ${relations.join(" · ")}`, "");
	}
	lines.push(text);
	// Explicit status always exposes every retained diagnostic, including when
	// the overall run failed or was aborted. Automatic delivery adds only a
	// compact pointer for otherwise-clean runs.
	if (options.failedToolDetails && failedTools.length > 0) {
		lines.push(
			"",
			`⚠ ${failedTools.length} failed tool call${failedTools.length === 1 ? "" : "s"}:`,
			...failedTools.map((tool) => `- ${tool.toolName}: ${tool.error.trim() || "(no output)"}`),
		);
	} else if (!failed && failedTools.length > 0) {
		const lookup = result.runId !== undefined ? ` · details: subagent_status #${result.runId}` : "";
		lines.push("", `⚠ ${failedTools.length} failed tool call${failedTools.length === 1 ? "" : "s"}${lookup}`);
	}
	if (truncated) {
		// The full text lives on disk so the main agent can read it on demand.
		lines.push("", `(output truncated to ${maxResultLines} lines; full result: ${writeResultArtifact(output, result.agent, result.projectCwd ?? cwd)})`);
	}
	return lines.join("\n");
}

/** Instruction appended to a model-level failure: the sub-agent's provider never
 * produced usable output (or the run stalled), so the task is handed back to the
 * main window instead of being left as a dead failure. When the run preserved a
 * session with earlier work (and the run id is known), steer the main agent to
 * RESUME it in-context once a model is available, instead of re-dispatching
 * fresh (which would re-scan everything). */
export function modelLevelTakeoverNote(result: SingleResult, opts?: { runId?: number }): string {
	const retry = result.modelFallbackFrom ? ", and the current main model also failed" : "";
	const detail = result.errorMessage?.trim();
	const cause = detail
		? `its model/provider call failed (${detail})`
		: "its model was unavailable or failed (or the run stalled)";
	const sessionPreserved = Boolean(result.sessionDir && result.sessionId) && opts?.runId !== undefined;
	const recovery = sessionPreserved
		? ` The sub-agent's earlier work in this run is preserved. Once a model is available again, call subagent_control with { action: "resume", id: ${opts!.runId} } to CONTINUE it in-context (it keeps the same run id and does not re-scan), or execute the task in the main window with your own tools.`
		: ` Please execute this task in the main window with your own tools; do not re-dispatch it as a sub-agent.`;
	return `The sub-agent could not complete this task: ${cause}${retry}.${recovery}`;
}

/** Resolve a run-id request to actual ids: an exact numeric match always wins
 * (so "1" never fans out to 10, 11, …); only when no exact match exists does a
 * prefix match run, as a convenience for partial ids. Keeps single-digit lookups
 * from returning — or, for subagent_stop, acting on — a whole prefix family. */
export function matchRunIds(ids: number[], requested: string): number[] {
	const exact = ids.filter((id) => String(id) === requested);
	if (exact.length > 0) return exact;
	return ids.filter((id) => String(id).startsWith(requested));
}
