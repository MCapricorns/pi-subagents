import assert from "node:assert/strict";
import { existsSync, utimesSync } from "node:fs";
import fsPromises, { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir, uptime } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getProjectRoot } from "../src/execution/spawn.ts";
import { runAutomaticCleanup, runStorageCleanup } from "../src/isolation/cleanup.ts";
import { getRecoveryManifestPath } from "../src/isolation/recovery.ts";
import { getThreadsManifestPath, PARKED_RECORD_MAX_AGE_MS, pruneThreadRecords, readThreadRecords, type ThreadRecord } from "../src/lifecycle/durable.ts";
import { createRuntime } from "../src/lifecycle/runtime.ts";
import { bootstrapDurableState } from "../src/lifecycle/thread-restore.ts";
import { monitor } from "../src/presentation/monitor.ts";

const fakePi = () => ({ getActiveTools: () => [], getAllTools: () => [], on: () => undefined, sendMessage: () => undefined }) as unknown as ExtensionAPI;

async function fixture(run: (configPath: string, cwd: string) => Promise<void>): Promise<void> {
	const root = await mkdtemp(join(tmpdir(), "pi-subagents-retention-safety-"));
	const cwd = join(root, "project");
	await mkdir(cwd);
	try { await run(join(root, "agent", "config.json"), cwd); }
	finally { monitor.clear(); await rm(root, { recursive: true, force: true }); }
}

function record(cwd: string, sessionDir: string, overrides: Partial<ThreadRecord> = {}): ThreadRecord {
	return {
		runId: 71, createdAt: Date.now(), updatedAt: Date.now(), generation: 1,
		agentName: "artisan", task: "retained work", cwd, executionCwd: cwd,
		isolation: "shared", state: "parked", elapsedMs: 1, childPids: [],
		sessionDir, sessionId: "retained", ...overrides,
	};
}

async function session(configPath: string, cwd: string, pid: number): Promise<string> {
	const path = join(getProjectRoot(configPath, cwd), "sessions", "pi-subagent-session-retained");
	await mkdir(path, { recursive: true });
	await writeFile(join(path, "owner.json"), JSON.stringify({ pid, createdAt: 1 }));
	await writeFile(join(path, "2026_retained.jsonl"), "retained transcript\n");
	return path;
}

async function manifest(configPath: string, cwd: string, records: ThreadRecord[]): Promise<string> {
	const path = getThreadsManifestPath(configPath, cwd);
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, JSON.stringify({ version: 1, records }));
	return path;
}

function age(paths: string[], milliseconds: number): void {
	const old = new Date(Date.now() - milliseconds);
	for (const path of paths) utimesSync(path, old, old);
}

describe("retention preserves uncertain recovery references", () => {
	for (const kind of ["thread", "recovery"] as const) {
		for (const failure of ["read", "json", "shape"] as const) {
			it(`keeps artifacts and the ${kind} manifest after a ${failure} failure`, async (t) => {
				await fixture(async (configPath, cwd) => {
					const retained = await session(configPath, cwd, 2_147_483_647);
					const group = join(getProjectRoot(configPath, cwd), "worktrees", "pi-subagent-worktree-retained");
					await mkdir(join(group, "worktree"), { recursive: true });
					await writeFile(join(group, "owner.json"), JSON.stringify({ pid: 2_147_483_647, createdAt: 1 }));
					await writeFile(join(group, "changes.patch"), "retained edits\n");
					const path = kind === "thread" ? getThreadsManifestPath(configPath, cwd) : getRecoveryManifestPath(configPath);
					const valid = JSON.stringify({ version: 1, records: kind === "thread" ? [record(cwd, retained)] : [{ runId: 71, createdAt: Date.now(), integrated: false, worktreePath: join(group, "worktree"), patchPath: join(group, "changes.patch") }] });
					const bytes = failure === "json" ? "{unfinished" : failure === "shape" ? '{"records":null}' : valid;
					await writeFile(path, bytes);
					const originalRead = fsPromises.readFile;
					if (failure === "read") {
						t.mock.method(fsPromises, "readFile", async (...args: any[]) => {
							if (String(args[0]) === path) throw Object.assign(new Error("Manifest is temporarily unreadable"), { code: "EACCES" });
							return (originalRead as any)(...args);
						});
						syncBuiltinESMExports();
					}
					const runtime = createRuntime(fakePi(), configPath);
					try {
						assert.equal((await runAutomaticCleanup(runtime, { force: true, budgetBytes: 0 })).skipped, true);
						await assert.rejects(runStorageCleanup(configPath));
						await bootstrapDurableState(runtime, cwd);
						assert.equal(await originalRead(path, "utf8"), bytes, "an unavailable manifest is never rewritten as empty");
						assert.equal(existsSync(join(retained, "2026_retained.jsonl")), true);
						assert.equal(await readFile(join(group, "changes.patch"), "utf8"), "retained edits\n");
					} finally {
						t.mock.restoreAll(); syncBuiltinESMExports();
						await runtime.shutdown();
					}
				});
			});
		}
	}

	it("does not drop a valid reference when filesystem validation is temporarily denied", async (t) => {
		await fixture(async (configPath, cwd) => {
			const retained = await session(configPath, cwd, 2_147_483_647);
			const path = await manifest(configPath, cwd, [record(cwd, retained)]);
			const bytes = await readFile(path, "utf8");
			const originalStat = fsPromises.lstat;
			t.mock.method(fsPromises, "lstat", async (...args: any[]) => {
				if (String(args[0]) === retained) throw Object.assign(new Error("Directory is temporarily unreadable"), { code: "EACCES" });
				return (originalStat as any)(...args);
			});
			syncBuiltinESMExports();
			try {
				await assert.rejects(readThreadRecords(configPath), /temporarily unreadable/u);
				assert.equal(await readFile(path, "utf8"), bytes);
				assert.equal((await runAutomaticCleanup({ configPath, threads: new Map() }, { force: true })).skipped, true);
				assert.equal(existsSync(retained), true);
			} finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
		});
	});
});

describe("retention and live ownership", () => {
	it("keeps another live process's session through age, budget and project cleanup", async () => {
		await fixture(async (configPath, cwd) => {
			const retained = await session(configPath, cwd, process.ppid);
			age([join(retained, "owner.json"), join(retained, "2026_retained.jsonl"), retained], 4 * 24 * 60 * 60_000);
			await runAutomaticCleanup({ configPath, threads: new Map() }, { force: true, budgetBytes: 0 });
			assert.equal(existsSync(retained), true);
			await runStorageCleanup(configPath);
			assert.equal(existsSync(retained), true);
		});
	});

	it("keeps a live owner's empty session while its first prompt is being prepared", async () => {
		await fixture(async (configPath, cwd) => {
			const retained = await session(configPath, cwd, process.pid);
			await rm(join(retained, "2026_retained.jsonl"));
			await runStorageCleanup(configPath);
			assert.equal(existsSync(retained), true);
		});
	});

	for (const owner of ["parent", "child"] as const) {
		it(`keeps an expired checkpoint with a live ${owner}`, async () => {
			await fixture(async (configPath, cwd) => {
				const retained = await session(configPath, cwd, process.ppid);
				await manifest(configPath, cwd, [record(cwd, retained, {
					updatedAt: Date.now() - PARKED_RECORD_MAX_AGE_MS - 60_000,
					bootId: Math.round(Date.now() - uptime() * 1_000),
					...(owner === "parent" ? { ownerPid: process.ppid } : { childPids: [process.pid] }),
				})]);
				await pruneThreadRecords(configPath);
				assert.equal((await readThreadRecords(configPath)).length, 1);
				assert.equal(existsSync(retained), true);
			});
		});
	}

	it("prunes expired records before publishing restored threads", async () => {
		await fixture(async (configPath, cwd) => {
			const retained = await session(configPath, cwd, 2_147_483_647);
			await manifest(configPath, cwd, [record(cwd, retained, { updatedAt: Date.now() - PARKED_RECORD_MAX_AGE_MS - 60_000 })]);
			const runtime = createRuntime(fakePi(), configPath);
			try {
				await bootstrapDurableState(runtime, cwd);
				assert.deepEqual(runtime.restoredRunIds, []);
				assert.equal(runtime.threads.size, 0);
				assert.equal(existsSync(retained), false);
				assert.deepEqual(await readThreadRecords(configPath), []);
			} finally { await runtime.shutdown(); }
			assert.deepEqual(await readThreadRecords(configPath), [], "shutdown must not resurrect expired records");
		});
	});
});
