/** Run a child using Pi RPC, with a session retained after settlement. */

import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { Message, Usage } from "@earendil-works/pi-ai";
import type { JsonAgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { SUBAGENT_TOOL_NAMES, type AgentConfig } from "../delegation/agents.ts";
import type { ThinkingLevel } from "../configuration/config.ts";
import { writeTempOwnerMarker } from "../isolation/temp-hygiene.ts";
import { terminateProcessTree } from "./process-tree.ts";
import { asPlainTextPrompt, emptyUsage, type RunControl, type AttemptControl, type RunResult, type SubagentLiveEvent } from "./run-control.ts";

const DEPTH_ENV_VAR = "PI_SUBAGENT_DEPTH";
/** Every tool of an MCP server shares this prefix, whatever its exposure. */
const MCP_TOOL_PREFIX = "mcp__";
const SUBAGENT_KILL_GRACE_MS = 5_000;
const CLI_STARTUP_TIMEOUT_MS = 60_000;
export const CHILD_STDERR_MAX_CHARS = 32_000;


/** Append child stderr while keeping only the newest bounded tail. */
export function appendBoundedStderr(current: string, chunk: string, maxChars = CHILD_STDERR_MAX_CHARS): string {
	const next = current + chunk;
	return next.length <= maxChars ? next : next.slice(next.length - maxChars);
}

export function currentSubagentDepth(env: NodeJS.ProcessEnv = process.env): number {
	const raw = env[DEPTH_ENV_VAR];
	const parsed = raw === undefined ? 0 : Number.parseInt(raw, 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

/** Match pi's `<timestamp>Z_<id>.jsonl` session-file convention. */
export function sessionExists(sessionDir: string, sessionId: string): boolean {
	try {
		return readdirSync(sessionDir).some((file) => file.endsWith(`_${sessionId}.jsonl`));
	} catch {
		return false;
	}
}

/** Resolve how to invoke the same pi build as the current process. */
function getPiInvocation(args: string[]): { command: string; args: string[] } {
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

function extractToolErrorText(content: unknown): string {
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
		.map((line) => (line.length > 200 ? `${line.slice(0, 200)}…` : line))
		.join("\n");
}

/** Hand the agent body to the child as a file rather than inline argv text.
 * `--append-system-prompt` takes either, but a system prompt is unbounded — a
 * role can carry a whole spec — while Windows caps a command line at
 * 32767 characters, so inlining turns a long agent into an opaque spawn failure.
 * The file lives in the run's scratch dir and is removed when the attempt ends. */
async function writePromptToTempFile(
	scratchRoot: string,
	agentName: string,
	prompt: string,
): Promise<{ dir: string; filePath: string }> {
	await mkdir(scratchRoot, { recursive: true });
	const dir = await mkdtemp(join(scratchRoot, "pi-subagents-"));
	writeTempOwnerMarker(dir);
	const safeName = agentName.replace(/[^\w.-]+/g, "_");
	const filePath = join(dir, `prompt-${safeName}.md`);
	try {
		await writeFile(filePath, prompt, "utf8");
		return { dir, filePath };
	} catch (error) {
		await rm(dir, { recursive: true, force: true }).catch(() => undefined);
		throw error;
	}
}


export interface ChildLaunchOptions {
	agent: Pick<AgentConfig, "model" | "tools">;
	thinkingLevel: ThinkingLevel;
	sessionDir?: string;
	sessionId?: string;
	/** The session directory already holds the session being resumed. */
	resumeExistingSession?: boolean;
	/** Appended system prompt file, when the role carries one. */
	promptPath?: string;
}

/** Command line for one child attempt.
 *
 * An explicit role list is a strict intersection of the parent's tools, but pi
 * keeps MCP tools unless a `--tools` entry names one, so a list that names none
 * has to exclude them by pattern. Scout depends on that: its read-only boundary
 * must not leak an MCP writer. */
export function buildChildLaunchArgs(options: ChildLaunchOptions): string[] {
	const { agent, thinkingLevel } = options;
	const excludedTools: string[] = [...SUBAGENT_TOOL_NAMES];
	const args: string[] = ["--mode", "rpc"];
	if (options.sessionDir && options.sessionId) {
		args.push("--session-dir", options.sessionDir);
		args.push(options.resumeExistingSession ? "--session" : "--session-id", options.sessionId);
	} else {
		args.push("--no-session");
	}
	if (agent.model) args.push("--model", agent.model);
	args.push("--thinking", thinkingLevel);
	if (agent.tools) {
		if (agent.tools.length > 0) {
			args.push("--tools", agent.tools.join(","));
			if (!agent.tools.some((tool) => tool.startsWith(MCP_TOOL_PREFIX))) excludedTools.push(`${MCP_TOOL_PREFIX}*`);
		} else {
			args.push("--no-tools");
		}
	}
	args.push("--exclude-tools", excludedTools.join(","));
	if (options.promptPath) args.push("--append-system-prompt", options.promptPath);
	return args;
}


export interface RunCliAttemptOptions {
	defaultCwd: string;
	agent: AgentConfig;
	agentName: string;
	task: string;
	cwd?: string;
	thinkingLevel: ThinkingLevel;
	idleTimeoutMs: number;
	sessionDir?: string;
	sessionId?: string;
	scratchRoot: string;
	prompt: string;
	signal?: AbortSignal;
	onLive?: (event: SubagentLiveEvent) => void;
	env?: NodeJS.ProcessEnv;
	control?: RunControl;
	startupTimeoutMs?: number;
}

export async function runCliAgentAttempt(options: RunCliAttemptOptions): Promise<RunResult> {
	const { agent, agentName, task, control, signal, onLive } = options;
	const result: RunResult = {
		agent: agentName, task, exitCode: 0, messages: [], stderr: "", usage: emptyUsage(),
		model: agent.model, thinking: options.thinkingLevel,
		sessionId: options.sessionId, sessionDir: options.sessionDir,
	};
	let promptFile: Awaited<ReturnType<typeof writePromptToTempFile>> | undefined;
	try {
		if (signal?.aborted || control?.isStopRequested()) {
			return { ...result, exitCode: 1, stopReason: "aborted", errorMessage: control?.getStopMessage() ?? "Subagent was aborted" };
		}
		if (agent.systemPrompt.trim()) promptFile = await writePromptToTempFile(options.scratchRoot, agent.name, agent.systemPrompt);
		const args = buildChildLaunchArgs({
			agent, thinkingLevel: options.thinkingLevel,
			sessionDir: options.sessionDir, sessionId: options.sessionId,
			resumeExistingSession: Boolean(options.sessionDir && options.sessionId && sessionExists(options.sessionDir, options.sessionId)),
			promptPath: promptFile?.filePath,
		});
		const invocation = getPiInvocation(args);
		const processGroup = process.platform !== "win32";
		const proc = spawn(invocation.command, invocation.args, {
			cwd: options.cwd ?? options.defaultCwd, shell: false, stdio: ["pipe", "pipe", "pipe"],
			env: { ...(options.env ?? process.env), [DEPTH_ENV_VAR]: String(currentSubagentDepth(options.env) + 1) },
			detached: processGroup,
		});
		const token = control?.beginAttempt();
		let closed = false;
		let settled = false;
		let stopping = false;
		let lastActivityAt = Date.now();
		let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
		let shutdownTimer: ReturnType<typeof setTimeout> | undefined;
		let idleTimer: ReturnType<typeof setInterval> | undefined;
		let startupTimer: ReturnType<typeof setTimeout> | undefined;
		let nextRequestId = 0;
		const pendingSteers = new Map<string, { resolve: () => void; reject: (error: Error) => void }>();
		let resolveClosed!: () => void;
		const processClosed = new Promise<void>((resolve) => { resolveClosed = resolve; });
		const emit = (event: SubagentLiveEvent): void => {
			try { onLive?.(event); } catch { /* Observers do not own the child lifecycle. */ }
		};
		const terminate = (): void => {
			if (closed || forceKillTimer) return;
			terminateProcessTree(proc, false, processGroup);
			forceKillTimer = setTimeout(() => {
				if (!closed) terminateProcessTree(proc, true, processGroup);
			}, SUBAGENT_KILL_GRACE_MS);
		};
		const attempt: AttemptControl = {
			steer(message) {
				if (closed || settled || stopping || proc.stdin.destroyed) return Promise.reject(new Error("Subagent has stopped accepting messages."));
				const id = `steer-${++nextRequestId}`;
				return new Promise<void>((resolve, reject) => {
					const timer = setTimeout(() => {
						if (pendingSteers.delete(id)) reject(new Error("No acknowledgement; message delivery is unconfirmed."));
					}, 10_000);
					timer.unref?.();
					pendingSteers.set(id, { resolve: () => { clearTimeout(timer); resolve(); }, reject: (error) => { clearTimeout(timer); reject(error); } });
					proc.stdin.write(JSON.stringify({ id, type: "steer", message: asPlainTextPrompt(message) }) + "\n", (error) => {
						if (error) {
							const pending = pendingSteers.get(id);
							if (pending) { pendingSteers.delete(id); pending.reject(error); }
						}
					});
				});
			},
			async stop(reason = "Subagent was aborted") {
				if (!closed) {
					stopping = true;
					result.exitCode = 1;
					result.stopReason = "aborted";
					result.errorMessage = reason;
					if (token !== undefined) control?.updateAttemptPhase(token, "interrupting");
					emit({ kind: "status", status: "interrupting" });
					terminate();
				}
				await processClosed;
			},
		};
		if (token !== undefined) control?.attach(token, attempt);
		if (proc.pid !== undefined) control?.noteChildPid(proc.pid);
		control?.markStarting();
		const addUsage = (usage: Partial<Usage> | undefined): void => {
			if (!usage) return;
			result.usage.input += usage.input ?? 0;
			result.usage.output += usage.output ?? 0;
			result.usage.cacheRead += usage.cacheRead ?? 0;
			result.usage.cacheWrite += usage.cacheWrite ?? 0;
			result.usage.cost += usage.cost?.total ?? 0;
			result.usage.contextTokens = usage.totalTokens ?? result.usage.contextTokens;
		};
		const processLine = (line: string): void => {
			let record: any;
			try { record = JSON.parse(line); } catch { return; }
			if (record?.type === "response") {
				if (record.id === "initial-prompt" && (!record.success || record.data?.disposition === "handled")) {
					result.dispatchFailed = true;
					result.errorMessage = record.error || "Subagent prompt was handled without starting a run.";
					terminate();
				}
				const pending = pendingSteers.get(record.id);
				if (pending) {
					pendingSteers.delete(record.id);
					if (record.success) pending.resolve();
					else pending.reject(new Error(record.error || "Steering was rejected."));
				}
				return;
			}
			const event = record as JsonAgentSessionEvent;
			if (!event || typeof event !== "object") return;
			if (event.type === "agent_start" || event.type === "turn_start") {
				result.activityObserved = true;
				if (startupTimer) clearTimeout(startupTimer);
				if (!stopping) {
					if (token !== undefined) control?.updateAttemptPhase(token, "running");
					emit({ kind: "status", status: "running" });
				}
			} else if (event.type === "message_update") {
				const type = event.assistantMessageEvent?.type;
				if (type === "thinking_delta" || type === "text_delta") emit({ kind: type === "thinking_delta" ? "thinking" : "text" });
			} else if (event.type === "tool_execution_start") {
				result.activityObserved = true;
				emit({ kind: "tool_start", toolCallId: event.toolCallId, toolName: event.toolName, args: event.args });
			} else if (event.type === "tool_execution_end") {
				emit({ kind: "tool_end", toolCallId: event.toolCallId, toolName: event.toolName, isError: event.isError });
				if (event.isError) (result.failedTools ??= []).push({ toolName: event.toolName, error: extractToolErrorText(event.result?.content) });
			} else if (event.type === "message_end" && event.message) {
				result.activityObserved = true;
				const message = event.message;
				if (message.role === "assistant" || message.role === "user" || message.role === "toolResult") result.messages.push(message as Message);
				if (message.role === "assistant") {
					result.usage.turns++;
					addUsage(message.usage);
					if (message.provider && message.model) result.model = message.provider + "/" + message.model;
					if (!stopping) {
						result.stopReason = message.stopReason;
						result.errorMessage = message.errorMessage;
					}
				} else if (message.role === "toolResult") addUsage(message.usage);
				emit({ kind: "usage", usage: { ...result.usage }, model: result.model });
			} else if (event.type === "compaction_end") {
				addUsage(event.result?.usage);
				emit({ kind: "usage", usage: { ...result.usage }, model: result.model });
			} else if (event.type === "agent_settled") {
				settled = true;
				if (startupTimer) clearTimeout(startupTimer);
				if (event.aborted && !stopping) {
					result.stopReason = "aborted";
					result.errorMessage ??= "Subagent was aborted";
				}
				// RPC remains alive until stdin closes. A steer racing settlement is
				// unconfirmed, so reject it rather than claim it was delivered.
				for (const pending of pendingSteers.values()) pending.reject(new Error("Subagent settled before acknowledging the message."));
				pendingSteers.clear();
				proc.stdin.end();
				if (!closed) shutdownTimer ??= setTimeout(terminate, SUBAGENT_KILL_GRACE_MS);
			}
		};
		const stdoutDecoder = new StringDecoder("utf8");
		const stderrDecoder = new StringDecoder("utf8");
		let stdoutBuffer = "";
		proc.stdout.on("data", (chunk: Buffer) => {
			lastActivityAt = Date.now();
			stdoutBuffer += stdoutDecoder.write(chunk);
			let start = 0;
			for (let lf = stdoutBuffer.indexOf("\n"); lf !== -1; lf = stdoutBuffer.indexOf("\n", start)) {
				processLine(stdoutBuffer.slice(start, lf));
				start = lf + 1;
			}
			if (start) stdoutBuffer = stdoutBuffer.slice(start);
		});
		proc.stderr.on("data", (chunk: Buffer) => { result.stderr = appendBoundedStderr(result.stderr, stderrDecoder.write(chunk)); });
		proc.stdin.on("error", (error) => {
			if (stopping || closed || settled) return;
			result.dispatchFailed = true;
			result.errorMessage ??= "Subagent stdin failed: " + error.message;
			terminate();
		});
		proc.once("error", (error) => {
			result.dispatchFailed = true;
			result.errorMessage ??= "Failed to start the sub-agent process: " + error.message;
		});
		proc.once("close", (code, exitSignal) => {
			closed = true;
			for (const pending of pendingSteers.values()) pending.reject(new Error("Subagent exited before acknowledging the message."));
			pendingSteers.clear();
			if (startupTimer) clearTimeout(startupTimer);
			if (idleTimer) clearInterval(idleTimer);
			if (forceKillTimer) clearTimeout(forceKillTimer);
			if (shutdownTimer) clearTimeout(shutdownTimer);
			signal?.removeEventListener("abort", onAbort);
			stdoutBuffer += stdoutDecoder.end();
			result.stderr = appendBoundedStderr(result.stderr, stderrDecoder.end());
			if (stdoutBuffer.trim()) processLine(stdoutBuffer);
			// A settlement event does not excuse an abnormal process exit.
			if (!stopping && (!settled || code !== 0)) {
				const detail = exitSignal ? "signal=" + exitSignal : "code=" + code;
				const error = "Subagent JSON process exited " + (settled ? "after settlement" : "before settling") + " (" + detail + ").";
				result.errorMessage = [result.errorMessage, error, result.stderr.trim()].filter(Boolean).join("\n");
				result.stopReason = "error";
				if (!result.errorMessage.startsWith("Subagent idle timeout")) result.dispatchFailed = true;
			}
			if (!stopping && result.stopReason === "length") result.errorMessage = "Subagent answer was truncated at the model output limit.";
			if (!stopping && settled && !result.messages.some((message) => message.role === "assistant")) {
				result.stopReason = "error";
				result.errorMessage ??= "Subagent settled without an assistant answer.";
				result.dispatchFailed = true;
			}
			result.exitCode = result.dispatchFailed || result.stopReason === "error" || result.stopReason === "aborted" || result.stopReason === "length" ? 1 : 0;
			resolveClosed();
		});
		const onAbort = (): void => { void attempt.stop("Subagent was aborted"); };
		startupTimer = setTimeout(() => {
			result.dispatchFailed = true;
			result.errorMessage = "Subagent startup timeout before agent activity.";
			terminate();
		}, options.startupTimeoutMs ?? CLI_STARTUP_TIMEOUT_MS);
		if (options.idleTimeoutMs > 0) {
			idleTimer = setInterval(() => {
				if (settled || stopping || closed || Date.now() - lastActivityAt < options.idleTimeoutMs) return;
				result.errorMessage = "Subagent idle timeout: no activity for " + Math.ceil(options.idleTimeoutMs / 1000) + " seconds.";
				result.stopReason = "error";
				terminate();
			}, Math.max(1, Math.min(10_000, Math.floor(options.idleTimeoutMs / 3))));
		}
		signal?.addEventListener("abort", onAbort, { once: true });
		try {
			if (signal?.aborted || control?.isStopRequested()) await attempt.stop(control?.getStopMessage());
			else proc.stdin.write(JSON.stringify({ id: "initial-prompt", type: "prompt", message: asPlainTextPrompt(options.prompt) }) + "\n");
			await processClosed;
			return result;
		} finally {
			if (token !== undefined) control?.detach(token);
		}
	} finally {
		if (promptFile) await rm(promptFile.dir, { recursive: true, force: true }).catch(() => undefined);
	}
}
