import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { emptyUsage, RunControl } from "../src/execution/run-control.ts";
import { createRuntime, type SubagentThread } from "../src/lifecycle/runtime.ts";
import { registerLookupTools } from "../src/lifecycle/tools.ts";
import { cancelActiveWork, registerCancellationHooks } from "../src/lifecycle/cancellation.ts";
import { monitor } from "../src/presentation/monitor.ts";
import { compileWorkflow } from "../src/workflow/plan.ts";
import { findOwnedPhases, persistInterruptedWorkflows, startWorkflow, stopWorkflow } from "../src/workflow/engine.ts";

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => { resolve = done; });
	return { promise, resolve };
}

async function until(check: () => boolean): Promise<void> {
	const deadline = Date.now() + 2000;
	while (!check()) {
		if (Date.now() > deadline) throw new Error("condition not reached");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

async function harness() {
	const root = await mkdtemp(join(tmpdir(), "pi-subagents-cancel-"));
	const events = new Map<string, (event: any) => Promise<void> | void>();
	const sent: Array<{ message: any; options: any }> = [];
	const pi = {
		on: (event: string, handler: (event: any) => Promise<void> | void) => events.set(event, handler),
		getActiveTools: () => [], getAllTools: () => [], sendMessage: (message: unknown, options: unknown) => sent.push({ message, options }),
	} as unknown as ExtensionAPI;
	const runtime = createRuntime(pi, join(root, "config.json"));
	registerCancellationHooks(pi, runtime);
	runtime.shutdownHooks.push(() => persistInterruptedWorkflows(runtime));
	const cleanupEntered = deferred();
	const cleanupRelease = deferred();
	let finalized = false;
	const started: string[] = [];
	const plan = compileWorkflow({ name: "cancel-test", nodes: [
		{ id: "apply", agent: "artisan", task: "Apply change" },
		{ id: "gate", agent: "artisan", task: "Run gate", dependsOn: ["apply"] },
	] }, root, ["artisan", "sentinel"]);
	const handle = startWorkflow({ runtime, resultsRoot: join(root, "results"), notify: () => undefined, resolveIsolation: () => "shared",
		startBackground: async (agent, task, _cwd, _isolation, options) => {
			started.push(task);
			const id = monitor.addRun(agent, task, undefined, undefined, { workflow: options?.workflow });
			const thread: SubagentThread = {
				id, generation: 1, agentName: agent, task, cwd: root, executionCwd: root, isolation: "shared", state: "running",
				workflow: options?.workflow, control: new RunControl(task, 1), lifecycleVersion: 0, elapsedMs: 0, generationCompletion: Promise.resolve(),
				finalizeIsolation: async (_generation, result) => {
					cleanupEntered.resolve();
					await cleanupRelease.promise;
					finalized = true;
					if (result) result.integrationStatus = "integrated";
					return { status: "integrated", integrated: true, hadChanges: true };
				},
			};
			runtime.threads.set(id, thread);
			return { agent, task, runId: id, exitCode: -1, messages: [], stderr: "", usage: emptyUsage() };
		},
	}, plan);
	return { root, pi, runtime, handle, events, sent, started, cleanupEntered, cleanupRelease, finalized: () => finalized };
}

describe("workflow stop and parent cancellation", () => {
	it("reserves pending phases before run ids exist", async () => {
		const h = await harness();
		try {
			const owned = findOwnedPhases(h.runtime, compileWorkflow({ name: "other", nodes: [{ id: "gate", agent: "artisan", task: "Run gate" }] }, h.root, ["artisan", "sentinel"]));
			assert.equal(owned[0]?.workflowId, h.handle.run.id);
			assert.equal(owned[0]?.ownerNodeId, "gate");
			h.cleanupRelease.resolve();
			await stopWorkflow(h.runtime, h.handle.run);
			await h.handle.done;
		} finally { h.cleanupRelease.resolve(); await h.runtime.shutdown(); await rm(h.root, { recursive: true, force: true }); }
	});

	it("waits for isolation finalization before delivering a stopped graph", async () => {
		const h = await harness();
		try {
			await until(() => h.handle.run.nodes[0]?.runId !== undefined);
			const stopping = stopWorkflow(h.runtime, h.handle.run);
			await h.cleanupEntered.promise;
			assert.equal(h.finalized(), false);
			assert.equal(h.sent.length, 0, "the summary cannot precede Git cleanup");
			h.cleanupRelease.resolve();
			await stopping;
			await h.handle.done;
			assert.equal(h.finalized(), true);
			assert.equal(h.handle.run.nodes[0]!.result?.integrationStatus, "integrated");
			assert.equal(h.handle.run.nodes[1]!.runId, undefined);
			assert.equal(h.sent.length, 1);
		} finally { h.cleanupRelease.resolve(); await h.runtime.shutdown(); await rm(h.root, { recursive: true, force: true }); }
	});

	for (const event of ["agent_settled", "session_before_tree"]) {
		it("stops abandoned work without waking the parent on " + event, async () => {
			const h = await harness();
			try {
				await until(() => h.handle.run.nodes[0]?.runId !== undefined);
				if (event === "agent_settled") {
					await h.events.get(event)!({ aborted: false });
					assert.equal(h.handle.run.state, "running", "normal parent settlement leaves background work alive");
				}
				const stopping = h.events.get(event)!({ aborted: true });
				await h.cleanupEntered.promise;
				h.cleanupRelease.resolve();
				await stopping;
				await h.handle.done;
				h.runtime.completionBatcher.flush();
				assert.equal(h.handle.run.state, "stopped");
				assert.equal(h.started.length, 1);
				assert.equal(h.sent.length, event === "agent_settled" ? 1 : 0);
				if (event === "agent_settled") {
					assert.equal(h.sent[0]!.message.customType, "subagent-cancelled");
					assert.match(h.sent[0]!.message.content, /already cancelled; no further subagent_stop is needed/u);
					assert.deepEqual(h.sent[0]!.message.details.workflowIds, [h.handle.run.id]);
					assert.deepEqual(h.sent[0]!.options, { deliverAs: "nextTurn", triggerTurn: false });
					await h.events.get(event)!({ aborted: true });
					assert.equal(h.sent.length, 1, "repeated Escape must not duplicate the receipt");
				}
				assert.equal(h.runtime.suppressCompletions, false);
			} finally { h.cleanupRelease.resolve(); await h.runtime.shutdown(); await rm(h.root, { recursive: true, force: true }); }
		});
	}

	it("records cancellation performed by an awaited tool before the settled hook", async () => {
		const h = await harness();
		try {
			await until(() => h.handle.run.nodes[0]?.runId !== undefined);
			h.cleanupRelease.resolve();
			await cancelActiveWork(h.runtime, "Parent run was cancelled.");
			assert.equal(h.sent.length, 1);
			assert.match(h.sent[0]!.message.content, /no further subagent_stop is needed/u);
			await h.events.get("agent_settled")!({ aborted: true });
			assert.equal(h.sent.length, 1, "the settled hook must not lose or duplicate the receipt");
		} finally { h.cleanupRelease.resolve(); await h.runtime.shutdown(); await rm(h.root, { recursive: true, force: true }); }
	});

	it("stop-all interrupts an unrelated writer before waiting for graph cleanup", { timeout: 5_000 }, async () => {
		const h = await harness();
		try {
			await until(() => h.handle.run.nodes[0]?.runId !== undefined);
			let stoppedWriter = false;
			const id = monitor.addRun("artisan", "Unrelated shared writer");
			const control = new RunControl("Unrelated shared writer", 1);
			const token = control.beginAttempt();
			control.attach(token, { stop: async () => { stoppedWriter = true; h.cleanupRelease.resolve(); } });
			h.runtime.threads.set(id, { id, generation: 1, agentName: "artisan", task: "Unrelated shared writer", cwd: h.root, executionCwd: h.root, isolation: "shared", state: "running", control, lifecycleVersion: 0, elapsedMs: 0, generationCompletion: Promise.resolve(), finalizeIsolation: async () => undefined });
			let stopTool: any;
			registerLookupTools({ ...h.pi, registerTool: (tool: any) => { if (tool.name === "subagent_stop") stopTool = tool; } } as ExtensionAPI, h.runtime);
			await stopTool.execute("stop-all", { all: true }, undefined, undefined, { cwd: h.root });
			await h.handle.done;
			assert.equal(stoppedWriter, true);
			assert.equal(h.finalized(), true);
			assert.equal(h.started.length, 1);
		} finally { h.cleanupRelease.resolve(); await h.runtime.shutdown(); await rm(h.root, { recursive: true, force: true }); }
	});

	it("ends old-session work without delivery on new-session shutdown", async () => {
		const h = await harness();
		try {
			await until(() => h.handle.run.nodes[0]?.runId !== undefined);
			await h.runtime.shutdown();
			await h.handle.done;
			assert.equal(h.handle.run.state, "interrupted");
			assert.equal(h.started.length, 1);
			assert.equal(h.sent.length, 0);
			assert.equal(h.runtime.threads.size, 0);
			assert.equal(monitor.getWorkflows().length, 0);
		} finally { h.cleanupRelease.resolve(); await h.runtime.shutdown(); await rm(h.root, { recursive: true, force: true }); }
	});
});
