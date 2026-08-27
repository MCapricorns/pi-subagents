import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readThreadRecords, upsertThreadRecord, type ThreadRecord } from "../src/durable.ts";
import { monitor } from "../src/monitor.ts";
import { createRuntime, type SubagentRuntime } from "../src/runtime.ts";
import { restoreDurableThreads } from "../src/thread-lifecycle.ts";
import * as tempHygieneModule from "../src/temp-hygiene.ts";
import * as worktreeModule from "../src/worktree.ts";
import type { WorktreeIsolation } from "../src/worktree.ts";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	vi.restoreAllMocks();
});

function createSession(cwd: string): { id: string; dir: string } {
	const dir = mkdtempSync(join(tmpdir(), "pi-subagents-restore-session-"));
	roots.push(dir);
	const manager = SessionManager.create(cwd, dir);
	manager.appendMessage({ role: "user", content: "objective", timestamp: Date.now() });
	manager.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: "retained work" }],
		api: "test",
		provider: "test",
		model: "test-model",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	});
	return { id: manager.getSessionId(), dir };
}

function record(overrides: Partial<ThreadRecord>): ThreadRecord {
	return {
		runId: 5,
		createdAt: 1_000,
		updatedAt: 2_000,
		generation: 1,
		agentName: "worker",
		task: "resume me",
		cwd: "C:/repo",
		executionCwd: "C:/repo",
		isolation: "shared",
		state: "parked",
		elapsedMs: 12_000,
		childPids: [],
		...overrides,
	};
}

describe("durable thread restore", () => {
	let runtime: SubagentRuntime;

	beforeEach(() => {
		monitor.clear();
		const agentDir = mkdtempSync(join(tmpdir(), "pi-subagents-restore-agent-"));
		roots.push(agentDir);
		runtime = createRuntime(
			{ sendMessage: vi.fn(), getActiveTools: () => [] } as any,
			join(agentDir, "pi-subagents.json"),
		);
	});

	it("restores parked threads with monitor rows and continued run ids", async () => {
		const session = createSession("C:/repo");
		await upsertThreadRecord(runtime.configPath, record({ sessionId: session.id, sessionDir: session.dir }));

		const restored = await restoreDurableThreads(runtime);
		expect(restored).toEqual([5]);

		const thread = runtime.threads.get(5)!;
		expect(thread).toBeDefined();
		expect(thread.state).toBe("parked");
		expect(thread.agentName).toBe("worker");
		expect(thread.elapsedMs).toBe(12_000);
		expect(runtime.sessionDirs.has(session.dir)).toBe(true);

		const row = monitor.findRun(5);
		expect(row?.status).toBe("parked");
		expect(row?.elapsedMs).toBe(12_000);
		// New ids continue above every restored id.
		expect(monitor.reserveRunId()).toBeGreaterThan(5);

		// Restoring twice is idempotent.
		expect(await restoreDurableThreads(runtime)).toEqual([]);
	});

	it("seeds settled results for restored completed threads", async () => {
		const session = createSession("C:/repo");
		await upsertThreadRecord(runtime.configPath, record({
			runId: 6,
			state: "completed",
			sessionId: session.id,
			sessionDir: session.dir,
			resultSummary: {
				agent: "worker",
				task: "resume me",
				exitCode: 0,
				failed: false,
				usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 },
				output: "all done",
			},
		}));

		await restoreDurableThreads(runtime);
		expect(runtime.threads.get(6)?.state).toBe("completed");
		expect(monitor.findRun(6)).toBeUndefined();
		expect(runtime.settledRuns.get(6)).toBeDefined();
	});

	it("drops records whose retained session vanished, with their artifacts", async () => {
		const ghostDir = mkdtempSync(join(tmpdir(), "pi-subagents-restore-ghost-"));
		roots.push(ghostDir);
		const worktree = {
			originalCwd: "C:/repo",
			originalRoot: "C:/repo",
			cwd: "C:/repo/w",
			worktreePath: join(ghostDir, "worktree"),
			tempDir: ghostDir,
			patchPath: join(ghostDir, "changes.patch"),
			head: "h",
			integrationBaseHead: "h",
			state: "integrated",
		} as const;
		const discard = vi.fn(async () => undefined);
		vi.spyOn(worktreeModule, "restoreWorktreeIsolation").mockResolvedValue({
			...worktree,
			getContinuationCheckpoint: () => undefined,
			snapshotCheckpoint: async () => {
				throw new Error("unused");
			},
			discard,
			finalize: async () => ({ status: "integrated", integrated: true, hadChanges: true }),
		} as unknown as WorktreeIsolation);
		// No Pi session file is ever written, so the record is unrestorable.
		await upsertThreadRecord(runtime.configPath, record({
			isolation: "worktree",
			sessionId: "missing",
			sessionDir: ghostDir,
			worktree,
		}));

		const restored = await restoreDurableThreads(runtime);
		expect(restored).toEqual([]);
		expect(runtime.threads.size).toBe(0);
		expect(discard).not.toHaveBeenCalled(); // integrated handles keep no filesystem
		expect(existsSync(ghostDir)).toBe(false);
		expect(await readThreadRecords(runtime.configPath)).toEqual([]);
	});

	it("rehydrates an active worktree and keeps the isolation invariant", async () => {
		const session = createSession("C:/repo");
		const worktree = {
			originalCwd: "C:/repo",
			originalRoot: "C:/repo",
			cwd: "C:/repo/w",
			worktreePath: "C:/repo/w",
			tempDir: "C:/state/worktree-1",
			patchPath: "C:/state/worktree-1/changes.patch",
			head: "h",
			integrationBaseHead: "h",
			state: "active",
		} as const;
		const handle = {
			...worktree,
			getContinuationCheckpoint: () => undefined,
			snapshotCheckpoint: async () => {
				throw new Error("unused");
			},
			discard: async () => undefined,
			finalize: async () => ({ status: "integrated", integrated: true, hadChanges: true }),
		} as unknown as WorktreeIsolation;
		vi.spyOn(worktreeModule, "restoreWorktreeIsolation").mockResolvedValue(handle);
		await upsertThreadRecord(runtime.configPath, record({
			isolation: "worktree",
			sessionId: session.id,
			sessionDir: session.dir,
			worktree,
		}));

		await restoreDurableThreads(runtime);
		const thread = runtime.threads.get(5)!;
		expect(thread.worktree).toBe(handle);
		expect(thread.isolation).toBe("worktree");
		expect(monitor.findRun(5)?.integrationStatus).toBe("pending");
	});

	it("degrades to failed when an isolated filesystem is gone", async () => {
		const session = createSession("C:/repo");
		vi.spyOn(worktreeModule, "restoreWorktreeIsolation").mockResolvedValue(undefined);
		await upsertThreadRecord(runtime.configPath, record({
			isolation: "worktree",
			sessionId: session.id,
			sessionDir: session.dir,
			worktree: {
				originalCwd: "C:/repo",
				originalRoot: "C:/repo",
				cwd: "C:/repo/w",
				worktreePath: "C:/gone/worktree",
				tempDir: "C:/gone",
				patchPath: "C:/gone/changes.patch",
				head: "h",
				integrationBaseHead: "h",
				state: "active",
			},
		}));

		await restoreDurableThreads(runtime);
		expect(runtime.threads.get(5)?.state).toBe("failed");
	});

	it("kills orphaned child processes recorded by the previous process", async () => {
		const session = createSession("C:/repo");
		const kill = vi.fn();
		vi.spyOn(tempHygieneModule, "isProcessAlive").mockReturnValue(true);
		vi.spyOn(tempHygieneModule, "killProcessTree").mockImplementation(kill);
		await upsertThreadRecord(runtime.configPath, record({
			sessionId: session.id,
			sessionDir: session.dir,
			childPids: [424242, 424243],
		}));

		await restoreDurableThreads(runtime);
		expect(kill).toHaveBeenCalledWith(424242);
		expect(kill).toHaveBeenCalledWith(424243);
	});
});
