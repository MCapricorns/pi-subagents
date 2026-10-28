import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, it, type TestContext } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_CONFIG } from "../src/configuration/config.ts";
import { loadBuiltinAgents } from "../src/delegation/agents.ts";
import { registerSubagentTool } from "../src/delegation/dispatch.ts";
import { findRuntimeWriterConflict, pendingWorkflowLeases, registerMainOwnershipGuard } from "../src/delegation/ownership.ts";
import { normalizePhaseScope } from "../src/delegation/phase-scope.ts";
import { buildDelegationDirective } from "../src/delegation/prompt.ts";
import { RunControl } from "../src/execution/run-control.ts";
import { createDispatchCore } from "../src/lifecycle/dispatch-core.ts";
import { createRuntime, type SubagentThread } from "../src/lifecycle/runtime.ts";
import { monitor } from "../src/presentation/monitor.ts";
import { compileWorkflow } from "../src/workflow/plan.ts";
import { startWorkflow } from "../src/workflow/engine.ts";
import type { WorkflowRun } from "../src/workflow/state.ts";
import { registerWorkflowTool } from "../src/workflow/tool.ts";

async function harness(t: TestContext) {
	const root = await mkdtemp(join(tmpdir(), "pi-ownership-"));
	const events = new Map<string, (event: any, ctx: any) => any>();
	const tools = new Map<string, { execute: (...args: any[]) => Promise<any> }>();
	const pi = {
		on: (name: string, handler: (event: any, ctx: any) => any) => events.set(name, handler),
		getActiveTools: () => ["read", "edit", "write"],
		getAllTools: () => [],
		sendMessage: () => undefined,
		registerTool: (tool: { name: string; execute: (...args: any[]) => Promise<any> }) => tools.set(tool.name, tool),
	} as unknown as ExtensionAPI;
	const runtime = createRuntime(pi, join(root, "config.json"));
	const core = createDispatchCore(runtime);
	registerMainOwnershipGuard(pi, runtime);
	registerSubagentTool(pi, runtime, core);
	registerWorkflowTool(pi, runtime, core);
	const ctx = { cwd: root, modelRegistry: { getAvailable: () => [] }, ui: { notify: () => undefined } } as unknown as ExtensionContext;
	core.setEnvironment({ ctx, config: DEFAULT_CONFIG, agents: loadBuiltinAgents() });
	t.after(async () => {
		// All fixture threads are inert; real dispatches below are already settled.
		runtime.threads.clear();
		runtime.workflows.clear();
		await runtime.shutdown();
		monitor.clear();
		await rm(root, { recursive: true, force: true });
	});
	return {
		root, runtime, core, ctx,
		call: (toolName: string, path: string, toolCallId = "main-call", parentToolCallId?: string) =>
			events.get("tool_call")!({ toolName, input: { path }, toolCallId, parentToolCallId }, ctx),
		end: (toolCallId = "main-call", isError = false) => events.get("tool_execution_end")!({ toolCallId, isError }, ctx),
		execute: (name: string, params: Record<string, unknown>) => tools.get(name)!.execute("dispatch", params, new AbortController().signal, undefined, ctx),
	};
}

function writer(cwd: string, scope = normalizePhaseScope({ paths: ["src"] }, cwd)): SubagentThread {
	return {
		id: 10, generation: 1, agentName: "artisan", task: "Implement parser", phaseId: "parser", scope, writeCapable: true,
		cwd, executionCwd: cwd, isolation: "worktree", state: "running", control: new RunControl("Implement parser", 1),
		generationCompletion: Promise.resolve(), lifecycleVersion: 0, elapsedMs: 0, finalizeIsolation: async () => undefined,
	};
}

function graph(cwd: string): WorkflowRun {
	return {
		id: 3, name: "pipeline", slug: "pipeline", cwd, state: "running", startedAt: Date.now(), controller: new AbortController(),
		nodes: [{ id: "fix", agent: "artisan", task: "Fix parser using upstream facts", phaseId: "pipeline.fix", cwd,
			state: "pending", dependsOn: ["research"], ancestors: ["research"], scope: normalizePhaseScope({ paths: ["src"] }, cwd) }],
	};
}

describe("main and delegated ownership", () => {
	it("blocks main writes, including nested calls, while allowing reads and disjoint paths", async (t) => {
		const h = await harness(t);
		const thread = writer(h.root);
		h.runtime.threads.set(thread.id, thread);
		assert.equal(await h.call("read", "src/parser.ts"), undefined);
		for (const tool of ["edit", "write"]) {
			const blocked = await h.call(tool, "src/parser.ts", "script/1", "script");
			assert.equal(blocked.block, true);
			assert.match(blocked.reason, /run #10.*owns scope/);
		}
		assert.equal(h.runtime.mainWrites.size, 0);
		assert.equal(await h.call("edit", "docs/guide.md"), undefined);
		assert.equal(h.runtime.mainWrites.size, 1);
		h.end();
		assert.equal(h.runtime.mainWrites.size, 0);
	});

	it("protects pending graph nodes before allocation and releases cancelled reservations", async (t) => {
		const h = await harness(t);
		const run = graph(h.root);
		h.runtime.workflows.set(run.id, run);
		const source = pendingWorkflowLeases(h.runtime)[0]!;
		assert.equal(source.workflow?.nodeId, "fix");
		const prompt = buildDelegationDirective(loadBuiltinAgents(), [source]);
		assert.match(prompt, /workflow #3\/fix.*phase:pipeline.fix/);
		assert.ok(prompt.includes(source.scope!.paths![0]!));
		assert.match((await h.call("write", "src/parser.ts")).reason, /workflow #3 node "fix"/);
		assert.equal(findRuntimeWriterConflict(h.runtime, source.scope!, { excludeWorkflowId: run.id }), undefined);
		run.nodes[0]!.state = "running";
		assert.equal(pendingWorkflowLeases(h.runtime).length, 1, "dispatch in flight still owns its reservation");
		run.state = "stopped";
		assert.equal(await h.call("write", "src/parser.ts"), undefined);
	});

	it("rejects single, batch, and workflow writers against an in-flight main write", async (t) => {
		const h = await harness(t);
		assert.equal(await h.call("edit", "src/parser.ts"), undefined);
		const task = { agent: "artisan", task: "Implement parser", scope: { paths: ["src"] } };
		await assert.rejects(h.execute("subagent", task), /overlaps main edit/);
		await assert.rejects(h.execute("subagent", { tasks: [
			{ agent: "artisan", task: "Disjoint first phase", scope: { paths: ["docs"] } }, task,
		] }), /main edit.*No background tasks were started/s);
		await assert.rejects(h.execute("subagent_workflow", { nodes: [
			{ id: "research", agent: "scout", task: "Research parser" },
			{ ...task, id: "fix", dependsOn: ["research"] },
		] }), /main edit.*No nodes were started/s);
		assert.equal(h.runtime.threads.size, 0);
		assert.equal(h.runtime.workflows.size, 0);
		h.end("main-call", true);
		assert.equal(findRuntimeWriterConflict(h.runtime, normalizePhaseScope(task.scope, h.root)!), undefined, "failed tools release their claim too");
	});

	it("rejects all external writers against a pending graph before any child starts", async (t) => {
		const h = await harness(t);
		const run = graph(h.root);
		h.runtime.workflows.set(run.id, run);
		const task = { agent: "artisan", task: "A differently worded parser change", phaseId: "different", scope: { paths: ["src/parser.ts"] } };
		await assert.rejects(h.execute("subagent", task), /workflow #3 node "fix"/);
		await assert.rejects(h.execute("subagent", { tasks: [
			{ agent: "artisan", task: "Disjoint work", scope: { paths: ["docs"] } }, task,
		] }), /workflow #3 node "fix"/);
		await assert.rejects(h.execute("subagent_workflow", { name: "another", nodes: [
			{ id: "research", agent: "scout", task: "Read docs" }, { ...task, id: "fix", dependsOn: ["research"] },
		] }), /workflow #3 node "fix"/);
		assert.equal(h.runtime.threads.size, 0);
		assert.equal(h.runtime.workflows.size, 1);
	});

	it("keeps stopped and settling writers protected until their finalization ends", async (t) => {
		const h = await harness(t);
		const thread = writer(h.root);
		h.runtime.threads.set(thread.id, thread);
		for (const state of ["running", "queued", "interrupting", "parked"] as const) {
			thread.state = state;
			assert.equal((await h.call("edit", "src/parser.ts")).block, true);
		}
		thread.state = "stopped";
		thread.retired = true;
		thread.lifecycleOperation = "stop";
		assert.equal((await h.call("edit", "src/parser.ts")).block, true);
		thread.retired = false;
		thread.state = "completed";
		thread.lifecycleOperation = "settle";
		assert.equal((await h.call("edit", "src/parser.ts")).block, true);
		thread.lifecycleOperation = undefined;
		assert.equal(await h.call("edit", "src/parser.ts"), undefined);
		assert.match(buildDelegationDirective(loadBuiltinAgents(), [thread]), /Recent settled phases.*reuse results/s);
	});

	it("resolves native path spellings and conservatively protects file-level writes to claimed symbols", async (t) => {
		const h = await harness(t);
		const thread = writer(h.root, normalizePhaseScope({ symbols: [{ path: "src/parser.ts", name: "parse" }] }, h.root));
		h.runtime.threads.set(thread.id, thread);
		for (const path of ["@src/parser.ts", "nested/../src/parser.ts", pathToFileURL(join(h.root, "src/parser.ts")).href]) {
			assert.equal((await h.call("write", path)).block, true, path);
		}
		thread.scope = normalizePhaseScope({ paths: [homedir()] }, h.root);
		assert.equal((await h.call("write", "~/parser.ts")).block, true);
		thread.writeCapable = false;
		assert.equal(await h.call("write", "~/parser.ts"), undefined, "a read-only claim cannot block writers");
	});

	it("waits for durable restore before admitting main writes", async (t) => {
		const h = await harness(t);
		let release!: () => void;
		h.runtime.durableRestore = new Promise<void>((resolve) => { release = resolve; });
		const pending = h.call("edit", "src/parser.ts");
		h.runtime.threads.set(10, writer(h.root));
		release();
		assert.equal((await pending).block, true);
	});

	it("runs ordered nodes with shared scope through the actual dispatcher", { timeout: 10_000 }, async (t) => {
		const h = await harness(t);
		const child = join(h.root, "child.mjs");
		await writeFile(child, `
import { createInterface } from "node:readline";
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  const command = JSON.parse(line);
  if (command.type !== "prompt") return;
  send({ type: "response", id: command.id, command: "prompt", success: true, data: { disposition: "started" } });
  send({ type: "agent_start" });
  send({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Completed phase" }], stopReason: "stop" } });
  send({ type: "agent_settled" });
});`);
		const previousScript = process.argv[1];
		process.argv[1] = child;
		try {
			const plan = compileWorkflow({ name: "ordered", nodes: [
				{ id: "fix", agent: "artisan", task: "Implement parser", scope: { paths: ["src"] } },
				{ id: "extend", agent: "artisan", task: "Extend parser from {{fix}}", dependsOn: ["fix"], scope: { paths: ["src"] } },
			] }, h.root, ["artisan"]);
			const handle = startWorkflow({ runtime: h.runtime, startBackground: h.core.startBackground, resolveIsolation: () => "shared", resultsRoot: join(h.root, "results"), notify: () => undefined }, plan);
			assert.equal((await handle.done).state, "completed");
			assert.equal(h.runtime.threads.size, 2);
			assert.equal(await h.call("edit", "src/parser.ts"), undefined);
		} finally {
			process.argv[1] = previousScript;
		}
	});
});
