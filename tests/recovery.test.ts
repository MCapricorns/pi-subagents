import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	announceRecoveryRecords,
	getRecoveryManifestPath,
	persistRecoveryRecords,
	readRecoveryRecords,
} from "../src/recovery.ts";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("durable worktree recovery handoff", () => {
	it("persists retained finalizations durably and announces them in the next session", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-subagents-recovery-"));
		roots.push(root);
		const configPath = join(root, "pi-subagents.json");
		const worktreePath = join(root, "retained-worktree");
		const patchPath = join(root, "retained.patch");
		mkdirSync(worktreePath);
		writeFileSync(patchPath, "patch", "utf8");
		// Retained finalizations persist their recovery record from the
		// finalization itself (thread-lifecycle), not from session shutdown.
		await persistRecoveryRecords(configPath, [{
			runId: 7,
			createdAt: Date.now(),
			integrated: false,
			worktreePath,
			patchPath,
			error: "patch does not apply",
		}]);
		const records = await readRecoveryRecords(configPath);
		expect(records).toEqual([
			expect.objectContaining({
				runId: 7,
				integrated: false,
				worktreePath,
				patchPath,
				error: "patch does not apply",
			}),
		]);
		expect(existsSync(getRecoveryManifestPath(configPath))).toBe(true);

		const notify = vi.fn();
		await announceRecoveryRecords(configPath, { hasUI: true, ui: { notify } });
		expect(notify).toHaveBeenCalledWith(
			expect.stringContaining(`run #7`),
			"error",
		);
		expect(notify.mock.calls[0]![0]).toContain(worktreePath);
		expect(notify.mock.calls[0]![0]).toContain(patchPath);
		// The handoff stays durable and is shown again until artifacts are removed.
		expect(await readRecoveryRecords(configPath)).toHaveLength(1);
	});

	it("deduplicates records and prunes them after recovery artifacts are removed", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-subagents-recovery-prune-"));
		roots.push(root);
		const configPath = join(root, "pi-subagents.json");
		const patchPath = join(root, "changes.patch");
		writeFileSync(patchPath, "patch", "utf8");
		const record = {
			runId: 2,
			createdAt: 10,
			integrated: false,
			patchPath,
			error: "conflict",
		};
		await persistRecoveryRecords(configPath, [record]);
		await persistRecoveryRecords(configPath, [{ ...record, createdAt: 20 }]);
		expect(await readRecoveryRecords(configPath)).toHaveLength(1);

		rmSync(patchPath);
		const notify = vi.fn();
		await announceRecoveryRecords(configPath, { hasUI: true, ui: { notify } });
		expect(notify).not.toHaveBeenCalled();
		expect(await readRecoveryRecords(configPath)).toEqual([]);
		expect(existsSync(getRecoveryManifestPath(configPath))).toBe(false);
	});

	it("heals cleanup-failed records by removing the retained group at session start", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-subagents-recovery-heal-"));
		roots.push(root);
		const configPath = join(root, "pi-subagents.json");
		const group = join(root, "pi-subagent-worktree-heal1");
		const worktreePath = join(group, "worktree");
		const patchPath = join(group, "changes.patch");
		mkdirSync(worktreePath, { recursive: true });
		writeFileSync(patchPath, "patch", "utf8");
		// Changes already landed; the retained copy is the only thing left.
		await persistRecoveryRecords(configPath, [{
			runId: 5,
			createdAt: Date.now(),
			integrated: true,
			worktreePath,
			patchPath,
			error: "removing isolated worktree failed (exit 255): Filename too long",
		}]);

		const notify = vi.fn();
		await announceRecoveryRecords(configPath, { hasUI: true, ui: { notify } });
		expect(notify).not.toHaveBeenCalled();
		expect(existsSync(group)).toBe(false);
		expect(await readRecoveryRecords(configPath)).toEqual([]);
	});

	it("keeps announcing integration failures and never deletes unapplied worktrees", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-subagents-recovery-keep-"));
		roots.push(root);
		const configPath = join(root, "pi-subagents.json");
		const worktreePath = join(root, "retained-worktree");
		const patchPath = join(root, "retained.patch");
		mkdirSync(worktreePath, { recursive: true });
		writeFileSync(patchPath, "patch", "utf8");
		// integrated:false means the changes never landed; the worktree is the
		// only copy of that work and must survive until a human resolves it.
		await persistRecoveryRecords(configPath, [{
			runId: 9,
			createdAt: Date.now(),
			integrated: false,
			worktreePath,
			patchPath,
			error: "patch does not apply",
		}]);

		const notify = vi.fn();
		await announceRecoveryRecords(configPath, { hasUI: true, ui: { notify } });
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("run #9"), "error");
		expect(existsSync(worktreePath)).toBe(true);
		expect(existsSync(patchPath)).toBe(true);
		expect(await readRecoveryRecords(configPath)).toHaveLength(1);
	});

	it("never deletes a cleanup-failed group outside the worktree-group layout", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-subagents-recovery-guard-"));
		roots.push(root);
		const configPath = join(root, "pi-subagents.json");
		const worktreePath = join(root, "custom-retained-dir", "worktree");
		mkdirSync(worktreePath, { recursive: true });
		await persistRecoveryRecords(configPath, [{
			runId: 3,
			createdAt: Date.now(),
			integrated: true,
			worktreePath,
			error: "cleanup failed",
		}]);

		const notify = vi.fn();
		await announceRecoveryRecords(configPath, { hasUI: true, ui: { notify } });
		expect(existsSync(worktreePath)).toBe(true);
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("run #3"), "error");
	});
});
