/**
 * Smart batching for successful background completions.
 *
 * A short debounce coalesces sibling runs while a max-wait timer, measured from
 * the first item in the open group, bounds delivery latency. Runs that finish
 * shortly after an emitted group use a smaller straggler window. Failures are
 * intentionally handled by the caller: flush held successes, then emit the
 * failure directly so it is never delayed.
 */

import { getResultOutput, isFailedResult, reviewVerdict, type SingleResult } from "./spawn.ts";

export interface CompletionBatchTimings {
	debounceMs: number;
	maxWaitMs: number;
	stragglerDebounceMs: number;
	stragglerMaxWaitMs: number;
	stragglerWindowMs: number;
}

export const DEFAULT_COMPLETION_BATCH_TIMINGS: CompletionBatchTimings = {
	debounceMs: 150,
	maxWaitMs: 1_000,
	stragglerDebounceMs: 75,
	stragglerMaxWaitMs: 400,
	stragglerWindowMs: 2_000,
};

type TimerHandle = unknown;

export interface TimerApi {
	setTimeout(handler: () => void, delayMs: number): TimerHandle;
	clearTimeout(handle: TimerHandle): void;
}

const defaultTimers: TimerApi = {
	setTimeout: (handler, delayMs) => setTimeout(handler, delayMs),
	clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

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
	timers?: TimerApi;
	now?: () => number;
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
	const timers = options.timers ?? defaultTimers;
	const now = options.now ?? Date.now;
	const timings = { ...DEFAULT_COMPLETION_BATCH_TIMINGS, ...options.timings };
	let pending: T[] = [];
	let debounceTimer: TimerHandle | null = null;
	let maxWaitTimer: TimerHandle | null = null;
	let straggler = false;
	let lastEmitAt: number | null = null;

	const clearTimers = (): void => {
		if (debounceTimer !== null) {
			timers.clearTimeout(debounceTimer);
			debounceTimer = null;
		}
		if (maxWaitTimer !== null) {
			timers.clearTimeout(maxWaitTimer);
			maxWaitTimer = null;
		}
	};

	const emitGroup = (): void => {
		clearTimers();
		if (pending.length === 0) return;
		const items = pending;
		pending = [];
		lastEmitAt = now();
		options.emit(items);
	};

	return {
		push(item: T): void {
			if (pending.length === 0) {
				straggler = lastEmitAt !== null && now() - lastEmitAt < timings.stragglerWindowMs;
			}
			pending.push(item);

			if (debounceTimer !== null) timers.clearTimeout(debounceTimer);
			const debounceDelay = straggler ? timings.stragglerDebounceMs : timings.debounceMs;
			debounceTimer = timers.setTimeout(emitGroup, debounceDelay);
			unrefHandle(debounceTimer);

			if (maxWaitTimer === null) {
				const maxWaitDelay = straggler ? timings.stragglerMaxWaitMs : timings.maxWaitMs;
				maxWaitTimer = timers.setTimeout(emitGroup, maxWaitDelay);
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
}

/** Keep the established single-result shape; add a summary only for real groups. */
export function formatCompletionMessage(items: readonly CompletionMessageItem[]): string {
	if (items.length === 0) return "";
	if (items.length === 1) return items[0].block;
	const agents = items.map((item) => item.agent).join(", ");
	return `### Subagents completed (${items.length}): ${agents}\n\n${items.map((item) => item.block).join("\n\n")}`;
}

/** A grouped completion wakes the main agent when any member requires a turn. */
export function completionGroupTriggersTurn(items: readonly CompletionMessageItem[]): boolean {
	return items.some((item) => item.triggerTurn);
}

/** Passing reviewer notifications may opt out of waking; every other result wakes. */
export function completionTriggersTurn(result: SingleResult, notifyOnReviewPass: boolean): boolean {
	if (isFailedResult(result)) return true;
	return !(
		notifyOnReviewPass &&
		result.agent === "reviewer" &&
		reviewVerdict(getResultOutput(result)) === "pass"
	);
}

/** Minimal shape of an active run, for the "others still running" footer. Kept
 * decoupled from the monitor's RunView so this stays a pure, easily tested
 * formatter; the caller maps its live runs into this shape. */
export interface ActiveRunFoot {
	id: number;
	agent: string;
	/** Optional content label (task-derived) shown next to the agent name. */
	label?: string;
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
		.map((run) => `#${run.id} ${run.agent}${run.label ? `·${run.label}` : ""}`)
		.join(", ");
	const more = runs.length > listed.length ? `, +${runs.length - listed.length} more` : "";
	return `\n\n⚠ ${runs.length} other run${runs.length === 1 ? "" : "s"} still active: ${items}${more}. Do not conclude the overall task yet — wait for their results (they wake you automatically) or check subagent_status.`;
}
