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
import { resolveSubagentConcurrency, BackgroundTaskQueue } from "./background.ts";
import {
	completionGroupTriggersTurn,
	createCompletionBatcher,
	formatActiveRunsFooter,
	formatCompletionMessage,
	type CompletionBatcher,
	type CompletionMessageItem,
} from "./completion.ts";
import { type ThinkingLevel } from "./config.ts";
import { removeThreadRecord, threadRecordFromThread, upsertThreadRecord, type ThreadRecord } from "./durable.ts";
import { isRunActiveStatus, monitor } from "./monitor.ts";
import type { RpcRunControl } from "./rpc-run.ts";
import type { StartBackgroundInternal } from "./thread-lifecycle.ts";
import { isFailedResult, type SingleResult } from "./spawn.ts";
import type { IsolationMode, WorktreeFinalization, WorktreeIsolation } from "./worktree.ts";

export type ThreadState =
	| "queued"
	| "resuming"
	| "running"
	| "interrupting"
	| "parked"
	| "completed"
	| "failed"
	| "stopped";

export type ThreadLifecycleOperation = "park" | "resume" | "stop" | "settle";

export interface SubagentThread {
	id: number;
	generation: number;
	agentName: string;
	task: string;
	/** Caller-facing cwd in the original worktree. */
	cwd: string;
	/** Actual child cwd (the equivalent path inside an isolated worktree). */
	executionCwd: string;
	thinkingLevel?: ThinkingLevel;
	isolation: IsolationMode;
	worktree?: WorktreeIsolation;
	state: ThreadState;
	control: RpcRunControl;
	queueController?: AbortController;
	/** Resolves only after the current generation's top-level child, downstream
	 * managed workflow, and queue work have fully quiesced and released their
	 * concurrency slot. */
	generationCompletion: Promise<void>;
	/** Synchronous CAS used by lifecycle controls across their async preflight. */
	lifecycleVersion: number;
	lifecycleOperation?: ThreadLifecycleOperation;
	sessionId?: string;
	sessionDir?: string;
	/** Active execution time accumulated across retained resume generations. */
	elapsedMs: number;
	/** Most recent generation result, retained for parked destructive-stop output. */
	lastResult?: SingleResult;
	/** A destructive stop retires context even if the active child settles later. */
	retireOnSettle?: boolean;
	retired?: boolean;
	/** Installed by dispatch so the control tool can restart the same logical id. */
	resume: (objective?: string, ctx?: ExtensionContext) => Promise<SingleResult>;
	/** Dispatch-owned, generation-guarded worktree settlement hook. Its apply
	 * runs under the canonical original-repository lane. */
	finalizeIsolation: (generation: number, result?: SingleResult) => Promise<WorktreeFinalization | undefined>;
	/** Best-effort shutdown notification for retained integration artifacts. */
	notifyIsolationFailure?: (finalization: WorktreeFinalization) => void;
	isolationFailureNotified?: boolean;
}

export interface SubagentRuntime {
	configPath: string;
	backgroundQueue: BackgroundTaskQueue;
	/** Live parent tool names from ExtensionAPI, read again for each child launch. */
	getActiveTools: () => string[];
	/** False after session_shutdown; guards delivery and queue work. */
	sessionActive: boolean;
	/** The process-wide background dispatcher. Set at tool registration so
	 * threads restored from the durable manifest can resume before any dispatch. */
	dispatcher?: StartBackgroundInternal;
	/** Run ids restored from the durable manifest at load; consumed by the
	 * one-time session-start notice. */
	restoredRunIds: number[];
	restoredNotified: boolean;
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
	/** Resume setup that has claimed a thread but has not yet enqueued its
	 * next generation. Shutdown invalidates these claims and waits for cleanup. */
	preflightOperations: Set<Promise<void>>;
	/** Every session directory retained for this parent session, including
	 * managed-workflow internals that are not directly controllable. */
	sessionDirs: Set<string>;
	retainSession: (result: Pick<SingleResult, "sessionDir">) => void;
	retireThreadSession: (thread: SubagentThread) => void;
	/** Flip sessionActive off and release all session-scoped resources. */
	shutdown: () => Promise<void>;
}

export function createRuntime(pi: ExtensionAPI, configPath: string): SubagentRuntime {
	const backgroundQueue = new BackgroundTaskQueue(resolveSubagentConcurrency());

	const runtime: SubagentRuntime = {
		configPath,
		backgroundQueue,
		getActiveTools: () => pi.getActiveTools(),
		sessionActive: true,
		restoredRunIds: [],
		restoredNotified: false,
		sendCompletionGroup: (items) => {
			if (!runtime.sessionActive || items.length === 0) return;
			// A result arriving for one run does not mean sibling runs are done.
			// Computing this at delivery (emit) time — not when the item was
			// pushed — reflects the current monitor state, since finishing runs
			// are removed from the monitor before their completion is pushed.
			// Managed-workflow parents remain "running" through reviewer and
			// documenter stages, so they are included without a special case.
			const active = monitor
				.getRuns()
				.filter((run) => isRunActiveStatus(run.status))
				.map((run) => ({
					id: run.id,
					agent: run.agent,
					label: run.label,
					...(run.status === "queued" && run.waitReason ? { wait: run.waitReason } : {}),
				}));
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
			const liveStates = new Set(["queued", "resuming", "running", "interrupting"]);
			const previousStates = new Map(shutdownThreads.map((thread) => [thread.id, thread.state] as const));
			// Invalidate every lifecycle claim synchronously before the first await.
			// Resume preflight checks both this version and sessionActive, then
			// cleans any worktree/session it created before resolving its tracker.
			// A generation already inside its settlement keeps its own claim: it
			// finalizes its worktree and persists its terminal record itself.
			const interrupting = shutdownThreads.filter((thread) =>
				!thread.retired &&
				thread.lifecycleOperation !== "settle" &&
				liveStates.has(thread.state),
			);
			for (const thread of shutdownThreads) {
				thread.lifecycleVersion++;
				if (thread.retired) {
					thread.lifecycleOperation = "stop";
					continue;
				}
				if (thread.lifecycleOperation === "settle") continue;
				thread.lifecycleOperation = "stop";
				// Deliberately NOT retireOnSettle: shutdown interrupts to the last
				// checkpoint but keeps the session/worktree resumable across reload.
				thread.retireOnSettle = false;
				if (liveStates.has(thread.state)) thread.state = "stopped";
			}
			const preflights = [...runtime.preflightOperations];
			runtime.completionBatcher.dispose();
			runtime.backgroundQueue.cancelAll();
			// Await live RPC process-tree cleanup and continuation preflight rollback
			// before persisting records or releasing ownership maps.
			await Promise.all([
				Promise.all(
					interrupting.map((thread) =>
						thread.control.stop("Parent session shut down").catch(() => undefined),
					),
				),
				Promise.allSettled(preflights),
				runtime.backgroundQueue.waitForIdle(),
			]);
			// Only interrupted (parked) threads stay resumable across reloads:
			// each keeps its durable record and retained artifacts. Settled
			// threads drop their record — the manifest exists only while
			// unfinished work needs it — and their sessions are deleted now. A
			// thread whose settlement finished during the wait above already
			// wrote (or removed) its own record; the lastResult-derived state
			// below matches it.
			const settledIds: number[] = [];
			const records: ThreadRecord[] = [];
			for (const thread of runtime.threads.values()) {
				if (thread.retired) continue;
				const previous = previousStates.get(thread.id) ?? thread.state;
				let state: "parked" | "completed" | "failed";
				if (previous === "completed" || previous === "failed") {
					state = previous;
				} else if (thread.lifecycleOperation === "settle" && thread.lastResult) {
					state = isFailedResult(thread.lastResult) ? "failed" : "completed";
				} else {
					state = "parked";
				}
				if (state === "parked") records.push(threadRecordFromThread(thread, state));
				else settledIds.push(thread.id);
			}
			await Promise.all([
				...records.map((record) => upsertThreadRecord(runtime.configPath, record).catch(() => undefined)),
				...settledIds.map((runId) => removeThreadRecord(runtime.configPath, runId).catch(() => undefined)),
			]);
			// Retained-failure recovery records are persisted by the finalization
			// itself; shutdown only drops sessions no record claims anymore.
			const referenced = new Set(
				records.flatMap((record) =>
					[record.sessionDir, record.worktree?.tempDir].filter(Boolean) as string[],
				),
			);
			for (const sessionDir of runtime.sessionDirs) {
				if (referenced.has(sessionDir)) continue;
				try {
					rmSync(sessionDir, { recursive: true, force: true });
				} catch {
					/* best-effort; the state-root sweep catches leftovers later */
				}
			}
			runtime.settledRuns.clear();
			runtime.settledListeners.clear();
			runtime.runControllers.clear();
			// sessionDirs entries still referenced by records stay owned by the
			// manifest; the next process re-registers them at restore.
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
