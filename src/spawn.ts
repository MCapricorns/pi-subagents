/**
 * Sub-agent dispatch: each agent runs as an isolated `pi` child process
 * (`--mode json -p --no-session`). The agent's system prompt (the .md body) is
 * written to a temp file and passed via `--append-system-prompt` (which accepts a
 * file path). The task itself is sent through the child's stdin pipe, not another
 * temp file or command-line argument. Child stdout is a JSON-lines event stream;
 * we accumulate assistant messages from `message_end` events.
 *
 * Adapted from the official pi example `examples/extensions/subagent`.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, unlinkSync, rmdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { Message } from "@earendil-works/pi-ai";
import type { AgentConfig, AgentSource } from "./agents.ts";
import { DEFAULT_THINKING_LEVEL, type ThinkingLevel } from "./config.ts";

/**
 * Limits are configurable: see maxConcurrency in config.ts (default 4, via
 * /subagents-setup or pi-subagents.json).
 */
/** Default thinking level for sub-agents. pi clamps it to the resolved model's support. */
export const SUBAGENT_THINKING_LEVEL: ThinkingLevel = DEFAULT_THINKING_LEVEL;
export const DEPTH_ENV_VAR = "PI_SUBAGENT_DEPTH";
export const SUBAGENT_KILL_GRACE_MS = 5_000;
/** Default idle watchdog: terminate a child whose stdout goes silent for this
 * many milliseconds. 0 disables it. The actual value comes from config
 * (idleTimeoutSec); this constant is only a fallback for tests. */
export const SUBAGENT_DEFAULT_IDLE_TIMEOUT_MS = 0;

/** Backoff schedule for retrying a child that exited before any model or tool
 * activity — the signature of a concurrent pi startup race, where several
 * sub-agents contending for pi's startup lock lose and exit with nothing on
 * stdout. Bounded and short so persistent launch failures are not amplified
 * while the startup lock clears. */
export const SUBAGENT_STARTUP_RETRY_DELAYS_MS = [250, 750, 1500] as const;
/** A genuine startup race fails well before a model request can complete. */
export const MAX_SUBAGENT_STARTUP_FAILURE_DURATION_MS = 2000;

/** Backoff schedule (ms) for retrying a run whose configured model failed at the
 * provider level with a TRANSIENT error (503/429/timeout/network/overloaded/...) —
 * i.e. NOT a terminal error (quota exhausted, billing, invalid API key). The same
 * model is relaunched (each relaunch gets its own startup-retry inner loop), so a
 * one-off provider hiccup recovers without demoting the configured agent model.
 *
 * This sits OUTSIDE pi-ai's per-request provider retry (default 3 attempts, 2/4/8s
 * backoff): when the provider still can't recover after its own retries, the
 * child exits carrying the final error, and this layer relaunches the whole run
 * up to len(delays) more times before falling back to the main-window model.
 *
 * Bounded and capped so a stubborn outage does not stall a dispatch forever. */
export const SUBAGENT_RUN_LEVEL_RETRY_DELAYS_MS = [2_000, 4_000, 8_000, 16_000, 30_000] as const;

export interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

export interface SingleResult {
	agent: string;
	agentSource: AgentSource | "unknown";
	task: string;
	exitCode: number; // -1 = still running
	messages: Message[];
	stderr: string;
	usage: UsageStats;
	model?: string;
	/** Effective thinking strength this run was launched with. */
	thinking?: string;
	stopReason?: string;
	errorMessage?: string;
	/** Model the run degraded from: set when a failed run was retried with the main-window model. */
	modelFallbackFrom?: string;
	/** True when the result was synthesized from a thrown exception (spawn infra,
	 * temp-file/fs errors, delivery bugs) instead of being produced by the agent
	 * process. A dispatch failure is never a model-level failure. */
	dispatchFailed?: boolean;
	/** How many times the run was relaunched after a silent, zero-activity startup
	 * exit (a concurrent pi startup race) before it produced a result. Set only when
	 * the run actually recovered after retrying, so callers can surface it. */
	startupRetries?: number;
	/** How many times the SAME configured model was relaunched after a transient
	 * provider-level failure (503/429/timeout/network/...) before the run produced
	 * a result. Set on recovery and on fall-back to the main-window model; left
	 * undefined for a terminal (quota/billing/invalid-key) error that short-
	 * circuits before any retry, since no relaunch happened. */
	modelRetries?: number;
	/** Tool calls that failed inside the run (from tool_execution_end events). A
	 * clean process exit can still hide a failed build/test/tool — the completion
	 * message must surface these so the main agent is never misled by a rosy final
	 * text (e.g. a worker that ended with "keep waiting" while its build failed). */
	failedTools?: Array<{ toolName: string; error: string }>;
	/** The pi session id this run used (every run is session-backed so a
	 * model-level failure can be resumed on another model without re-scanning). */
	sessionId?: string;
	/** Directory holding the run's pi session file. Preserved across the initial
	 * attempt and any resume attempts; kept on disk only when a model-level
	 * failure is handed back, so a later `resume` can pick up the context. */
	sessionDir?: string;
	/** True when the result was produced by resuming an earlier session (a
	 * model-level fallback or an explicit resume) rather than a fresh start. */
	resumed?: boolean;
}

export interface SubagentDetails {
	mode: "single" | "parallel";
	results: SingleResult[];
	/** The tool returned immediately while the child process continues in the background. */
	background?: boolean;
}

export type SubagentLiveEvent =
	| { kind: "status"; status: "queued" | "running" | "done" | "failed" }
	| { kind: "usage"; usage: UsageStats; model?: string }
	| { kind: "tool_start"; toolName: string; args: unknown }
	| { kind: "tool_end"; toolName: string; isError: boolean }
	| { kind: "thinking" }
	| { kind: "text" };

function emptyUsage(): UsageStats {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
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

/**
 * Parse the machine-readable verdict a reviewer emits (see agents/reviewer.md).
 * Only the LAST standalone `VERDICT: REVIEW_PASS/FAIL` line counts, so a report
 * that merely discusses the tokens cannot be misclassified. Returns undefined
 * when no verdict marker is present, so non-review agents are never mistaken
 * for reviews.
 */
export function reviewVerdict(output: string): "pass" | "fail" | undefined {
	const lines = output.split("\n");
	for (let index = lines.length - 1; index >= 0; index--) {
		const match = /^\s*VERDICT:\s*REVIEW_(PASS|FAIL)\s*$/i.exec(lines[index]);
		if (match) return match[1].toUpperCase() === "PASS" ? "pass" : "fail";
	}
	return undefined;
}

/** Tool errors are usually the trailing lines of a long output (build logs);
 * keep the last non-empty lines, clipped to RESULT_LINE_MAX each. */
export function extractToolErrorText(content: unknown): string {
	const parts = Array.isArray(content) ? content : [];
	const text = parts
		.filter(
			(part): part is { type: "text"; text: string } =>
				typeof part === "object" &&
				part !== null &&
				(part as { type?: unknown }).type === "text" &&
				typeof (part as { text?: unknown }).text === "string",
		)
		.map((part) => part.text)
		.join("\n");
	return text
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean)
		.slice(-3)
		.map((line) => (line.length > RESULT_LINE_MAX ? `${line.slice(0, RESULT_LINE_MAX)}…` : line))
		.join("\n");
}

/** Hard cap for a single line inside a truncated result (minified blobs must not blow up). */
export const RESULT_LINE_MAX = 200;

export interface TruncatedOutput {
	/** The result text that fits in the completion message. */
	text: string;
	/** True when lines were dropped or shortened, so the full text is written to disk. */
	truncated: boolean;
}

/** Cap result text for the main conversation: keep the first `maxLines` lines, at most RESULT_LINE_MAX chars each. */
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

/** Persist the full result where the main agent can read it on demand. Returns the file path.
 * Results are grouped under a per-project subdirectory so concurrent projects don't
 * litter a single flat folder. */
export function writeResultArtifact(output: string, agentName: string, cwd?: string): string {
	const projectSlug = cwd
		? basename(cwd).replace(/[^\w.-]+/g, "_") || "default"
		: "default";
	const dir = join(tmpdir(), "pi-subagents-results", projectSlug);
	mkdirSync(dir, { recursive: true });
	const safeName = agentName.replace(/[^\w.-]+/g, "_");
	// A random suffix keeps same-millisecond writes from clobbering each other.
	const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
	const filePath = join(dir, `${unique}-${safeName}.md`);
	writeFileSync(filePath, output, "utf8");
	return filePath;
}

export function isFailedResult(result: SingleResult): boolean {
	return result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
}

/**
 * True when a failed run never got usable output from its model: the provider
 * rejected the call before the model produced any text (bad model id, auth,
 * thinking level, quota, ...). Task-level failures — the model worked and the
 * task failed — and aborts/timeouts are NOT model-level and must not degrade.
 */
export function isModelLevelFailure(result: SingleResult): boolean {
	if (!isFailedResult(result)) return false;
	if (result.stopReason === "aborted") return false;
	// A result synthesized from a thrown exception (spawn infra, fs, delivery
	// bugs) never came from the provider: it is a dispatch failure, not a
	// model-level one, and must not be handed back as a model problem.
	if (result.dispatchFailed) return false;
	// An idle timeout (stdout went silent) signals a stalled provider connection,
	// not a task-level failure: allow model fallback even if the model produced
	// partial output before going quiet.
	if (result.errorMessage?.includes("idle timeout")) return true;
	// The model produced text: the failure belongs to the task, not the model.
	if (getFinalOutput(result.messages)) return false;
	// Require evidence the failure came from the model/provider (an error
	// message or stderr), not from the child process failing to start.
	return result.messages.length > 0 || result.stderr.trim().length > 0;
}

/** Patterns that signal a TERMINAL provider/account error: retrying the same
 * model (or falling back to the main-window model under the same account) cannot
 * fix it, so the run skips both run-level retry and model fallback and is handed
 * back to the main agent. This is the complement of pi-ai's transient-error set
 * (429/5xx/overloaded/network/timeout/...): anything NOT matching here is treated
 * as transient and retried on the same model before degrading.
 *
 * Mirrors pi-ai's NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN (quota/billing/
 * subscription-limit text) and adds the auth/credential failures the user cited
 * ("key无效"). Auth is account-scoped, so a fallback model on the same provider
 * would fail identically — hand it to the main agent immediately. */
const TERMINAL_MODEL_ERROR_PATTERN =
	/insufficient_quota|quota\s+exceeded|exceeded[^.\n]{0,40}quota|out\s+of\s+budget|billing|usage\s+limit|usage_limit|gousagelimiterror|freeusagelimiterror|monthly\s+usage\s+limit\s+reached|available\s+balance|invalid\s+(?:api\s+)?key|incorrect\s+api\s+key|unauthori[sz]ed|\b401\b|\b403\b|forbidden|permission\s+denied/i;

/** True when a model-level failure carries a TERMINAL error message — quota
 * exhaustion, billing, an invalid API key, auth rejection. Such a run is NEVER
 * retried on the same model and never falls back to the main-window model: the
 * account is the bottleneck, so it is handed back to the main agent to fix.
 *
 * Caller must first confirm `isModelLevelFailure(result)` — aborts and
 * dispatch-crafted results never reach this classifier. */
export function isTerminalModelError(result: SingleResult): boolean {
	const message = result.errorMessage?.trim();
	if (message) return TERMINAL_MODEL_ERROR_PATTERN.test(message);
	// Only consult stderr when there is no structured errorMessage: pi-ai surfaces
	// provider errors via message_end -> errorMessage, so a transient errorMessage
	// (e.g. "503 Service Unavailable") must not be overridden by noisy stderr that
	// happens to mention a terminal-looking word (an npm warning, a proxy banner).
	// This keeps transient failures retryable even when stderr is chatty.
	const stderr = result.stderr.trim();
	return stderr.length > 0 && TERMINAL_MODEL_ERROR_PATTERN.test(stderr);
}

/**
 * True when a failed run produced NO model, tool, output, or usage activity
 * within the startup window — the signature of a concurrent pi startup race,
 * where the child lost pi's startup lock and exited before doing anything.
 * Such a run is safe to relaunch: nothing was mutated and no provider call
 * completed, so retrying cannot duplicate work.
 *
 * Fails closed: any final output, assistant message, usage, stderr, structured
 * error message, idle-timeout, abort, dispatch crash, or run that outlived the
 * startup window disqualifies the run from retry (it either did real work or
 * carries a real error that belongs to model fallback / normal failure
 * delivery instead). Only a clean, SILENT, fast, zero-activity exit retries.
 */
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
	// Any stderr or structured error could be a real provider/config error (auth,
	// bad model id, quota, ...) that must not be amplified by retry. A silent
	// zero-activity exit — no stdout, no stderr, no error message — is the race.
	if (result.stderr.trim().length > 0) return false;
	if (result.errorMessage && result.errorMessage.trim().length > 0) return false;
	return true;
}

/** Error surfaced when every startup-retry attempt still exited with no
 * activity. Tells the main agent the dispatch never reached a model and what to
 * do (retry, or lower maxConcurrency). */
export function formatStartupRetryExhaustedError(model: string, attempts: number): string {
	return `Subagent failed to start after ${attempts} attempt${attempts === 1 ? "" : "s"} on ${model}: the child exited before any model, tool, output, or usage activity. This is typically a concurrent pi startup race (several sub-agents starting at once). Retry the dispatch, or temporarily lower maxConcurrency in /subagents-setup.`;
}

/** Wait out a startup-retry backoff. Resolves false immediately (do not retry)
 * when the signal is or becomes aborted during the wait, so cancellation never
 * delays delivering the last result. The timer is unref'd so it cannot keep the
 * event loop alive on shutdown. */
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

export function getResultOutput(result: SingleResult): string {
	if (isFailedResult(result)) {
		const error = result.errorMessage || result.stderr;
		const partial = getFinalOutput(result.messages);
		if (error && partial) return `${error}\n\n--- Partial output ---\n${partial}`;
		return error || partial || "(no output)";
	}
	return getFinalOutput(result.messages) || "(no output)";
}

/**
 * True when a pi session file for `sessionId` already exists in `sessionDir`.
 * Every sub-agent run is session-backed; the FIRST attempt creates the session
 * (`--session-id`) and every later attempt on the same session RESUMES it
 * (`--session`), so a model-level retry or fallback picks up the prior context
 * instead of re-scanning. The session file is named `<timestamp>Z_<id>.jsonl`
 * (pi's convention), so a suffix match is exact and cheap.
 */
export function sessionExists(sessionDir: string, sessionId: string): boolean {
	try {
		return readdirSync(sessionDir).some((file) => file.endsWith(`_${sessionId}.jsonl`));
	} catch {
		return false;
	}
}

/**
 * Build the continuation prompt sent to a RESUMED sub-agent session. The model
 * sees the full prior history (loaded by `--session`) plus this new user turn,
 * so it continues from where it stopped. Steering it not to redo finished work
 * is what saves the re-scan the user wants to avoid.
 *
 * `reason` is a short clause describing why the session is resuming
 * ("a transient provider error" / "your previous model hit a quota or auth
 * limit, so a different model is now continuing").
 */
export function buildResumePrompt(task: string, reason: string): string {
	return `You are resuming an earlier sub-agent session after ${reason}. Your earlier work — searches, reads, edits, and reasoning — is preserved in this session's history above; review it before acting. Original task: ${task}. Pick up exactly where you left off and finish it. Do NOT redo searches, reads, or edits you already completed unless a step clearly failed. Continue now.`;
}

/** Reason clause for resuming on a DIFFERENT model after the configured model
 * failed at the provider level (quota/auth/overloaded/...). */
export function buildFallbackResumeReason(fromModel?: string): string {
	return fromModel
		? `your previous model (${fromModel}) hit a quota, billing, or auth limit, so a different model is now continuing`
		: "your previous model became unavailable, so a different model is now continuing";
}

async function writePromptToTempFile(agentName: string, prompt: string): Promise<{ dir: string; filePath: string }> {
	const dir = await mkdtemp(join(tmpdir(), "pi-subagents-"));
	const safeName = agentName.replace(/[^\w.-]+/g, "_");
	const filePath = join(dir, `prompt-${safeName}.md`);
	await writeFile(filePath, prompt, "utf8");
	return { dir, filePath };
}

/** Resolve how to invoke the SAME pi build as the current process. */
export function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}
	const execName = basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) return { command: process.execPath, args };
	return { command: "pi", args };
}

/** Terminate the child and any tool processes it left behind. */
function terminateProcessTree(proc: ChildProcess, force: boolean): void {
	if (process.platform === "win32" && proc.pid !== undefined) {
		const killer = spawn("taskkill", ["/pid", String(proc.pid), "/t", "/f"], {
			stdio: "ignore",
			windowsHide: true,
		});
		const fallback = (): void => {
			try {
				proc.kill(force ? "SIGKILL" : "SIGTERM");
			} catch {
				/* process may already be gone */
			}
		};
		killer.on("error", fallback);
		killer.on("close", (code) => {
			if (code !== 0) fallback();
		});
		return;
	}

	try {
		proc.kill(force ? "SIGKILL" : "SIGTERM");
	} catch {
		/* process may already be gone */
	}
}

export function currentSubagentDepth(env: NodeJS.ProcessEnv = process.env): number {
	const raw = env[DEPTH_ENV_VAR];
	const parsed = raw === undefined ? 0 : Number.parseInt(raw, 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

export interface RunSingleOptions {
	defaultCwd: string;
	agent: AgentConfig | undefined;
	agentName: string;
	task: string;
	cwd?: string;
	/** Thinking level passed to the child pi process. */
	thinkingLevel?: ThinkingLevel;
	/** Idle timeout in ms: terminate the child if its stdout produces no activity
	 * for this duration. 0 (the default) disables the idle watchdog. */
	idleTimeoutMs?: number;
	/** Startup-retry backoff schedule (ms) for silent, zero-activity child exits
	 * (a concurrent pi startup race). Defaults to SUBAGENT_STARTUP_RETRY_DELAYS_MS;
	 * pass a shorter array in tests to keep them fast. */
	startupRetryDelaysMs?: readonly number[];
	/** Run-level backoff schedule (ms) for relaunching the SAME configured model
	 * after a transient provider-level failure (503/429/timeout/network/...). Each
	 * relaunch gets its own startup-retry inner loop. Defaults to
	 * SUBAGENT_RUN_LEVEL_RETRY_DELAYS_MS; pass [] to disable (e.g. when an isolated
	 * test wants to assert only the fallback path runs once). */
	runLevelRetryDelaysMs?: readonly number[];
	/** Directory holding this run's pi session. When set (with sessionId), the
	 * child is session-backed: it creates the session on the first attempt and
	 * RESUMES it on any later attempt (model-level retry/fallback), so a model
	 * switch inherits the prior context. When unset, the child runs ephemerally
	 * (--no-session) and cannot be resumed. The caller owns the directory's
	 * lifecycle; runSingleAgent neither creates nor removes it. */
	sessionDir?: string;
	/** Pi session id paired with sessionDir. The first attempt creates it
	 * (--session-id); later attempts resume (--session) once the session file
	 * exists. */
	sessionId?: string;
	/** Text sent to the child via stdin. Defaults to `Task: ${task}`. A resumed
	 * attempt passes a continuation prompt (see buildResumePrompt) so the model
	 * picks up the prior session instead of starting the task over. */
	stdinText?: string;
	signal?: AbortSignal;
	onLive?: (e: SubagentLiveEvent) => void;
	makeDetails: (results: SingleResult[]) => SubagentDetails;
	env?: NodeJS.ProcessEnv;
}

/** Spawn one agent as an isolated pi child process and collect its output. */
export async function runSingleAgent(options: RunSingleOptions): Promise<SingleResult> {
	const {
		agent,
		agentName,
		task,
		cwd,
		thinkingLevel = SUBAGENT_THINKING_LEVEL,
		idleTimeoutMs = SUBAGENT_DEFAULT_IDLE_TIMEOUT_MS,
		signal,
		onLive,
		makeDetails,
	} = options;

	if (!agent) {
		return {
			agent: agentName,
			agentSource: "unknown",
			task,
			exitCode: 1,
			messages: [],
			stderr: `Unknown agent: "${agentName}".`,
			usage: emptyUsage(),
		};
	}

	// Defense in depth: even if another extension ignores the depth marker, a
	// child process can never expose a tool named `subagent` back to its model.
	const args: string[] = ["--mode", "json", "-p", "--exclude-tools", "subagent"];
	// Session-backed: every run persists its pi session so a model-level retry or
	// fallback can RESUME it (--session) instead of re-scanning from scratch. The
	// first attempt creates the session (--session-id); once the session file
	// exists, later attempts resume it. No sessionDir → ephemeral (--no-session).
	if (options.sessionDir && options.sessionId) {
		args.push("--session-dir", options.sessionDir);
		args.push(
			sessionExists(options.sessionDir, options.sessionId) ? "--session" : "--session-id",
			options.sessionId,
		);
	} else {
		args.push("--no-session");
	}
	if (agent.model) args.push("--model", agent.model);
	// The configured level is clamped adaptively per model by pi.
	args.push("--thinking", thinkingLevel);
	if (agent.tools && agent.tools.length > 0) args.push("--tools", agent.tools.join(","));

	let tmpPromptDir: string | null = null;
	let tmpPromptPath: string | null = null;

	const hasSession = Boolean(options.sessionDir && options.sessionId);
	const currentResult: SingleResult = {
		agent: agentName,
		agentSource: agent.source,
		task,
		exitCode: 0,
		messages: [],
		stderr: "",
		usage: emptyUsage(),
		model: agent.model,
		thinking: thinkingLevel,
		sessionId: options.sessionId,
		sessionDir: options.sessionDir,
		resumed: hasSession && sessionExists(options.sessionDir as string, options.sessionId as string),
	};

	try {
		if (agent.systemPrompt.trim()) {
			const tmp = await writePromptToTempFile(agent.name, agent.systemPrompt);
			tmpPromptDir = tmp.dir;
			tmpPromptPath = tmp.filePath;
			args.push("--append-system-prompt", tmpPromptPath);
		}

		let wasAborted = false;

		// Increment depth so nested sub-agents can be guarded against runaway recursion.
		const childDepth = currentSubagentDepth(options.env) + 1;
		const childEnv: NodeJS.ProcessEnv = {
			...(options.env ?? process.env),
			[DEPTH_ENV_VAR]: String(childDepth),
		};

		const exitCode = await new Promise<number>((resolve) => {
			const invocation = getPiInvocation(args);
			const proc = spawn(invocation.command, invocation.args, {
				cwd: cwd ?? options.defaultCwd,
				shell: false,
				stdio: ["pipe", "pipe", "pipe"],
				env: childEnv,
			});
			let buffer = "";
			let closed = false;
			let termSent = false;
			let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
			let abortHandler: (() => void) | undefined;
			let lastActivityAt = Date.now();
			let idleTimer: ReturnType<typeof setInterval> | undefined;

			const finish = (code: number | null): void => {
				if (closed) return;
				closed = true;
				if (forceKillTimer) clearTimeout(forceKillTimer);
				if (idleTimer) clearInterval(idleTimer);
				if (signal && abortHandler) signal.removeEventListener("abort", abortHandler);
				resolve(code ?? 1);
			};

			const terminate = (): void => {
				if (closed) return;
				if (!termSent) {
					termSent = true;
					terminateProcessTree(proc, false);
				}
				if (!forceKillTimer) {
					forceKillTimer = setTimeout(() => {
						if (!closed) terminateProcessTree(proc, true);
					}, SUBAGENT_KILL_GRACE_MS);
				}
			};

			const processLine = (line: string): void => {
				if (!line.trim()) return;
				let event: any;
				try {
					event = JSON.parse(line);
				} catch {
					return;
				}

				// Live event: agent started
				if (event.type === "agent_start" || event.type === "turn_start") {
					if (onLive) {
						try {
							onLive({ kind: "status", status: "running" });
						} catch { /* never throw from event handling */ }
					}
				}

				// Live event: streamed assistant reasoning / output text
				if (event.type === "message_update") {
					const t = event.assistantMessageEvent?.type;
					if (t === "thinking_delta" || t === "text_delta") {
						if (onLive) {
							try {
								onLive({ kind: t === "thinking_delta" ? "thinking" : "text" });
							} catch { /* never throw from event handling */ }
						}
					}
				}

				// Live event: tool execution started
				if (event.type === "tool_execution_start") {
					if (onLive) {
						try {
							onLive({ kind: "tool_start", toolName: event.toolName ?? "unknown", args: event.args });
						} catch { /* never throw from event handling */ }
					}
				}

				// Live event: tool execution ended
				if (event.type === "tool_execution_end") {
					if (onLive) {
						try {
							onLive({ kind: "tool_end", toolName: event.toolName ?? "unknown", isError: Boolean(event.isError) });
						} catch { /* never throw from event handling */ }
					}
					if (event.isError) {
						(currentResult.failedTools ??= []).push({
							toolName: event.toolName ?? "unknown",
							error: extractToolErrorText(event.result?.content),
						});
					}
				}

				if (event.type === "message_end" && event.message) {
					const msg = event.message as Message;
					currentResult.messages.push(msg);
					if (msg.role === "assistant") {
						currentResult.usage.turns++;
						const usage = (msg as any).usage;
						if (usage) {
							currentResult.usage.input += usage.input || 0;
							currentResult.usage.output += usage.output || 0;
							currentResult.usage.cacheRead += usage.cacheRead || 0;
							currentResult.usage.cacheWrite += usage.cacheWrite || 0;
							currentResult.usage.cost += usage.cost?.total || 0;
							currentResult.usage.contextTokens = usage.totalTokens || 0;
						}
						if (!currentResult.model && (msg as any).model) currentResult.model = (msg as any).model;
						if ((msg as any).stopReason) currentResult.stopReason = (msg as any).stopReason;
						if ((msg as any).errorMessage) currentResult.errorMessage = (msg as any).errorMessage;
					}
					// Live event: usage snapshot after accumulation
					if (onLive) {
						try {
							onLive({ kind: "usage", usage: { ...currentResult.usage }, model: currentResult.model });
						} catch { /* never throw from event handling */ }
					}
				}

				if (event.type === "tool_result_end" && event.message) {
					currentResult.messages.push(event.message as Message);
				}
			};
			// Send the task (or a continuation prompt for a resumed session) through
			// the child stdin pipe instead of the command line. This avoids OS
			// argument-length limits and requires no extra temp file for the data.
			proc.stdin?.on("error", () => undefined);
			proc.stdin?.end(options.stdinText ?? `Task: ${task}`);

			// Decode stdout through a StringDecoder so multi-byte UTF-8 characters
			// (CJK, emoji) split across chunk boundaries never produce U+FFFD
			// replacement characters — a corrupted JSON line would drop the whole
			// message (including a reviewer's verdict line) from parsing.
			const stdoutDecoder = new StringDecoder("utf8");
			proc.stdout.on("data", (data) => {
				lastActivityAt = Date.now();
				buffer += stdoutDecoder.write(data);
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) processLine(line);
			});

			proc.stderr.on("data", (data) => {
				currentResult.stderr += data.toString();
			});

			proc.on("close", (code) => {
				// Flush any bytes still held by the decoder (a trailing incomplete
				// multi-byte sequence) before processing the final buffer.
				buffer += stdoutDecoder.end();
				if (buffer.trim()) processLine(buffer);
				// A null exit code means the process was terminated by a signal and
				// must be reported as failure, never as a false clean completion.
				const failed =
					code !== 0 ||
					wasAborted ||
					(signal?.aborted ?? false) ||
					currentResult.stopReason === "error" ||
					currentResult.stopReason === "aborted";
				if (onLive) {
					try {
						onLive({ kind: "status", status: failed ? "failed" : "done" });
					} catch { /* never throw from event handling */ }
				}
				finish(code);
			});

			proc.on("error", () => {
				// Spawn itself failed; close may never fire, so finish the run here.
				currentResult.stopReason = "error";
				currentResult.errorMessage ??= "Failed to start the sub-agent process.";
				if (onLive) {
					try {
						onLive({ kind: "status", status: "failed" });
					} catch { /* never throw from event handling */ }
				}
				finish(1);
			});

			if (idleTimeoutMs > 0) {
				const checkInterval = Math.min(10_000, Math.floor(idleTimeoutMs / 3));
				idleTimer = setInterval(() => {
					if (closed) return;
					if (Date.now() - lastActivityAt >= idleTimeoutMs) {
						if (idleTimer) clearInterval(idleTimer);
						currentResult.stopReason = "error";
						currentResult.errorMessage = `Subagent idle timeout: no activity for ${Math.ceil(idleTimeoutMs / 1000)} seconds.`;
						terminate();
					}
				}, checkInterval);
			}

			if (signal) {
				abortHandler = (): void => {
					wasAborted = true;
					terminate();
				};
				if (signal.aborted) abortHandler();
				else signal.addEventListener("abort", abortHandler, { once: true });
			}
		});

		currentResult.exitCode = exitCode;
		if (wasAborted) {
			currentResult.stopReason = "aborted";
			currentResult.errorMessage ??= "Subagent was aborted";
			if (onLive) {
				try {
					onLive({ kind: "status", status: "failed" });
				} catch { /* never throw from event handling */ }
			}
		}
		return currentResult;
	} finally {
		if (tmpPromptPath)
			try {
				unlinkSync(tmpPromptPath);
			} catch {
				/* ignore */
			}
		if (tmpPromptDir)
			try {
				rmdirSync(tmpPromptDir);
			} catch {
				/* ignore */
			}
	}
}

/**
 * Run one agent with three layers of resilience, all session-backed so a model
 * switch RESUMES the prior context instead of re-scanning from scratch:
 *
 * 1. Startup retry (inner loop): a concurrent pi startup race can make the child
 *    exit before any model/tool activity. Relaunch with backoff so the startup
 *    lock clears. The SAME model is retried — the race is in the host, not the
 *    model — and only a clean, silent, zero-activity exit qualifies (see
 *    isRetryableStartupFailure), so retrying can never duplicate real work.
 * 2. Run-level retry on the SAME configured model (middle): when the provider
 *    rejects the model with a TRANSIENT error (503/429/timeout/network/...) —
 *    NOT a terminal one (quota/billing/invalid key/auth — see isTerminalModelError)
 *    — RESUME the session on the same model up to
 *    SUBAGENT_RUN_LEVEL_RETRY_DELAYS_MS.length more times with backoff. Resuming
 *    preserves any work done before the hiccup.
 * 3. Model fallback (outer): when the same model still fails, RESUME the session
 *    once on the main window's current model — the fallback inherits the prior
 *    context, so the user never pays to re-scan after a model switch.
 *
 * Terminal model errors short-circuit to the caller: the account is the
 * bottleneck, so neither same-model retry nor a same-account fallback can help.
 * The session is preserved on disk (the result carries sessionId/sessionDir) so
 * a later manual resume on a working model can continue without re-scanning.
 *
 * The fallback is per-run only and never persisted: a transient provider hiccup
 * must not silently downgrade the configured agent model.
 */
export async function runSingleAgentWithModelFallback(
	options: RunSingleOptions,
	fallbackModelRef?: string,
): Promise<SingleResult> {
	const agent = options.agent;
	const launchedRef = agent?.model;
	const startupDelays = options.startupRetryDelaysMs ?? SUBAGENT_STARTUP_RETRY_DELAYS_MS;
	// Run-level retry is opted out of with an explicit empty array (e.g. a test
	// that wants to assert ONLY the fallback path runs once); undefined means
	// "use the default 5-attempt transient-error schedule".
	const runDelays = options.runLevelRetryDelaysMs ?? SUBAGENT_RUN_LEVEL_RETRY_DELAYS_MS;

	const runWithStartupRetry = async (opts: RunSingleOptions): Promise<SingleResult> => {
		let lastResult: SingleResult;
		let retries = 0;
		for (let attempt = 0; ; attempt++) {
			const start = Date.now();
			lastResult = await runSingleAgent(opts);
			const durationMs = Date.now() - start;
			if (!isRetryableStartupFailure(lastResult, durationMs)) {
				if (retries > 0 && !isFailedResult(lastResult)) lastResult.startupRetries = retries;
				return lastResult;
			}
			const delay = startupDelays[attempt];
			if (delay === undefined) {
				// Exhausted: the agent never reached a model. Surface the concurrency-race
				// cause as a dispatch-level failure (no model was ever reached, so this
				// must NOT trigger run-level retry or model fallback) so the main agent
				// can retry or lower maxConcurrency.
				lastResult.errorMessage = formatStartupRetryExhaustedError(
					lastResult.model ?? opts.agent?.model ?? "default",
					attempt + 1,
				);
				lastResult.stopReason ??= "error";
				lastResult.dispatchFailed = true;
				return lastResult;
			}
			// Flip the live status back to running so the widget does not flash a
			// false "failed" while we wait out the backoff and relaunch the child.
			try {
				opts.onLive?.({ kind: "status", status: "running" });
			} catch { /* never throw from event handling */ }
			const shouldRetry = await waitForStartupRetry(delay, opts.signal);
			if (!shouldRetry) return lastResult;
			retries++;
		}
	};

	// One pi session backs the whole logical run, shared by the initial attempt
	// and every resume (model-level retry / fallback), so a model switch inherits
	// the prior context instead of re-scanning. Created here unless the caller
	// passed one in (an explicit resume of a handed-back session).
	const sessionId = options.sessionId ?? randomUUID();
	const sessionDir = options.sessionDir ?? (await mkdtemp(join(tmpdir(), "pi-subagent-session-")));
	const baseOptions: RunSingleOptions = { ...options, sessionDir, sessionId };

	let modelRetries = 0;
	let result: SingleResult | undefined;
	try {
		result = await runWithStartupRetry(baseOptions);

		// A TERMINAL model error (quota/billing/invalid key/auth) is account-scoped:
		// neither a same-model retry nor a same-account fallback can help. Skip the
		// automatic retry/fallback and hand the run back — the session is preserved
		// (see finally) so a later manual resume on a working model can continue
		// without re-scanning.
		const terminal = isModelLevelFailure(result) && isTerminalModelError(result);

		// A TRANSIENT provider failure (503/429/timeout/network/...) usually
		// recovers on a relaunch. RESUME the same session on the same configured
		// model up to runDelays.length more times with backoff — resuming (not
		// restarting) preserves any work done before the hiccup. This sits outside
		// pi-ai's per-request provider retry, which by then already tried and gave up.
		if (!terminal && agent && launchedRef && isModelLevelFailure(result) && runDelays.length > 0) {
			const retryOpts: RunSingleOptions = {
				...baseOptions,
				stdinText: buildResumePrompt(options.task, "a transient provider error"),
			};
			for (let attempt = 0; ; attempt++) {
				const delay = runDelays[attempt];
				if (delay === undefined) break;
				try {
					options.onLive?.({ kind: "status", status: "running" });
				} catch { /* never throw from event handling */ }
				const shouldRetry = await waitForStartupRetry(delay, options.signal);
				if (!shouldRetry) break;
				const retried = await runWithStartupRetry(retryOpts);
				modelRetries++;
				// failedTools reflect ONLY the final attempt (each runSingleAgent call
				// accumulates its own), so the completion message stays accurate.
				result = retried;
				if (!isModelLevelFailure(retried) || isTerminalModelError(retried)) break;
			}
		}

		// Transient retries exhausted (or none) and still a model-level failure:
		// RESUME the session on the main window's current model exactly once. The
		// fallback inherits the prior context (no re-scan). Skipped when there is no
		// fallback ref, it equals the configured model, or the failure is terminal
		// (a same-account fallback would fail identically — leave it for manual resume).
		if (
			!terminal &&
			agent &&
			launchedRef &&
			fallbackModelRef &&
			launchedRef !== fallbackModelRef &&
			isModelLevelFailure(result)
		) {
			const retried = await runWithStartupRetry({
				...baseOptions,
				stdinText: buildResumePrompt(options.task, buildFallbackResumeReason(launchedRef)),
				agent: { ...agent, model: fallbackModelRef },
			});
			// The fallback replaces the result wholesale: failedTools reflect ONLY the
			// fallback (final) attempt — stale build errors from the first model are
			// not merged, so a clean final attempt is never misattributed a failure.
			result = { ...retried, modelFallbackFrom: launchedRef };
		}

		// A terminal failure takes the bare result (no retries or fallback ran, so
		// modelRetries stays undefined — matching the contract callers assert).
		return terminal ? result : { ...result, modelRetries };
	} finally {
		// Keep the session on disk only for a model-level failure that did real work
		// and is being handed back, so a later `resume` can continue it. A provider
		// rejection before any work (no messages/tools/output) has nothing to resume,
		// so it is cleaned up along with every success and task-level failure. Never
		// remove a caller-provided sessionDir (an explicit resume owns its dir).
		if (result) {
			result.sessionId ??= sessionId;
			result.sessionDir ??= sessionDir;
		}
		const hasWork =
			!!result &&
			(result.messages.length > 1 ||
				(result.failedTools?.length ?? 0) > 0 ||
				Boolean(getFinalOutput(result.messages)));
		const keep = !!result && isModelLevelFailure(result) && hasWork;
		if (!keep && !options.sessionDir) {
			await rm(sessionDir, { recursive: true, force: true }).catch(() => undefined);
		}
	}
}
