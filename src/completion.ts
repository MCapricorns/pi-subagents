/**
 * Smart batching for successful background completions.
 *
 * A short debounce coalesces sibling runs while a max-wait timer, measured from
 * the first item in the open group, bounds delivery latency. Failures are
 * intentionally handled by the caller: flush held successes, then emit the
 * failure directly so it is never delayed.
 */

import { formatUsageCompact, sumUsage, type RunWaitReason } from "./monitor.ts";
import type { UsageStats } from "./rpc-run.ts";

export interface CompletionBatchTimings {
	debounceMs: number;
	maxWaitMs: number;
}

export const DEFAULT_COMPLETION_BATCH_TIMINGS: CompletionBatchTimings = {
	debounceMs: 150,
	maxWaitMs: 1_000,
};

type TimerHandle = ReturnType<typeof setTimeout>;

function unrefHandle(handle: TimerHandle): void {
	if (
		handle &&
		typeof handle === "object" &&
		"unref" in handle &&
		typeof (handle as { unref: unknown }).unref === "function"
	) {
		(handle as { unref: () => void }).unref();
	}
}

export interface CompletionBatcherOptions<T> {
	emit: (items: T[]) => void;
	timings?: Partial<CompletionBatchTimings>;
}

export interface CompletionBatcher<T> {
	/** Add an item to the current debounced group. */
	push(item: T): void;
	/** Emit any held items immediately as one group. */
	flush(): void;
	/** Clear timers and return held items without emitting them. */
	dispose(): T[];
}

export function createCompletionBatcher<T>(options: CompletionBatcherOptions<T>): CompletionBatcher<T> {
	const timings = { ...DEFAULT_COMPLETION_BATCH_TIMINGS, ...options.timings };
	let pending: T[] = [];
	let debounceTimer: TimerHandle | null = null;
	let maxWaitTimer: TimerHandle | null = null;

	const clearTimers = (): void => {
		if (debounceTimer !== null) {
			clearTimeout(debounceTimer);
			debounceTimer = null;
		}
		if (maxWaitTimer !== null) {
			clearTimeout(maxWaitTimer);
			maxWaitTimer = null;
		}
	};

	const emitGroup = (): void => {
		clearTimers();
		if (pending.length === 0) return;
		const items = pending;
		pending = [];
		options.emit(items);
	};

	return {
		push(item: T): void {
			pending.push(item);

			if (debounceTimer !== null) clearTimeout(debounceTimer);
			debounceTimer = setTimeout(emitGroup, timings.debounceMs);
			unrefHandle(debounceTimer);

			if (maxWaitTimer === null) {
				maxWaitTimer = setTimeout(emitGroup, timings.maxWaitMs);
				unrefHandle(maxWaitTimer);
			}
		},
		flush: emitGroup,
		dispose(): T[] {
			clearTimers();
			const abandoned = pending;
			pending = [];
			return abandoned;
		},
	};
}

export interface CompletionMessageItem {
	agent: string;
	block: string;
	triggerTurn: boolean;
	/** Final usage of the underlying run (or chain); aggregated into the group totals. */
	usage?: UsageStats;
}

/** Keep the established single-result shape; add a group header and an aggregate
 * token/cost footer only for real groups. */
export function formatCompletionMessage(items: readonly CompletionMessageItem[]): string {
	if (items.length === 0) return "";
	if (items.length === 1) return items[0].block;
	const agents = items.map((item) => item.agent).join(", ");
	const withUsage = items.filter((item) => item.usage !== undefined);
	const totals = withUsage.length > 0 ? formatUsageCompact(sumUsage(withUsage.map((item) => item.usage!))) : "";
	const footer = totals ? `\n\nTotals: ${items.length} runs · ${totals}` : "";
	return `### Subagents completed (${items.length}): ${agents}\n\n${items.map((item) => item.block).join("\n\n")}${footer}`;
}

/** A grouped completion wakes the main agent when any member requires a turn. */
export function completionGroupTriggersTurn(items: readonly CompletionMessageItem[]): boolean {
	return items.some((item) => item.triggerTurn);
}

/** Minimal shape of an active run, for the "others still running" footer. Kept
 * decoupled from the monitor's RunView so this stays a pure, easily tested
 * formatter; the caller maps its live runs into this shape. */
export interface ActiveRunFoot {
	id: number;
	agent: string;
	/** Optional content label (task-derived) shown next to the agent name. */
	label?: string;
	/** Why a not-yet-executing run is waiting. Stated precisely so a repository
	 * lane wait or a starting child is never mistaken for an exhausted pool. */
	wait?: RunWaitReason;
}

function activeRunWaitTag(wait: RunWaitReason | undefined): string {
	switch (wait) {
		case "process-slot":
			return " (queued, starts when a process slot frees)";
		case "repository-lane":
			return " (waiting for the repository write lane, not for a slot)";
		case "starting":
			return " (starting)";
		default:
			return "";
	}
}

/**
 * Footer appended to a completion message when OTHER runs are still active, so
 * the main agent does not declare the overall task done prematurely. A result
 * arriving for one run does not mean sibling runs are finished; naming them
 * gives the main agent concrete, in-context awareness to keep waiting.
 *
 * Returns "" when nothing is active (the common, single-run case stays quiet).
 */
export function formatActiveRunsFooter(runs: readonly ActiveRunFoot[], maxListed = 4): string {
	if (runs.length === 0) return "";
	const listed = runs.slice(0, maxListed);
	const items = listed
		.map((run) => `#${run.id} ${run.agent}${run.label ? `·${run.label}` : ""}${activeRunWaitTag(run.wait)}`)
		.join(", ");
	const more = runs.length > listed.length ? `, +${runs.length - listed.length} more` : "";
	return `\n\n⚠ ${runs.length} other run${runs.length === 1 ? "" : "s"} still active: ${items}${more}. Do not conclude the overall task yet — their results wake you automatically.`;
}
