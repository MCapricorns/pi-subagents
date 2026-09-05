import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { describe, it } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getProjectRoot } from "../src/execution/spawn.ts";
import {
	announceRecoveryRecords,
	getRecoveryManifestPath,
	persistRecoveryRecords,
	readRecoveryRecords,
	type RecoveryRecord,
} from "../src/isolation/recovery.ts";
import { TEMP_OWNER_FILE_NAME } from "../src/isolation/temp-hygiene.ts";
import { createWorktreeIsolation, worktreeSnapshot } from "../src/isolation/worktree.ts";
import { monitor } from "../src/presentation/monitor.ts";
import {
	PARKED_RECORD_MAX_AGE_MS,
	PROJECT_ROOT_MAX_AGE_MS,
	getThreadsManifestPath,
	pruneStaleProjectRoots,
	pruneThreadRecords,
	readThreadRecords,
	type ThreadRecord,
} from "../src/lifecycle/durable.ts";
import { createRuntime } from "../src/lifecycle/runtime.ts";
import { bootstrapDurableState, restoreDurableThreads } from "../src/lifecycle/thread-restore.ts";

const execFileAsync = promisify(execFile);

function fakePi(): ExtensionAPI {
	return {
		getActiveTools: () => [],
		on: () => undefined,
		sendMessage: () => undefined,
	} as unknown as ExtensionAPI;
}

async function createRepository(root: string): Promise<{ cwd: string; repository: string }> {
	const repository = join(root, "repository");
	const cwd = join(repository, "nested");
	await mkdir(cwd, { recursive: true });
	await writeFile(join(repository, "tracked.txt"), "tracked\n", "utf8");
	await execFileAsync("git", ["init"], { cwd: repository });
	await execFileAsync("git", ["config", "user.name", "Recovery Safety Test"], { cwd: repository });
	await execFileAsync("git", ["config", "user.email", "recovery-safety@example.invalid"], { cwd: repository });
	await execFileAsync("git", ["add", "."], { cwd: repository });
	await execFileAsync("git", ["commit", "-m", "initial"], { cwd: repository });
	return { cwd, repository };
}

function threadRecord(cwd: string, overrides: Partial<ThreadRecord>): ThreadRecord {
	const now = Date.now();
	return {
		runId: 71,
		createdAt: now,
		updatedAt: now,
		generation: 1,
		agentName: "artisan",
		task: "recover safely",
		cwd,
		executionCwd: cwd,
		isolation: "shared",
		state: "parked",
		elapsedMs: 10,
		childPids: [],
		...overrides,
	};
}

async function writeThreadManifest(configPath: string, cwd: string, records: ThreadRecord[]): Promise<void> {
	const path = getThreadsManifestPath(configPath, cwd);
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, `${JSON.stringify({ version: 1, records }, null, 2)}\n`, "utf8");
}

async function createManagedRecovery(
	configPath: string,
	cwd: string,
	runId = 81,
): Promise<{ group: string; record: RecoveryRecord }> {
	const group = join(getProjectRoot(configPath, cwd), "worktrees", `pi-subagent-worktree-${runId}`);
	const worktreePath = join(group, "worktree");
	const patchPath = join(group, "changes.patch");
	await mkdir(worktreePath, { recursive: true });
	await writeFile(patchPath, "retained patch\n", "utf8");
	return {
		group,
		record: {
			runId,
			createdAt: Date.now(),
			integrated: false,
			worktreePath,
			patchPath,
			error: "retained for recovery",
		},
	};
}

async function withFixture(run: (root: string, configPath: string) => Promise<void>): Promise<void> {
	const root = await mkdtemp(join(tmpdir(), "pi-subagents-recovery-safety-"));
	try {
		await run(root, join(root, "agent", "settings.json"));
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

describe("interrupted work without a retained session", () => {
	it("keeps isolated edits and allows final integration without changing the parent's index", async () => {
		await withFixture(async (root, configPath) => {
			const { cwd, repository } = await createRepository(root);
			await execFileAsync("git", ["config", "core.autocrlf", "false"], { cwd: repository });
			await writeFile(join(repository, "tracked.txt"), "parent staged edit\n", "utf8");
			await execFileAsync("git", ["add", "tracked.txt"], { cwd: repository });
			const indexBefore = (await execFileAsync("git", ["diff", "--cached"], { cwd: repository })).stdout;
			const projectRoot = getProjectRoot(configPath, cwd);
			const worktree = await createWorktreeIsolation(cwd, { tempBaseDir: join(projectRoot, "worktrees") });
			const pendingFile = join(worktree.cwd, "pending.txt");
			await writeFile(pendingFile, "unmerged child edit\n", "utf8");
			const sessionDir = join(projectRoot, "sessions", "pi-subagent-session-missing");
			await mkdir(sessionDir, { recursive: true });
			const record = threadRecord(cwd, {
				isolation: "worktree", executionCwd: worktree.cwd, worktree: worktreeSnapshot(worktree),
				sessionId: "missing", sessionDir,
			});
			const runtime = createRuntime(fakePi(), configPath);
			try {
				await writeThreadManifest(configPath, cwd, [record]);
				assert.equal((await readThreadRecords(configPath)).length, 1, "the recovery record must pass path validation");
				const restored = await restoreDurableThreads(runtime);
				assert.equal(existsSync(pendingFile), true, "a missing session must not delete unintegrated edits");
				assert.deepEqual(restored, [71]);
				const thread = runtime.threads.get(71)!;
				assert.equal(thread.sessionId, undefined);
				assert.equal(thread.sessionDir, undefined);
				assert.equal((await thread.finalizeIsolation(thread.generation))?.status, "integrated");
				assert.equal(await readFile(join(cwd, "pending.txt"), "utf8"), "unmerged child edit\n");
				assert.equal((await execFileAsync("git", ["diff", "--cached"], { cwd: repository })).stdout, indexBefore);
			} finally {
				await runtime.shutdown();
				await worktree.discard().catch(() => undefined);
				monitor.clear();
			}
		});
	});
});

describe("durable thread path validation", () => {
	it("does not restore a forged external session and removes its record", async () => {
		await withFixture(async (root, configPath) => {
			const { cwd } = await createRepository(root);
			const externalSession = join(root, "external-session");
			const sessionId = "external-session-id";
			await mkdir(externalSession, { recursive: true });
			await writeFile(join(externalSession, `2026-01-01T00-00-00.000Z_${sessionId}.jsonl`), "{}\n", "utf8");
			const sentinel = join(externalSession, "sentinel.txt");
			await writeFile(sentinel, "keep\n", "utf8");
			await writeThreadManifest(configPath, cwd, [threadRecord(cwd, {
				sessionId,
				sessionDir: externalSession,
			})]);

			const runtime = createRuntime(fakePi(), configPath);
			assert.deepEqual(await restoreDurableThreads(runtime), []);
			assert.equal(runtime.threads.has(71), false);
			assert.equal(existsSync(sentinel), true);
			assert.deepEqual(await readThreadRecords(configPath), []);
		});
	});

	it("does not delete forged external session and worktree targets during retention", async () => {
		await withFixture(async (root, configPath) => {
			const { cwd, repository } = await createRepository(root);
			const externalSession = join(root, "external-expired-session");
			const externalGroup = join(root, "pi-subagent-worktree-external");
			const externalWorktree = join(externalGroup, "worktree");
			await mkdir(externalSession, { recursive: true });
			await mkdir(externalWorktree, { recursive: true });
			const sessionSentinel = join(externalSession, "sentinel.txt");
			const worktreeSentinel = join(externalWorktree, "sentinel.txt");
			await writeFile(sessionSentinel, "keep session\n", "utf8");
			await writeFile(worktreeSentinel, "keep worktree\n", "utf8");
			const old = Date.now() - PARKED_RECORD_MAX_AGE_MS - 1;
			await writeThreadManifest(configPath, cwd, [threadRecord(cwd, {
				createdAt: old,
				updatedAt: old,
				sessionId: "expired",
				sessionDir: externalSession,
				isolation: "worktree",
				executionCwd: externalWorktree,
				worktree: {
					originalCwd: cwd,
					originalRoot: repository,
					cwd: externalWorktree,
					worktreePath: externalWorktree,
					tempDir: externalGroup,
					patchPath: join(externalGroup, "changes.patch"),
					head: "abc",
					integrationBaseHead: "abc",
					state: "active",
				},
			})]);

			await pruneThreadRecords(configPath, Date.now());
			assert.equal(existsSync(sessionSentinel), true);
			assert.equal(existsSync(worktreeSentinel), true);
			assert.deepEqual(await readThreadRecords(configPath), []);
		});
	});

	it("rejects a managed session path that escapes through a junction or symlink", async () => {
		await withFixture(async (root, configPath) => {
			const { cwd } = await createRepository(root);
			const externalSession = join(root, "junction-target");
			const sessionId = "junction-session-id";
			await mkdir(externalSession, { recursive: true });
			await writeFile(join(externalSession, `2026-01-01T00-00-00.000Z_${sessionId}.jsonl`), "{}\n", "utf8");
			const managedSession = join(getProjectRoot(configPath, cwd), "sessions", "pi-subagent-session-forged");
			await mkdir(dirname(managedSession), { recursive: true });
			await symlink(externalSession, managedSession, process.platform === "win32" ? "junction" : "dir");
			await writeThreadManifest(configPath, cwd, [threadRecord(cwd, {
				sessionId,
				sessionDir: managedSession,
			})]);

			const runtime = createRuntime(fakePi(), configPath);
			assert.deepEqual(await restoreDurableThreads(runtime), []);
			assert.equal(runtime.threads.has(71), false);
			assert.equal(existsSync(join(externalSession, `2026-01-01T00-00-00.000Z_${sessionId}.jsonl`)), true);
		});
	});

	it("rejects repository and restored-cwd mismatches inside a managed worktree layout", async () => {
		await withFixture(async (root, configPath) => {
			const { cwd, repository } = await createRepository(root);
			const projectRoot = getProjectRoot(configPath, cwd);
			const records: ThreadRecord[] = [];
			for (const [runId, mismatch] of [[72, "repository"], [73, "cwd"]] as const) {
				const sessionId = `managed-${runId}`;
				const sessionDir = join(projectRoot, "sessions", `pi-subagent-session-${runId}`);
				const group = join(projectRoot, "worktrees", `pi-subagent-worktree-${runId}`);
				const worktreePath = join(group, "worktree");
				const restoredCwd = mismatch === "cwd" ? join(worktreePath, "wrong") : join(worktreePath, "nested");
				await mkdir(sessionDir, { recursive: true });
				await mkdir(restoredCwd, { recursive: true });
				await writeFile(join(sessionDir, `2026-01-01T00-00-00.000Z_${sessionId}.jsonl`), "{}\n", "utf8");
				await writeFile(join(worktreePath, "sentinel.txt"), "keep\n", "utf8");
				records.push(threadRecord(cwd, {
					runId,
					sessionId,
					sessionDir,
					isolation: "worktree",
					executionCwd: restoredCwd,
					worktree: {
						originalCwd: cwd,
						originalRoot: mismatch === "repository" ? root : repository,
						cwd: restoredCwd,
						worktreePath,
						tempDir: group,
						patchPath: join(group, "changes.patch"),
						head: "abc",
						integrationBaseHead: "abc",
						state: "active",
					},
				}));
			}
			await writeThreadManifest(configPath, cwd, records);

			const runtime = createRuntime(fakePi(), configPath);
			assert.deepEqual(await restoreDurableThreads(runtime), []);
			assert.equal(runtime.threads.has(72), false);
			assert.equal(runtime.threads.has(73), false);
			for (const runId of [72, 73]) {
				assert.equal(existsSync(join(projectRoot, "worktrees", `pi-subagent-worktree-${runId}`, "worktree", "sentinel.txt")), true);
			}
			assert.deepEqual(await readThreadRecords(configPath), []);
		});
	});

	it("accepts Windows case variants of canonical managed paths", { skip: process.platform !== "win32" }, async () => {
		await withFixture(async (root, configPath) => {
			const { cwd } = await createRepository(root);
			const sessionId = "case-insensitive-session";
			const sessionDir = join(getProjectRoot(configPath, cwd), "sessions", "pi-subagent-session-case");
			await mkdir(sessionDir, { recursive: true });
			await writeFile(join(sessionDir, `2026-01-01T00-00-00.000Z_${sessionId}.jsonl`), "{}\n", "utf8");
			const caseVariantCwd = cwd.toUpperCase();
			await writeThreadManifest(configPath, cwd, [threadRecord(caseVariantCwd, {
				runId: 74,
				executionCwd: caseVariantCwd,
				sessionId,
				sessionDir: sessionDir.toUpperCase(),
			})]);

			const runtime = createRuntime(fakePi(), configPath);
			assert.deepEqual(await restoreDurableThreads(runtime), [74]);
			assert.equal(runtime.threads.has(74), true);
			await runtime.shutdown();
		});
	});
});

describe("recovery manifest path validation and retention", () => {
	it("drops forged cleanup paths without deleting their external target", async () => {
		await withFixture(async (root, configPath) => {
			const externalGroup = join(root, "pi-subagent-worktree-forged");
			const externalWorktree = join(externalGroup, "worktree");
			const sentinel = join(externalWorktree, "sentinel.txt");
			await mkdir(externalWorktree, { recursive: true });
			await writeFile(sentinel, "keep\n", "utf8");
			const manifestPath = getRecoveryManifestPath(configPath);
			await mkdir(dirname(manifestPath), { recursive: true });
			await writeFile(manifestPath, `${JSON.stringify({
				version: 1,
				records: [{
					runId: 91,
					createdAt: Date.now(),
					integrated: true,
					worktreePath: externalWorktree,
					patchPath: join(externalGroup, "changes.patch"),
				}],
			}, null, 2)}\n`, "utf8");

			await announceRecoveryRecords(configPath, { hasUI: true, ui: { notify: () => undefined } });
			assert.equal(existsSync(sentinel), true);
			assert.deepEqual(await readRecoveryRecords(configPath), []);
		});
	});

	it("does not follow a recovery worktrees junction outside managed storage", async () => {
		await withFixture(async (root, configPath) => {
			const projectRoot = getProjectRoot(configPath, process.cwd());
			const externalWorktrees = join(root, "external-worktrees");
			const managedWorktrees = join(projectRoot, "worktrees");
			const externalGroup = join(externalWorktrees, "pi-subagent-worktree-junction");
			const group = join(managedWorktrees, "pi-subagent-worktree-junction");
			const worktreePath = join(group, "worktree");
			const sentinel = join(externalGroup, "worktree", "sentinel.txt");
			await mkdir(join(externalGroup, "worktree"), { recursive: true });
			await writeFile(sentinel, "keep\n", "utf8");
			await mkdir(projectRoot, { recursive: true });
			await symlink(externalWorktrees, managedWorktrees, process.platform === "win32" ? "junction" : "dir");
			const manifestPath = getRecoveryManifestPath(configPath);
			await writeFile(manifestPath, `${JSON.stringify({
				version: 1,
				records: [{
					runId: 92,
					createdAt: Date.now(),
					integrated: true,
					worktreePath,
					patchPath: join(group, "changes.patch"),
				}],
			}, null, 2)}\n`, "utf8");

			await announceRecoveryRecords(configPath, { hasUI: true, ui: { notify: () => undefined } });
			assert.equal(existsSync(sentinel), true);
			assert.equal(existsSync(join(projectRoot, "worktrees")), true);
			assert.deepEqual(await readRecoveryRecords(configPath), []);
		});
	});

	it("keeps recovery-owned worktree groups during the per-directory sweep", async () => {
		await withFixture(async (_root, configPath) => {
			const cwd = process.cwd();
			const { group, record } = await createManagedRecovery(configPath, cwd);
			await writeFile(join(group, TEMP_OWNER_FILE_NAME), `${JSON.stringify({ pid: 2147483647, createdAt: 1 })}\n`, "utf8");
			await persistRecoveryRecords(configPath, [record]);

			const runtime = createRuntime(fakePi(), configPath);
			await bootstrapDurableState(runtime);
			assert.equal(existsSync(group), true);
			assert.equal(await readFile(join(group, "changes.patch"), "utf8"), "retained patch\n");
		});
	});

	it("keeps an otherwise stale project root while recovery still references it", async () => {
		await withFixture(async (_root, configPath) => {
			const cwd = process.cwd();
			const { group, record } = await createManagedRecovery(configPath, cwd);
			await persistRecoveryRecords(configPath, [record]);
			const future = Date.now() + PROJECT_ROOT_MAX_AGE_MS + 60_000;

			const removed = await pruneStaleProjectRoots(configPath, { now: future });
			assert.deepEqual(removed, []);
			assert.equal(existsSync(group), true);
		});
	});
});
