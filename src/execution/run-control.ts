/** Shared one-shot result types and stable logical-run control. */

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

export interface RunResult {
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
	/** Pi emitted agent, message, or tool activity for this attempt. */
	activityObserved?: boolean;
	failedTools?: Array<{ toolName: string; error: string }>;
	sessionId?: string;
	sessionDir?: string;
	/** Full completion artifact, when presentation truncated the result. */
	resultFile?: string;
	/** Original task/project cwd used for result-artifact retention buckets. */
	projectCwd?: string;
	/** Stable logical run id assigned by dispatch (also present on queued results). */
	runId?: number;
	/** Filesystem isolation selected for this logical thread. */
	isolation?: IsolationMode;
	/** Why automatic isolation used the caller's directory instead. */
	isolationNote?: string;
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

export type RunControlPhase =
	| "queued"
	| "starting"
	| "running"
	| "interrupting"
	| "settled"
	| "stopped";

export interface AttemptControl {
	stop(reason?: string): Promise<void>;
	steer?(message: string): Promise<void>;
}

/** Prevent CLI prompt expansion when a message starts with a slash command. */
export function asPlainTextPrompt(message: string): string {
	if (!message.trimStart().startsWith("/")) return message;
	return `Treat the following as plain-text sub-agent instructions, not a Pi command:\n\n${message}`;
}

/**
 * Stable control surface for a logical run generation. Startup/main-handoff attempts
 * attach and detach beneath it, so callers never retain a stale child handle.
 * Control calls are serialized to prevent overlapping stop and settlement flows.
 */
export class RunControl {
	private objective: string;
	private phase: RunControlPhase = "queued";
	private attempt?: { token: number; control: AttemptControl };
	private nextToken = 1;
	private serial: Promise<void> = Promise.resolve();
	private stopRequested = false;
	private stopMessage = "Subagent was aborted";
	private childPids = new Set<number>();
	readonly generation: number;
	private readonly onPhase?: (phase: RunControlPhase) => void;

	constructor(
		objective: string,
		generation: number,
		onPhase?: (phase: RunControlPhase) => void,
	) {
		this.objective = objective;
		this.generation = generation;
		this.onPhase = onPhase;
	}

	getObjective(): string {
		return this.objective;
	}

	getPhase(): RunControlPhase {
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

	updateAttemptPhase(token: number, phase: RunControlPhase): void {
		if (this.attempt?.token !== token) return;
		this.setPhase(phase);
	}

	async steer(message: string): Promise<void> {
		if (this.stopRequested || this.phase !== "running" || !this.attempt?.control.steer) {
			throw new Error("This run is not accepting steering messages.");
		}
		await this.attempt.control.steer(message);
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

	private setPhase(phase: RunControlPhase): void {
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
