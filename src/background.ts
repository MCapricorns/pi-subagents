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

import { cpus } from "node:os";

export type BackgroundTask = (signal: AbortSignal, controller: AbortController) => Promise<void>;

interface PendingTask {
	kind: "task";
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

interface PendingAcquire {
	kind: "acquire";
	controller: AbortController;
	resolve: (acquired: boolean) => void;
}

type PendingEntry = PendingTask | PendingAcquire;

/** Child-process concurrency scales with the host but stays within 4–6.
 * The queue paces wider batches instead of rejecting independent work. */
export function resolveSubagentConcurrency(cpuCount: number = cpus().length): number {
	return Math.min(6, Math.max(4, Math.floor(cpuCount / 2)));
}

export class BackgroundTaskQueue {
	private concurrency: number;
	private readonly pending: PendingEntry[] = [];
	private readonly active = new Set<AbortController>();
	/** Active tasks that no longer count toward the concurrency limit. They keep
	 * every other guarantee: abortable, awaited by waitForTask/waitForIdle. */
	private readonly suspended = new Set<AbortController>();
	private readonly completions = new WeakMap<AbortController, Promise<void>>();
	private readonly idleWaiters = new Set<() => void>();
	private stopped = false;

	constructor(concurrency: number) {
		this.concurrency = Math.max(1, concurrency);
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

		this.pending.push({ kind: "task", task, controller, complete, onCancelled, onError });
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

	/** Slot count, exposed so dispatch/status output can state the real pacing
	 * limit instead of leaving queued work looking like an unexplained cap. */
	get capacity(): number {
		return this.concurrency;
	}

	/** Tasks still waiting for a free slot (never started). */
	get pendingCount(): number {
		return this.pending.filter((entry) => entry.kind === "task").length;
	}

	/** Tasks currently holding a slot. Suspended tasks (lane waits, managed
	 * workflow continuations) hold none and are excluded. */
	get activeCount(): number {
		return this.active.size;
	}

	/** Stop counting a running task toward the concurrency limit. Its body keeps
	 * running under the same abort signal; completion still releases everything
	 * waitForTask/waitForIdle promise. Frees a slot for queued work immediately.
	 *
	 * Used by tasks whose execution is serialized elsewhere anyway (managed
	 * workflow continuations, shared-checkout writers waiting on the repository
	 * lane): letting such a task also hold a global slot would let waiters
	 * starve independent work that could start right away. The controller is
	 * handed to the task body directly, so a task can always suspend itself
	 * without racing the enqueue() caller's assignment. */
	suspend(controller: AbortController | undefined): void {
		if (!controller || this.stopped) return;
		if (!this.active.delete(controller)) return;
		this.suspended.add(controller);
		this.drain();
	}

	/** Reacquire a released process slot before a suspended task starts another
	 * child process. Reacquisitions share FIFO order with not-yet-started tasks,
	 * so lane waiters cannot bypass work already queued for the pool. */
	acquire(controller: AbortController | undefined): Promise<boolean> {
		if (!controller || this.stopped || controller.signal.aborted) return Promise.resolve(false);
		if (this.active.has(controller)) return Promise.resolve(true);
		if (!this.suspended.has(controller)) return Promise.resolve(false);
		return new Promise<boolean>((resolve) => {
			this.pending.push({ kind: "acquire", controller, resolve });
			this.drain();
		});
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
			if (entry.kind === "task") {
				this.runCancelled(entry.onCancelled);
				entry.complete();
			} else {
				this.suspended.delete(controller);
				entry.resolve(false);
			}
			this.drain();
			this.resolveIdleWaiters();
		}
	}

	/** Resolve once no queued or running task remains. */
	waitForIdle(): Promise<void> {
		if (this.pending.length === 0 && this.active.size === 0 && this.suspended.size === 0) return Promise.resolve();
		return new Promise<void>((resolve) => this.idleWaiters.add(resolve));
	}

	/** Stop queued work and request cancellation for running work. */
	cancelAll(): void {
		if (this.stopped) return;
		this.stopped = true;

		for (const entry of this.pending.splice(0)) {
			entry.controller.abort();
			if (entry.kind === "task") {
				this.runCancelled(entry.onCancelled);
				entry.complete();
			} else {
				this.suspended.delete(entry.controller);
				entry.resolve(false);
			}
		}
		for (const controller of this.active) controller.abort();
		for (const controller of this.suspended) controller.abort();
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
				if (entry.kind === "task") {
					this.runCancelled(entry.onCancelled);
					entry.complete();
				} else {
					this.suspended.delete(entry.controller);
					entry.resolve(false);
				}
				continue;
			}

			if (entry.kind === "acquire") {
				if (!this.suspended.delete(entry.controller)) {
					entry.resolve(false);
					continue;
				}
				this.active.add(entry.controller);
				entry.resolve(true);
				continue;
			}

			this.active.add(entry.controller);
			void entry.task(entry.controller.signal, entry.controller)
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
					this.suspended.delete(entry.controller);
					entry.complete();
					this.drain();
					this.resolveIdleWaiters();
				});
		}
	}

	private resolveIdleWaiters(): void {
		if (this.pending.length > 0 || this.active.size > 0 || this.suspended.size > 0) return;
		for (const resolve of this.idleWaiters) resolve();
		this.idleWaiters.clear();
	}
}
