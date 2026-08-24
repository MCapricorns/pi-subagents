/**
 * Sub-agent result handling and resilient RPC launch orchestration.
 *
 * The process transport itself lives in rpc-run.ts. Each attempt starts pi in
 * persistent `--mode rpc`, sends commands over strict LF-delimited JSONL, and
 * settles only on `agent_settled`. This module owns startup-race recovery,
 * selected-to-main model handoff, capability-clamped thinking, accounting, and
 * result formatting around those attempts.
 */

import { createHash, randomUUID } from "node:crypto";
import { type Dirent, mkdirSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import type { AgentConfig } from "./agents.ts";
import { DEFAULT_THINKING_LEVEL, type ThinkingLevel } from "./config.ts";
import {
	currentSubagentDepth,
	DEPTH_ENV_VAR,
	emptyUsage,
	extractToolErrorText,
	getPiInvocation,
	isRpcCommandTimeoutError,
	RpcRunControl,
	runRpcAgentAttempt,
	sessionExists,
	writeChildRetryPolicyExtension,
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
	isRpcCommandTimeoutError,
	RpcRunControl,
	sessionExists,
	SUBAGENT_KILL_GRACE_MS,
	writeChildRetryPolicyExtension,
};
export type { SubagentLiveEvent, UsageStats };

export const SUBAGENT_THINKING_LEVEL: ThinkingLevel = DEFAULT_THINKING_LEVEL;
/** 0 disables the watchdog; dispatch supplies the configured timeout. */
export const SUBAGENT_DEFAULT_IDLE_TIMEOUT_MS = 0;
/** Base delays cover Pi's stale-lock window and leave headroom beyond the
 * default four-way launch fan-out. Additive jitter below reduces the chance
 * that contenders retry in the same lockstep waves. */
export const SUBAGENT_STARTUP_RETRY_DELAYS_MS = [250, 750, 1500, 3000, 6000] as const;
export const MAX_SUBAGENT_STARTUP_FAILURE_DURATION_MS = 2000;
export const MAX_SUBAGENT_STARTUP_RETRY_JITTER_MS = 1000;

function normalizeStartupRetryDelay(delayMs: number): number {
	return Number.isFinite(delayMs) && delayMs > 0 ? delayMs : 0;
}

export function addStartupRetryJitter(delayMs: number, randomValue = Math.random()): number {
	const baseDelay = Math.floor(normalizeStartupRetryDelay(delayMs));
	if (baseDelay === 0) return 0;
	const boundedRandom = Number.isFinite(randomValue) ? Math.max(0, Math.min(1, randomValue)) : 0;
	return baseDelay + Math.floor(Math.min(baseDelay, MAX_SUBAGENT_STARTUP_RETRY_JITTER_MS) * boundedRandom);
}

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

export const RESULT_ARTIFACT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1_000;
export const RESULT_ARTIFACT_MAX_FILES_PER_PROJECT = 50;
// Explicit current prefix plus the strict timestamp/token convention used by 1.1.0.
const RESULT_ARTIFACT_NAME = /^(?:pi-subagent-\d{13,}-[0-9a-f]{12}|\d{13,}-[a-z0-9]{6})-[\w.-]+\.md$/;

interface ResultArtifactRetentionOptions {
	now?: number;
	maxAgeMs?: number;
	maxFilesPerProject?: number;
}

/** Remove only stale/overflow Markdown result artifacts. Unknown files and
 * symlinks are never touched. Called on each artifact write, so storage stays
 * bounded without deleting a result that the current completion just linked. */
export function pruneResultArtifacts(
	rootDir: string = join(tmpdir(), "pi-subagents-results"),
	options: ResultArtifactRetentionOptions = {},
): void {
	const now = options.now ?? Date.now();
	const maxAgeMs = Math.max(0, options.maxAgeMs ?? RESULT_ARTIFACT_MAX_AGE_MS);
	const maxFiles = Math.max(0, Math.floor(options.maxFilesPerProject ?? RESULT_ARTIFACT_MAX_FILES_PER_PROJECT));
	let projects: Dirent[];
	try {
		projects = readdirSync(rootDir, { withFileTypes: true });
	} catch {
		return;
	}

	for (const project of projects) {
		if (!project.isDirectory() || project.isSymbolicLink()) continue;
		const projectDir = join(rootDir, project.name);
		let entries: Dirent[];
		try {
			entries = readdirSync(projectDir, { withFileTypes: true });
		} catch {
			continue;
		}
		const artifacts = entries
			.filter((entry) => entry.isFile() && !entry.isSymbolicLink() && RESULT_ARTIFACT_NAME.test(entry.name))
			.flatMap((entry) => {
				const path = join(projectDir, entry.name);
				try {
					return [{ path, mtimeMs: statSync(path).mtimeMs }];
				} catch {
					return [];
				}
			})
			.sort((left, right) => right.mtimeMs - left.mtimeMs);

		for (const [index, artifact] of artifacts.entries()) {
			if (index < maxFiles && now - artifact.mtimeMs <= maxAgeMs) continue;
			try {
				rmSync(artifact.path, { force: true });
			} catch {
				// Temp cleanup is best-effort; result delivery must still succeed.
			}
		}
	}
}

export function resultArtifactProjectKey(cwd?: string): string {
	if (!cwd) return "default";
	let canonical: string;
	try {
		canonical = realpathSync.native(cwd);
	} catch {
		canonical = resolve(cwd);
	}
	if (process.platform === "win32") canonical = canonical.toLowerCase();
	const slug = basename(canonical).replace(/[^\w.-]+/g, "_") || "project";
	const digest = createHash("sha256").update(canonical).digest("hex").slice(0, 12);
	return `${slug}-${digest}`;
}

export function writeResultArtifact(output: string, agentName: string, cwd?: string): string {
	const rootDir = join(tmpdir(), "pi-subagents-results");
	const dir = join(rootDir, resultArtifactProjectKey(cwd));
	mkdirSync(dir, { recursive: true });
	const safeName = agentName.replace(/[^\w.-]+/g, "_") || "agent";
	const unique = `pi-subagent-${Date.now()}-${randomUUID().replaceAll("-", "").slice(0, 12)}`;
	const filePath = join(dir, `${unique}-${safeName}.md`);
	writeFileSync(filePath, output, "utf8");
	pruneResultArtifacts(rootDir);
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

export function isModelLevelFailure(result: SingleResult): boolean {
	if (!isFailedResult(result)) return false;
	if (result.stopReason === "aborted") return false;
	if (result.dispatchFailed) return false;
	if (result.rpcStartupFailed) return false;
	if (isRpcCommandTimeoutError(result.errorMessage)) return false;
	if (result.integrationStatus === "retained") return false;
	if (result.errorMessage?.includes("idle timeout")) return true;
	if (result.rpcPromptRejected) return true;

	// Classification belongs to the final assistant turn, not the whole attempt.
	// Earlier useful text or failed tool calls are retained session history and
	// must not hide a later provider error (for example a second-turn 503).
	const finalAssistant = lastAssistantMessage(result.messages);
	if (finalAssistant) {
		// Provider streams may preserve partial text on a terminal error. The stop
		// reason, not content emptiness, is the transport boundary; ordinary tool or
		// task failures settle with a non-error assistant stop reason.
		return finalAssistant.stopReason === "error";
	}

	if ((result.failedTools?.length ?? 0) > 0) return false;
	// No accepted prompt, no activity, and no assistant turn means the provider
	// was never reached. Stderr or an exit error here is a startup/transport miss.
	if (!result.rpcPromptAccepted && !result.rpcActivity) return false;
	return Boolean(
		result.rpcPromptAccepted ||
		result.rpcActivity ||
		result.errorMessage?.trim() ||
		result.stderr.trim(),
	);
}

export function isRetryableStartupFailure(result: SingleResult, durationMs: number): boolean {
	if (result.exitCode === 0) return false;
	if (result.stopReason === "aborted") return false;
	if (result.dispatchFailed) return false;
	if (result.rpcPromptDispatched || result.rpcPromptAccepted || result.rpcActivity) return false;
	if (result.errorMessage?.includes("idle timeout")) return false;
	if (getFinalOutput(result.messages)) return false;
	if (result.messages.length > 0) return false;
	const usage = result.usage;
	if (usage.turns || usage.input || usage.output || usage.cacheRead || usage.cacheWrite || usage.cost) return false;
	if (result.rpcStartupFailed) return true;
	if (durationMs > MAX_SUBAGENT_STARTUP_FAILURE_DURATION_MS) return false;
	if (result.stderr.trim().length > 0) return false;
	if (result.errorMessage && result.errorMessage.trim().length > 0) return false;
	return true;
}

export function formatStartupRetryExhaustedError(model: string, attempts: number): string {
	return `Subagent failed to start after ${attempts} attempt${attempts === 1 ? "" : "s"} on ${model}: the child failed before its initial RPC prompt was dispatched and produced no model, tool, output, or usage activity. This is typically a concurrent pi startup race (several sub-agents starting at once). Retry the dispatch, or temporarily lower maxConcurrency in /subagents-setup.`;
}

export async function waitForStartupRetry(delayMs: number, signal?: AbortSignal): Promise<boolean> {
	const normalizedDelay = normalizeStartupRetryDelay(delayMs);
	if (normalizedDelay === 0) return !signal?.aborted;
	if (!signal) {
		return new Promise<boolean>((resolve) => {
			const timer = setTimeout(() => resolve(true), normalizedDelay);
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
		const timer = setTimeout(() => finish(true), normalizedDelay);
		if (typeof timer.unref === "function") timer.unref();
		signal.addEventListener("abort", onAbort, { once: true });
	});
}

async function waitForControlledRetry(
	delayMs: number,
	signal: AbortSignal | undefined,
	control: RpcRunControl | undefined,
): Promise<boolean> {
	let remaining = normalizeStartupRetryDelay(delayMs);
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
		? `the selected model (${fromModel}) failed at the model/provider level, so the current main model is continuing`
		: "the selected model failed at the model/provider level, so the current main model is continuing";
}

export interface RunSingleOptions {
	defaultCwd: string;
	agent: AgentConfig;
	agentName: string;
	task: string;
	cwd?: string;
	thinkingLevel?: ThinkingLevel;
	/** Resolve the effective level for each runtime model candidate. */
	thinkingLevelForModel?: (modelRef?: string) => ThinkingLevel;
	idleTimeoutMs?: number;
	startupRetryDelaysMs?: readonly number[];
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
	rpcReadyTimeoutMs?: number;
	rpcCommandTimeoutMs?: number;
}

function controlledDisposition(options: RunSingleOptions, base?: SingleResult): SingleResult | undefined {
	const control = options.control;
	if (!control?.isParkRequested() && !control?.isStopRequested()) return undefined;
	const result: SingleResult = base ?? {
		agent: options.agentName,
		task: control.getObjective(),
		exitCode: 0,
		messages: [],
		stderr: "",
		usage: emptyUsage(),
		model: options.agent.model,
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

function signalAbortDisposition(options: RunSingleOptions, base: SingleResult): SingleResult | undefined {
	if (!options.signal?.aborted) return undefined;
	base.parked = undefined;
	base.exitCode = 1;
	base.stopReason = "aborted";
	base.errorMessage = "Subagent was aborted";
	return base;
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
		rpcReadyTimeoutMs: options.rpcReadyTimeoutMs,
		rpcCommandTimeoutMs: options.rpcCommandTimeoutMs,
	});
	result.task = control?.getObjective() ?? result.task;
	return result;
}

/**
 * Run one logical generation on the selected model, then hand directly to the
 * current main model after any model/provider-level failure. Startup-race retries
 * remain process-level recovery; provider/model retries and extra candidates do not.
 * Both attempts resume the same retained Pi session.
 */
export async function runSingleAgentWithMainFallback(
	options: RunSingleOptions,
	mainFallbackRef?: string,
): Promise<SingleResult> {
	const agent = options.agent;
	const launchedRef = agent?.model;
	const customStartupDelays = options.startupRetryDelaysMs;
	const startupDelays = customStartupDelays ?? SUBAGENT_STARTUP_RETRY_DELAYS_MS;

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
			task: options.control?.getObjective() ?? options.task,
			exitCode: 1,
			messages: [],
			stderr: errorMessage,
			usage: emptyUsage(),
			model: options.agent.model,
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
					lastResult.model ?? opts.agent.model ?? "default",
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
			const retryDelay = customStartupDelays ? delay : addStartupRetryJitter(delay);
			if (!(await waitForControlledRetry(retryDelay, opts.signal, opts.control))) {
				return controlledDisposition(opts, lastResult) ?? signalAbortDisposition(opts, lastResult) ?? lastResult;
			}
			retries++;
		}
	};

	const selectedRef = launchedRef?.trim() || undefined;
	const normalizedMainRef = mainFallbackRef?.trim() || undefined;
	const candidates: Array<{ agent: AgentConfig; ref?: string }> = [
		{ agent, ref: selectedRef },
	];
	if (normalizedMainRef && normalizedMainRef !== selectedRef) {
		candidates.push({ agent: { ...agent, model: normalizedMainRef }, ref: normalizedMainRef });
	}

	let fallbackUsed = false;
	let result: SingleResult | undefined;
	const priorFailedTools: NonNullable<SingleResult["failedTools"]> = [];
	const priorUsage = emptyUsage();

	const retainAttemptDiagnostics = (attempt: SingleResult): void => {
		priorFailedTools.push(...(attempt.failedTools ?? []));
		priorUsage.input += attempt.usage.input;
		priorUsage.output += attempt.usage.output;
		priorUsage.cacheRead += attempt.usage.cacheRead;
		priorUsage.cacheWrite += attempt.usage.cacheWrite;
		priorUsage.cost += attempt.usage.cost;
		priorUsage.turns += attempt.usage.turns;
		priorUsage.contextTokens = attempt.usage.contextTokens || priorUsage.contextTokens;
	};

	const finish = async (settled: SingleResult): Promise<SingleResult> => {
		if (priorFailedTools.length > 0) {
			settled.failedTools = [...priorFailedTools, ...(settled.failedTools ?? [])];
		}
		if (
			priorUsage.turns || priorUsage.input || priorUsage.output || priorUsage.cacheRead ||
			priorUsage.cacheWrite || priorUsage.cost || priorUsage.contextTokens
		) {
			settled.usage = {
				input: priorUsage.input + settled.usage.input,
				output: priorUsage.output + settled.usage.output,
				cacheRead: priorUsage.cacheRead + settled.usage.cacheRead,
				cacheWrite: priorUsage.cacheWrite + settled.usage.cacheWrite,
				cost: priorUsage.cost + settled.usage.cost,
				turns: priorUsage.turns + settled.usage.turns,
				contextTokens: settled.usage.contextTokens || priorUsage.contextTokens,
			};
		}
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
		options.control?.markSettled();
		return settled;
	};

	for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex++) {
		const candidate = candidates[candidateIndex];
		fallbackUsed ||= candidateIndex > 0;
		const previousModel = result?.model ?? candidates[candidateIndex - 1]?.ref;
		const candidateThinking = options.thinkingLevelForModel?.(candidate.ref) ?? options.thinkingLevel;
		const candidateOptions: RunSingleOptions = {
			...baseOptions,
			agent: candidate.agent,
			thinkingLevel: candidateThinking,
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
				thinking: candidateThinking,
				...(candidateIndex > 0 && launchedRef ? { fallbackFrom: launchedRef } : {}),
			});
		} catch {
			/* never throw from event handling */
		}

		result = await runWithStartupRetry(candidateOptions);
		if (result.parked || result.stopReason === "aborted") return finish(result);
		if (!isModelLevelFailure(result)) return finish(result);
		// Any model-level failure advances immediately to the sole fallback (the
		// current main model). Retain selected-attempt tool diagnostics and usage;
		// ordinary task/tool failures returned above without a handoff.
		if (candidateIndex < candidates.length - 1) retainAttemptDiagnostics(result);
	}

	return finish(result!);
}
