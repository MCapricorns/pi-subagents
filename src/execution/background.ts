/** Bounded background task scheduler: up to MAX_CONCURRENT_SUBAGENTS tasks execute
 * concurrently, and each remains owned until its settlement cleanup finishes. */

export const MAX_CONCURRENT_SUBAGENTS = 5;

type BackgroundTask = (signal: AbortSignal, releaseSlot: () => void) => Promise<void>;

interface PendingTask {
	task: BackgroundTask;
	controller: AbortController;
	complete: () => void;
	onError?: (error: unknown) => void | Promise<void>;
}

export class BackgroundTaskQueue {
	private readonly concurrency: number;
	private readonly pending: PendingTask[] = [];
	private readonly executing = new Set<AbortController>();
	private readonly owned = new Set<AbortController>();
	private readonly completions = new WeakMap<AbortController, Promise<void>>();
	private readonly idleWaiters = new Set<() => void>();
	private stopped = false;

	constructor(concurrency: number = MAX_CONCURRENT_SUBAGENTS) {
		this.concurrency = Math.max(1, Math.floor(concurrency));
	}

	enqueue(task: BackgroundTask, onError?: (error: unknown) => void | Promise<void>): AbortController {
		const controller = new AbortController();
		if (this.stopped) {
			controller.abort();
			this.completions.set(controller, Promise.resolve());
			return controller;
		}
		let complete!: () => void;
		this.completions.set(controller, new Promise<void>((resolve) => { complete = resolve; }));
		this.owned.add(controller);
		this.pending.push({ task, controller, complete, onError });
		this.drain();
		return controller;
	}

	/** Wait for the task body and error handler, including isolation cleanup. */
	waitForTask(controller: AbortController | undefined): Promise<void> {
		return (controller && this.completions.get(controller)) || Promise.resolve();
	}

	get capacity(): number { return this.concurrency; }

	get activeCount(): number { return this.executing.size; }

	get pendingCount(): number { return this.pending.length; }

	cancel(controller: AbortController | undefined): void {
		if (!controller) return;
		controller.abort();
		const index = this.pending.findIndex((entry) => entry.controller === controller);
		if (index === -1) return;
		const [entry] = this.pending.splice(index, 1);
		this.owned.delete(controller);
		entry!.complete();
		this.resolveIdleIfDone();
	}

	waitForIdle(): Promise<void> {
		return this.owned.size === 0 ? Promise.resolve() : new Promise<void>((resolve) => this.idleWaiters.add(resolve));
	}

	cancelAll(): void {
		this.stopped = true;
		for (const entry of this.pending.splice(0)) {
			entry.controller.abort();
			this.owned.delete(entry.controller);
			entry.complete();
		}
		for (const controller of this.owned) controller.abort();
		this.resolveIdleIfDone();
	}

	private drain(): void {
		while (!this.stopped && this.executing.size < this.concurrency && this.pending.length > 0) {
			const entry = this.pending.shift()!;
			const { controller, task, onError, complete } = entry;
			if (controller.signal.aborted) {
				this.owned.delete(controller);
				complete();
				this.resolveIdleIfDone();
				continue;
			}
			this.executing.add(controller);
			const releaseSlot = (): void => {
				if (!this.executing.delete(controller)) return;
				this.drain();
			};
			// The async boundary catches synchronous throws as well as rejected tasks.
			void (async () => task(controller.signal, releaseSlot))()
				.catch(async (error: unknown) => {
					if (controller.signal.aborted) return;
					try { await onError?.(error); } catch { /* error reporting must not strand ownership */ }
				})
				.finally(() => {
					releaseSlot();
					this.owned.delete(controller);
					complete();
					this.resolveIdleIfDone();
				});
		}
	}

	private resolveIdleIfDone(): void {
		if (this.owned.size !== 0) return;
		for (const resolve of this.idleWaiters) resolve();
		this.idleWaiters.clear();
	}
}
