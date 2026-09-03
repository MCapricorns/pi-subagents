import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { BackgroundTaskQueue } from "../src/background.ts";
import type { CompletionMessageItem } from "../src/completion.ts";
import { readThreadRecords, upsertThreadRecord, type ThreadRecord } from "../src/durable.ts";
import { monitor } from "../src/monitor.ts";
import { createRuntime } from "../src/runtime.ts";
import { emptyUsage } from "../src/rpc-run.ts";
import { restoreDurableThreads } from "../src/thread-lifecycle.ts";

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function fakePi(sent: Array<{ message: unknown; options: unknown }>): ExtensionAPI {
	return {
		getActiveTools: () => [],
		on: () => undefined,
		sendMessage: (message: unknown, options: unknown) => {
			sent.push({ message, options });
		},
	} as unknown as ExtensionAPI;
}

function completion(agent: string): CompletionMessageItem {
	return { agent, block: `${agent} completed`, usage: emptyUsage() };
}

describe("BackgroundTaskQueue slot ownership", () => {
	it("makes a suspended lane waiter reacquire a slot before child work", async () => {
		const queue = new BackgroundTaskQueue(1);
		const laneGranted = deferred();
		const releaseOther = deferred();
		const order: string[] = [];

		const writer = queue.enqueue(async (_signal, controller) => {
			order.push("writer-waiting");
			queue.suspend(controller);
			await laneGranted.promise;
			assert.equal(await queue.acquire(controller), true);
			order.push("writer-child");
		});
		const other = queue.enqueue(async () => {
			order.push("other-child");
			await releaseOther.promise;
		});

		assert.deepEqual(order, ["writer-waiting", "other-child"]);
		assert.equal(queue.activeCount, 1);
		laneGranted.resolve();
		await Promise.resolve();
		assert.deepEqual(order, ["writer-waiting", "other-child"]);

		releaseOther.resolve();
		await Promise.all([queue.waitForTask(writer), queue.waitForTask(other)]);
		assert.deepEqual(order, ["writer-waiting", "other-child", "writer-child"]);
		assert.equal(queue.activeCount, 0);
	});

	it("releases a finished child's slot while finalization remains owned", async () => {
		const queue = new BackgroundTaskQueue(1);
		const finalizationStarted = deferred();
		const releaseFinalization = deferred();
		const otherStarted = deferred();
		const releaseOther = deferred();

		const isolated = queue.enqueue(async (_signal, controller) => {
			queue.suspend(controller);
			finalizationStarted.resolve();
			await releaseFinalization.promise;
		});
		await finalizationStarted.promise;
		const other = queue.enqueue(async () => {
			otherStarted.resolve();
			await releaseOther.promise;
		});
		await otherStarted.promise;

		assert.equal(queue.activeCount, 1);
		let isolatedSettled = false;
		void queue.waitForTask(isolated).then(() => {
			isolatedSettled = true;
		});
		await Promise.resolve();
		assert.equal(isolatedSettled, false);

		releaseFinalization.resolve();
		releaseOther.resolve();
		await Promise.all([queue.waitForTask(isolated), queue.waitForTask(other)]);
		assert.equal(queue.activeCount, 0);
	});
});

describe("completion delivery ownership", () => {
	it("uses follow-up wakeups and delivers an awaited result through exactly one route", () => {
		const sent: Array<{ message: any; options: any }> = [];
		const runtime = createRuntime(fakePi(sent), join(tmpdir(), "pi-subagents-test-config.json"));

		runtime.claimRunDelivery(1, "await");
		runtime.publishRunCompletion(1, completion("scout"), false);
		assert.equal(sent.length, 0);
		runtime.completeAwaitDelivery([1]);
		runtime.fallbackAwaitDelivery([1]);
		assert.equal(sent.length, 0);

		runtime.claimRunDelivery(2, "await");
		runtime.publishRunCompletion(2, completion("artisan"), false);
		runtime.fallbackAwaitDelivery([2]);
		runtime.completionBatcher.flush();
		runtime.fallbackAwaitDelivery([2]);
		assert.equal(sent.length, 1);
		assert.deepEqual(sent[0]?.options, { deliverAs: "followUp", triggerTurn: true });
	});

	it("flushes held successes before an immediate failure", () => {
		const sent: Array<{ message: any; options: any }> = [];
		const runtime = createRuntime(fakePi(sent), join(tmpdir(), "pi-subagents-test-config.json"));

		runtime.claimRunDelivery(1, "background");
		runtime.publishRunCompletion(1, completion("scout"), false);
		runtime.claimRunDelivery(2, "background");
		runtime.publishRunCompletion(2, completion("artisan"), true);

		assert.equal(sent.length, 2);
		assert.match(sent[0]?.message.content, /scout completed/);
		assert.match(sent[1]?.message.content, /artisan completed/);
	});
});

describe("durable worktree restoration", () => {
	it("surfaces a missing recorded worktree as failed and non-resumable", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-subagents-restore-"));
		const configPath = join(root, "settings.json");
		const cwd = join(root, "project");
		const sessionDir = join(root, "session");
		const sessionId = "retained-session";
		await mkdir(cwd, { recursive: true });
		await mkdir(sessionDir, { recursive: true });
		await writeFile(join(sessionDir, `2026-01-01T00-00-00.000Z_${sessionId}.jsonl`), "{}\n", "utf8");
		const missingWorktree = join(root, "missing-worktree");
		const record: ThreadRecord = {
			runId: 41,
			createdAt: Date.now(),
			updatedAt: Date.now(),
			generation: 1,
			agentName: "artisan",
			task: "retained edits",
			cwd,
			executionCwd: missingWorktree,
			isolation: "worktree",
			state: "parked",
			elapsedMs: 10,
			sessionId,
			sessionDir,
			childPids: [],
			worktree: {
				originalCwd: cwd,
				originalRoot: cwd,
				cwd: missingWorktree,
				worktreePath: missingWorktree,
				tempDir: join(root, "worktree-group"),
				patchPath: join(root, "worktree-group", "changes.patch"),
				head: "abc",
				integrationBaseHead: "abc",
				state: "active",
			},
		};

		try {
			await upsertThreadRecord(configPath, record);
			const runtime = createRuntime(fakePi([]), configPath);
			const restored = await restoreDurableThreads(runtime);
			assert.deepEqual(restored, []);
			const thread = runtime.threads.get(41);
			assert.ok(thread);
			assert.equal(thread.state, "failed");
			assert.equal(monitor.findRun(41)?.status, "failed");
			const resume = await thread.resume();
			assert.notEqual(resume.exitCode, -1);
			assert.match(resume.errorMessage ?? resume.stderr, /worktree.*could not be restored/i);
			await runtime.shutdown();
			const retained = (await readThreadRecords(configPath)).find((candidate) => candidate.runId === 41);
			assert.equal(retained?.state, "parked");
			assert.equal(retained?.worktree?.worktreePath, missingWorktree);
		} finally {
			monitor.clear();
			await rm(root, { recursive: true, force: true });
		}
	});
});
