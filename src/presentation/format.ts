/**
 * Pure formatting/result helpers shared by the subagent tool and completion
 * delivery: usage rendering, completion blocks, and synthetic result constructors.
 */

import { readFileSync } from "node:fs";
import { stripVTControlCharacters } from "node:util";
import type { AgentConfig } from "../delegation/agents.ts";
import { formatUsageCompact, runLabel, shrinkRunLabel } from "./monitor.ts";
import { emptyUsage } from "../execution/run-control.ts";
import {
	getResultError,
	getResultOutput,
	isFailedResult,
	isModelLevelFailure,
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

export function formatUsage(usage: UsageStats): string {
	const turns = usage.turns ? `${usage.turns} turn${usage.turns > 1 ? "s" : ""}` : undefined;
	return [turns, formatUsageCompact(usage)].filter(Boolean).join(" ");
}

/** Preserve the brief's paragraphs and indentation when a Pi tool card expands. */
export function formatExpandedBrief(task: string): string {
	return stripVTControlCharacters(task).replace(/\r\n?/gu, "\n").split("\n")
		.map((line) => line && "    " + line).join("\n");
}

interface CompletionFormatOptions {
	/** Project-scoped directory the full result is written to when the output
	 * is truncated: <projectRoot>/results. */
	resultRoot?: string;
}

/** Display width of the task-derived label folded into the completion heading:
 * tight enough to stay a hint rather than a second copy of the task. */
const COMPLETION_LABEL_MAX = 24;

/** Characters of one full line in the inline budget of a completion block. */
export const RESULT_LINE_CHARS = 200;

/** The result's existing artifact when it already holds exactly this output.
 * Results derived from a delivered one (a crash or stop wrapper) carry its path
 * but different text, so they get their own file. */
function reusableArtifact(result: SingleResult, output: string): string | undefined {
	if (!result.resultFile) return undefined;
	try {
		return readFileSync(result.resultFile, "utf8") === output ? result.resultFile : undefined;
	} catch {
		return undefined;
	}
}

/** How an answer exceeds the inline budget of `maxLines` lines and the
 * characters of that many full lines; undefined when it fits. Long prose lines
 * fit, so only an oversized answer moves to its result file. */
function inlineOverflow(output: string, maxLines: number): string | undefined {
	const lineCount = output.split("\n").length;
	const maxChars = maxLines * RESULT_LINE_CHARS;
	const overflow = [
		lineCount > maxLines ? `${lineCount} lines` : undefined,
		output.length > maxChars ? `${output.length} characters` : undefined,
	].filter(Boolean);
	return overflow.length > 0 ? overflow.join(" · ") : undefined;
}

/** Bounded head of an oversized output for inline fallback when no artifact file
 * is available: at most `maxLines` lines and `maxLines * RESULT_LINE_CHARS` chars. */
function truncateHead(output: string, maxLines: number): string {
	const lineLimit = Math.max(0, maxLines);
	if (lineLimit === 0) return "";
	const charLimit = lineLimit * RESULT_LINE_CHARS;
	let head = output.split("\n").slice(0, lineLimit).join("\n");
	if (head.length > charLimit) head = head.slice(0, charLimit);
	return head;
}

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
	const overflow = inlineOverflow(output, maxResultLines);
	const runNote = result.runId !== undefined ? ` · run #${result.runId}` : "";
	// A short task-derived label, not the task itself: the parent authored the
	// task and still has it in context, but a wide fan-out of same-agent runs
	// needs more than a run id to tell completions apart.
	const label = shrinkRunLabel(runLabel(result.task), COMPLETION_LABEL_MAX);
	const lines = [
		`### [${result.agent}${label ? `·${label}` : ""}] ${status}${usage ? ` (${usage})` : ""}${runNote}`,
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
	if (result.isolationNote) lines.push(`Isolation: ${result.isolationNote}`, "");
	if (!overflow) lines.push(output);
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
	if (overflow) {
		// No inline copy when the full output is saved to a file: a truncated
		// dump reads as complete while hiding the rest, and the parent re-reads
		// the full text from the file anyway. Fall back to a bounded head only
		// when the artifact cannot be written or no result root is available.
		let artifact = reusableArtifact(result, output);
		let saveFailure: string | undefined;
		if (!artifact) {
			if (!options.resultRoot) {
				saveFailure = "result root unavailable";
			} else {
				try {
					artifact = writeResultArtifact(output, result.agent, options.resultRoot);
					result.resultFile = artifact;
				} catch (error) {
					saveFailure = error instanceof Error ? error.message : String(error);
				}
			}
		}
		if (artifact) {
			if (options.resultRoot) result.resultFile = artifact;
			lines.push(
				"",
				`⚠ The child's answer (${overflow}) is not inlined here, so it is delivered exactly once. Read the complete result file \`${artifact}\`; it holds the full, untruncated output.`,
			);
		} else {
			delete result.resultFile;
			const head = truncateHead(output, maxResultLines);
			if (head) {
				if (lines[lines.length - 1] !== "") lines.push("");
				lines.push(head);
			}
			lines.push(
				"",
				`⚠ The child's answer (${overflow}) was truncated above because the full result could not be saved (${saveFailure ?? "unknown error"}).`,
			);
		}
	}
	if (failed && isModelLevelFailure(result)) lines.push("", modelLevelTakeoverNote(result));
	if (!failed && result.agent === "worker") {
		lines.push("", "Review handoff: main. Worker completion is not review approval. Inspect the actual diff, affected callers, acceptance criteria, and check evidence. Send confirmed corrections to the owning worker with subagent_message; main owns acceptance and release.");
	}
	return lines.join("\n");
}

/** A terminal model failure hands the unfinished task to main, not another run. */
function modelLevelTakeoverNote(result: SingleResult): string {
	const cause = getResultError(result) ?? "its model was unavailable or failed";
	const role = result.agent || "subagent";
	return `The ${role} could not complete this task: ${cause}. No automatic model upgrade was attempted. Earlier edits and retained result/session artifacts remain available. Main must inspect that work and decide how to proceed; do not repeat this failed phase automatically.`;
}
