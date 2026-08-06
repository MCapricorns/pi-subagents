/**
 * Bounded background task scheduler.
 *
 * Tasks get their own AbortSignal rather than inheriting the foreground agent
 * turn's signal. The owning extension cancels all work only on session teardown.
 *
 * Task exceptions are never swallowed: the per-task onError callback receives
 * them (unless the task was cancelled) so callers can surface the failure to
 * the user and the main agent instead of it vanishing into the queue.
 */

export type BackgroundTask = (signal: AbortSignal) => Promise<void>;

interface PendingTask {
	task: BackgroundTask;
	controller: AbortController;
	/** Called when a queued task is aborted before its body ever runs (drain skips
	 * an already-aborted entry; cancelAll aborts every pending entry), so the
	 * task body never produces a result. Callers that resolve waiters on a run id
	 * must register a synthetic result here (or via a stop path) — otherwise a
	 * waiter resolves via a "removed before its result was recorded" note. Never
	 * called for a task whose body already started; that path owns its result. */
	onCancelled?: () => void;
	/** Invoked when the task throws and was not cancelled (cancellation is not a
	 * failure — e.g. session shutdown races must never be reported as errors). */
	onError?: (error: unknown) => void;
}

export class BackgroundTaskQueue {
	private concurrency: number;
	private readonly pending: PendingTask[] = [];
	private readonly active = new Set<AbortController>();
	private stopped = false;

	constructor(concurrency: number) {
		this.concurrency = Math.max(1, concurrency);
	}

	/**
	 * Update the concurrency limit (e.g. after a config change). Raising it
	 * immediately starts more queued work; lowering it takes effect as running
	 * tasks finish — already-running tasks are never interrupted.
	 */
	setConcurrency(concurrency: number): void {
		this.concurrency = Math.max(1, concurrency);
		this.drain();
	}

	enqueue(task: BackgroundTask, onCancelled?: () => void, onError?: (error: unknown) => void): AbortController {
		const controller = new AbortController();
		if (this.stopped) {
			controller.abort();
			this.runCancelled(onCancelled);
			return controller;
		}

		this.pending.push({ task, controller, onCancelled, onError });
		this.drain();
		return controller;
	}

	/** Stop queued work and request cancellation for running work. */
	cancelAll(): void {
		if (this.stopped) return;
		this.stopped = true;

		for (const entry of this.pending.splice(0)) {
			entry.controller.abort();
			this.runCancelled(entry.onCancelled);
		}
		for (const controller of this.active) controller.abort();
	}

	/** Cancellation callbacks are user-supplied: a throw must never break the queue
	 * (mirrors the try/catch around onError in drain). */
	private runCancelled(callback: (() => void) | undefined): void {
		if (!callback) return;
		try {
			callback();
		} catch {
			/* cancellation callbacks must never break the queue */
		}
	}

	private drain(): void {
		while (!this.stopped && this.active.size < this.concurrency) {
			const entry = this.pending.shift();
			if (!entry) return;
			if (entry.controller.signal.aborted) {
				this.runCancelled(entry.onCancelled);
				continue;
			}

			this.active.add(entry.controller);
			void entry.task(entry.controller.signal)
				.catch((error: unknown) => {
					// Cancellation is not a failure: aborted work (e.g. session
					// shutdown) must never be reported as an exception.
					if (entry.controller.signal.aborted) return;
					try {
						entry.onError?.(error);
					} catch {
						/* error reporting must never break the queue */
					}
				})
				.finally(() => {
					this.active.delete(entry.controller);
					this.drain();
				});
		}
	}
}
