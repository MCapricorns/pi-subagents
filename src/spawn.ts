/**
 * Sub-agent result handling and resilient RPC launch orchestration.
 *
 * The process transport itself lives in rpc-run.ts. Each attempt starts pi in
 * persistent `--mode rpc`, sends commands over strict LF-delimited JSONL, and
 * settles only on `agent_settled`. This module preserves the existing startup
 * retry, same-model retry, model fallback, accounting, and result formatting
 * contracts around those attempts.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import type { AgentConfig } from "./agents.ts";
import { DEFAULT_THINKING_LEVEL, type ThinkingLevel } from "./config.ts";
import {
	currentSubagentDepth,
	DEPTH_ENV_VAR,
	extractToolErrorText,
	getPiInvocation,
	RpcRunControl,
	runRpcAgentAttempt,
	sessionExists,
	SUBAGENT_KILL_GRACE_MS,
	type RpcSingleResult,
	type SubagentLiveEvent,
	type UsageStats,
} from "./rpc-run.ts";

export {
	currentSubagentDepth,
	DEPTH_ENV_VAR,
	extractToolErrorText,
	getPiInvocation,
	RpcRunControl,
	sessionExists,
	SUBAGENT_KILL_GRACE_MS,
};
export type { SubagentLiveEvent, UsageStats };

export const SUBAGENT_THINKING_LEVEL: ThinkingLevel = DEFAULT_THINKING_LEVEL;
/** 0 disables the watchdog; dispatch supplies the configured timeout. */
export const SUBAGENT_DEFAULT_IDLE_TIMEOUT_MS = 0;
export const SUBAGENT_STARTUP_RETRY_DELAYS_MS = [250, 750, 1500] as const;
export const MAX_SUBAGENT_STARTUP_FAILURE_DURATION_MS = 2000;
export const SUBAGENT_RUN_LEVEL_RETRY_DELAYS_MS = [2_000, 4_000, 8_000, 16_000, 30_000] as const;

export interface SingleResult extends RpcSingleResult {}

export interface SubagentDetails {
	mode: "single" | "parallel";
	results: SingleResult[];
	background?: boolean;
}

export function getFinalOutput(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") return part.text;
			}
		}
	}
	return "";
}

/** Only the last standalone reviewer verdict line counts. */
export function reviewVerdict(output: string): "pass" | "fail" | undefined {
	const lines = output.split("\n");
	for (let index = lines.length - 1; index >= 0; index--) {
		const match = /^\s*VERDICT:\s*REVIEW_(PASS|FAIL)\s*$/i.exec(lines[index]);
		if (match) return match[1].toUpperCase() === "PASS" ? "pass" : "fail";
	}
	return undefined;
}

export const RESULT_LINE_MAX = 200;

export interface TruncatedOutput {
	text: string;
	truncated: boolean;
}

export function truncateResultOutput(output: string, maxLines: number): TruncatedOutput {
	const lines = output.split("\n");
	if (lines.length <= maxLines && lines.every((line) => line.length <= RESULT_LINE_MAX)) {
		return { text: output, truncated: false };
	}
	const kept = lines.slice(0, maxLines).map((line) =>
		line.length > RESULT_LINE_MAX ? `${line.slice(0, RESULT_LINE_MAX)}…` : line,
	);
	return { text: kept.join("\n"), truncated: true };
}

export function writeResultArtifact(output: string, agentName: string, cwd?: string): string {
	const projectSlug = cwd ? basename(cwd).replace(/[^\w.-]+/g, "_") || "default" : "default";
	const dir = join(tmpdir(), "pi-subagents-results", projectSlug);
	mkdirSync(dir, { recursive: true });
	const safeName = agentName.replace(/[^\w.-]+/g, "_");
	const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
	const filePath = join(dir, `${unique}-${safeName}.md`);
	writeFileSync(filePath, output, "utf8");
	return filePath;
}

export function isFailedResult(result: SingleResult): boolean {
	if (result.parked) return false;
	return result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
}

function lastAssistantMessage(messages: Message[]): Extract<Message, { role: "assistant" }> | undefined {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message.role === "assistant") return message;
	}
	return undefined;
}

function assistantText(message: Extract<Message, { role: "assistant" }>): string {
	return message.content
		.filter((part): part is Extract<(typeof message.content)[number], { type: "text" }> => part.type === "text")
		.map((part) => part.text)
		.join("");
}

export function isModelLevelFailure(result: SingleResult): boolean {
	if (!isFailedResult(result)) return false;
	if (result.stopReason === "aborted") return false;
	if (result.dispatchFailed) return false;
	if (result.integrationStatus === "retained") return false;
	if (result.errorMessage?.includes("idle timeout")) return true;
	if (result.rpcPromptRejected) return true;

	// Classification belongs to the final assistant turn, not the whole attempt.
	// Earlier useful text or failed tool calls are retained session history and
	// must not hide a later provider error (for example a second-turn 503).
	const finalAssistant = lastAssistantMessage(result.messages);
	if (finalAssistant) {
		if (finalAssistant.stopReason !== "error") return false;
		if (assistantText(finalAssistant).trim()) return false;
		return Boolean(
			finalAssistant.errorMessage?.trim() ||
			result.errorMessage?.trim() ||
			result.stderr.trim() ||
			finalAssistant.content.length === 0
		);
	}

	if ((result.failedTools?.length ?? 0) > 0) return false;
	return Boolean(result.errorMessage?.trim()) || result.stderr.trim().length > 0;
}

const TERMINAL_MODEL_ERROR_PATTERN =
	/insufficient_quota|quota\s+exceeded|exceeded[^.\n]{0,40}quota|out\s+of\s+budget|billing|usage\s+limit|usage_limit|gousagelimiterror|freeusagelimiterror|monthly\s+usage\s+limit\s+reached|available\s+balance|invalid\s+(?:api\s+)?key|incorrect\s+api\s+key|unauthori[sz]ed|\b401\b|\b403\b|forbidden|permission\s+denied/i;
const PERMANENT_MODEL_CANDIDATE_ERROR_PATTERN =
	/model[_ -]?not[_ -]?found|no\s+models?\s+(?:found|matched)|(?:model|provider)[^.\n]{0,80}(?:not\s+found|unknown|does\s+not\s+exist|unsupported|invalid)|(?:not\s+found|unknown|unsupported|invalid)[^.\n]{0,40}(?:model|provider)|\b404\b/i;

export function isTerminalModelError(result: SingleResult): boolean {
	const message = result.errorMessage?.trim();
	if (message) return TERMINAL_MODEL_ERROR_PATTERN.test(message);
	const stderr = result.stderr.trim();
	return stderr.length > 0 && TERMINAL_MODEL_ERROR_PATTERN.test(stderr);
}

/** A permanent failure of this model/provider reference (stale id, unknown
 * provider, 404 config route). Skip same-candidate backoff, but keep advancing
 * through backup and current-main candidates. */
export function isPermanentModelCandidateError(result: SingleResult): boolean {
	const message = result.errorMessage?.trim();
	if (message) return PERMANENT_MODEL_CANDIDATE_ERROR_PATTERN.test(message);
	const stderr = result.stderr.trim();
	return stderr.length > 0 && PERMANENT_MODEL_CANDIDATE_ERROR_PATTERN.test(stderr);
}

export function isRetryableStartupFailure(result: SingleResult, durationMs: number): boolean {
	if (result.exitCode === 0) return false;
	if (result.stopReason === "aborted") return false;
	if (result.dispatchFailed) return false;
	if (result.errorMessage?.includes("idle timeout")) return false;
	if (getFinalOutput(result.messages)) return false;
	if (result.messages.length > 0) return false;
	const usage = result.usage;
	if (usage.turns || usage.input || usage.output || usage.cacheRead || usage.cacheWrite || usage.cost) return false;
	if (durationMs > MAX_SUBAGENT_STARTUP_FAILURE_DURATION_MS) return false;
	if (result.stderr.trim().length > 0) return false;
	if (result.errorMessage && result.errorMessage.trim().length > 0) return false;
	return true;
}

export function formatStartupRetryExhaustedError(model: string, attempts: number): string {
	return `Subagent failed to start after ${attempts} attempt${attempts === 1 ? "" : "s"} on ${model}: the child exited before any model, tool, output, or usage activity. This is typically a concurrent pi startup race (several sub-agents starting at once). Retry the dispatch, or temporarily lower maxConcurrency in /subagents-setup.`;
}

export async function waitForStartupRetry(delayMs: number, signal?: AbortSignal): Promise<boolean> {
	if (delayMs <= 0) return !signal?.aborted;
	if (!signal) {
		return new Promise<boolean>((resolve) => {
			const timer = setTimeout(() => resolve(true), delayMs);
			if (typeof timer.unref === "function") timer.unref();
		});
	}
	if (signal.aborted) return false;
	return new Promise<boolean>((resolve) => {
		let settled = false;
		const finish = (shouldRetry: boolean): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			signal.removeEventListener("abort", onAbort);
			resolve(shouldRetry);
		};
		const onAbort = (): void => finish(false);
		const timer = setTimeout(() => finish(true), delayMs);
		if (typeof timer.unref === "function") timer.unref();
		signal.addEventListener("abort", onAbort, { once: true });
	});
}

async function waitForControlledRetry(
	delayMs: number,
	signal: AbortSignal | undefined,
	control: RpcRunControl | undefined,
): Promise<boolean> {
	let remaining = delayMs;
	while (remaining > 0) {
		if (control?.isParkRequested() || control?.isStopRequested()) return false;
		const slice = Math.min(remaining, 50);
		if (!(await waitForStartupRetry(slice, signal))) return false;
		remaining -= slice;
	}
	return !signal?.aborted && !control?.isParkRequested() && !control?.isStopRequested();
}

export function getResultOutput(result: SingleResult): string {
	if (isFailedResult(result)) {
		const error = result.errorMessage || result.stderr;
		const partial = getFinalOutput(result.messages);
		if (error && partial) return `${error}\n\n--- Partial output ---\n${partial}`;
		return error || partial || "(no output)";
	}
	return getFinalOutput(result.messages) || "(no output)";
}

export function buildResumePrompt(task: string, reason: string): string {
	return `You are resuming an earlier sub-agent session after ${reason}. Your earlier work — searches, reads, edits, and reasoning — is preserved in this session's history above; review it before acting. Original task: ${task}. Pick up exactly where you left off and finish it. Do NOT redo searches, reads, or edits you already completed unless a step clearly failed. Continue now.`;
}

export function buildFallbackResumeReason(fromModel?: string): string {
	return fromModel
		? `the previous model (${fromModel}) failed at the model/provider level, so the next model in its configured pool is continuing`
		: "the previous model failed at the model/provider level, so the next model in its configured pool is continuing";
}

export interface RunSingleOptions {
	defaultCwd: string;
	agent: AgentConfig | undefined;
	agentName: string;
	task: string;
	cwd?: string;
	thinkingLevel?: ThinkingLevel;
	idleTimeoutMs?: number;
	startupRetryDelaysMs?: readonly number[];
	runLevelRetryDelaysMs?: readonly number[];
	sessionDir?: string;
	sessionId?: string;
	/** Initial RPC prompt. Kept under the old name to limit caller churn. */
	stdinText?: string;
	signal?: AbortSignal;
	onLive?: (event: SubagentLiveEvent) => void;
	makeDetails: (results: SingleResult[]) => SubagentDetails;
	env?: NodeJS.ProcessEnv;
	/** Stable logical-generation controller shared across retry attempts. */
	control?: RpcRunControl;
}

function controlledDisposition(options: RunSingleOptions, base?: SingleResult): SingleResult | undefined {
	const control = options.control;
	if (!control?.isParkRequested() && !control?.isStopRequested()) return undefined;
	const result: SingleResult = base ?? {
		agent: options.agentName,
		agentSource: options.agent?.source ?? "unknown",
		task: control.getObjective(),
		exitCode: 0,
		messages: [],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		model: options.agent?.model,
		thinking: options.thinkingLevel,
		sessionId: options.sessionId,
		sessionDir: options.sessionDir,
	};
	result.task = control.getObjective();
	if (control.isParkRequested()) {
		result.parked = true;
		result.exitCode = 0;
		result.stopReason = undefined;
		result.errorMessage = undefined;
	} else {
		result.parked = undefined;
		result.exitCode = 1;
		result.stopReason = "aborted";
		result.errorMessage = control.getStopMessage();
	}
	return result;
}

/** Spawn one RPC attempt and wait for stable settlement. */
export async function runSingleAgent(options: RunSingleOptions): Promise<SingleResult> {
	const {
		agent,
		agentName,
		thinkingLevel = SUBAGENT_THINKING_LEVEL,
		idleTimeoutMs = SUBAGENT_DEFAULT_IDLE_TIMEOUT_MS,
		control,
	} = options;
	if (!agent) {
		return {
			agent: agentName,
			agentSource: "unknown",
			task: options.task,
			exitCode: 1,
			messages: [],
			stderr: `Unknown agent: "${agentName}".`,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		};
	}

	const disposition = controlledDisposition(options);
	if (disposition) return disposition;
	const objective = control?.getObjective() ?? options.task;
	let prompt = options.stdinText ?? `Task: ${objective}`;
	if (control && objective !== options.task) {
		prompt = options.sessionDir && sessionExists(options.sessionDir, options.sessionId ?? "")
			? `Abandon the previous objective. New objective: ${objective}`
			: `Task: ${objective}`;
	}
	const result = await runRpcAgentAttempt({
		defaultCwd: options.defaultCwd,
		agent,
		agentName,
		task: objective,
		cwd: options.cwd,
		thinkingLevel,
		idleTimeoutMs,
		sessionDir: options.sessionDir,
		sessionId: options.sessionId,
		prompt,
		signal: options.signal,
		onLive: options.onLive,
		env: options.env,
		control,
	});
	result.task = control?.getObjective() ?? result.task;
	return result;
}

/**
 * Run one logical generation across an ordered model pool. Every candidate gets
 * startup retries plus same-model retries for transient provider failures;
 * terminal model errors skip those retries and advance immediately. All
 * candidates resume the same retained pi session.
 */
export async function runSingleAgentWithModelFallback(
	options: RunSingleOptions,
	fallbackModelRefs: readonly string[] = [],
): Promise<SingleResult> {
	const agent = options.agent;
	const launchedRef = agent?.model;
	const startupDelays = options.startupRetryDelaysMs ?? SUBAGENT_STARTUP_RETRY_DELAYS_MS;
	const runDelays = options.runLevelRetryDelaysMs ?? SUBAGENT_RUN_LEVEL_RETRY_DELAYS_MS;

	const sessionId = options.sessionId ?? randomUUID();
	const sessionDir = options.sessionDir ?? (await mkdtemp(join(tmpdir(), "pi-subagent-session-")));
	const baseOptions: RunSingleOptions = { ...options, sessionDir, sessionId };

	const dispatchFailure = async (error: unknown): Promise<SingleResult> => {
		const errorMessage = error instanceof Error ? error.message : String(error);
		const hasSession = sessionExists(sessionDir, sessionId);
		if (!hasSession && !options.sessionDir) {
			await rm(sessionDir, { recursive: true, force: true }).catch(() => undefined);
		}
		return {
			agent: options.agentName,
			agentSource: options.agent?.source ?? "unknown",
			task: options.control?.getObjective() ?? options.task,
			exitCode: 1,
			messages: [],
			stderr: errorMessage,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
			model: options.agent?.model,
			thinking: options.thinkingLevel,
			stopReason: "error",
			errorMessage,
			dispatchFailed: true,
			...(hasSession || options.sessionDir ? { sessionId, sessionDir } : {}),
		};
	};

	const runWithStartupRetry = async (opts: RunSingleOptions): Promise<SingleResult> => {
		let lastResult: SingleResult;
		let retries = 0;
		for (let attempt = 0; ; attempt++) {
			const immediate = controlledDisposition(opts);
			if (immediate) {
				if (immediate.parked && !options.sessionDir && !sessionExists(sessionDir, sessionId)) {
					await rm(sessionDir, { recursive: true, force: true }).catch(() => undefined);
					immediate.sessionId = undefined;
					immediate.sessionDir = undefined;
				}
				return immediate;
			}
			const start = Date.now();
			try {
				lastResult = await runSingleAgent(opts);
			} catch (error) {
				const failed = await dispatchFailure(error);
				return controlledDisposition(opts, failed) ?? failed;
			}
			const durationMs = Date.now() - start;
			const controlled = controlledDisposition(opts, lastResult);
			if (controlled) return controlled;
			if (lastResult.parked || lastResult.stopReason === "aborted") return lastResult;
			if (!isRetryableStartupFailure(lastResult, durationMs)) {
				if (retries > 0 && !isFailedResult(lastResult)) lastResult.startupRetries = retries;
				return lastResult;
			}
			const delay = startupDelays[attempt];
			if (delay === undefined) {
				lastResult.errorMessage = formatStartupRetryExhaustedError(
					lastResult.model ?? opts.agent?.model ?? "default",
					attempt + 1,
				);
				lastResult.stopReason ??= "error";
				lastResult.dispatchFailed = true;
				return lastResult;
			}
			opts.control?.markRetrying();
			try {
				opts.onLive?.({ kind: "status", status: "running" });
			} catch {
				/* never throw from event handling */
			}
			if (!(await waitForControlledRetry(delay, opts.signal, opts.control))) {
				return controlledDisposition(opts, lastResult) ?? lastResult;
			}
			retries++;
		}
	};

	const fallbackRefs: string[] = [];
	const seenRefs = new Set<string>();
	if (launchedRef?.trim()) seenRefs.add(launchedRef.trim());
	for (const candidate of fallbackModelRefs) {
		const ref = candidate.trim();
		if (!ref || seenRefs.has(ref)) continue;
		seenRefs.add(ref);
		fallbackRefs.push(ref);
	}

	const candidates: Array<{ agent: AgentConfig | undefined; ref?: string }> = [
		{ agent, ref: launchedRef?.trim() || undefined },
	];
	if (agent) {
		for (const ref of fallbackRefs) candidates.push({ agent: { ...agent, model: ref }, ref });
	}

	let modelRetries = 0;
	let fallbackUsed = false;
	let result: SingleResult | undefined;

	const finish = async (settled: SingleResult): Promise<SingleResult> => {
		const persistedSession = sessionExists(sessionDir, sessionId);
		if (!settled.dispatchFailed || persistedSession || options.sessionDir) {
			settled.sessionId ??= sessionId;
			settled.sessionDir ??= sessionDir;
		} else {
			await rm(sessionDir, { recursive: true, force: true }).catch(() => undefined);
			settled.sessionId = undefined;
			settled.sessionDir = undefined;
		}
		settled.task = options.control?.getObjective() ?? settled.task;
		if (fallbackUsed && launchedRef) settled.modelFallbackFrom = launchedRef;
		settled.modelRetries = modelRetries;
		options.control?.markSettled();
		return settled;
	};

	for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex++) {
		const candidate = candidates[candidateIndex];
		fallbackUsed ||= candidateIndex > 0;
		const previousModel = result?.model ?? candidates[candidateIndex - 1]?.ref;
		const candidateOptions: RunSingleOptions = {
			...baseOptions,
			agent: candidate.agent,
			...(candidateIndex > 0
				? {
					stdinText: buildResumePrompt(
						options.control?.getObjective() ?? options.task,
						buildFallbackResumeReason(previousModel),
					),
				}
				: {}),
		};
		try {
			options.onLive?.({
				kind: "model",
				model: candidate.ref,
				...(candidateIndex > 0 && launchedRef ? { fallbackFrom: launchedRef } : {}),
			});
		} catch {
			/* never throw from event handling */
		}

		result = await runWithStartupRetry(candidateOptions);
		if (result.parked || result.stopReason === "aborted") return result;
		if (!isModelLevelFailure(result)) return finish(result);

		if (!isTerminalModelError(result) && !isPermanentModelCandidateError(result)) {
			const retryOptions: RunSingleOptions = {
				...candidateOptions,
				stdinText: buildResumePrompt(
					options.control?.getObjective() ?? options.task,
					"a transient provider error on the same model",
				),
			};
			for (const delay of runDelays) {
				baseOptions.control?.markRetrying();
				try {
					options.onLive?.({ kind: "status", status: "running" });
				} catch {
					/* never throw from event handling */
				}
				if (!(await waitForControlledRetry(delay, options.signal, options.control))) {
					return controlledDisposition(baseOptions, result) ?? result;
				}
				result = await runWithStartupRetry(retryOptions);
				modelRetries++;
				if (result.parked || result.stopReason === "aborted") return result;
				if (
					!isModelLevelFailure(result) ||
					isTerminalModelError(result) ||
					isPermanentModelCandidateError(result)
				) break;
			}
		}

		if (!isModelLevelFailure(result)) return finish(result);
		// Transient exhaustion plus terminal/permanent candidate errors advance
		// to the next configured candidate. Ordinary task/tool failures returned above.
	}

	return finish(result ?? (await dispatchFailure("No model candidate was attempted.")));
}
