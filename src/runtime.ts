/**
 * Shared per-session runtime state for pi-subagents.
 *
 * The extension registers several tools (subagent, subagent_wait/status/stop)
 * that share the background queue, completion batcher, abort controllers per
 * run, and settled-results store.
 * `createRuntime` builds those once per extension load and hands the same object
 * to every registration site, so state stays in one place without globals.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { rmSync } from "node:fs";
import { BackgroundTaskQueue } from "./background.ts";
import {
	completionGroupTriggersTurn,
	createCompletionBatcher,
	formatActiveRunsFooter,
	formatCompletionMessage,
	type CompletionBatcher,
	type CompletionMessageItem,
} from "./completion.ts";
import { loadConfigSync, type ThinkingLevel } from "./config.ts";
import { isRunActiveStatus, monitor } from "./monitor.ts";
import {
	persistRecoveryRecords,
	recoveryRecordFromFinalization,
	type RecoveryRecord,
} from "./recovery.ts";
import type { RpcRunControl } from "./rpc-run.ts";
import type { SingleResult } from "./spawn.ts";
import type { IsolationMode, WorktreeFinalization, WorktreeIsolation } from "./worktree.ts";

export type ThreadState =
	| "queued"
	| "resuming"
	| "running"
	| "steering"
	| "interrupting"
	| "parked"
	| "completed"
	| "failed"
	| "stopped";

export type ThreadLifecycleOperation = "park" | "resume" | "fork" | "stop" | "settle";

export interface SubagentThread {
	id: number;
	generation: number;
	agentName: string;
	task: string;
	/** Caller-facing cwd in the original worktree. */
	cwd: string;
	/** Actual child cwd (the equivalent path inside an isolated worktree). */
	executionCwd: string;
	vision: boolean;
	/** Exact primary→fallback refs inherited by a session fork. */
	modelPool: string[];
	thinkingLevel?: ThinkingLevel;
	isolation: IsolationMode;
	worktree?: WorktreeIsolation;
	state: ThreadState;
	control: RpcRunControl;
	queueController?: AbortController;
	/** Resolves only after the current generation's queue work has fully
	 * quiesced and released its concurrency slot. Auto-fix orchestration is part
	 * of the parent generation and replaces/extends this promise. */
	generationCompletion: Promise<void>;
	/** Synchronous CAS used by lifecycle controls across their async preflight. */
	lifecycleVersion: number;
	lifecycleOperation?: ThreadLifecycleOperation;
	sessionId?: string;
	sessionDir?: string;
	/** Most recent generation result, retained for parked destructive-stop output. */
	lastResult?: SingleResult;
	/** A destructive stop retires context even if the active child settles later. */
	retireOnSettle?: boolean;
	retired?: boolean;
	/** Abort the active generation to a stable checkpoint and wait until its
	 * queue work has published that checkpoint and released its slot. */
	park: () => Promise<"queued" | "active">;
	/** Installed by dispatch so the control tool can restart the same logical id. */
	resume: (objective?: string, ctx?: ExtensionContext) => Promise<SingleResult>;
	/** Create a new logical thread from this thread's retained Pi session branch. */
	fork: (objective?: string, ctx?: ExtensionContext) => Promise<SingleResult>;
	forkedFromRunId?: number;
	forkChildRunIds: number[];
	/** Dispatch-owned, generation-guarded worktree settlement hook. */
	finalizeIsolation: (generation: number, result?: SingleResult) => Promise<WorktreeFinalization | undefined>;
	/** Best-effort shutdown notification for retained integration artifacts. */
	notifyIsolationFailure?: (finalization: WorktreeFinalization) => void;
	isolationFailureNotified?: boolean;
}

export interface SubagentRuntime {
	configPath: string;
	backgroundQueue: BackgroundTaskQueue;
	/** False after session_shutdown; guards delivery and queue work. */
	sessionActive: boolean;
	/** Deliver a batch of completion messages to the main window, waking it only
	 * when the batch needs a turn. */
	sendCompletionGroup: (items: CompletionMessageItem[]) => void;
	completionBatcher: CompletionBatcher<CompletionMessageItem>;
	/** Abort controllers per active run, so subagent_stop can cancel a run in-turn. */
	runControllers: Map<number, AbortController>;
	/** Final results keyed by run id, so subagent_wait can hand the model the
	 * actual result in-turn instead of it sleeping/polling for a wake-up message. */
	settledRuns: Map<number, SingleResult>;
	settledListeners: Map<number, Set<(result: SingleResult) => void>>;
	registerRunResult: (runId: number, result: SingleResult) => void;
	/** Logical threads outlive process attempts and completed generations. */
	threads: Map<number, SubagentThread>;
	/** Resume/fork setup that has claimed a thread but has not yet enqueued its
	 * next generation. Shutdown invalidates these claims and waits for cleanup. */
	preflightOperations: Set<Promise<void>>;
	/** Every session directory retained for this parent session, including
	 * auto-fix internals that are not directly controllable. */
	sessionDirs: Set<string>;
	retainSession: (result: Pick<SingleResult, "sessionDir">) => void;
	retireThreadSession: (thread: SubagentThread) => void;
	/** Flip sessionActive off and release all session-scoped resources. */
	shutdown: () => Promise<void>;
}

export function createRuntime(pi: ExtensionAPI, configPath: string): SubagentRuntime {
	// Init-time decisions need the config synchronously; the full (migrating)
	// async load runs per tool call.
	const initialConfig = loadConfigSync(configPath);
	const backgroundQueue = new BackgroundTaskQueue(initialConfig.maxConcurrency);

	const runtime: SubagentRuntime = {
		configPath,
		backgroundQueue,
		sessionActive: true,
		sendCompletionGroup: (items) => {
			if (!runtime.sessionActive || items.length === 0) return;
			// A result arriving for one run does not mean sibling runs are done.
			// Computing this at delivery (emit) time — not when the item was
			// pushed — reflects the current monitor state, since finishing runs
			// are removed from the monitor before their completion is pushed.
			// Auto-fix parents are flipped back to "running" while their chain
			// owns the logical run, so they are included without a special case.
			const active = monitor
				.getRuns()
				.filter((run) => isRunActiveStatus(run.status))
				.map((run) => ({ id: run.id, agent: run.agent, label: run.label }));
			const message = {
				customType: "subagent-result",
				content: formatCompletionMessage(items) + formatActiveRunsFooter(active),
				display: true,
			};
			if (completionGroupTriggersTurn(items)) {
				// steer: the result is injected after the current tool call even mid-turn,
				// or starts a new turn when idle. followUp would sit in the queue until the
				// whole turn ends — a main agent waiting for the result (sleep/poll) would
				// never see it delivered, which is exactly the "returned but never woken"
				// failure mode.
				pi.sendMessage(message, { deliverAs: "steer", triggerTurn: true });
			} else {
				// No-wake delivery: nextTurn rides along with the next user turn and can
				// never start a continuation by itself. followUp would auto-continue
				// whenever pi is already streaming, defeating the opt-out.
				pi.sendMessage(message, { deliverAs: "nextTurn" });
			}
		},
		completionBatcher: undefined as unknown as CompletionBatcher<CompletionMessageItem>,
		runControllers: new Map<number, AbortController>(),
		settledRuns: new Map<number, SingleResult>(),
		settledListeners: new Map<number, Set<(result: SingleResult) => void>>(),
		threads: new Map<number, SubagentThread>(),
		preflightOperations: new Set<Promise<void>>(),
		sessionDirs: new Set<string>(),
		retainSession: (result) => {
			if (result.sessionDir) runtime.sessionDirs.add(result.sessionDir);
		},
		retireThreadSession: (thread) => {
			thread.retired = true;
			if (!thread.sessionDir) return;
			const sessionDir = thread.sessionDir;
			try {
				rmSync(sessionDir, { recursive: true, force: true });
				runtime.sessionDirs.delete(sessionDir);
				thread.sessionDir = undefined;
				thread.sessionId = undefined;
			} catch {
				/* best-effort; shutdown retries the still-retained directory */
			}
		},
		registerRunResult: (runId, result) => {
			runtime.settledRuns.set(runId, result);
			const listeners = runtime.settledListeners.get(runId);
			if (listeners) {
				runtime.settledListeners.delete(runId);
				for (const listener of listeners) {
					try {
						listener(result);
					} catch {
						/* listener errors must never break settling */
					}
				}
			}
		},
		shutdown: async () => {
			if (!runtime.sessionActive) return;
			runtime.sessionActive = false;
			const shutdownThreads = [...runtime.threads.values()];
			// Invalidate every lifecycle claim synchronously before the first await.
			// Resume/fork preflight checks both this version and sessionActive, then
			// cleans any worktree/session it created before resolving its tracker.
			for (const thread of shutdownThreads) {
				thread.lifecycleVersion++;
				thread.lifecycleOperation = "stop";
				thread.retired = true;
				thread.retireOnSettle = true;
				thread.state = "stopped";
			}
			const preflights = [...runtime.preflightOperations];
			runtime.completionBatcher.dispose();
			runtime.backgroundQueue.cancelAll();
			// Await live RPC process-tree cleanup and continuation preflight rollback
			// before removing sessions/worktrees or clearing ownership maps.
			await Promise.all([
				Promise.all(
					shutdownThreads.map((thread) =>
						thread.control.stop("Parent session shut down").catch(() => undefined),
					),
				),
				Promise.allSettled(preflights),
				runtime.backgroundQueue.waitForIdle(),
			]);
			// Parked work owns no queue task, so shutdown is its final settlement.
			// Active/stopped tasks may already have finalized; the handle and callback
			// are idempotent and generation-guarded.
			const recoveryRecords: RecoveryRecord[] = [];
			for (const thread of runtime.threads.values()) {
				const finalization = await thread.finalizeIsolation(thread.generation).catch(() => undefined);
				if (finalization?.status === "retained") {
					recoveryRecords.push(recoveryRecordFromFinalization(thread.id, finalization));
					if (!thread.isolationFailureNotified) {
						thread.isolationFailureNotified = true;
						try {
							thread.notifyIsolationFailure?.(finalization);
						} catch {
							/* the parent UI may already be shutting down */
						}
					}
				}
			}
			// Persist before tearing down the old runtime. A /new, /resume, or quit
			// must not make the only recovery paths unreachable.
			await persistRecoveryRecords(runtime.configPath, recoveryRecords).catch(() => undefined);
			runtime.settledRuns.clear();
			runtime.settledListeners.clear();
			runtime.runControllers.clear();
			for (const sessionDir of runtime.sessionDirs) {
				try {
					rmSync(sessionDir, { recursive: true, force: true });
				} catch {
					/* best-effort */
				}
			}
			runtime.sessionDirs.clear();
			runtime.preflightOperations.clear();
			runtime.threads.clear();
			monitor.clear();
		},
	};

	runtime.completionBatcher = createCompletionBatcher<CompletionMessageItem>({
		emit: runtime.sendCompletionGroup,
	});
	return runtime;
}
