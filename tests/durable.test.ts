import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	getStateRoot,
	getThreadsManifestPath,
	PARKED_RECORD_MAX_AGE_MS,
	pruneThreadRecords,
	readThreadRecords,
	referencedDurablePaths,
	removeThreadRecord,
	restoredResultFromSummary,
	SETTLED_RECORD_MAX_AGE_MS,
	STATE_DIR_NAME,
	THREADS_MANIFEST_FILE_NAME,
	threadRecordFromThread,
	upsertThreadRecord,
	type ThreadRecord,
} from "../src/durable.ts";
import { getResultOutput } from "../src/spawn.ts";
import type { WorktreeIsolation } from "../src/worktree.ts";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeRecord(overrides: Partial<ThreadRecord> = {}): ThreadRecord {
	return {
		runId: 1,
		createdAt: 1_000,
		updatedAt: 2_000,
		generation: 2,
		agentName: "worker",
		task: "do the thing",
		cwd: "C:/repo",
		executionCwd: "C:/repo",
		isolation: "shared",
		state: "parked",
		elapsedMs: 45_000,
		sessionId: "session-id",
		sessionDir: "C:/state/session-x",
		childPids: [],
		...overrides,
	};
}

describe("thread manifest", () => {
	it("round-trips records through upsert and remove", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-subagents-durable-"));
		roots.push(root);
		const configPath = join(root, "pi-subagents.json");

		await upsertThreadRecord(configPath, makeRecord());
		await upsertThreadRecord(configPath, makeRecord({ runId: 2, createdAt: 5_000 }));
		let records = await readThreadRecords(configPath);
		expect(records.map((record) => record.runId)).toEqual([1, 2]);

		// Upsert keeps the original createdAt and refreshes the body.
		await upsertThreadRecord(configPath, makeRecord({ updatedAt: 3_000, task: "renamed" }));
		records = await readThreadRecords(configPath);
		expect(records).toHaveLength(2);
		const updated = records.find((record) => record.runId === 1)!;
		expect(updated.createdAt).toBe(1_000);
		expect(updated.task).toBe("renamed");

		await removeThreadRecord(configPath, 1);
		expect(await readThreadRecords(configPath)).toHaveLength(1);
		await removeThreadRecord(configPath, 2);
		expect(await readThreadRecords(configPath)).toEqual([]);
		expect(existsSync(getThreadsManifestPath(configPath))).toBe(false);
	});

	it("rejects malformed records instead of restoring garbage", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-subagents-durable-garbage-"));
		roots.push(root);
		const configPath = join(root, "pi-subagents.json");
		writeFileSync(getThreadsManifestPath(configPath), JSON.stringify({
			version: 1,
			records: [
				{ runId: 0, createdAt: 1, updatedAt: 1 },
				{ runId: "x", createdAt: 1, updatedAt: 1 },
				makeRecord({ worktree: { worktreePath: "C:/w" } as unknown as ThreadRecord["worktree"] }),
				makeRecord(),
			],
		}), "utf8");
		const records = await readThreadRecords(configPath);
		expect(records).toHaveLength(1);
		expect(records[0]!.runId).toBe(1);
	});

	it("projects a live thread with its worktree handle and child pids", () => {
		const thread = {
			id: 9,
			generation: 3,
			agentName: "worker",
			task: "task text",
			cwd: "C:/repo",
			executionCwd: "C:/repo/wt/worktree",
			isolation: "worktree",
			elapsedMs: 1_000,
			sessionId: "s1",
			sessionDir: "C:/state/session-1",
			control: { getChildPids: () => [111, 222] },
			lastResult: {
				agent: "worker",
				task: "task text",
				exitCode: 0,
				messages: [{ role: "assistant", content: [{ type: "text", text: "final answer" }], stopReason: "stop" }],
				stderr: "",
				usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 },
			},
			worktree: fakeWorktree("active", { baseHead: "a", commit: "b", patch: Buffer.from("x") }),
		} as any;
		const record = threadRecordFromThread(thread, "parked", undefined, 5_000);
		expect(record.runId).toBe(9);
		expect(record.childPids).toEqual([111, 222]);
		expect(record.worktree).toMatchObject({ state: "active", head: "deadbeef" });
		expect(record.worktree!.checkpoint).toMatchObject({ baseHead: "a", commit: "b" });
		expect(record.resultSummary).toMatchObject({ failed: false, output: "final answer" });
	});

	it("rebuilds a displayable result from a persisted summary", () => {
		const record = makeRecord({
			state: "completed",
			resultSummary: {
				agent: "worker",
				task: "do the thing",
				exitCode: 0,
				failed: false,
				usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 },
				output: "the conclusion",
			},
		});
		const result = restoredResultFromSummary(record)!;
		expect(getResultOutput(result)).toBe("the conclusion");
		expect(restoredResultFromSummary(makeRecord({ resultSummary: undefined }))).toBeUndefined();
	});

	it("prunes expired records with their artifacts but keeps parked work", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-subagents-durable-prune-"));
		roots.push(root);
		const configPath = join(root, "pi-subagents.json");
		const now = 10 * SETTLED_RECORD_MAX_AGE_MS;
		const settledSession = join(root, "session-settled");
		const parkedSession = join(root, "session-parked");
		const ancientSession = join(root, "session-ancient");
		mkdirSync(settledSession);
		mkdirSync(parkedSession);
		mkdirSync(ancientSession);

		await upsertThreadRecord(configPath, makeRecord({
			runId: 1,
			state: "completed",
			updatedAt: now - SETTLED_RECORD_MAX_AGE_MS - 1,
			sessionDir: settledSession,
		}));
		await upsertThreadRecord(configPath, makeRecord({
			runId: 2,
			state: "parked",
			updatedAt: now - PARKED_RECORD_MAX_AGE_MS + 60_000,
			sessionDir: parkedSession,
		}));
		await upsertThreadRecord(configPath, makeRecord({
			runId: 3,
			state: "parked",
			updatedAt: now - PARKED_RECORD_MAX_AGE_MS - 1,
			sessionDir: ancientSession,
		}));

		await pruneThreadRecords(configPath, now);
		const records = await readThreadRecords(configPath);
		expect(records.map((record) => record.runId)).toEqual([2]);
		expect(existsSync(settledSession)).toBe(false);
		expect(existsSync(ancientSession)).toBe(false);
		expect(existsSync(parkedSession)).toBe(true);
	});

	it("collects every durable path a record references", () => {
		const paths = referencedDurablePaths([
			makeRecord({ sessionDir: "C:/state/session-a" }),
			makeRecord({
				sessionDir: "C:/state/session-b",
				worktree: {
					originalCwd: "C:/repo",
					originalRoot: "C:/repo",
					cwd: "C:/repo/wt/worktree",
					worktreePath: "C:/nonexistent-worktree",
					tempDir: "C:/state/worktree-b",
					patchPath: "C:/state/worktree-b/changes.patch",
					head: "h",
					integrationBaseHead: "h",
					state: "active",
				},
			}),
		]);
		expect([...paths].sort()).toEqual(["C:/state/session-a", "C:/state/session-b", "C:/state/worktree-b"].sort());
	});

	it("places the state root and manifest beside the config", () => {
		expect(getStateRoot("C:/agent/settings.json")).toBe(join("C:/agent", STATE_DIR_NAME));
		expect(getThreadsManifestPath("C:/agent/settings.json")).toBe(join("C:/agent", THREADS_MANIFEST_FILE_NAME));
	});
});

function fakeWorktree(
	state: WorktreeIsolation["state"],
	checkpoint?: { baseHead: string; commit: string; patch: Buffer },
): WorktreeIsolation {
	return {
		originalCwd: "C:/repo",
		originalRoot: "C:/repo",
		cwd: "C:/repo/wt/worktree",
		worktreePath: "C:/repo/wt/worktree",
		tempDir: "C:/state/worktree-1",
		patchPath: "C:/state/worktree-1/changes.patch",
		head: "deadbeef",
		integrationBaseHead: "deadbeef",
		state,
		getContinuationCheckpoint: () => checkpoint,
		snapshotCheckpoint: async () => {
			throw new Error("not needed");
		},
		discard: async () => undefined,
		finalize: async () => ({ status: "integrated", integrated: true, hadChanges: true }),
	};
}
