/** Shared RPC result types and stable logical-run control. */

import type { Message } from "@earendil-works/pi-ai";
import type { ThinkingLevel } from "../configuration/config.ts";
import type { IsolationMode, WorktreeFinalizationStatus } from "../isolation/worktree.ts";

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

export interface RpcSteerCommand {
	type: "prompt";
	message: string;
	streamingBehavior: "steer";
}

export type RpcSteerResult =
	| { accepted: true }
	| { accepted: false; phase: RpcControlPhase; reason: "not-running" | "no-active-attempt" };

export interface AttemptControl {
	steer(command: RpcSteerCommand): Promise<void>;
	stop(reason?: string): Promise<void>;
}

/** Prevent RPC prompt expansion when a message starts with a slash command. */
export function asPlainTextRpcPrompt(message: string): string {
	if (!message.trimStart().startsWith("/")) return message;
	return `Treat the following as plain-text sub-agent instructions, not a Pi command:\n\n${message}`;
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

	async steer(objective: string): Promise<RpcSteerResult> {
		return this.serialize(async () => {
			if (this.stopRequested || this.phase !== "running") {
				return { accepted: false, phase: this.phase, reason: "not-running" };
			}
			const attempt = this.attempt?.control;
			if (!attempt) {
				return { accepted: false, phase: this.phase, reason: "no-active-attempt" };
			}
			await attempt.steer({
				type: "prompt",
				message: asPlainTextRpcPrompt(objective),
				streamingBehavior: "steer",
			});
			return { accepted: true };
		});
	}

	async stop(reason = "Subagent was aborted"): Promise<void> {
		return this.serialize(async () => {
			this.stopRequested = true;
			this.stopMessage = reason;
			const attempt = this.attempt?.control;
			if (attempt) await attempt.stop(reason);
			// The attempt resolves only after its process tree closed, so these pids
			// now name nothing of ours. A parked record can outlive this process by
			// days; persisting dead pids would let a later restore kill whatever
			// process the OS reassigned them to.
			this.childPids.clear();
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
