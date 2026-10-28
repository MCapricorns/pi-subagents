import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, type TestContext } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { RunControl } from "../src/execution/run-control.ts";
import { createRuntime, type SubagentRuntime, type SubagentThread } from "../src/lifecycle/runtime.ts";
import { readWorkflowRecords, removeWorkflowRecord, upsertWorkflowRecord, workflowRecordIdentity, type WorkflowRecord } from "../src/workflow/durable.ts";
import { formatRetainedWorkflow, readRetainedWorkflows } from "../src/workflow/engine.ts";
import type { WorkflowRun } from "../src/workflow/state.ts";

async function fixture(t: TestContext) {
	const root = await mkdtemp(join(tmpdir(), "pi-workflow-recovery-"));
	const config = join(root, "config.json");
	const runtime = createRuntime({ on() {}, getActiveTools: () => [], getAllTools: () => [], sendMessage() {} } as unknown as ExtensionAPI, config);
	t.after(async () => { await runtime.shutdown(); await rm(root, { recursive: true, force: true }); });
	return { root, config, runtime };
}

function record(cwd: string, durableId?: string): WorkflowRecord {
	return {
		...(durableId ? { durableId } : {}), workflowId: 1, name: "research", cwd,
		state: "interrupted", startedAt: 1000, updatedAt: 2000,
		nodes: [{ id: "primary", agent: "scout", task: "Find evidence", state: "running", dependsOn: [], runId: 1 }],
	};
}

function restoredThread(runtime: SubagentRuntime, id: number, durableId: string, cwd: string): void {
	const thread: SubagentThread = {
		id, durableId, generation: 1, agentName: "scout", task: "Find evidence",
		cwd, executionCwd: cwd, isolation: "shared", state: "parked",
		control: new RunControl("Find evidence", 1), lifecycleVersion: 0, elapsedMs: 0,
		generationCompletion: Promise.resolve(), finalizeIsolation: async () => undefined,
	};
	runtime.threads.set(id, thread);
}

describe("workflow recovery identities", () => {
	it("keeps same-numbered workflows independent through updates and removal", async (t) => {
		const { root, config } = await fixture(t);
		const first = record(root, "window-a-workflow");
		const second = { ...record(root, "window-b-workflow"), startedAt: 1500 };
		await Promise.all([upsertWorkflowRecord(config, first), upsertWorkflowRecord(config, second)]);
		await upsertWorkflowRecord(config, { ...second, updatedAt: 3000, stopReason: "Second window stopped" });
		let stored = await readWorkflowRecords(config, root);
		assert.equal(stored.length, 2);
		assert.equal(stored.find((entry) => entry.durableId === first.durableId)!.stopReason, undefined);
		assert.equal(stored.find((entry) => entry.durableId === second.durableId)!.startedAt, 1500);
		await removeWorkflowRecord(config, workflowRecordIdentity(second), root);
		stored = await readWorkflowRecords(config, root);
		assert.deepEqual(stored.map((entry) => entry.durableId), [first.durableId]);
	});

	it("gives retained workflows stable local ids without colliding with live graphs", async (t) => {
		const { root, config, runtime } = await fixture(t);
		runtime.workflows.set(1, { id: 1, durableId: "live-workflow", name: "research", slug: "research-live", cwd: root, state: "completed", startedAt: 1, nodes: [], controller: new AbortController() } satisfies WorkflowRun);
		await upsertWorkflowRecord(config, record(root, "retained-a"));
		await upsertWorkflowRecord(config, { ...record(root, "retained-b"), updatedAt: 3000 });
		const first = await readRetainedWorkflows(runtime, root);
		assert.equal(new Set(first.map((entry) => entry.id)).size, 2);
		assert.ok(first.every((entry) => entry.id !== 1));
		const second = await readRetainedWorkflows(runtime, root);
		assert.deepEqual(second.map((entry) => [entry.durableId, entry.id]), first.map((entry) => [entry.durableId, entry.id]));
		assert.ok(runtime.reserveWorkflowId() > Math.max(...first.map((entry) => entry.id)));
	});

	it("links recovered nodes by durable run identity after display-id reassignment", async (t) => {
		const { root, config, runtime } = await fixture(t);
		const graph = record(root, "graph-a");
		graph.nodes[0]!.durableRunId = "run-a";
		await upsertWorkflowRecord(config, graph);
		restoredThread(runtime, 1, "unrelated-run", root);
		restoredThread(runtime, 9, "run-a", root);
		const [retained] = await readRetainedWorkflows(runtime, root);
		assert.equal(retained!.nodes[0]!.runId, 9);
		assert.match(formatRetainedWorkflow(retained!).join("\n"), /run #9/u);
	});

	it("never attaches an unavailable or legacy node to a different run sharing its old id", async (t) => {
		const { root, config, runtime } = await fixture(t);
		const legacy = record(root);
		await upsertWorkflowRecord(config, legacy);
		restoredThread(runtime, 1, "unrelated-run", root);
		const [retained] = await readRetainedWorkflows(runtime, root);
		assert.equal(retained!.nodes[0]!.runId, undefined);
		assert.equal(retained!.nodes[0]!.originalRunId, 1);
		assert.match(formatRetainedWorkflow(retained!).join("\n"), /original run #1/u);
		assert.equal(workflowRecordIdentity((await readWorkflowRecords(config, root))[0]!), workflowRecordIdentity(legacy));
		await removeWorkflowRecord(config, workflowRecordIdentity(legacy), root);
		assert.deepEqual(await readWorkflowRecords(config, root), []);
	});
});
