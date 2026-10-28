import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { BackgroundTaskQueue } from "../src/execution/background.ts";
import { getProjectRoot } from "../src/execution/spawn.ts";
import type { CompletionMessageItem } from "../src/lifecycle/completion.ts";
import { readThreadRecords, upsertThreadRecord, type ThreadRecord } from "../src/lifecycle/durable.ts";
import { monitor } from "../src/presentation/monitor.ts";
import { createRuntime } from "../src/lifecycle/runtime.ts";
import { emptyUsage } from "../src/execution/run-control.ts";
import { restoreDurableThreads } from "../src/lifecycle/thread-restore.ts";

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
		getAllTools: () => [],
		on: () => undefined,
		sendMessage: (message: unknown, options: unknown) => {
			sent.push({ message, options });
		},
	} as unknown as ExtensionAPI;
}

function completion(agent: string): CompletionMessageItem {
	return { agent, block: `${agent} completed`, usage: emptyUsage() };
}

describe("unlimited background execution", () => {
	it("starts every task without waiting for one of six slots", async () => {
		const queue = new BackgroundTaskQueue();
		const release = deferred();
		const started: number[] = [];
		const controllers = Array.from({ length: 12 }, (_, id) => queue.enqueue(async () => {
			started.push(id);
			await release.promise;
		}));
		try {
			assert.equal(started.length, 12);
			assert.equal(queue.activeCount, 12);
			controllers.forEach((controller) => queue.cancel(controller));
			assert.ok(controllers.every((controller) => controller.signal.aborted));
		} finally { release.resolve(); await queue.waitForIdle(); }
	});

	it("reports a synchronous task exception and still releases ownership", async () => {
		const queue = new BackgroundTaskQueue();
		const errors: unknown[] = [];
		const failure = new Error("synchronous failure");
		const controller = queue.enqueue(() => { throw failure; }, undefined, (error) => { errors.push(error); });
		await queue.waitForTask(controller);
		assert.deepEqual(errors, [failure]);
		assert.equal(queue.activeCount, 0);
	});
});

describe("background task ownership", () => {
	it("waits for aborted work and its cleanup before becoming idle", async () => {
		const queue = new BackgroundTaskQueue();
		const release = deferred();
		const controller = queue.enqueue(async () => release.promise);
		queue.cancelAll();
		assert.equal(controller.signal.aborted, true);
		let idle = false;
		void queue.waitForIdle().then(() => { idle = true; });
		await Promise.resolve();
		assert.equal(idle, false);
		release.resolve();
		await queue.waitForTask(controller);
		await queue.waitForIdle();
		assert.equal(queue.activeCount, 0);
	});

	it("rejects new work after shutdown and tolerates cancellation callback failures", async () => {
		const queue = new BackgroundTaskQueue();
		queue.cancelAll();
		let ran = false;
		const controller = queue.enqueue(async () => { ran = true; }, () => { throw new Error("callback failed"); });
		assert.equal(controller.signal.aborted, true);
		assert.equal(ran, false);
		await queue.waitForTask(controller);
		await queue.waitForIdle();
	});
});

describe("completion delivery ownership", () => {
	it("steers completions before the next parent model call and delivers an awaited result once", () => {
		const sent: Array<{ message: any; options: any }> = [];
		const runtime = createRuntime(fakePi(sent), join(tmpdir(), "pi-subagents-test-config.json"));

		runtime.claimRunDelivery(1, "await");
		runtime.publishRunCompletion(1, completion("scout"), false);
		assert.equal(sent.length, 0);
		runtime.completeAwaitDelivery([1]);
		assert.equal(sent.length, 0);

		runtime.claimRunDelivery(2, "background");
		runtime.publishRunCompletion(2, completion("artisan"), false);
		runtime.completionBatcher.flush();
		assert.equal(sent.length, 1);
		assert.deepEqual(sent[0]?.options, { deliverAs: "steer", triggerTurn: true });
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
	it("keeps a missing recorded worktree failure inspectable for recovery", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-subagents-restore-"));
		const configPath = join(root, "settings.json");
		const cwd = await realpath(process.cwd());
		const projectRoot = getProjectRoot(configPath, cwd);
		const sessionDir = join(projectRoot, "sessions", "pi-subagent-session-retained");
		const sessionId = "retained-session";
		await mkdir(sessionDir, { recursive: true });
		await writeFile(join(sessionDir, `2026-01-01T00-00-00.000Z_${sessionId}.jsonl`), "{}\n", "utf8");
		const worktreeGroup = join(projectRoot, "worktrees", "pi-subagent-worktree-missing");
		const missingWorktree = join(worktreeGroup, "worktree");
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
				tempDir: worktreeGroup,
				patchPath: join(worktreeGroup, "changes.patch"),
				head: "abc",
				integrationBaseHead: "abc",
				state: "active",
			},
		};

		try {
			await upsertThreadRecord(configPath, record);
			const runtime = createRuntime(fakePi([]), configPath);
			const restored = await restoreDurableThreads(runtime, cwd);
			assert.deepEqual(restored, []);
			const thread = runtime.threads.get(41);
			assert.ok(thread);
			assert.equal(thread.state, "failed");
			assert.equal(monitor.findRun(41)?.status, "failed");
			assert.match(thread.lastResult?.errorMessage ?? "", /worktree.*could not be restored/i);
			assert.equal(runtime.settledRuns.get(41), thread.lastResult);
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
