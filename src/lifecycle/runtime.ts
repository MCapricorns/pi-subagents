/**
 * Shared per-session runtime state for pi-subagents.
 *
 * The extension registers dispatch, read-only status, and destructive stop tools
 * that share the background queue, completion batcher, abort controllers per
 * run, and settled-results store.
 * `createRuntime` builds those once per extension load and hands the same object
 * to every registration site, so state stays in one place without globals.
 */

import type { ExtensionAPI, ToolInfo } from "@earendil-works/pi-coding-agent";
import { findDuplicateDispatch } from "../delegation/prompt.ts";
import { pendingWorkflowLeases } from "../delegation/ownership.ts";
import type { PhaseScope } from "../delegation/phase-scope.ts";
import { rmSync } from "node:fs";
import { BackgroundTaskQueue } from "../execution/background.ts";
import {
	createCompletionBatcher,
	formatActiveRunsFooter,
	formatCompletionMessage,
	type CompletionBatcher,
	type CompletionMessageItem,
} from "./completion.ts";
import { type ThinkingLevel } from "../configuration/config.ts";
import { removeThreadRecord, threadRecordFromThread, upsertThreadRecord, type ThreadRecord } from "./durable.ts";
import { isRunActiveStatus, monitor, type RunWorkflowTag } from "../presentation/monitor.ts";
import type { RunControl, SteeringReceipt } from "../execution/run-control.ts";
import { isFailedResult, type SingleResult } from "../execution/spawn.ts";
import type { IsolationMode, WorktreeFinalization, WorktreeIsolation } from "../isolation/worktree.ts";
import type { WorkflowRun } from "../workflow/state.ts";

export type ThreadState = "queued" | "running" | "interrupting" | "parked" | "completed" | "failed" | "stopped";

export type ThreadLifecycleOperation = "stop" | "settle";

export interface SubagentThread {
	/** Stable manifest identity; display ids are local to a Pi window. */
	durableId?: string;
	id: number;
	generation: number;
	agentName: string;
	task: string;
	phaseId?: string;
	scope?: PhaseScope;
	/** Capability snapshot used by declared-scope admission, including after restore. */
	writeCapable?: boolean;
	/** Live graph membership; graph summaries own delivery for these runs. */
	workflow?: RunWorkflowTag;
	/** Caller-facing cwd in the original worktree. */
	cwd: string;
	/** Actual child cwd (the equivalent path inside an isolated worktree). */
	executionCwd: string;
	thinkingLevel?: ThinkingLevel;
	requestedThinkingLevel?: ThinkingLevel;
	isolation: IsolationMode;
	worktree?: WorktreeIsolation;
	/** Original durable evidence retained when its worktree handle is unavailable. */
	restorationRecord?: ThreadRecord;
	state: ThreadState;
	control: RunControl;
	/** Last child acknowledgement; queued delivery does not prove model execution. */
	lastSteering?: SteeringReceipt & { message: string };
	queueController?: AbortController;
	/** Resolves after the child, isolation finalization, and queue work fully quiesce. */
	generationCompletion: Promise<void>;
	/** Arbitration between asynchronous settlement and destructive stop. */
	lifecycleVersion: number;
	lifecycleOperation?: ThreadLifecycleOperation;
	sessionId?: string;
	sessionDir?: string;
	elapsedMs: number;
	/** Terminal or interrupted partial result; independent of the transient monitor row. */
	lastResult?: SingleResult;
	/** A destructive stop retires context even if the active child settles later. */
	retireOnSettle?: boolean;
	retired?: boolean;
	/** All owners finalize under the same original-repository lane. */
	finalizeIsolation: (generation: number, result?: SingleResult) => Promise<WorktreeFinalization | undefined>;
	notifyIsolationFailure?: (finalization: WorktreeFinalization) => void;
	isolationFailureNotified?: boolean;
}

export interface SubagentRuntime {
	configPath: string;
	backgroundQueue: BackgroundTaskQueue;
	/** Live parent tool names from ExtensionAPI, read again for each child launch. */
	getActiveTools: () => string[];
	/** Live metadata for the registered tools, read again for each child launch.
	 * Read-only role policy and write capability come from it, never from a
	 * hardcoded list of extension or MCP tool names. */
	getToolInfos: () => ToolInfo[];
	/** False after session_shutdown; guards delivery and queue work. */
	sessionActive: boolean;
	/** Cancelling a parent must not wake it again with old child results. */
	suppressCompletions: boolean;
	discardCompletions: () => void;
	/** Record cancellation for the next user turn without waking the parent. */
	recordCancellation: (runIds: number[], workflowIds: number[]) => void;
	/** Resolves when the load-time durable restore pass has finished. Everything
	 * that answers "which threads exist" awaits it — the lookup tools, a fresh
	 * dispatch before it allocates a run id, and the restored-thread notice — so
	 * a reload can never report parked work as missing, or hand a new run an id a
	 * record still owns, while the manifest is being read. Resolved by default;
	 * `bootstrapDurableState` publishes the real pass. */
	durableRestore: Promise<void>;
	/** Run ids restored from the durable manifest at load; consumed by the
	 * one-time session-start notice. */
	restoredRunIds: number[];
	restoredNotified: boolean;
	/** Deliver a batch at the next safe parent turn boundary and wake an idle parent. */
	sendCompletionGroup: (items: CompletionMessageItem[]) => void;
	/** Claim the sole delivery route before a generation can settle. */
	claimRunDelivery: (runId: number, route: "background" | "await") => void;
	/** Publish a terminal completion through its claimed route. Immediate failures
	 * flush older successful batches first. */
	publishRunCompletion: (runId: number, item: CompletionMessageItem, immediate: boolean) => void;
	/** Mark awaited results as returned in the tool response. */
	completeAwaitDelivery: (runIds: readonly number[]) => void;
	completionBatcher: CompletionBatcher<CompletionMessageItem>;
	/** Abort controllers per active run, so subagent_stop can cancel a run in-turn. */
	runControllers: Map<number, AbortController>;
	/** Final results keyed by run id, so a dispatch with wait: true can hand the
	 * model the actual result in-turn instead of it sleeping/polling for a
	 * wake-up message. */
	settledRuns: Map<number, SingleResult>;
	settledListeners: Map<number, Set<(result: SingleResult) => void>>;
	registerRunResult: (runId: number, result: SingleResult) => void;
	/** Logical threads outlive process attempts and completed generations. */
	threads: Map<number, SubagentThread>;
	/** Explicit main edit/write calls hold their paths until tool_execution_end. */
	mainWrites: Map<string, { toolName: string; scope: PhaseScope }>;
	/** Workflow graphs started in this parent session, live and settled. */
	workflows: Map<number, WorkflowRun>;
	/** Stable mapping from persisted identities to this window's display ids. */
	workflowRecordIds: Map<string, number>;
	/** Allocate a graph id that no retained or live workflow record owns. */
	reserveWorkflowId: () => number;
	/** Raise the graph-id allocator above an id restored from a durable record. */
	ensureWorkflowIdAbove: (id: number) => void;
	/** Session-teardown tasks that must run before runtime state is released
	 * (persisting a graph's shape, for example). */
	shutdownHooks: Array<() => Promise<void> | void>;
	/** Every session directory retained for this parent session. */
	sessionDirs: Set<string>;
	retainSession: (result: Pick<SingleResult, "sessionDir">) => void;
	retireThreadSession: (thread: SubagentThread) => void;
	/** Flip sessionActive off and release all session-scoped resources. */
	shutdown: () => Promise<void>;
}

/** Pending nodes reserve their phases before they allocate ordinary run ids. */
export function findPendingWorkflowPhase(
	runtime: Pick<SubagentRuntime, "workflows">,
	task: string,
	cwd: string,
	phaseId?: string,
	excludeWorkflowId?: number,
): { workflowId: number; nodeId: string; agent: string } | undefined {
	const duplicate = findDuplicateDispatch(pendingWorkflowLeases(runtime, excludeWorkflowId), task, cwd, phaseId);
	const owner = duplicate?.source;
	return owner?.workflow ? { workflowId: owner.workflow.workflowId, nodeId: owner.workflow.nodeId, agent: owner.agentName } : undefined;
}

export function createRuntime(pi: ExtensionAPI, configPath: string): SubagentRuntime {
	const backgroundQueue = new BackgroundTaskQueue();
	let nextWorkflowId = 1;
	// Compaction reads the whole history, summarizes it, and replaces it. A
	// completion injected into that window can be swallowed by the summary,
	// silently losing a result a child spent minutes producing — so delivery is
	// held until compaction settles (either outcome) instead.
	let compactionInFlight = false;
	let heldCompletions: CompletionMessageItem[] = [];

	const runDeliveries = new Map<number, "background" | "await">();
	const runtime: SubagentRuntime = {
		configPath,
		backgroundQueue,
		getActiveTools: () => pi.getActiveTools(),
		getToolInfos: () => pi.getAllTools(),
		sessionActive: true,
		suppressCompletions: false,
		recordCancellation: (runIds, workflowIds) => {
			const targets = [
				...(runIds.length ? ["runs " + runIds.map((id) => `#${id}`).join(", ")] : []),
				...(workflowIds.length ? ["workflows " + workflowIds.map((id) => `#${id}`).join(", ")] : []),
			].join("; ");
			pi.sendMessage({
				customType: "subagent-cancelled",
				content: `Parent cancellation stopped ${targets}. These runs are already cancelled; no further subagent_stop is needed. Do not restart cancelled work unless the user requests it. Partial edits and retained integration artifacts may remain; inspect them only if continuing the task.`,
				display: true,
				details: { runIds, workflowIds },
			}, { deliverAs: "nextTurn", triggerTurn: false });
		},
		discardCompletions: () => {
			runtime.completionBatcher.dispose();
			heldCompletions = [];
			runDeliveries.clear();
		},
		durableRestore: Promise.resolve(),
		restoredRunIds: [],
		restoredNotified: false,
		sendCompletionGroup: (items) => {
			if (!runtime.sessionActive || runtime.suppressCompletions || items.length === 0) return;
			// Direct (immediate-failure/stop) delivery must follow successes already
			// held by the debounce batcher. A batcher's own emit sees an empty batch.
			runtime.completionBatcher?.flush();
			if (compactionInFlight) {
				heldCompletions.push(...items);
				return;
			}
			// A result arriving for one run does not mean sibling runs are done.
			// Computing this at delivery (emit) time — not when the item was
			// pushed — reflects the current monitor state, since finishing runs
			// are removed from the monitor before their completion is pushed.
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
			// Steer delivers after the current assistant turn's tool calls and before
			// the next model call. A follow-up would wait for the whole parent run to
			// settle, allowing completions and stop results to arrive after its final reply.
			pi.sendMessage(message, { deliverAs: "steer", triggerTurn: true });
		},
		claimRunDelivery: (runId, route) => {
			runDeliveries.set(runId, route);
		},
		publishRunCompletion: (runId, item, immediate) => {
			if (runtime.suppressCompletions) { runDeliveries.delete(runId); return; }
			if (runDeliveries.get(runId) === "await") return;
			runDeliveries.delete(runId);
			if (immediate) {
				runtime.sendCompletionGroup([item]);
			} else {
				runtime.completionBatcher.push(item);
			}
		},
		completeAwaitDelivery: (runIds) => {
			for (const runId of runIds) {
				if (runDeliveries.get(runId) === "await") runDeliveries.delete(runId);
			}
		},

		completionBatcher: undefined as unknown as CompletionBatcher<CompletionMessageItem>,
		runControllers: new Map<number, AbortController>(),
		settledRuns: new Map<number, SingleResult>(),
		settledListeners: new Map<number, Set<(result: SingleResult) => void>>(),
		threads: new Map<number, SubagentThread>(),
		mainWrites: new Map(),
		workflows: new Map<number, WorkflowRun>(),
		workflowRecordIds: new Map(),
		reserveWorkflowId: () => nextWorkflowId++,
		ensureWorkflowIdAbove: (id) => {
			if (id >= nextWorkflowId) nextWorkflowId = id + 1;
		},
		shutdownHooks: [],
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
			const liveStates = new Set(["queued", "running", "interrupting"]);
			const previousStates = new Map(shutdownThreads.map((thread) => [thread.id, thread.state] as const));
			// Invalidate pending lifecycle claims synchronously before the first await.
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
				// checkpoint and preserves session/worktree artifacts for manual recovery.
				thread.retireOnSettle = false;
				if (liveStates.has(thread.state)) thread.state = "stopped";
			}
			runtime.completionBatcher.dispose();
			// The parent session is gone; no window remains for buffered delivery.
			heldCompletions = [];
			compactionInFlight = false;
			runtime.backgroundQueue.cancelAll();
			// Quiesce child processes and owned queue work before persisting records.
			await Promise.all([
				...interrupting.map((thread) => thread.control.stop("Parent session shut down").catch(() => undefined)),
				runtime.backgroundQueue.waitForIdle(),
			]);
			// Only interrupted work keeps recovery artifacts across reloads:
			// each keeps its durable record and retained artifacts. Settled
			// threads drop their record — the manifest exists only while
			// unfinished work needs it — and their sessions are deleted now. A
			// thread whose settlement finished during the wait above already
			// wrote (or removed) its own record; the lastResult-derived state
			// below matches it.
			const settled: Array<{ identity: string; cwd: string }> = [];
			const records: ThreadRecord[] = [];
			for (const thread of runtime.threads.values()) {
				if (thread.retired) continue;
				if (thread.restorationRecord) {
					// Keep recovery evidence until an explicit destructive stop retires it.
					records.push({
						...thread.restorationRecord,
						updatedAt: Date.now(),
						elapsedMs: thread.elapsedMs,
					});
					continue;
				}
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
				else if (thread.durableId) settled.push({ identity: thread.durableId, cwd: thread.cwd });
			}
			await Promise.all([
				...records.map((record) => upsertThreadRecord(runtime.configPath, record).catch(() => undefined)),
				...settled.map(({ identity, cwd }) => removeThreadRecord(runtime.configPath, identity, cwd).catch(() => undefined)),
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
			// Let owners persist their own last state (a workflow's shape) while the
			// threads it refers to still exist.
			for (const hook of runtime.shutdownHooks) {
				try {
					await hook();
				} catch {
					/* a teardown hook must never block shutdown */
				}
			}
			runtime.settledRuns.clear();
			runtime.settledListeners.clear();
			runtime.runControllers.clear();
			runDeliveries.clear();
			// sessionDirs entries still referenced by records stay owned by the
			// manifest; the next process re-registers them at restore.
			runtime.sessionDirs.clear();
			runtime.threads.clear();
			runtime.mainWrites.clear();
			runtime.workflows.clear();
			runtime.workflowRecordIds.clear();
			runtime.shutdownHooks = [];
			monitor.clear();
		},
	};

	// Hold delivery across compaction. `session_before_compact` opens the
	// window; BOTH terminal events close it, because a failed or aborted
	// compaction that never released would strand every held result forever.
	pi.on("session_before_compact", () => {
		compactionInFlight = true;
	});
	const releaseHeldCompletions = (): void => {
		// Drain the debounce while the compaction gate is still closed so newer
		// pending successes append after completions already held by that gate.
		runtime.completionBatcher.flush();
		compactionInFlight = false;
		if (heldCompletions.length === 0) return;
		const items = heldCompletions;
		heldCompletions = [];
		// Re-enter the normal path now that the gate is open so the active-runs
		// footer reflects delivery time, not the moment the items were held.
		runtime.sendCompletionGroup(items);
	};
	pi.on("session_compact", releaseHeldCompletions);
	pi.on("session_compact_failed", releaseHeldCompletions);

	runtime.completionBatcher = createCompletionBatcher<CompletionMessageItem>({
		emit: runtime.sendCompletionGroup,
	});
	return runtime;
}
