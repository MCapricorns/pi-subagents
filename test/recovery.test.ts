import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { getProjectRoot } from "../src/execution/spawn.ts";
import {
	getRecoveryManifestPath,
	persistRecoveryRecords,
	readRecoveryRecords,
	relocateRecoveryManifest,
	type RecoveryRecord,
} from "../src/isolation/recovery.ts";
import { isPathInside } from "../src/isolation/worktree.ts";

function record(configPath: string, runId: number, error: string): RecoveryRecord {
	const group = join(getProjectRoot(configPath, process.cwd()), "worktrees", `pi-subagent-worktree-${runId}`);
	return {
		runId,
		createdAt: runId * 1000,
		integrated: false,
		worktreePath: join(group, "worktree"),
		error,
	};
}

describe("recovery manifest storage", () => {
	it("relocates and merges the agent-root manifest under ferris-pi-subagents", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-subagents-recovery-"));
		const configPath = join(root, "pi-subagents.json");
		const legacyPath = join(root, "pi-subagents-recovery.json");
		const current = record(configPath, 2, "current");
		const legacy = record(configPath, 1, "legacy");

		try {
			await persistRecoveryRecords(configPath, [current]);
			const legacyManifest = `${JSON.stringify({ version: 1, records: [legacy] }, null, 2)}\n`;
			await writeFile(legacyPath, legacyManifest, "utf8");

			await relocateRecoveryManifest(configPath);

			const expectedPath = join(root, "ferris-pi-subagents", "pi-subagents-recovery.json");
			assert.equal(getRecoveryManifestPath(configPath), expectedPath);
			assert.equal(existsSync(legacyPath), false);
			assert.deepEqual(await readRecoveryRecords(configPath), [current, legacy]);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});

describe("isPathInside", () => {
	it("treats a dot-dot-prefixed child name as inside the root", () => {
		const root = resolve("repo");
		assert.equal(isPathInside(root, root), true);
		assert.equal(isPathInside(root, join(root, "..cache", "file")), true);
		assert.equal(isPathInside(root, join(root, "src")), true);
		assert.equal(isPathInside(root, resolve("other")), false);
		assert.equal(isPathInside(root, dirname(root)), false);
	});
});
