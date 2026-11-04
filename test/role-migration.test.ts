import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it, type TestContext } from "node:test";
import { getThreadsManifestPath, readThreadRecords } from "../src/lifecycle/durable.ts";

async function fixture(t: TestContext) {
	const root = await mkdtemp(join(tmpdir(), "pi-role-migration-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	return { root, configPath: join(root, "config.json") };
}

async function assertNoRewrite(path: string, readAgain: () => Promise<unknown>): Promise<void> {
	const time = new Date("2000-01-01T00:00:00Z");
	await utimes(path, time, time);
	const before = await stat(path);
	await readAgain();
	assert.equal((await stat(path)).mtimeMs, before.mtimeMs, "migrated files must not be rewritten on later reads");
}

describe("stored role migration", () => {
	it("persists renamed thread roles and result summaries without changing ownership", async (t) => {
		const { root, configPath } = await fixture(t);
		const path = getThreadsManifestPath(configPath, root);
		const records = ["reviewer", "critic", "skeptic"].map((agentName, index) => ({
			runId: index + 1, createdAt: 1000, updatedAt: 2000, generation: 2,
			agentName, task: `Keep ${agentName} in the original brief ${index}`,
			cwd: root, executionCwd: root, isolation: "shared", state: "parked", elapsedMs: 30, childPids: [],
			resultSummary: { agent: agentName, task: "Original task", exitCode: 1, failed: true, output: "Original evidence" },
		}));
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, JSON.stringify({ version: 1, records }));
		const migrated = await readThreadRecords(configPath);
		assert.deepEqual(migrated.map((record) => record.agentName), ["sentinel", "sentinel", "sentinel"]);
		assert.deepEqual(migrated.map((record) => record.resultSummary?.agent), ["sentinel", "sentinel", "sentinel"]);
		assert.deepEqual(migrated.map((record) => [record.runId, record.state, record.task]), records.map((record) => [record.runId, record.state, record.task]));
		const saved = JSON.parse(await readFile(path, "utf8"));
		assert.deepEqual(saved.records.map((record: { agentName: string }) => record.agentName), ["sentinel", "sentinel", "sentinel"]);
		assert.equal(saved.records[0].updatedAt, 2000);
		await assertNoRewrite(path, () => readThreadRecords(configPath));
	});
});
