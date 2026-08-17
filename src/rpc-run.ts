/*
 * Persistent pi RPC child transport for one logical sub-agent generation.
 *
 * A child stays alive across prompt/steer/abort/retarget operations and speaks
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
import type { AgentConfig, AgentSource } from "./agents.ts";
import type { ThinkingLevel } from "./config.ts";
import type { IsolationMode, WorktreeFinalizationStatus } from "./worktree.ts";

export const DEPTH_ENV_VAR = "PI_SUBAGENT_DEPTH";
export const SUBAGENT_KILL_GRACE_MS = 5_000;
export const RPC_COMMAND_TIMEOUT_MS = 30_000;
export const RPC_ABORT_SETTLE_TIMEOUT_MS = 5_000;

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
	agentSource: AgentSource | "unknown";
	task: string;
	exitCode: number;
	messages: Message[];
	stderr: string;
	usage: UsageStats;
	model?: string;
	thinking?: string;
	stopReason?: string;
	errorMessage?: string;
	/** Primary model when this result came from a later candidate in its configured pool. */
	modelFallbackFrom?: string;
	dispatchFailed?: boolean;
	/** An accepted generation failed because an RPC prompt was rejected before
	 * model execution. This remains model-candidate retry/fallback eligible even
	 * when an earlier, aborted objective left assistant text in the session. */
	rpcPromptRejected?: boolean;
	startupRetries?: number;
	modelRetries?: number;
	failedTools?: Array<{ toolName: string; error: string }>;
	sessionId?: string;
	sessionDir?: string;
	resumed?: boolean;
	/** Internal disposition: dispatch suppresses completion delivery for parks. */
	parked?: boolean;
	/** Stable logical run id assigned by dispatch (also present on queued results). */
	runId?: number;
	/** Filesystem isolation selected for this logical thread. */
	isolation?: IsolationMode;
	/** Original parent cwd; isolated children execute at isolationCwd instead. */
	originalCwd?: string;
	isolationCwd?: string;
	/** Final integration state for a worktree-isolated settlement. */
	integrationStatus?: "pending" | WorktreeFinalizationStatus;
	integrationApplied?: boolean;
	integrationError?: string;
	/** Retained only when integration/cleanup failed; never contains patch data. */
	integrationWorktreePath?: string;
	integrationPatchPath?: string;
	/** Session-fork relationships between stable logical run ids. */
	forkedFromRunId?: number;
	forkChildRunIds?: number[];
}

export type SubagentLiveEvent =
	| { kind: "status"; status: "queued" | "running" | "steering" | "interrupting" | "parked" | "done" | "failed" }
	| { kind: "model"; model?: string; fallbackFrom?: string }
	| { kind: "usage"; usage: UsageStats; model?: string }
	| { kind: "tool_start"; toolCallId?: string; toolName: string; args: unknown }
	| { kind: "tool_end"; toolCallId?: string; toolName: string; isError: boolean }
	| { kind: "thinking" }
	| { kind: "text" };

/** Carries the actual streamed payload (dropped by the plain text/thinking
 * live events). Emitted in addition to the aliveness events so monitor
 * observers stay unchanged while the inspector can apply its rolling budget
 * without silently losing part of a transport delta. */
export interface SubagentRecordEvent {
	kind: "thinking" | "text";
	delta: string;
}

export type RpcControlPhase =
	| "queued"
	| "starting"
	| "running"
	| "steering"
	| "interrupting"
	| "retrying"
	| "parked"
	| "settled"
	| "stopped";

interface AttemptControl {
	steer(instruction: string): Promise<void>;
	retarget(objective: string): Promise<void>;
	park(): Promise<void>;
	stop(reason?: string): Promise<void>;
}

/**
 * Stable control surface for a logical run generation. Retry/fallback attempts
 * attach and detach beneath it, so callers never retain a stale child handle.
 * Control calls are serialized to prevent overlapping abort/settle/prompt flows.
 */
export class RpcRunControl {
	private objective: string;
	private phase: RpcControlPhase = "queued";
	private attempt?: { token: number; control: AttemptControl };
	private nextToken = 1;
	private serial: Promise<void> = Promise.resolve();
	private parkRequested = false;
	private stopRequested = false;
	private stopMessage = "Subagent was aborted";

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

	isParkRequested(): boolean {
		return this.parkRequested;
	}

	isStopRequested(): boolean {
		return this.stopRequested;
	}

	getStopMessage(): string {
		return this.stopMessage;
	}

	/** Update a not-yet-started/retrying objective without launching a process. */
	retargetPending(objective: string): void {
		this.objective = objective;
	}

	/** Mark queued/starting work for park without waiting on an RPC abort event. */
	parkPending(): void {
		this.parkRequested = true;
		this.setPhase("parked");
	}

	markQueued(): void {
		this.setPhase("queued");
	}

	markStarting(): void {
		this.setPhase("starting");
	}

	markRetrying(): void {
		if (!this.parkRequested && !this.stopRequested) this.setPhase("retrying");
	}

	markSettled(): void {
		this.attempt = undefined;
		if (!this.parkRequested && !this.stopRequested) this.setPhase("settled");
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

	async steer(instruction: string): Promise<void> {
		return this.serialize(async () => {
			const attempt = this.attempt?.control;
			if (!attempt) throw new Error(`Thread is ${this.phase}; steering requires a running child.`);
			await attempt.steer(instruction);
		});
	}

	async retarget(objective: string): Promise<void> {
		return this.serialize(async () => {
			this.objective = objective;
			const attempt = this.attempt?.control;
			if (!attempt) return;
			await attempt.retarget(objective);
		});
	}

	async park(): Promise<void> {
		return this.serialize(async () => {
			this.parkRequested = true;
			const attempt = this.attempt?.control;
			if (attempt) await attempt.park();
			this.setPhase("parked");
		});
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

async function writePromptToTempFile(agentName: string, prompt: string): Promise<{ dir: string; filePath: string }> {
	const dir = await mkdtemp(join(tmpdir(), "pi-subagents-"));
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

interface PendingRequest {
	resolve: (response: RpcResponse) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout>;
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
	/** Receives the raw streamed deltas; observer errors are swallowed. */
	onRecord?: (event: SubagentRecordEvent) => void;
	env?: NodeJS.ProcessEnv;
	control?: RpcRunControl;
}

/** Run one persistent RPC child until a stable `agent_settled` or control action. */
export async function runRpcAgentAttempt(options: RunRpcAttemptOptions): Promise<RpcSingleResult> {
	const { agent, agentName, task, thinkingLevel, idleTimeoutMs, signal, onLive, onRecord, control } = options;
	const args: string[] = ["--mode", "rpc", "--exclude-tools", "subagent,subagent_control"];
	if (options.sessionDir && options.sessionId) {
		args.push("--session-dir", options.sessionDir);
		args.push(sessionExists(options.sessionDir, options.sessionId) ? "--session" : "--session-id", options.sessionId);
	} else {
		args.push("--no-session");
	}
	if (agent.model) args.push("--model", agent.model);
	args.push("--thinking", thinkingLevel);
	if (agent.tools && agent.tools.length > 0) args.push("--tools", agent.tools.join(","));

	let tmpPromptDir: string | null = null;
	let tmpPromptPath: string | null = null;
	if (agent.systemPrompt.trim()) {
		const tmp = await writePromptToTempFile(agent.name, agent.systemPrompt);
		tmpPromptDir = tmp.dir;
		tmpPromptPath = tmp.filePath;
		args.push("--append-system-prompt", tmpPromptPath);
	}

	const resumed = Boolean(
		options.sessionDir && options.sessionId && sessionExists(options.sessionDir, options.sessionId),
	);
	const result: RpcSingleResult = {
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
		resumed,
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
	let initialPromptResolved = false;
	const initialPrompt = deferred<{ accepted: boolean; error?: Error }>();
	let continuationCommandInFlight = false;
	let continuationAccepted = false;
	let continuationTurnStarted = false;
	let continuationTurnCompleted = false;
	let deferredAgentSettlement = false;
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

	const emitRecord = (event: SubagentRecordEvent): void => {
		try {
			onRecord?.(event);
		} catch {
			/* record observers must never break protocol handling */
		}
	};

	const setAttemptPhase = (phase: RpcControlPhase): void => {
		if (attemptToken !== undefined) control?.updateAttemptPhase(attemptToken, phase);
		switch (phase) {
			case "running":
			case "steering":
			case "interrupting":
			case "parked":
				emit({ kind: "status", status: phase });
				break;
		}
	};

	const rejectPending = (error: Error): void => {
		for (const request of pendingRequests.values()) {
			clearTimeout(request.timer);
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

	const writeLine = (value: object): void => {
		if (!proc.stdin || proc.stdin.destroyed || !proc.stdin.writable) {
			throw new Error("Subagent RPC stdin is not writable.");
		}
		// JSON strings may contain U+2028/U+2029. Only the final ASCII LF frames a
		// record; never use a generic line reader on the receiving side.
		proc.stdin.write(`${JSON.stringify(value)}\n`, "utf8");
	};

	const send = async (command: Record<string, unknown>): Promise<RpcResponse> => {
		if (finished || closed) throw new Error("Subagent RPC process is no longer active.");
		const id = `req_${++requestId}`;
		return new Promise<RpcResponse>((resolve, reject) => {
			const timer = setTimeout(() => {
				pendingRequests.delete(id);
				reject(new Error(`Timed out waiting for RPC response to ${String(command.type)}.`));
			}, RPC_COMMAND_TIMEOUT_MS);
			if (typeof timer.unref === "function") timer.unref();
			pendingRequests.set(id, { resolve, reject, timer });
			try {
				writeLine({ ...command, id });
			} catch (error) {
				pendingRequests.delete(id);
				clearTimeout(timer);
				reject(error instanceof Error ? error : new Error(String(error)));
			}
		}).then((response) => {
			if (!response.success) throw new Error(response.error || `RPC ${response.command} failed.`);
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
		async steer(instruction: string): Promise<void> {
			if (finished) throw new Error("Thread already settled before it could be steered.");
			const acceptance = await initialPrompt.promise;
			if (!acceptance.accepted) throw acceptance.error ?? new Error("The initial prompt was rejected.");
			setAttemptPhase("steering");
			// Prompt+streamingBehavior performs the active→steer / idle→new-prompt
			// choice atomically inside Pi. Hold any old agent_settled event until this
			// command is accepted so an extension-handler race cannot drop the steer.
			continuationCommandInFlight = true;
			continuationAccepted = false;
			continuationTurnStarted = false;
			continuationTurnCompleted = false;
			deferredAgentSettlement = false;
			try {
				await send({ type: "prompt", message: asPlainTextRpcPrompt(instruction), streamingBehavior: "steer" });
				continuationAccepted = true;
				if (deferredAgentSettlement && !continuationTurnStarted) {
					// A handled input can succeed without starting a turn. Confirm the
					// server is idle before consuming the delayed settlement.
					const state = await send({ type: "get_state" }).catch(() => undefined);
					if ((state?.data as { isStreaming?: unknown } | undefined)?.isStreaming === false) {
						continuationAccepted = false;
						deferredAgentSettlement = false;
						settleRun();
					}
				}
			} catch (error) {
				continuationAccepted = false;
				if (deferredAgentSettlement) {
					deferredAgentSettlement = false;
					settleRun();
				}
				throw error;
			} finally {
				continuationCommandInFlight = false;
			}
			// Remain visibly steering until the next turn starts.
		},
		async retarget(objective: string): Promise<void> {
			if (finished) throw new Error("Thread already settled before it could be retargeted.");
			setAttemptPhase("interrupting");
			result.task = objective;
			const accepted = await abortAcceptedPrompt();
			if (!accepted) {
				if (!closed) await processClosed.promise;
				return;
			}
			if (finished || closed) throw new Error("Thread exited while retargeting.");
			// The aborted assistant message remains in the retained session/history,
			// but it must not classify the replacement objective as aborted.
			result.stopReason = undefined;
			result.errorMessage = undefined;
			result.exitCode = 0;
			// Tool failures belong to the abandoned objective. Keep them in session
			// history, but do not classify a successful replacement as failed.
			result.failedTools = undefined;
			try {
				await send({ type: "prompt", message: asPlainTextRpcPrompt(objective) });
				setAttemptPhase("running");
			} catch (error) {
				const promptError = error instanceof Error ? error : new Error(String(error));
				result.exitCode = 1;
				result.stopReason = "error";
				result.errorMessage = `Replacement prompt was rejected: ${promptError.message}`;
				result.rpcPromptRejected = true;
				finish();
				terminate();
				if (!closed) await processClosed.promise;
				throw promptError;
			}
		},
		async park(): Promise<void> {
			if (finished) {
				if (!closed) await processClosed.promise;
				throw new Error("Thread already settled before it could be parked.");
			}
			setAttemptPhase("interrupting");
			const accepted = await abortAcceptedPrompt();
			if (!accepted && !closed) await processClosed.promise;
			if (finished && accepted) throw new Error("Thread exited while parking.");
			result.parked = true;
			result.exitCode = 0;
			result.stopReason = undefined;
			result.errorMessage = undefined;
			setAttemptPhase("parked");
			finish();
			terminate();
			if (!closed) await processClosed.promise;
		},
		async stop(reason = "Subagent was aborted"): Promise<void> {
			if (finished) {
				if (!closed) await processClosed.promise;
				return;
			}
			setAttemptPhase("interrupting");
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
			result.errorMessage = reason;
			finish();
			// Even when RPC abort/settle times out, give Pi SIGTERM first so its
			// shutdown handler can reap detached tool process groups. terminate()
			// retains the hard-kill timer as the bounded fallback.
			terminate(false);
			if (!closed) await processClosed.promise;
		},
	};

	if (attemptToken !== undefined) control?.attach(attemptToken, attemptControl);
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

		// Child RPC mode exposes extension dialogs. Sub-agents are non-interactive:
		// cancel blocking dialogs so an unrelated child extension cannot deadlock.
		if (
			event.type === "extension_ui_request" &&
			typeof event.id === "string" &&
			["select", "confirm", "input", "editor"].includes(event.method)
		) {
			try {
				writeLine({ type: "extension_ui_response", id: event.id, cancelled: true });
			} catch {
				/* process failure is handled by close/error */
			}
			return;
		}

		if (event.type === "agent_start") {
			resolveInitialPrompt(true);
			setAttemptPhase("running");
			emit({ kind: "status", status: "running" });
		}
		if (event.type === "turn_start") {
			if (continuationCommandInFlight || continuationAccepted) {
				continuationTurnStarted = true;
			}
			setAttemptPhase("running");
		}
		if (event.type === "turn_end" && continuationTurnStarted) {
			continuationTurnCompleted = true;
			deferredAgentSettlement = false;
		}

		if (event.type === "message_update") {
			const type = event.assistantMessageEvent?.type;
			if (type === "thinking_delta" || type === "text_delta") {
				emit({ kind: type === "thinking_delta" ? "thinking" : "text" });
				const delta = event.assistantMessageEvent?.delta;
				if (typeof delta === "string" && delta) {
					// TranscriptBuffer owns the complete rolling-budget decision. Truncating
					// one RPC delta here would silently lose text without setting its flag.
					emitRecord({ kind: type === "thinking_delta" ? "thinking" : "text", delta });
				}
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
			if ((continuationCommandInFlight || continuationAccepted) && !continuationTurnCompleted) {
				// Pi may emit an old settlement while an extension handler is yielding
				// and the atomic prompt command starts the continuation. Its successful
				// response guarantees a new/queued turn, so defer this stale event until
				// that continuation has completed a turn.
				deferredAgentSettlement = true;
				return;
			}
			continuationAccepted = false;
			continuationTurnStarted = false;
			continuationTurnCompleted = false;
			deferredAgentSettlement = false;
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
		if (control?.isParkRequested()) {
			resolveInitialPrompt(false, new Error("Run was parked before its initial prompt."));
			result.parked = true;
			result.exitCode = 0;
			finish();
			terminate();
		} else if (control?.isStopRequested()) {
			resolveInitialPrompt(false, new Error("Run was stopped before its initial prompt."));
			await attemptControl.stop();
		} else {
			void send({ type: "prompt", message: asPlainTextRpcPrompt(options.prompt) }).then(
				() => resolveInitialPrompt(true),
				(error) => {
					const promptError = error instanceof Error ? error : new Error(String(error));
					resolveInitialPrompt(false, promptError);
					if (finished) return;
					result.exitCode = 1;
					result.stopReason = "error";
					result.errorMessage = promptError.message;
					result.rpcPromptRejected = true;
					finish();
					terminate();
				},
			);
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
	}
}
