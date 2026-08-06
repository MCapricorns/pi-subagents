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
import { existsSync, mkdirSync, unlinkSync, rmdirSync, writeFileSync } from "node:fs";
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

export function getResultOutput(result: SingleResult): string {
	if (isFailedResult(result)) {
		const error = result.errorMessage || result.stderr;
		const partial = getFinalOutput(result.messages);
		if (error && partial) return `${error}\n\n--- Partial output ---\n${partial}`;
		return error || partial || "(no output)";
	}
	return getFinalOutput(result.messages) || "(no output)";
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
	const args: string[] = ["--mode", "json", "-p", "--no-session", "--exclude-tools", "subagent"];
	if (agent.model) args.push("--model", agent.model);
	// The configured level is clamped adaptively per model by pi.
	args.push("--thinking", thinkingLevel);
	if (agent.tools && agent.tools.length > 0) args.push("--tools", agent.tools.join(","));

	let tmpPromptDir: string | null = null;
	let tmpPromptPath: string | null = null;

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
			// Send the task through the child stdin pipe instead of the process
			// command line. This avoids OS argument-length limits and does not
			// require another temporary file for conversation data.
			proc.stdin?.on("error", () => undefined);
			proc.stdin?.end(`Task: ${task}`);

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
 * Run one agent; when the configured model fails at the provider level before
 * producing any output (see isModelLevelFailure), retry once with the main
 * window's current model. The retried result is returned with `modelFallbackFrom`
 * set so callers can surface the degradation. The fallback is per-run only and
 * never persisted: a transient provider hiccup must not silently downgrade the
 * configured agent model.
 */
export async function runSingleAgentWithModelFallback(
	options: RunSingleOptions,
	fallbackModelRef?: string,
): Promise<SingleResult> {
	const result = await runSingleAgent(options);
	const agent = options.agent;
	const launchedRef = agent?.model;
	if (!agent || !launchedRef || !fallbackModelRef || launchedRef === fallbackModelRef) return result;
	if (!isModelLevelFailure(result)) return result;
	const retried = await runSingleAgent({ ...options, agent: { ...agent, model: fallbackModelRef } });
	return { ...retried, modelFallbackFrom: launchedRef };
}
