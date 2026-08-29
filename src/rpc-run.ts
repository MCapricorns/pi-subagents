/*
 * Persistent pi RPC child transport for one logical sub-agent generation.
 *
 * A child stays alive across prompt/abort operations and speaks
 * strict LF-delimited JSONL. The process is terminated only after the logical
 * run settles, is parked/stopped, or fails. Session files remain owned by the
 * parent runtime so a later generation can resume the same thread.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readdirSync, unlinkSync, rmdirSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { Message } from "@earendil-works/pi-ai";
import { SUBAGENT_TOOL_NAMES, type AgentConfig } from "./agents.ts";
import type { ThinkingLevel } from "./config.ts";
import { writeTempOwnerMarker } from "./temp-hygiene.ts";
import type { IsolationMode, WorktreeFinalizationStatus } from "./worktree.ts";

export const DEPTH_ENV_VAR = "PI_SUBAGENT_DEPTH";
export const SUBAGENT_KILL_GRACE_MS = 5_000;
/** ACK budget after the child is known to be reading RPC. */
export const RPC_COMMAND_TIMEOUT_MS = 30_000;

/** clear_queue is stop-path hygiene ahead of the abort: give it its own short
 * budget so a hung response cannot eat into the abort-settle window. */
const RPC_CLEAR_QUEUE_TIMEOUT_MS = 2_000;
/** Time allowed for the child to boot and answer get_state. */
export const RPC_READY_TIMEOUT_MS = 60_000;
export const RPC_ABORT_SETTLE_TIMEOUT_MS = 5_000;

export function isRpcCommandTimeoutError(message?: string): boolean {
	return typeof message === "string" && message.includes("Timed out waiting for RPC response");
}

/** Prevent RPC prompt expansion when a control objective itself starts with
 * slash (for example `/subagents-setup`). The original text stays verbatim
 * below a non-command prefix and therefore always starts a model turn. */
export function asPlainTextRpcPrompt(message: string): string {
	if (!message.trimStart().startsWith("/")) return message;
	return `Treat the following as plain-text sub-agent instructions, not a Pi command:\n\n${message}`;
}

export interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

export interface RpcSingleResult {
	agent: string;
	task: string;
	exitCode: number;
	messages: Message[];
	stderr: string;
	usage: UsageStats;
	model?: string;
	thinking?: string;
	stopReason?: string;
	errorMessage?: string;
	/** Selected model when this result handed off to the current main model. */
	modelFallbackFrom?: string;
	dispatchFailed?: boolean;
	/** An accepted generation failed because an RPC prompt was rejected before
	 * model execution. This remains main-model handoff eligible even when an
	 * earlier, aborted objective left assistant text in the session. */
	rpcPromptRejected?: boolean;
	/** Startup handshake failed before the initial prompt was dispatched. This
	 * transport miss is safe to retry and is not a model/provider failure. */
	rpcStartupFailed?: boolean;
	/** The parent dispatched the initial prompt command. Until its response is
	 * observed, Pi may already be running it, so startup retries must not replay it. */
	rpcPromptDispatched?: boolean;
	/** The child confirmed prompt acceptance (or emitted agent activity). */
	rpcPromptAccepted?: boolean;
	/** Pi emitted agent/turn/model/tool activity for this attempt. */
	rpcActivity?: boolean;
	startupRetries?: number;
	failedTools?: Array<{ toolName: string; error: string }>;
	sessionId?: string;
	sessionDir?: string;
	/** Original task/project cwd used for result-artifact retention buckets. */
	projectCwd?: string;
	/** Stable logical run id assigned by dispatch (also present on queued results). */
	runId?: number;
	/** Filesystem isolation selected for this logical thread. */
	isolation?: IsolationMode;
	/** Final integration state for a worktree-isolated settlement. */
	integrationStatus?: "pending" | WorktreeFinalizationStatus;
	integrationApplied?: boolean;
	integrationError?: string;
	/** Retained only when integration/cleanup failed; never contains patch data. */
	integrationWorktreePath?: string;
	integrationPatchPath?: string;
}

export type SubagentLiveEvent =
	| { kind: "status"; status: "queued" | "running" | "interrupting" | "done" | "failed" }
	| { kind: "model"; model?: string; thinking?: ThinkingLevel; fallbackFrom?: string }
	| { kind: "usage"; usage: UsageStats; model?: string }
	| { kind: "session"; sessionId: string; sessionDir: string }
	| { kind: "tool_start"; toolCallId?: string; toolName: string; args: unknown }
	| { kind: "tool_end"; toolCallId?: string; toolName: string; isError: boolean }
	| { kind: "thinking" }
	| { kind: "text" };

export type RpcControlPhase =
	| "queued"
	| "starting"
	| "running"
	| "interrupting"
	| "retrying"
	| "settled"
	| "stopped";

interface AttemptControl {
	stop(reason?: string): Promise<void>;
}

/**
 * Stable control surface for a logical run generation. Startup/main-handoff attempts
 * attach and detach beneath it, so callers never retain a stale child handle.
 * Control calls are serialized to prevent overlapping abort/settle/prompt flows.
 */
export class RpcRunControl {
	private objective: string;
	private phase: RpcControlPhase = "queued";
	private attempt?: { token: number; control: AttemptControl };
	private nextToken = 1;
	private serial: Promise<void> = Promise.resolve();
	private stopRequested = false;
	private stopMessage = "Subagent was aborted";
	private childPids = new Set<number>();

	constructor(
		objective: string,
		readonly generation: number,
		private readonly onPhase?: (phase: RpcControlPhase) => void,
	) {
		this.objective = objective;
	}

	getObjective(): string {
		return this.objective;
	}

	getPhase(): RpcControlPhase {
		return this.phase;
	}

	isStopRequested(): boolean {
		return this.stopRequested;
	}

	getStopMessage(): string {
		return this.stopMessage;
	}

	/** Pids of every child process this generation spawned. Persisted with the
	 * thread record so a later load can kill orphans that still hold the
	 * retained session. */
	noteChildPid(pid: number): void {
		if (Number.isInteger(pid) && pid > 0) this.childPids.add(pid);
	}

	getChildPids(): number[] {
		return [...this.childPids];
	}

	markStarting(): void {
		this.setPhase("starting");
	}

	markRetrying(): void {
		if (!this.stopRequested) this.setPhase("retrying");
	}

	markSettled(): void {
		this.attempt = undefined;
		if (!this.stopRequested) this.setPhase("settled");
	}

	/** Allocate an attempt token used to reject state updates from old children. */
	beginAttempt(): number {
		return this.nextToken++;
	}

	attach(token: number, control: AttemptControl): void {
		this.attempt = { token, control };
	}

	detach(token: number): void {
		if (this.attempt?.token === token) this.attempt = undefined;
	}

	updateAttemptPhase(token: number, phase: RpcControlPhase): void {
		if (this.attempt?.token !== token) return;
		this.setPhase(phase);
	}

	async stop(reason = "Subagent was aborted"): Promise<void> {
		return this.serialize(async () => {
			this.stopRequested = true;
			this.stopMessage = reason;
			const attempt = this.attempt?.control;
			if (attempt) await attempt.stop(reason);
			this.setPhase("stopped");
		});
	}

	private setPhase(phase: RpcControlPhase): void {
		if (this.phase === phase) return;
		this.phase = phase;
		try {
			this.onPhase?.(phase);
		} catch {
			/* monitor callbacks must never break control flow */
		}
	}

	private serialize<T>(operation: () => Promise<T>): Promise<T> {
		const next = this.serial.then(operation, operation);
		this.serial = next.then(
			() => undefined,
			() => undefined,
		);
		return next;
	}
}

export function emptyUsage(): UsageStats {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
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

/** Terminate the child and every tool process in its process tree. */
export function terminateProcessTree(proc: ChildProcess, force: boolean, processGroup = false): void {
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
		if (processGroup && proc.pid !== undefined) {
			// RPC children are spawned as POSIX process-group leaders. Signalling the
			// negative pid reaches Pi and non-detached tool descendants; Pi's SIGTERM
			// handler cleans its own tracked detached children before the hard fallback.
			process.kill(-proc.pid, force ? "SIGKILL" : "SIGTERM");
		} else {
			proc.kill(force ? "SIGKILL" : "SIGTERM");
		}
	} catch {
		/* process may already be gone */
	}
}

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
		.map((line) => (line.length > 200 ? `${line.slice(0, 200)}…` : line))
		.join("\n");
}

interface ChildRetryPolicyExtension {
	dir: string;
	filePath: string;
}

/** Build a child-only Pi extension that replaces the selected provider's
 * stream adapter with its registered API implementation while forcing
 * maxRetries=0. It uses Pi's public extension and pi-ai compatibility APIs, so
 * it works in Node and standalone/Bun builds without touching user settings. */
export async function writeChildRetryPolicyExtension(
	modelRef?: string,
): Promise<ChildRetryPolicyExtension> {
	const dir = await mkdtemp(join(tmpdir(), "pi-subagents-policy-"));
	writeTempOwnerMarker(dir);
	const filePath = join(dir, "no-provider-retries.mjs");
	const slash = modelRef?.indexOf("/") ?? -1;
	const selectedProvider = slash > 0 ? modelRef!.slice(0, slash) : undefined;
	const source = `import { getApiProvider } from "@earendil-works/pi-ai/compat";\n`
		+ `const selectedProvider = ${JSON.stringify(selectedProvider)};\n`
		+ `export default function noProviderRetries(pi) {\n`
		+ `  pi.on("before_provider_request", (_event, ctx) => {\n`
		+ `    const providerId = ctx.model?.provider ?? selectedProvider;\n`
		+ `    if (!providerId) return;\n`
		+ `    pi.registerProvider(providerId, {\n`
		+ `      streamSimple(model, context, options) {\n`
		+ `        const api = getApiProvider(model.api);\n`
		+ `        if (!api) throw new Error(\`No API stream implementation is registered for \${model.api}.\`);\n`
		+ `        return api.streamSimple(model, context, { ...options, maxRetries: 0 });\n`
		+ `      },\n`
		+ `    });\n`
		+ `  });\n`
		+ `}\n`;
	try {
		await writeFile(filePath, source, "utf8");
		return { dir, filePath };
	} catch (error) {
		await rm(dir, { recursive: true, force: true }).catch(() => undefined);
		throw error;
	}
}

async function writePromptToTempFile(agentName: string, prompt: string): Promise<{ dir: string; filePath: string }> {
	const dir = await mkdtemp(join(tmpdir(), "pi-subagents-"));
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

interface RpcResponse {
	id?: string;
	type: "response";
	command: string;
	success: boolean;
	error?: string;
	data?: unknown;
}

class RpcCommandRejectedError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "RpcCommandRejectedError";
	}
}

interface PendingRequest {
	resolve: (response: RpcResponse) => void;
	reject: (error: Error) => void;
	timer?: ReturnType<typeof setTimeout>;
}

interface Deferred<T> {
	promise: Promise<T>;
	resolve(value: T): void;
	reject(error: Error): void;
}

function deferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

export interface RunRpcAttemptOptions {
	defaultCwd: string;
	agent: AgentConfig;
	agentName: string;
	task: string;
	cwd?: string;
	thinkingLevel: ThinkingLevel;
	idleTimeoutMs: number;
	sessionDir?: string;
	sessionId?: string;
	prompt: string;
	signal?: AbortSignal;
	onLive?: (event: SubagentLiveEvent) => void;
	env?: NodeJS.ProcessEnv;
	control?: RpcRunControl;
	rpcReadyTimeoutMs?: number;
	rpcCommandTimeoutMs?: number;
}

/** Run one persistent RPC child until a stable `agent_settled` or control action. */
export async function runRpcAgentAttempt(options: RunRpcAttemptOptions): Promise<RpcSingleResult> {
	const { agent, agentName, task, thinkingLevel, idleTimeoutMs, signal, onLive, control } = options;
	const args: string[] = ["--mode", "rpc", "--exclude-tools", SUBAGENT_TOOL_NAMES.join(",")];
	if (options.sessionDir && options.sessionId) {
		args.push("--session-dir", options.sessionDir);
		args.push(sessionExists(options.sessionDir, options.sessionId) ? "--session" : "--session-id", options.sessionId);
	} else {
		args.push("--no-session");
	}
	if (agent.model) args.push("--model", agent.model);
	args.push("--thinking", thinkingLevel);
	if (agent.tools) {
		if (agent.tools.length > 0) args.push("--tools", agent.tools.join(","));
		else args.push("--no-tools");
	}

	let tmpPromptDir: string | null = null;
	let tmpPromptPath: string | null = null;
	if (agent.systemPrompt.trim()) {
		const tmp = await writePromptToTempFile(agent.name, agent.systemPrompt);
		tmpPromptDir = tmp.dir;
		tmpPromptPath = tmp.filePath;
		args.push("--append-system-prompt", tmpPromptPath);
	}

	let retryPolicy: ChildRetryPolicyExtension;
	try {
		retryPolicy = await writeChildRetryPolicyExtension(agent.model);
		args.push("--extension", retryPolicy.filePath);
	} catch (error) {
		if (tmpPromptDir) await rm(tmpPromptDir, { recursive: true, force: true }).catch(() => undefined);
		throw error;
	}

	const result: RpcSingleResult = {
		agent: agentName,
		task,
		exitCode: 0,
		messages: [],
		stderr: "",
		usage: emptyUsage(),
		model: agent.model,
		thinking: thinkingLevel,
		sessionId: options.sessionId,
		sessionDir: options.sessionDir,
	};

	const childDepth = currentSubagentDepth(options.env) + 1;
	const childEnv: NodeJS.ProcessEnv = {
		...(options.env ?? process.env),
		[DEPTH_ENV_VAR]: String(childDepth),
	};
	const invocation = getPiInvocation(args);
	const usePosixProcessGroup = process.platform !== "win32";
	const proc = spawn(invocation.command, invocation.args, {
		cwd: options.cwd ?? options.defaultCwd,
		shell: false,
		stdio: ["pipe", "pipe", "pipe"],
		env: childEnv,
		detached: usePosixProcessGroup,
	});

	const attemptToken = control?.beginAttempt();
	let closed = false;
	let finished = false;
	let requestId = 0;
	let stdoutBuffer = "";
	let lastActivityAt = Date.now();
	let idleTimer: ReturnType<typeof setInterval> | undefined;
	let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
	let abortHandler: (() => void) | undefined;
	let abortSettlement: Deferred<void> | undefined;
	let droppedQueuedCount = 0;
	let initialPromptResolved = false;
	const initialPrompt = deferred<{ accepted: boolean; error?: Error }>();
	const pendingRequests = new Map<string, PendingRequest>();
	const outcome = deferred<void>();
	const processClosed = deferred<void>();
	const stdoutDecoder = new StringDecoder("utf8");
	const stderrDecoder = new StringDecoder("utf8");

	const emit = (event: SubagentLiveEvent): void => {
		try {
			onLive?.(event);
		} catch {
			/* live observers must never break protocol handling */
		}
	};

	const setAttemptPhase = (phase: RpcControlPhase): void => {
		if (attemptToken !== undefined) control?.updateAttemptPhase(attemptToken, phase);
		if (phase === "running" || phase === "interrupting") {
			emit({ kind: "status", status: phase });
		}
	};

	const rejectPending = (error: Error): void => {
		for (const request of pendingRequests.values()) {
			if (request.timer) clearTimeout(request.timer);
			request.reject(error);
		}
		pendingRequests.clear();
	};

	const finish = (): void => {
		if (finished) return;
		finished = true;
		if (idleTimer) clearInterval(idleTimer);
		if (signal && abortHandler) signal.removeEventListener("abort", abortHandler);
		outcome.resolve();
	};

	const resolveInitialPrompt = (accepted: boolean, error?: Error): void => {
		if (initialPromptResolved) return;
		initialPromptResolved = true;
		if (accepted) result.rpcPromptAccepted = true;
		initialPrompt.resolve({ accepted, error });
	};

	const settleRun = (): void => {
		const failed = result.stopReason === "error" || result.stopReason === "aborted";
		result.exitCode = failed ? 1 : 0;
		// RPC settlement only means model transport is quiescent. Dispatch may still
		// be applying an isolated worktree, so it alone publishes the terminal live
		// status after filesystem finalization completes.
		finish();
	};

	const terminate = (force = false): void => {
		if (closed) return;
		terminateProcessTree(proc, force, usePosixProcessGroup);
		if (!force && !forceKillTimer) {
			forceKillTimer = setTimeout(() => {
				if (!closed) terminateProcessTree(proc, true, usePosixProcessGroup);
			}, SUBAGENT_KILL_GRACE_MS);
		}
	};

	const readyTimeoutMs = options.rpcReadyTimeoutMs ?? RPC_READY_TIMEOUT_MS;
	const commandTimeoutMs = options.rpcCommandTimeoutMs ?? RPC_COMMAND_TIMEOUT_MS;

	const writeLine = (value: object): Promise<void> =>
		new Promise((resolve, reject) => {
			if (!proc.stdin || proc.stdin.destroyed || !proc.stdin.writable) {
				reject(new Error("Subagent RPC stdin is not writable."));
				return;
			}
			// JSON strings may contain U+2028/U+2029. Only the final ASCII LF frames a
			// record; never use a generic line reader on the receiving side.
			proc.stdin.write(`${JSON.stringify(value)}\n`, "utf8", (error) => {
				if (error) reject(error);
				else resolve();
			});
		});

	const send = async (command: Record<string, unknown>, timeoutMs = commandTimeoutMs): Promise<RpcResponse> => {
		if (finished || closed) throw new Error("Subagent RPC process is no longer active.");
		const id = `req_${++requestId}`;
		const payload = { ...command, id };
		return new Promise<RpcResponse>((resolve, reject) => {
			const pending: PendingRequest = { resolve, reject };
			pendingRequests.set(id, pending);
			void writeLine(payload).then(
				() => {
					if (!pendingRequests.has(id)) return;
					pending.timer = setTimeout(() => {
						pendingRequests.delete(id);
						reject(new Error(`Timed out waiting for RPC response to ${String(command.type)}.`));
					}, timeoutMs);
					if (typeof pending.timer.unref === "function") pending.timer.unref();
				},
				(error) => {
					if (!pendingRequests.has(id)) return;
					pendingRequests.delete(id);
					if (pending.timer) clearTimeout(pending.timer);
					reject(error instanceof Error ? error : new Error(String(error)));
				},
			);
		}).then((response) => {
			if (!response.success) {
				throw new RpcCommandRejectedError(response.error || `RPC ${response.command} failed.`);
			}
			return response;
		});
	};

	const waitForAbortSettlement = (): Deferred<void> => {
		if (abortSettlement) throw new Error("Another RPC abort transition is already in progress.");
		abortSettlement = deferred<void>();
		return abortSettlement;
	};

	const abortAcceptedPrompt = async (): Promise<boolean> => {
		const acceptance = await initialPrompt.promise;
		if (!acceptance.accepted) return false;
		// Pi continues queued steering/follow-up messages after an abort. Drop
		// them first so a stopped run — or a later resume of its retained
		// thread — cannot be revived by stale queue entries. Best-effort: an
		// older child rejects the command and a hung child falls through to
		// the bounded abort below.
		try {
			const cleared = await send({ type: "clear_queue" }, RPC_CLEAR_QUEUE_TIMEOUT_MS);
			const data = cleared.data as { steering?: unknown; followUp?: unknown } | undefined;
			droppedQueuedCount =
				(Array.isArray(data?.steering) ? data.steering.length : 0) +
				(Array.isArray(data?.followUp) ? data.followUp.length : 0);
		} catch {
			/* abort below is the authoritative stop */
		}
		const stable = waitForAbortSettlement();
		try {
			await Promise.all([send({ type: "abort" }), stable.promise]);
			return true;
		} catch (error) {
			if (abortSettlement === stable) {
				abortSettlement = undefined;
				stable.resolve();
			}
			throw error;
		}
	};

	const attemptControl: AttemptControl = {
		async stop(reason = "Subagent was aborted"): Promise<void> {
			if (finished) {
				if (!closed) await processClosed.promise;
				return;
			}
			setAttemptPhase("interrupting");
			if (!initialPromptResolved) {
				const stopped = new Error(reason);
				resolveInitialPrompt(false, stopped);
				rejectPending(stopped);
			}
			let timer: ReturnType<typeof setTimeout> | undefined;
			const timeout = new Promise<boolean>((resolve) => {
				timer = setTimeout(() => resolve(false), RPC_ABORT_SETTLE_TIMEOUT_MS);
				if (typeof timer.unref === "function") timer.unref();
			});
			try {
				await Promise.race([abortAcceptedPrompt(), timeout]);
			} catch {
				/* process termination below is the bounded fallback */
			} finally {
				if (timer) clearTimeout(timer);
			}
			if (abortSettlement) {
				const stable = abortSettlement;
				abortSettlement = undefined;
				stable.resolve();
			}
			result.exitCode = 1;
			result.stopReason = "aborted";
			result.errorMessage =
				droppedQueuedCount > 0
					? `${reason} — dropped ${droppedQueuedCount} queued steering/follow-up message${droppedQueuedCount === 1 ? "" : "s"}`
					: reason;
			finish();
			// Even when RPC abort/settle times out, give Pi SIGTERM first so its
			// shutdown handler can reap detached tool process groups. terminate()
			// retains the hard-kill timer as the bounded fallback.
			terminate(false);
			if (!closed) await processClosed.promise;
		},
	};

	if (attemptToken !== undefined) control?.attach(attemptToken, attemptControl);
	if (proc.pid !== undefined) control?.noteChildPid(proc.pid);
	control?.markStarting();

	const processLine = (rawLine: string): void => {
		let line = rawLine;
		if (line.endsWith("\r")) line = line.slice(0, -1);
		if (!line.trim()) return;
		let event: any;
		try {
			event = JSON.parse(line);
		} catch {
			return;
		}

		if (event.type === "response" && typeof event.id === "string") {
			const pending = pendingRequests.get(event.id);
			if (pending) {
				pendingRequests.delete(event.id);
				clearTimeout(pending.timer);
				pending.resolve(event as RpcResponse);
				return;
			}
		}
		if (finished) return;

		if (
			[
				"agent_start",
				"agent_end",
				"turn_start",
				"turn_end",
				"message_start",
				"message_update",
				"message_end",
				"tool_execution_start",
				"tool_execution_update",
				"tool_execution_end",
				"auto_retry_start",
				"auto_retry_end",
				"agent_settled",
			].includes(event.type)
		) {
			result.rpcActivity = true;
		}

		// Let Pi's outer turn retry run. Grok/xAI long streams commonly drop with
		// a retryable `terminated` mid-turn; aborting that retry was misread as
		// "model unavailable" and handed a still-working model back to the parent.
		// After retries exhaust, dispatch still classifies a settled model-level
		// failure and hands off.

		// Child RPC mode exposes extension dialogs. Sub-agents are non-interactive:
		// cancel blocking dialogs so an unrelated child extension cannot deadlock.
		if (
			event.type === "extension_ui_request" &&
			typeof event.id === "string" &&
			["select", "confirm", "input", "editor"].includes(event.method)
		) {
			void writeLine({ type: "extension_ui_response", id: event.id, cancelled: true }).catch(() => undefined);
			return;
		}

		if (event.type === "agent_start") {
			resolveInitialPrompt(true);
			setAttemptPhase("running");
			emit({ kind: "status", status: "running" });
		}
		if (event.type === "turn_start") {
			setAttemptPhase("running");
		}

		if (event.type === "message_update") {
			const type = event.assistantMessageEvent?.type;
			if (type === "thinking_delta" || type === "text_delta") {
				emit({ kind: type === "thinking_delta" ? "thinking" : "text" });
			}
		}

		if (event.type === "tool_execution_start") {
			emit({
				kind: "tool_start",
				...(typeof event.toolCallId === "string" ? { toolCallId: event.toolCallId } : {}),
				toolName: event.toolName ?? "unknown",
				args: event.args,
			});
		}

		if (event.type === "tool_execution_end") {
			emit({
				kind: "tool_end",
				...(typeof event.toolCallId === "string" ? { toolCallId: event.toolCallId } : {}),
				toolName: event.toolName ?? "unknown",
				isError: Boolean(event.isError),
			});
			if (event.isError) {
				(result.failedTools ??= []).push({
					toolName: event.toolName ?? "unknown",
					error: extractToolErrorText(event.result?.content),
				});
			}
		}

		if (event.type === "message_end" && event.message) {
			const message = event.message as Message;
			result.messages.push(message);
			if (message.role === "assistant") {
				result.usage.turns++;
				const usage = (message as any).usage;
				if (usage) {
					result.usage.input += usage.input || 0;
					result.usage.output += usage.output || 0;
					result.usage.cacheRead += usage.cacheRead || 0;
					result.usage.cacheWrite += usage.cacheWrite || 0;
					result.usage.cost += usage.cost?.total || 0;
					result.usage.contextTokens = usage.totalTokens || 0;
				}
				if (!result.model && (message as any).model) result.model = (message as any).model;
				if ((message as any).stopReason) result.stopReason = (message as any).stopReason;
				if ((message as any).errorMessage) result.errorMessage = (message as any).errorMessage;
			}
			emit({ kind: "usage", usage: { ...result.usage }, model: result.model });
		}

		if (event.type === "agent_settled") {
			if (abortSettlement) {
				const stable = abortSettlement;
				abortSettlement = undefined;
				stable.resolve();
				return;
			}
			settleRun();
		}
	};

	proc.stdout?.on("data", (chunk: Buffer | string) => {
		lastActivityAt = Date.now();
		stdoutBuffer += typeof chunk === "string" ? chunk : stdoutDecoder.write(chunk);
		while (true) {
			const lf = stdoutBuffer.indexOf("\n");
			if (lf === -1) break;
			const line = stdoutBuffer.slice(0, lf);
			stdoutBuffer = stdoutBuffer.slice(lf + 1);
			processLine(line);
		}
	});

	proc.stderr?.on("data", (chunk: Buffer | string) => {
		result.stderr += typeof chunk === "string" ? chunk : stderrDecoder.write(chunk);
	});

	proc.stdin?.on("error", (error) => {
		if (finished) return;
		resolveInitialPrompt(false, error);
		result.exitCode = 1;
		result.stopReason = "error";
		result.errorMessage ??= `Subagent RPC stdin failed: ${error.message}`;
		result.dispatchFailed = true;
		finish();
		terminate();
	});

	proc.once("error", (error) => {
		if (finished) return;
		resolveInitialPrompt(false, error);
		result.exitCode = 1;
		result.stopReason = "error";
		result.errorMessage ??= `Failed to start the sub-agent process: ${error.message}`;
		result.dispatchFailed = true;
		finish();
	});

	proc.once("close", (code) => {
		closed = true;
		resolveInitialPrompt(false, new Error(`Subagent RPC process exited before the initial prompt was accepted (code=${code ?? "signal"}).`));
		if (forceKillTimer) clearTimeout(forceKillTimer);
		stdoutBuffer += stdoutDecoder.end();
		result.stderr += stderrDecoder.end();
		if (stdoutBuffer.length > 0) processLine(stdoutBuffer);
		const exitError = new Error(
			`Subagent RPC process exited before settling (code=${code ?? "signal"}).${result.stderr ? ` ${result.stderr.trim()}` : ""}`,
		);
		rejectPending(exitError);
		if (abortSettlement) {
			abortSettlement.reject(exitError);
			abortSettlement = undefined;
		}
		if (!finished) {
			result.exitCode = code === 0 ? 1 : (code ?? 1);
			result.stopReason ??= signal?.aborted ? "aborted" : "error";
			if (signal?.aborted) result.errorMessage ??= "Subagent was aborted";
			finish();
		}
		processClosed.resolve();
	});

	if (idleTimeoutMs > 0) {
		const checkInterval = Math.max(1, Math.min(10_000, Math.floor(idleTimeoutMs / 3)));
		idleTimer = setInterval(() => {
			if (finished || closed) return;
			if (Date.now() - lastActivityAt >= idleTimeoutMs) {
				result.exitCode = 1;
				result.stopReason = "error";
				result.errorMessage = `Subagent idle timeout: no activity for ${Math.ceil(idleTimeoutMs / 1000)} seconds.`;
				finish();
				terminate();
			}
		}, checkInterval);
	}

	if (signal) {
		abortHandler = () => {
			void attemptControl.stop("Subagent was aborted").catch(() => undefined);
		};
		if (signal.aborted) abortHandler();
		else signal.addEventListener("abort", abortHandler, { once: true });
	}

	try {
		if (control?.isStopRequested()) {
			resolveInitialPrompt(false, new Error("Run was stopped before its initial prompt."));
			await attemptControl.stop();
		} else {
			const failBeforePrompt = (error: Error, startup: boolean): void => {
				resolveInitialPrompt(false, error);
				if (finished) return;
				result.exitCode = 1;
				result.stopReason = "error";
				result.errorMessage = error.message;
				if (startup) result.rpcStartupFailed = true;
				else if (error instanceof RpcCommandRejectedError) result.rpcPromptRejected = true;
				finish();
				terminate();
			};
			try {
				await send({ type: "get_state" }, readyTimeoutMs);
			} catch (error) {
				const handshakeError = error instanceof Error ? error : new Error(String(error));
				if (!control?.isStopRequested()) {
					failBeforePrompt(handshakeError, true);
				} else {
					resolveInitialPrompt(false, handshakeError);
				}
			}
			if (!finished && !initialPromptResolved && !control?.isStopRequested()) {
				// Pi starts the agent immediately after prompt preflight, before its
				// success response necessarily reaches stdout. From this point on, a
				// missing ACK is ambiguous and must never be recovered by replay.
				result.rpcPromptDispatched = true;
				void send({ type: "prompt", message: asPlainTextRpcPrompt(options.prompt) }).then(
					() => resolveInitialPrompt(true),
					(error) => {
						const promptError = error instanceof Error ? error : new Error(String(error));
						failBeforePrompt(promptError, false);
					},
				);
			}
		}
		await outcome.promise;
		terminate();
		if (!closed) await processClosed.promise;
		return result;
	} finally {
		if (attemptToken !== undefined) control?.detach(attemptToken);
		if (tmpPromptPath) {
			try {
				unlinkSync(tmpPromptPath);
			} catch {
				/* ignore */
			}
		}
		if (tmpPromptDir) {
			try {
				rmdirSync(tmpPromptDir);
			} catch {
				/* ignore */
			}
		}
		await rm(retryPolicy.dir, { recursive: true, force: true }).catch(() => undefined);
	}
}
