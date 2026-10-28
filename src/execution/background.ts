/** Background tasks start immediately and remain owned until cleanup finishes. */

export type BackgroundTask = (signal: AbortSignal, controller: AbortController) => Promise<void>;

export class BackgroundTaskQueue {
	private readonly active = new Set<AbortController>();
	private readonly completions = new WeakMap<AbortController, Promise<void>>();
	private readonly idleWaiters = new Set<() => void>();
	private stopped = false;

	enqueue(task: BackgroundTask, onCancelled?: () => void, onError?: (error: unknown) => void | Promise<void>): AbortController {
		const controller = new AbortController();
		if (this.stopped) {
			controller.abort();
			try { onCancelled?.(); } catch { /* cancellation callbacks must not break teardown */ }
			return controller;
		}
		let complete!: () => void;
		this.completions.set(controller, new Promise<void>((resolve) => { complete = resolve; }));
		this.active.add(controller);
		// The async boundary catches synchronous throws as well as rejected tasks.
		void (async () => task(controller.signal, controller))()
			.catch(async (error: unknown) => {
				if (controller.signal.aborted) return;
				try { await onError?.(error); } catch { /* error reporting must not strand ownership */ }
			})
			.finally(() => {
				this.active.delete(controller);
				complete();
				if (this.active.size !== 0) return;
				for (const resolve of this.idleWaiters) resolve();
				this.idleWaiters.clear();
			});
		return controller;
	}

	/** Wait for the task body and error handler, including isolation cleanup. */
	waitForTask(controller: AbortController | undefined): Promise<void> {
		return (controller && this.completions.get(controller)) || Promise.resolve();
	}

	get activeCount(): number { return this.active.size; }

	cancel(controller: AbortController | undefined): void { controller?.abort(); }

	waitForIdle(): Promise<void> {
		return this.active.size === 0 ? Promise.resolve() : new Promise<void>((resolve) => this.idleWaiters.add(resolve));
	}

	cancelAll(): void {
		this.stopped = true;
		for (const controller of this.active) controller.abort();
	}
}
