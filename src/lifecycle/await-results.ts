/** Shared in-turn completion delivery for dispatches and completed-run follow-ups. */

import { Type } from "typebox";
import { isFailedResult, type SingleResult } from "../execution/spawn.ts";
import { formatCompletionBlock } from "../presentation/format.ts";
import { monitor, statusLabel } from "../presentation/monitor.ts";
import type { SubagentRuntime } from "./runtime.ts";
import { projectResultsRoot } from "./thread-shared.ts";

export const WaitSchema = Type.Optional(Type.Boolean({
	description: "Wait for runs started by this call and return their results once, after integration. Defaults to true in one-shot print/JSON sessions, false in TUI/RPC. Use true when the next step depends on the result; false to continue independent work. Cancelling the parent stops unfinished runs without background wake-ups.",
}));

/** In-turn wait for a new run or completed-run follow-up. Registration resolves it without a model-chosen
 * timer; parent abort ends the wait and cancels its owned work. */
export async function awaitRunResults(
	runtime: SubagentRuntime,
	runIds: number[],
	signal: AbortSignal | undefined,
	maxResultLines: number,
	fallbackCwd: string,
	onProgress?: (text: string) => void,
): Promise<string> {
	const waitForRun = (runId: number): Promise<{ result?: SingleResult; note?: string }> => {
		const already = runtime.settledRuns.get(runId);
		if (already) return Promise.resolve({ result: already });
		if (monitor.findRun(runId)?.status === "parked") {
			return Promise.resolve({ note: `run #${runId} was interrupted; inspect retained work with subagent_status and finish it in main` });
		}
		return new Promise((resolve) => {
			let done = false;
			let unsub: (() => void) | undefined;
			const cleanup = (): void => {
				if (unsub) unsub();
				signal?.removeEventListener("abort", onAbort);
				const listeners = runtime.settledListeners.get(runId);
				if (listeners) {
					listeners.delete(onSettled);
					if (listeners.size === 0) runtime.settledListeners.delete(runId);
				}
			};
			const finish = (outcome: { result?: SingleResult; note?: string }): void => {
				if (done) return;
				done = true;
				cleanup();
				resolve(outcome);
			};
			const onSettled = (result: SingleResult): void => finish({ result });
			const onMonitor = (): void => {
				const current = runtime.settledRuns.get(runId);
				if (current) {
					finish({ result: current });
					return;
				}
				const live = monitor.findRun(runId);
				if (live?.status === "parked") {
					finish({ note: `run #${runId} was interrupted; inspect retained work with subagent_status and finish it in main` });
					return;
				}
				if (!live) {
					// Removal is followed synchronously by registerRunResult in the
					// finishing task; re-check on the next tick so the result wins.
					setTimeout(() => {
						const late = runtime.settledRuns.get(runId);
						if (late) finish({ result: late });
						else finish({ note: `run #${runId} was removed before its result was recorded (cancelled or session ended)` });
					}, 0);
				}
			};
			const onAbort = (): void => finish({ note: `Parent wait cancelled for run #${runId}; automatic cancellation stops unfinished child work. No additional subagent_stop is needed.` });
			let listeners = runtime.settledListeners.get(runId);
			if (!listeners) {
				listeners = new Set();
				runtime.settledListeners.set(runId, listeners);
			}
			listeners.add(onSettled);
			unsub = monitor.subscribe(onMonitor);
			if (signal?.aborted) onAbort();
			else signal?.addEventListener("abort", onAbort, { once: true });
		});
	};
	// One shared subscription drives the progress line: each waiter already
	// subscribes for its own settlement, and the tool card wants a single
	// rolled-up line rather than one per run.
	let lastProgress: string | undefined;
	const emitProgress = onProgress
		? (): void => {
			const parts = runIds.map((id) => {
				const settled = runtime.settledRuns.get(id);
				if (settled) return `#${id} ${isFailedResult(settled) ? "failed" : "done"}`;
				const live = monitor.findRun(id);
				return live ? `#${id} ${statusLabel(live.status)}` : `#${id} …`;
			});
			const text = `Waiting in-turn on ${runIds.length} run${runIds.length === 1 ? "" : "s"} · ${parts.join(", ")}`;
			// The monitor notifies on every usage and activity change; this line
			// names only statuses, so most notifications leave it identical.
			if (text === lastProgress) return;
			lastProgress = text;
			onProgress(text);
		}
		: undefined;
	const progressUnsub = emitProgress ? monitor.subscribe(emitProgress) : undefined;
	try {
		emitProgress?.();
		const outcomes = await Promise.all(runIds.map(waitForRun));
		return outcomes.map((outcome) =>
			outcome.result
				? formatCompletionBlock(outcome.result, maxResultLines, { resultRoot: projectResultsRoot(runtime.configPath, outcome.result.projectCwd ?? fallbackCwd) })
				: (outcome.note ?? "(no outcome)"),
		).join("\n\n");
	} finally {
		progressUnsub?.();
	}
}
