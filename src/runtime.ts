/**
 * Shared per-session runtime state for pi-subagents.
 *
 * The extension registers several tools (subagent, subagent_wait/status/stop) and
 * a widget that all talk to one set of live structures: the background queue, the
 * completion batcher, abort controllers per run, and the settled-results store.
 * `createRuntime` builds those once per extension load and hands the same object
 * to every registration site, so state stays in one place without globals.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { BackgroundTaskQueue } from "./background.ts";
import {
	completionGroupTriggersTurn,
	createCompletionBatcher,
	formatActiveRunsFooter,
	formatCompletionMessage,
	type CompletionBatcher,
	type CompletionMessageItem,
} from "./completion.ts";
import { loadConfigSync } from "./config.ts";
import { monitor } from "./monitor.ts";
import type { SingleResult } from "./spawn.ts";

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
	/** Flip sessionActive off and release all session-scoped resources. */
	shutdown: () => void;
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
			const active = monitor
				.getRuns()
				.filter((run) => run.status === "queued" || run.status === "running" || run.retained)
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
		shutdown: () => {
			runtime.sessionActive = false;
			runtime.completionBatcher.dispose();
			runtime.backgroundQueue.cancelAll();
			runtime.settledRuns.clear();
			runtime.settledListeners.clear();
			runtime.runControllers.clear();
			// Clear the monitor so stale runs from this session never leak into the
			// next one (the module-level singleton survives across sessions).
			monitor.clear();
		},
	};

	runtime.completionBatcher = createCompletionBatcher<CompletionMessageItem>({
		emit: runtime.sendCompletionGroup,
	});
	return runtime;
}
