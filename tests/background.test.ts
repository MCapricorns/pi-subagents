import { describe, expect, it } from "vitest";
import { BackgroundTaskQueue, resolveSubagentConcurrency } from "../src/background.ts";

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

async function nextTask(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("BackgroundTaskQueue", () => {
	it("runs queued work within its concurrency limit", async () => {
		const queue = new BackgroundTaskQueue(1);
		const first = deferred();
		const second = deferred();
		const started: number[] = [];

		queue.enqueue(async () => {
			started.push(1);
			await first.promise;
		});
		queue.enqueue(async () => {
			started.push(2);
			await second.promise;
		});

		expect(started).toEqual([1]);
		first.resolve();
		await nextTask();
		expect(started).toEqual([1, 2]);
		second.resolve();
	});

	it("resolves per-task completion only after the slot is released", async () => {
		const queue = new BackgroundTaskQueue(1);
		const first = deferred();
		let secondStarted = false;
		const controller = queue.enqueue(async () => {
			await first.promise;
		});
		queue.enqueue(async () => {
			secondStarted = true;
		});
		let completed = false;
		const completion = queue.waitForTask(controller).then(() => {
			completed = true;
		});
		expect(completed).toBe(false);
		expect(secondStarted).toBe(false);
		first.resolve();
		await completion;
		expect(completed).toBe(true);
		expect(secondStarted).toBe(true);
	});

	it("cancels queued and active work", async () => {
		const queue = new BackgroundTaskQueue(1);
		const gate = deferred();
		let activeSignal: AbortSignal | undefined;
		let queuedStarted = false;
		let queuedCancelled = false;

		queue.enqueue(async (signal) => {
			activeSignal = signal;
			await gate.promise;
		});
		queue.enqueue(
			async () => {
				queuedStarted = true;
			},
			() => {
				queuedCancelled = true;
			},
		);

		queue.cancelAll();
		let becameIdle = false;
		const idle = queue.waitForIdle().then(() => {
			becameIdle = true;
		});
		expect(activeSignal?.aborted).toBe(true);
		expect(queuedCancelled).toBe(true);
		expect(queuedStarted).toBe(false);
		expect(becameIdle).toBe(false);
		gate.resolve();
		await idle;
		expect(becameIdle).toBe(true);
	});

	it("surfaces task exceptions through onError without breaking the queue", async () => {
		const queue = new BackgroundTaskQueue(1);
		const gate = deferred();
		const errors: unknown[] = [];
		let secondStarted = false;

		queue.enqueue(
			async () => {
				await gate.promise;
				throw new Error("boom");
			},
			undefined,
			(error) => {
				errors.push(error);
			},
		);
		queue.enqueue(async () => {
			secondStarted = true;
		});

		gate.resolve();
		await nextTask();
		await nextTask();
		expect(errors).toHaveLength(1);
		expect((errors[0] as Error).message).toBe("boom");
		expect(secondStarted).toBe(true);
	});

	it("does not report cancelled work as an error", async () => {
		const queue = new BackgroundTaskQueue(1);
		const gate = deferred();
		let onErrorCalled = false;

		const controller = queue.enqueue(
			async (signal) => {
				await gate.promise;
				signal.throwIfAborted();
			},
			undefined,
			() => {
				onErrorCalled = true;
			},
		);
		controller.abort();
		gate.resolve();
		await nextTask();
		await nextTask();
		expect(onErrorCalled).toBe(false);
	});

	it("does not call onError for a queued task cancelled before it starts", async () => {
		const queue = new BackgroundTaskQueue(1);
		const gate = deferred();
		let onErrorCalled = false;
		let cancelled = false;

		queue.enqueue(async () => {
			await gate.promise;
		});
		queue.enqueue(
			async () => {
				throw new Error("must not run");
			},
			() => {
				cancelled = true;
			},
			() => {
				onErrorCalled = true;
			},
		);

		queue.cancelAll();
		gate.resolve();
		await nextTask();
		expect(cancelled).toBe(true);
		expect(onErrorCalled).toBe(false);
	});

	it("survives an onError callback that throws", async () => {
		const queue = new BackgroundTaskQueue(1);
		const gate = deferred();
		let secondStarted = false;

		queue.enqueue(
			async () => {
				await gate.promise;
				throw new Error("boom");
			},
			undefined,
			() => {
				throw new Error("onError blew up");
			},
		);
		queue.enqueue(async () => {
			secondStarted = true;
		});

		gate.resolve();
		await nextTask();
		await nextTask();
		expect(secondStarted).toBe(true);
	});

	it("survives an onCancelled callback that throws", async () => {
		const queue = new BackgroundTaskQueue(1);
		const gate = deferred();
		let secondStarted = false;

		queue.enqueue(async () => {
			await gate.promise;
		});
		const cancelled = queue.enqueue(
			async () => {
				throw new Error("must not run");
			},
			() => {
				throw new Error("onCancelled blew up");
			},
		);
		// The queued entry is drained only when the active task finishes; abort it
		// first so drain hits the cancelled path with a throwing callback.
		cancelled.abort();
		gate.resolve();
		await nextTask();
		// A throwing cancellation callback must not break the queue: the next
		// enqueue still runs normally.
		queue.enqueue(async () => {
			secondStarted = true;
		});
		await nextTask();
		expect(secondStarted).toBe(true);
	});

	it("survives an onCancelled callback that throws during cancelAll", async () => {
		const queue = new BackgroundTaskQueue(1);
		const gate = deferred();

		queue.enqueue(async () => {
			await gate.promise;
		});
		queue.enqueue(
			async () => {
				throw new Error("must not run");
			},
			() => {
				throw new Error("onCancelled blew up");
			},
		);

		expect(() => queue.cancelAll()).not.toThrow();
		gate.resolve();
		await nextTask();
	});

	it("frees a slot when a running task suspends itself", async () => {
		const queue = new BackgroundTaskQueue(1);
		const suspendedTask = deferred();
		let secondStarted = false;
		const controller = queue.enqueue(async () => {
			await suspendedTask.promise;
		});
		queue.enqueue(async () => {
			secondStarted = true;
		});
		expect(secondStarted).toBe(false);

		queue.suspend(controller);
		await nextTask();
		expect(secondStarted).toBe(true);

		// waitForTask still resolves only after the suspended body quiesces.
		let completed = false;
		const completion = queue.waitForTask(controller).then(() => {
			completed = true;
		});
		expect(completed).toBe(false);
		suspendedTask.resolve();
		await completion;
		expect(completed).toBe(true);
	});

	it("keeps a suspended task abortable and counted by waitForIdle", async () => {
		const queue = new BackgroundTaskQueue(1);
		const gate = deferred();
		let aborted = false;
		const controller = queue.enqueue(async (signal) => {
			signal.addEventListener("abort", () => {
				aborted = true;
			});
			queue.suspend(controller);
			await gate.promise;
		});
		await nextTask();

		let idle = false;
		void queue.waitForIdle().then(() => {
			idle = true;
		});
		expect(idle).toBe(false);

		queue.cancel(controller);
		expect(aborted).toBe(true);
		gate.resolve();
		await nextTask();
		await queue.waitForIdle();
		expect(idle).toBe(true);
	});

	it("hands each task body its own controller so it can suspend itself before its first await", async () => {
		const queue = new BackgroundTaskQueue(1);
		const gate = deferred();
		let secondStarted = false;
		queue.enqueue((_signal, controller) => {
			// Synchronous first line, exactly like a shared writer parking itself
			// on the repository lane: the slot must free before any await.
			queue.suspend(controller);
			return gate.promise;
		});
		// The self-suspend already ran synchronously inside enqueue(), so the
		// next task starts without waiting for the first one to finish.
		queue.enqueue(async () => {
			secondStarted = true;
		});
		expect(secondStarted).toBe(true);
		gate.resolve();
		await queue.waitForIdle();
	});

	it("derives concurrency from the host and reports it via capacity", () => {
		expect(new BackgroundTaskQueue(resolveSubagentConcurrency(2)).capacity).toBe(4);
		expect(resolveSubagentConcurrency(2)).toBe(4);
		expect(resolveSubagentConcurrency(7)).toBe(4);
		expect(resolveSubagentConcurrency(8)).toBe(4);
		expect(resolveSubagentConcurrency(16)).toBe(8);
		expect(resolveSubagentConcurrency(64)).toBe(16);
	});
});
