import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
	getRecoveryManifestPath,
	persistRecoveryRecords,
	readRecoveryRecords,
	relocateRecoveryManifest,
	type RecoveryRecord,
} from "../src/isolation/recovery.ts";

function record(runId: number, error: string): RecoveryRecord {
	return {
		runId,
		createdAt: runId * 1000,
		integrated: false,
		worktreePath: `C:\\worktrees\\${runId}`,
		error,
	};
}

describe("recovery manifest storage", () => {
	it("relocates and merges the agent-root manifest under ferris-pi-subagents", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-subagents-recovery-"));
		const configPath = join(root, "pi-subagents.json");
		const legacyPath = join(root, "pi-subagents-recovery.json");
		const current = record(2, "current");
		const legacy = record(1, "legacy");

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
