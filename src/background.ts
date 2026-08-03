/**
 * Bounded background task scheduler.
 *
 * Tasks get their own AbortSignal rather than inheriting the foreground agent
 * turn's signal. The owning extension cancels all work only on session teardown.
 */

export type BackgroundTask = (signal: AbortSignal) => Promise<void>;

interface PendingTask {
	task: BackgroundTask;
	controller: AbortController;
	onCancelled?: () => void;
}

export class BackgroundTaskQueue {
	private readonly concurrency: number;
	private readonly pending: PendingTask[] = [];
	private readonly active = new Set<AbortController>();
	private stopped = false;

	constructor(concurrency: number) {
		this.concurrency = Math.max(1, concurrency);
	}

	enqueue(task: BackgroundTask, onCancelled?: () => void): AbortController {
		const controller = new AbortController();
		if (this.stopped) {
			controller.abort();
			onCancelled?.();
			return controller;
		}

		this.pending.push({ task, controller, onCancelled });
		this.drain();
		return controller;
	}

	/** Stop queued work and request cancellation for running work. */
	cancelAll(): void {
		if (this.stopped) return;
		this.stopped = true;

		for (const entry of this.pending.splice(0)) {
			entry.controller.abort();
			entry.onCancelled?.();
		}
		for (const controller of this.active) controller.abort();
	}

	private drain(): void {
		while (!this.stopped && this.active.size < this.concurrency) {
			const entry = this.pending.shift();
			if (!entry) return;
			if (entry.controller.signal.aborted) {
				entry.onCancelled?.();
				continue;
			}

			this.active.add(entry.controller);
			void entry.task(entry.controller.signal).catch(() => undefined).finally(() => {
				this.active.delete(entry.controller);
				this.drain();
			});
		}
	}
}
