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
});
