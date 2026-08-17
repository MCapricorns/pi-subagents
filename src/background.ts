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
	complete: () => void;
	/** Called when a queued task is aborted before its body ever runs (drain skips
	 * an already-aborted entry; cancelAll aborts every pending entry), so the
	 * task body never produces a result. Callers that resolve waiters on a run id
	 * must register a synthetic result here (or via a stop path) — otherwise a
	 * waiter resolves via a "removed before its result was recorded" note. Never
	 * called for a task whose body already started; that path owns its result. */
	onCancelled?: () => void;
	/** Invoked when the task throws and was not cancelled (cancellation is not a
	 * failure — e.g. session shutdown races must never be reported as errors). */
	onError?: (error: unknown) => void | Promise<void>;
}

export class BackgroundTaskQueue {
	private concurrency: number;
	private readonly pending: PendingTask[] = [];
	private readonly active = new Set<AbortController>();
	private readonly completions = new WeakMap<AbortController, Promise<void>>();
	private readonly idleWaiters = new Set<() => void>();
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

	enqueue(task: BackgroundTask, onCancelled?: () => void, onError?: (error: unknown) => void | Promise<void>): AbortController {
		const controller = new AbortController();
		let complete!: () => void;
		const completion = new Promise<void>((resolve) => {
			complete = resolve;
		});
		this.completions.set(controller, completion);
		if (this.stopped) {
			controller.abort();
			this.runCancelled(onCancelled);
			complete();
			return controller;
		}

		this.pending.push({ task, controller, complete, onCancelled, onError });
		this.drain();
		return controller;
	}

	/** Resolve after this exact task has left the pending/active sets. This is
	 * stronger than waiting for its task body: callers may safely reuse a
	 * concurrency slot or the task's persisted checkpoint after it resolves. */
	waitForTask(controller: AbortController | undefined): Promise<void> {
		if (!controller) return Promise.resolve();
		return this.completions.get(controller) ?? Promise.resolve();
	}

	/** Cancel one queued/running task. Queued entries are removed immediately;
	 * active entries resolve waitForTask only after their body and error handler
	 * have quiesced and the concurrency slot has been released. */
	cancel(controller: AbortController | undefined): void {
		if (!controller) return;
		controller.abort();
		const index = this.pending.findIndex((entry) => entry.controller === controller);
		if (index !== -1) {
			const [entry] = this.pending.splice(index, 1);
			this.runCancelled(entry.onCancelled);
			entry.complete();
			this.drain();
			this.resolveIdleWaiters();
		}
	}

	/** Resolve once no queued or running task remains. */
	waitForIdle(): Promise<void> {
		if (this.pending.length === 0 && this.active.size === 0) return Promise.resolve();
		return new Promise<void>((resolve) => this.idleWaiters.add(resolve));
	}

	/** Stop queued work and request cancellation for running work. */
	cancelAll(): void {
		if (this.stopped) return;
		this.stopped = true;

		for (const entry of this.pending.splice(0)) {
			entry.controller.abort();
			this.runCancelled(entry.onCancelled);
			entry.complete();
		}
		for (const controller of this.active) controller.abort();
		this.resolveIdleWaiters();
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
			if (!entry) {
				this.resolveIdleWaiters();
				return;
			}
			if (entry.controller.signal.aborted) {
				this.runCancelled(entry.onCancelled);
				entry.complete();
				continue;
			}

			this.active.add(entry.controller);
			void entry.task(entry.controller.signal)
				.catch(async (error: unknown) => {
					// Cancellation is not a failure: aborted work (e.g. session
					// shutdown) must never be reported as an exception.
					if (entry.controller.signal.aborted) return;
					try {
						await entry.onError?.(error);
					} catch {
						/* error reporting must never break the queue */
					}
				})
				.finally(() => {
					this.active.delete(entry.controller);
					entry.complete();
					this.drain();
					this.resolveIdleWaiters();
				});
		}
	}

	private resolveIdleWaiters(): void {
		if (this.pending.length > 0 || this.active.size > 0) return;
		for (const resolve of this.idleWaiters) resolve();
		this.idleWaiters.clear();
	}
}
