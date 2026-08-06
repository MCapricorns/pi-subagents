import { describe, expect, it } from "vitest";
import { BackgroundTaskQueue } from "../src/background.ts";

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

	it("starts more queued work when the concurrency limit is raised", async () => {
		const queue = new BackgroundTaskQueue(1);
		const gates = [deferred(), deferred(), deferred()];
		const started: number[] = [];

		for (let i = 0; i < 3; i++) {
			const index = i;
			queue.enqueue(async () => {
				started.push(index);
				await gates[index].promise;
			});
		}

		expect(started).toEqual([0]);
		queue.setConcurrency(3);
		await nextTask();
		expect(started).toEqual([0, 1, 2]);
		for (const gate of gates) gate.resolve();
		await nextTask();
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
		expect(activeSignal?.aborted).toBe(true);
		expect(queuedCancelled).toBe(true);
		expect(queuedStarted).toBe(false);
		gate.resolve();
		await nextTask();
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
});
