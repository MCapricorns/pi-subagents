import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it, type TestContext } from "node:test";
import { getThreadsManifestPath, readThreadRecords } from "../src/lifecycle/durable.ts";
import { getWorkflowsManifestPath, readWorkflowRecords } from "../src/workflow/durable.ts";
import { migrateWorkflowDefinition, readWorkflowFile } from "../src/workflow/files.ts";
import { compileWorkflow } from "../src/workflow/plan.ts";

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
		const records = ["reviewer", "critic"].map((agentName, index) => ({
			runId: index + 1, createdAt: 1000, updatedAt: 2000, generation: 2,
			agentName, task: "Keep reviewer and critic in the original brief", phaseId: `phase-${index}`, scope: { paths: [root] },
			cwd: root, executionCwd: root, isolation: "shared", state: "parked", elapsedMs: 30, childPids: [],
			resultSummary: { agent: agentName, task: "Original task", exitCode: 1, failed: true, output: "Original evidence" },
		}));
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, JSON.stringify({ version: 1, records }));
		const migrated = await readThreadRecords(configPath);
		assert.deepEqual(migrated.map((record) => record.agentName), ["sentinel", "skeptic"]);
		assert.deepEqual(migrated.map((record) => record.resultSummary?.agent), ["sentinel", "skeptic"]);
		assert.deepEqual(migrated.map((record) => [record.runId, record.phaseId, record.state, record.task]), records.map((record) => [record.runId, record.phaseId, record.state, record.task]));
		const saved = JSON.parse(await readFile(path, "utf8"));
		assert.deepEqual(saved.records.map((record: { agentName: string }) => record.agentName), ["sentinel", "skeptic"]);
		assert.equal(saved.records[0].updatedAt, 2000);
		await assertNoRewrite(path, () => readThreadRecords(configPath));
	});

	it("persists renamed retained graph nodes while preserving dependency and recovery facts", async (t) => {
		const { root, configPath } = await fixture(t);
		const path = getWorkflowsManifestPath(configPath, root);
		const nodes = [
			{ id: "reviewer", agent: "reviewer", task: "Original reviewer task", dependsOn: [], state: "completed", runId: 11 },
			{ id: "critic", agent: "critic", task: "Original critic task", dependsOn: ["reviewer"], state: "pending" },
		];
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, JSON.stringify({ version: 1, records: [{ workflowId: 3, name: "review", cwd: root, state: "interrupted", startedAt: 1000, updatedAt: 2000, nodes }] }));
		const [record] = await readWorkflowRecords(configPath, root);
		assert.deepEqual(record!.nodes, nodes.map((node, index) => ({ ...node, agent: index ? "skeptic" : "sentinel" })));
		const saved = JSON.parse(await readFile(path, "utf8"));
		assert.equal(saved.records[0].nodes[1].agent, "skeptic");
		assert.equal(saved.records[0].nodes[0].runId, 11);
		await assertNoRewrite(path, () => readWorkflowRecords(configPath, root));
	});

	for (const shape of ["json", "array", "markdown"] as const) {
		it(`migrates selected ${shape} definitions on disk and leaves non-role content intact`, async (t) => {
			const { root } = await fixture(t);
			const path = join(root, shape === "markdown" ? "review.md" : "review.json");
			const nodes = [
				{ id: "reviewer", agent: " reviewer ", task: "Inspect implementation; keep reviewer in this sentence" },
				{ id: "critic", agent: "critic", task: "Verify claims from {{reviewer}}", dependsOn: ["reviewer"] },
			];
			const value = shape === "array" ? nodes : { name: "saved", nodes, metadata: { agent: "reviewer" } };
			const prefix = "---\r\nname: saved\r\ndescription: reviewer in prose\r\n---\r\n\r\nKeep this prose.\r\n```json\r\n";
			const suffix = "```\r\n\r\nKeep critic in prose.\r\n";
			const content = shape === "markdown" ? prefix + JSON.stringify(value, null, 4).replace(/\n/gu, "\r\n") + "\r\n" + suffix : JSON.stringify(value, null, 4) + "\n";
			await writeFile(path, content, { mode: 0o600 });
			if (shape === "markdown") await chmod(path, 0o660);
			const originalMode = (await stat(path)).mode;
			const original = readWorkflowFile(path, "project").definition!;
			assert.ok(original);
			assert.equal(await readFile(path, "utf8"), content, "discovery must remain read-only");
			assert.throws(() => compileWorkflow(original.plan, root, ["sentinel", "skeptic"]), /not an enabled agent/);
			const migrated = await migrateWorkflowDefinition(original);
			assert.deepEqual(migrated.plan.nodes.map((node) => node.agent), ["sentinel", "skeptic"]);
			assert.deepEqual(migrated.plan.nodes.map((node) => [node.id, node.task, node.dependsOn]), nodes.map((node) => [node.id, node.task, node.dependsOn]));
			assert.equal(compileWorkflow(migrated.plan, root, ["sentinel", "skeptic"]).nodes.length, 2);
			const saved = await readFile(path, "utf8");
			assert.equal((await stat(path)).mode, originalMode);
			if (shape === "markdown") {
				assert.ok(saved.startsWith(prefix));
				assert.ok(saved.endsWith(suffix));
				assert.equal(saved.replace(/\r\n/gu, "").includes("\n"), false);
			}
			if (shape !== "array") assert.match(saved, /"metadata":\s*\{\s*"agent": "reviewer"/u);
			await assertNoRewrite(path, () => migrateWorkflowDefinition(migrated));
		});
	}
});
