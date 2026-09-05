/**
 * Pure formatting/result helpers shared by the subagent tool and completion
 * delivery: usage rendering, completion blocks, synthetic result constructors,
 * and run-id matching.
 */

import type { AgentConfig } from "../delegation/agents.ts";
import { runLabel, shrinkRunLabel } from "./monitor.ts";
import { emptyUsage } from "../execution/rpc-control.ts";
import {
	RESULT_LINE_MAX,
	getResultError,
	getResultOutput,
	isFailedResult,
	truncateResultOutput,
	writeResultArtifact,
	type SingleResult,
	type UsageStats,
} from "../execution/spawn.ts";

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
	/** Project-scoped directory the full result is written to when the output
	 * is truncated: <projectRoot>/results. */
	resultRoot?: string;
}

/** Display width of the task-derived label folded into the completion heading:
 * tight enough to stay a hint rather than a second copy of the task. */
const COMPLETION_LABEL_MAX = 24;

export function formatCompletionBlock(
	result: SingleResult,
	maxResultLines: number,
	options: CompletionFormatOptions = {},
): string {
	const failed = isFailedResult(result);
	const failedTools = result.failedTools ?? [];
	const status = failed ? "failed" : "completed";
	const usage = formatUsage(result.usage);
	const output = getResultOutput(result);
	const { text, truncated, shownLines, totalLines, widthClipped } = truncateResultOutput(output, maxResultLines);
	const fallbackNote = result.modelFallbackFrom
		? ` (selected model ${result.modelFallbackFrom} failed → main ${result.model ?? "dynamic default"})`
		: "";
	const startupRetryNote = result.startupRetries
		? ` (recovered after ${result.startupRetries} startup retr${result.startupRetries === 1 ? "y" : "ies"} — concurrent pi startup race)`
		: "";
	const runNote = result.runId !== undefined ? ` · run #${result.runId}` : "";
	// A short task-derived label, not the task itself: the parent authored the
	// task and still has it in context, but a wide fan-out of same-agent runs
	// needs more than a run id to tell completions apart.
	const label = shrinkRunLabel(runLabel(result.task), COMPLETION_LABEL_MAX);
	const lines = [
		`### [${result.agent}${label ? `·${label}` : ""}] ${status}${usage ? ` (${usage})` : ""}${fallbackNote}${startupRetryNote}${runNote}`,
		"",
	];
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
		lines.push(`Isolation: ${isolation}`);
		if (result.integrationWorktreePath) lines.push(`Retained worktree: ${result.integrationWorktreePath}`);
		if (result.integrationPatchPath) lines.push(`Retained patch: ${result.integrationPatchPath}`);
		if (result.integrationError) lines.push(`Integration error: ${result.integrationError}`);
		lines.push("");
	}
	lines.push(text);
	// Failed-tool diagnostics ride along only when the run itself failed: they
	// explain the failure, while on a successful run a transient failed call
	// (no-match grep, rejected edit) is noise the agent already worked around.
	if (failed && failedTools.length > 0) {
		lines.push(
			"",
			`⚠ ${failedTools.length} failed tool call${failedTools.length === 1 ? "" : "s"}:`,
			...failedTools.map((tool) => `- ${tool.toolName}: ${tool.error.trim() || "(no output)"}`),
		);
	}
	if (truncated) {
		// The full text lives on disk so the main agent can read it on demand.
		const artifact = options.resultRoot
			? writeResultArtifact(output, result.agent, options.resultRoot)
			: "(result root unavailable)";
		if (options.resultRoot) result.resultFile = artifact;
		// State the real loss and condition the read: handing the parent both a
		// summary and a full-text entrance invites the same content twice.
		const lineLoss = shownLines < totalLines ? `${shownLines} of ${totalLines} lines shown` : `${shownLines} line${shownLines === 1 ? "" : "s"} shown`;
		const widthLoss = widthClipped ? `clipped to ${RESULT_LINE_MAX} characters` : undefined;
		const loss = widthLoss ? `${lineLoss}, ${widthLoss}` : lineLoss;
		lines.push("", `(${loss}; full result ${artifact} — read only if these are insufficient)`);
	}
	return lines.join("\n");
}

/** A terminal model failure hands the unfinished task to main, not another run. */
export function modelLevelTakeoverNote(result: SingleResult): string {
	const retry = result.modelFallbackFrom ? ", and the current main model also failed" : "";
	const cause = getResultError(result) ?? "its model was unavailable or failed";
	return `The sub-agent could not complete this task: ${cause}${retry}. Earlier edits and any retained result/session artifacts remain available. Main must inspect that work and finish with its own tools; do not re-dispatch this phase.`;
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
