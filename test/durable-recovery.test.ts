import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import fsPromises, { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, mock } from "node:test";
import { promisify } from "node:util";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getProjectRoot, getSubagentsRoot } from "../src/execution/spawn.ts";
import { withManifestMutation } from "../src/isolation/manifest-mutation.ts";
import { announceRecoveryRecords, getRecoveryManifestPath, persistRecoveryRecords, readRecoveryRecords, type RecoveryRecord } from "../src/isolation/recovery.ts";
import { measureDurableUsage } from "../src/isolation/cleanup.ts";
import { pruneWorkflowRecords } from "../src/workflow/durable.ts";
import { TEMP_OWNER_FILE_NAME } from "../src/isolation/temp-hygiene.ts";
import { createWorktreeIsolation, worktreeSnapshot } from "../src/isolation/worktree.ts";
import { getThreadsManifestPath, readThreadRecords, removeThreadRecord, threadRecordFromThread, threadRecordIdentity, upsertThreadRecord, type ThreadRecord } from "../src/lifecycle/durable.ts";
import { createRuntime } from "../src/lifecycle/runtime.ts";
import { bootstrapDurableState, restoreDurableThreads } from "../src/lifecycle/thread-restore.ts";
import { monitor } from "../src/presentation/monitor.ts";

const execFileAsync = promisify(execFile);
const fakePi = () => ({ getActiveTools: () => [], getAllTools: () => [], on: () => undefined, sendMessage: () => undefined }) as unknown as ExtensionAPI;

async function fixture(run: (root: string, configPath: string, cwd: string) => Promise<void>): Promise<void> {
	const root = await mkdtemp(join(tmpdir(), "pi-subagents-durable-regression-"));
	const cwd = join(root, "repository");
	await mkdir(cwd, { recursive: true });
	try {
		await run(root, join(root, "agent", "settings.json"), cwd);
	} finally {
		monitor.clear();
		await rm(root, { recursive: true, force: true });
	}
}

function legacyRecord(cwd: string, createdAt: number): ThreadRecord {
	return {
		runId: 7, createdAt, updatedAt: Date.now(), generation: 1,
		agentName: "artisan", task: `interrupted ${createdAt}`, cwd, executionCwd: cwd,
		isolation: "shared", state: "parked", elapsedMs: 1, childPids: [],
	};
}

// Independent Node processes have independent monitors, runtimes and host file
// queues. Both allocate #1 before either writes its first checkpoint.
const windowScript = `
import { createRuntime } from "./src/lifecycle/runtime.ts";
import { restoreDurableThreads } from "./src/lifecycle/thread-restore.ts";
import { threadRecordFromThread, upsertThreadRecord, removeThreadRecord, getThreadsManifestPath } from "./src/lifecycle/durable.ts";
import { RunControl } from "./src/execution/run-control.ts";
import { monitor } from "./src/presentation/monitor.ts";
import { withManifestMutation } from "./src/isolation/manifest-mutation.ts";
const [configPath, cwd] = process.argv.slice(1);
const pi = { getActiveTools: () => [], getAllTools: () => [], on: () => {}, sendMessage: () => {} };
const runtime = createRuntime(pi, configPath);
await restoreDurableThreads(runtime, cwd);
const thread = {
 id: monitor.reserveRunId(), generation: 1, agentName: "artisan", task: "live window",
 cwd, executionCwd: cwd, isolation: "shared", state: "running", control: new RunControl("live window", 1),
 generationCompletion: Promise.resolve(), lifecycleVersion: 0, elapsedMs: 1, finalizeIsolation: async () => undefined,
};
runtime.threads.set(thread.id, thread);
process.on("message", async ({ command, task }) => {
 try {
  if (command === "checkpoint") {
   thread.task = task;
   await upsertThreadRecord(configPath, threadRecordFromThread(thread, "parked"));
  } else if (command === "restore") {
   await restoreDurableThreads(runtime, cwd);
  } else if (command === "settle") {
   thread.state = "completed";
   await removeThreadRecord(configPath, thread.durableId, cwd);
  } else if (command === "shutdown") {
   await runtime.shutdown();
  } else if (command === "holdLock") {
   await withManifestMutation(getThreadsManifestPath(configPath, cwd), async () => {
    process.send({ command, id: thread.id });
    await new Promise(() => {});
   });
  }
  process.send({ command, id: thread.id, durableId: thread.durableId });
 } catch (error) { process.send({ command, error: String(error) }); }
});
process.send({ command: "ready", id: thread.id });
`;

function nextMessage(child: ChildProcess): Promise<any> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => done(new Error("Window did not respond")), 15_000);
		const onMessage = (value: any) => done(value.error ? new Error(value.error) : undefined, value);
		const onExit = (code: number | null) => done(new Error(`Window exited with ${code}`));
		function done(error?: Error, value?: unknown): void {
			clearTimeout(timer);
			child.off("message", onMessage);
			child.off("exit", onExit);
			error ? reject(error) : resolve(value);
		}
		child.once("message", onMessage);
		child.once("exit", onExit);
	});
}

async function startWindow(configPath: string, cwd: string): Promise<ChildProcess> {
	const child = spawn(process.execPath, ["--input-type=module", "-e", windowScript, configPath, cwd], {
		cwd: process.cwd(), stdio: ["ignore", "ignore", "pipe", "ipc"],
	});
	let stderr = "";
	child.stderr!.on("data", (data) => { stderr += data; });
	try {
		assert.equal((await nextMessage(child)).id, 1);
		return child;
	} catch (error) {
		child.kill();
		throw new Error(`${error}\n${stderr}`);
	}
}

async function command(child: ChildProcess, name: string, task?: string): Promise<any> {
	const response = nextMessage(child);
	child.send({ command: name, task });
	return response;
}

async function killWindow(child: ChildProcess): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return;
	const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
	child.kill();
	await exited;
}

describe("durable identity across Pi windows", () => {
	it("keeps colliding live #1 checkpoints separate through updates, settlement, shutdown and restore", async () => {
		await fixture(async (_root, configPath, cwd) => {
			const a = await startWindow(configPath, cwd);
			const b = await startWindow(configPath, cwd);
			try {
				const first = await command(a, "checkpoint", "window A");
				await command(b, "restore"); // A's live owner must be left alone.
				const second = await command(b, "checkpoint", "window B");
				assert.notEqual(first.durableId, second.durableId);
				for (let index = 0; index < 4; index++) {
					await Promise.all([command(a, "checkpoint", `window A ${index}`), command(b, "checkpoint", `window B ${index}`)]);
				}
				const both = await readThreadRecords(configPath);
				assert.deepEqual(both.map((record) => record.runId), [1, 1]);
				assert.deepEqual(new Set(both.map((record) => record.task)), new Set(["window A 3", "window B 3"]));
				await command(b, "settle");
				await command(b, "shutdown");
				assert.deepEqual((await readThreadRecords(configPath)).map((record) => record.durableId), [first.durableId]);
				await killWindow(a); // A crashes; its last checkpoint remains recoverable.
				const runtime = createRuntime(fakePi(), configPath);
				assert.deepEqual(await restoreDurableThreads(runtime, cwd), [1]);
				assert.equal(runtime.threads.get(1)?.durableId, first.durableId);
				await runtime.shutdown();
				assert.equal((await readThreadRecords(configPath)).length, 1);
			} finally {
				await Promise.all([killWindow(a), killWindow(b)]);
			}
		});
	});

	it("reclaims a crashed manifest writer's cross-process lock", async () => {
		await fixture(async (_root, configPath, cwd) => {
			const child = await startWindow(configPath, cwd);
			try {
				await command(child, "holdLock");
				await killWindow(child);
				await withManifestMutation(getThreadsManifestPath(configPath, cwd), async () => undefined);
				assert.equal(existsSync(`${getThreadsManifestPath(configPath, cwd)}.lock`), false);
			} finally {
				await killWindow(child);
			}
		});
	});

	it("adopts legacy records with colliding display ids and removes only the selected identity", async () => {
		await fixture(async (_root, configPath, cwd) => {
			const records = [
				{ ...legacyRecord(cwd, 1), sessionId: "missing", sessionDir: join(getProjectRoot(configPath, cwd), "sessions", "pi-subagent-session-missing") },
				legacyRecord(cwd, 2),
			];
			const path = getThreadsManifestPath(configPath, cwd);
			await mkdir(getProjectRoot(configPath, cwd), { recursive: true });
			await writeFile(path, JSON.stringify({ version: 1, records }));
			const runtime = createRuntime(fakePi(), configPath);
			assert.deepEqual(await restoreDurableThreads(runtime, cwd), [7, 8]);
			assert.equal(runtime.threads.get(7)?.sessionDir, records[0]!.sessionDir);
			assert.equal(runtime.threads.get(7)?.durableId, threadRecordIdentity(records[0]!));
			const second = runtime.threads.get(8)!;
			assert.equal(second.durableId, threadRecordIdentity(records[1]!));
			await upsertThreadRecord(configPath, threadRecordFromThread(second, "parked"));
			assert.equal((await readThreadRecords(configPath)).length, 2);
			await removeThreadRecord(configPath, runtime.threads.get(7)!.durableId!, cwd);
			runtime.threads.get(7)!.state = "completed";
			await runtime.shutdown();
			const [remaining] = await readThreadRecords(configPath);
			assert.equal(remaining?.runId, 8);
			assert.equal(remaining?.durableId, second.durableId);
		});
	});
});

describe("temporarily unavailable recovery sources", () => {
	for (const unavailable of ["checkout", "git", "aliased checkout"] as const) {
		it(`preserves managed edits when the source ${unavailable} is unavailable`, async () => {
			await fixture(async (root, configPath, repository) => {
				let recordedCwd = repository;
				if (unavailable === "aliased checkout") {
					const alias = join(root, "source-alias");
					await symlink(root, alias, process.platform === "win32" ? "junction" : "dir");
					recordedCwd = join(alias, "repository");
				}
				const storageRoot = getProjectRoot(configPath, recordedCwd);
				await writeFile(join(repository, "tracked.txt"), "original\n");
				await execFileAsync("git", ["init"], { cwd: repository });
				await execFileAsync("git", ["add", "."], { cwd: repository });
				await execFileAsync("git", ["-c", "user.name=Recovery Test", "-c", "user.email=recovery@example.invalid", "commit", "-m", "initial"], { cwd: repository });
				const worktree = await createWorktreeIsolation(recordedCwd, { tempBaseDir: join(storageRoot, "worktrees") });
				const pending = join(worktree.cwd, "pending.txt");
				await writeFile(pending, "unintegrated edit\n");
				await writeFile(join(worktree.tempDir, TEMP_OWNER_FILE_NAME), JSON.stringify({ pid: 2147483647, createdAt: 1 }));
				await upsertThreadRecord(configPath, {
					...legacyRecord(recordedCwd, Date.now()), isolation: "worktree", executionCwd: worktree.cwd,
					worktree: worktreeSnapshot(worktree),
				});
				const source = unavailable === "git" ? join(repository, ".git") : repository;
				const moved = `${source}-unavailable`;
				await rename(source, moved);
				const runtime = createRuntime(fakePi(), configPath);
				try {
					assert.equal(getProjectRoot(configPath, recordedCwd), storageRoot, "source unavailability must not change the durable project key");
					await bootstrapDurableState(runtime, root);
					assert.equal(await readFile(pending, "utf8"), "unintegrated edit\n");
					assert.equal((await readThreadRecords(configPath)).length, 1);
					await restoreDurableThreads(runtime, recordedCwd);
					assert.equal(runtime.threads.get(7)?.state, "failed");
					assert.ok(runtime.threads.get(7)?.restorationRecord);
					await runtime.shutdown();
					assert.equal((await readThreadRecords(configPath)).length, 1);
				} finally {
					await rename(moved, source);
					await worktree.discard();
				}
			});
		});
	}
});

describe("recovery lock isolation", () => {
	it("never treats a held root manifest lock as a project during concurrent scans", async () => {
		await fixture(async (_root, configPath) => {
			const path = getRecoveryManifestPath(configPath);
			const lockDir = `${path}.lock`;
			await withManifestMutation(path, async () => {
				const originalMkdir = fsPromises.mkdir;
				const guard = mock.method(fsPromises, "mkdir", async (target: Parameters<typeof mkdir>[0], options: Parameters<typeof mkdir>[1]) => {
					const nested = String(target).startsWith(lockDir + "/") || String(target).startsWith(lockDir + "\\");
					assert.equal(nested, false, "a manifest scan must not create a nested lock inside another lock");
					return originalMkdir(target, options);
				});
				syncBuiltinESMExports();
				try {
					await Promise.all([readThreadRecords(configPath), pruneWorkflowRecords(configPath)]);
					assert.deepEqual(measureDurableUsage(getSubagentsRoot(configPath)).projects, []);
				} finally {
					guard.mock.restore();
					syncBuiltinESMExports();
				}
			});
			assert.equal(existsSync(lockDir), false, "successful mutation must release the root lock");
			await withManifestMutation(path, async () => undefined);
		});
	});
});

describe("recovery announcement mutation", () => {
	it("preserves a failure appended while announcement removes an older integrated artifact", async () => {
		await fixture(async (_root, configPath, cwd) => {
			const group = (id: number) => join(getProjectRoot(configPath, cwd), "worktrees", `pi-subagent-worktree-${id}`);
			const recovery = (id: number): RecoveryRecord => ({
				runId: id, createdAt: Date.now(), integrated: id === 1, worktreePath: join(group(id), "worktree"), error: `failure ${id}`,
			});
			await mkdir(recovery(1).worktreePath!, { recursive: true });
			await mkdir(recovery(2).worktreePath!, { recursive: true });
			await persistRecoveryRecords(configPath, [recovery(1)]);
			const originalRm = fsPromises.rm;
			let appended = false;
			const removal = mock.method(fsPromises, "rm", async (path: Parameters<typeof rm>[0], options: Parameters<typeof rm>[1]) => {
				if (path === group(1)) {
					await persistRecoveryRecords(configPath, [recovery(2)]);
					appended = true;
					assert.equal((await readRecoveryRecords(configPath)).length, 2);
				}
				return originalRm(path, options);
			});
			syncBuiltinESMExports();
			try {
				await announceRecoveryRecords(configPath, { cwd, hasUI: true, ui: { notify: () => undefined } });
				assert.equal(appended, true);
				assert.equal(existsSync(group(1)), false);
				assert.equal(existsSync(group(2)), true);
				assert.deepEqual((await readRecoveryRecords(configPath)).map((record) => record.runId), [2]);
			} finally {
				removal.mock.restore();
				syncBuiltinESMExports();
			}
		});
	});
});
