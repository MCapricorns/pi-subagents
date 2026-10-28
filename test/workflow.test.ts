import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { SingleResult } from "../src/execution/spawn.ts";
import type { SubagentRuntime } from "../src/lifecycle/runtime.ts";
import { emptyUsage } from "../src/execution/run-control.ts";
import type { CompletionMessageItem } from "../src/lifecycle/completion.ts";
import { compileWorkflow, defaultPhaseId, renderNodeTask, WORKFLOW_NODE_LIMIT, UPSTREAM_OUTPUT_MAX_CHARS } from "../src/workflow/plan.ts";
import { compileBuiltinWorkflow } from "../src/workflow/templates.ts";
import { findOwnedPhases, startWorkflow, stopWorkflow, persistInterruptedWorkflows, readRetainedWorkflows, workflowStatus, formatWorkflowStatus, formatRetainedWorkflow, formatWorkflowReport } from "../src/workflow/engine.ts";
import { ACCEPTANCE_BRIEF_MAX_CHARS, parseAcceptanceVerdict, WORKFLOW_ACCEPTANCE_ID } from "../src/workflow/acceptance.ts";
import { readWorkflowRecords, upsertWorkflowRecord } from "../src/workflow/durable.ts";
import type { WorkflowRun } from "../src/workflow/state.ts";
import { createRuntime } from "../src/lifecycle/runtime.ts";
import { registerWorkflowTool } from "../src/workflow/tool.ts";

const AGENTS = ["scout", "artisan", "sentinel"];

async function until(check: () => boolean, timeoutMs = 2_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!check()) {
		if (Date.now() > deadline) throw new Error("condition not reached");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}


function result(agent: string, task: string, runId: number, output: string, failed = false): SingleResult {
	return {
		agent,
		task,
		exitCode: failed ? 1 : 0,
		messages: [{ role: "assistant", content: [{ type: "text", text: output }], stopReason: "stop" } as SingleResult["messages"][number]],
		stderr: "",
		usage: emptyUsage(),
		runId,
		...(failed ? { stopReason: "error" as const, errorMessage: output } : {}),
	};
}

interface FakeRuntime {
	runtime: SubagentRuntime;
	completions: CompletionMessageItem[];
}

/**
 * Minimal runtime surface the graph runner uses. Nodes are started by a stub
 * dispatcher that settles them on a later tick, so dependency order, blocked
 * propagation, and the single-summary rule are observable without child
 * processes.
 */
interface DispatchHarness extends FakeRuntime {
	dispatch: (agent: string, task: string) => Promise<SingleResult>;
}

function fakeRuntime(
	configPath: string,
	settle: (agent: string, task: string, runId: number) => Promise<SingleResult>,
	accept: (agent: string, task: string, runId: number) => Promise<SingleResult> = async (agent, task, runId) => result(agent, task, runId, "Reviewed the integrated outcome.\nWORKFLOW_ACCEPTANCE: PASS"),
): DispatchHarness {
	const completions: CompletionMessageItem[] = [];
	let nextRunId = 1;
	let nextWorkflowId = 1;
	const runtime = {
		configPath,
		sessionActive: true,
		threads: new Map(),
		workflows: new Map(),
		workflowRecordIds: new Map(),
		settledRuns: new Map(),
		settledListeners: new Map(),
		runControllers: new Map(),
		backgroundQueue: { cancel: () => undefined },
		reserveWorkflowId: () => nextWorkflowId++,
		ensureWorkflowIdAbove: (id: number) => {
			if (id >= nextWorkflowId) nextWorkflowId = id + 1;
		},
		registerRunResult: (runId: number, settled: SingleResult) => {
			runtime.settledRuns.set(runId, settled);
			const listeners = runtime.settledListeners.get(runId);
			runtime.settledListeners.delete(runId);
			for (const listener of listeners ?? []) listener(settled);
		},
		sendCompletionGroup: (items: CompletionMessageItem[]) => {
			completions.push(...items);
		},
	} as unknown as SubagentRuntime;
	const dispatch = async (agent: string, task: string) => {
		const runId = nextRunId++;
		const queued: SingleResult = { agent, task, exitCode: -1, messages: [], stderr: "", usage: emptyUsage(), runId };
		const finish = task.startsWith("Act as the independent acceptance officer") ? accept : settle;
		void finish(agent, task, runId).then((settled) => runtime.registerRunResult(runId, settled));
		return queued;
	};
	return { runtime, completions, dispatch };
}

async function runGraph(
	dispatching: DispatchHarness,
	plan: Parameters<typeof compileWorkflow>[0],
	cwd: string,
): Promise<{ run: WorkflowRun; completions: CompletionMessageItem[]; tasks: string[] }> {
	const tasks: string[] = [];
	const workflow = compileWorkflow(plan, cwd, AGENTS);
	const handle = startWorkflow(
		{
			runtime: dispatching.runtime,
			startBackground: async (agent, task) => {
				tasks.push(task);
				return dispatching.dispatch(agent, task);
			},
			resolveIsolation: () => "shared",
			resultsRoot: join(cwd, "results"),
			notify: () => undefined,
		},
		workflow,
	);
	const run = await handle.done;
	return { run, completions: dispatching.completions, tasks };
}

describe("workflow plan compilation", () => {
	it("compiles a dependency graph and derives phase ids", () => {
		const workflow = compileWorkflow(
			{
				name: "Auth fix",
				nodes: [
					{ id: "map", agent: "scout", task: "Map the auth flow" },
					{ id: "fix", agent: "artisan", task: "Fix it. Context: {{map}}", dependsOn: ["map"] },
				],
			},
			process.cwd(),
			AGENTS,
		);
		assert.equal(workflow.name, "Auth fix");
		assert.equal(workflow.slug, "auth-fix");
		assert.deepEqual(workflow.nodes.map((node) => node.id), ["map", "fix", WORKFLOW_ACCEPTANCE_ID]);
		assert.deepEqual(workflow.nodes[1]!.ancestors, ["map"]);
		assert.equal(defaultPhaseId(workflow, workflow.nodes[1]!), "auth-fix.fix");
	});

	it("rejects invalid graphs before anything starts", () => {
		const cases: Array<{ plan: Parameters<typeof compileWorkflow>[0]; pattern: RegExp }> = [
			{ plan: { nodes: [] }, pattern: /at least one node/i },
			{
				plan: { nodes: [{ id: "a", agent: "scout", task: "x" }, { id: "a", agent: "scout", task: "y" }] },
				pattern: /declared twice/i,
			},
			{
				plan: { nodes: [{ id: "a", agent: "ghost", task: "x" }] },
				pattern: /not an enabled agent/i,
			},
			{
				plan: { nodes: [{ id: "a", agent: "scout", task: "x", dependsOn: ["missing"] }] },
				pattern: /unknown node/i,
			},
			{
				plan: {
					nodes: [
						{ id: "a", agent: "scout", task: "x", dependsOn: ["b"] },
						{ id: "b", agent: "scout", task: "y", dependsOn: ["a"] },
					],
				},
				pattern: /cycle/i,
			},
			{
				plan: { nodes: [{ id: "a", agent: "scout", task: "Use {{later}}" }, { id: "later", agent: "scout", task: "y" }] },
				pattern: /not a declared dependency/i,
			},
			{
				plan: {
					nodes: [
						{ id: "a", agent: "artisan", task: "x", scope: { paths: ["src/config.ts"] } },
						{ id: "b", agent: "artisan", task: "y", scope: { paths: ["src/config.ts"] } },
					],
				},
				pattern: /overlapping writer scope/i,
			},
			{
				plan: { nodes: Array.from({ length: WORKFLOW_NODE_LIMIT + 1 }, (_value, index) => ({ id: `n${index}`, agent: "scout", task: "x" })) },
				pattern: /at most/i,
			},
		];
		for (const { plan, pattern } of cases) {
			assert.throws(() => compileWorkflow(plan, process.cwd(), AGENTS), pattern);
		}
	});

	it("allows a shared writer scope when a dependency orders the nodes", () => {
		const workflow = compileWorkflow(
			{
				nodes: [
					{ id: "fix", agent: "artisan", task: "Fix src/config.ts", scope: { paths: ["src/config.ts"] } },
					{ id: "test", agent: "artisan", task: "Add tests", dependsOn: ["fix"], scope: { paths: ["src/config.ts"] } },
				],
			},
			process.cwd(),
			AGENTS,
		);
		assert.equal(workflow.nodes.length, 3);
	});

	it("renders upstream answers and facts into a dependent brief", () => {
		const workflow = compileWorkflow(
			{
				nodes: [
					{ id: "map", agent: "scout", task: "Map it" },
					{
						id: "fix",
						agent: "artisan",
						task: "Answer: {{map}}\nStatus: {{map.status}} run {{map.runId}} error {{map.error}}",
						dependsOn: ["map"],
					},
				],
			},
			process.cwd(),
			AGENTS,
		);
		const rendered = renderNodeTask(
			workflow.nodes[1]!.task,
			new Map([["map", { status: "completed", output: "the flow", runId: 7 }]]),
		);
		assert.match(rendered, /Answer: the flow/);
		assert.match(rendered, /Status: completed run #7/);
		assert.match(rendered, /error \(no error reported\)/);
	});
});

describe("workflow runner", () => {
	it("dispatches each dependent as soon as its prerequisites settle", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-subagents-workflow-run-"));
		try {
			const harness = fakeRuntime(join(root, "pi-subagents.json"), async (agent, task, runId) =>
				result(agent, task, runId, `answer from ${agent}`),
			);
			const { run, completions, tasks } = await runGraph(harness, {
					name: "chain",
					nodes: [
						{ id: "map", agent: "scout", task: "Map it" },
						{ id: "fix", agent: "artisan", task: "Fix it using {{map}}", dependsOn: ["map"] },
					],
				},
				root,
			);
			assert.equal(run.state, "completed");
			assert.deepEqual(run.nodes.map((node) => node.state), ["completed", "completed", "completed"]);
			assert.match(tasks[1] ?? "", /answer from scout/);
			assert.equal(completions.length, 1, "a graph reports once, not once per node");
			assert.match(completions[0]!.block, /workflow chain completed/);
			assert.match(completions[0]!.block, /answer from artisan/);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("blocks dependents of a failed node and keeps independent branches running", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-subagents-workflow-fail-"));
		try {
			const harness = fakeRuntime(join(root, "pi-subagents.json"), async (agent, task, runId) =>
				agent === "artisan" ? result(agent, task, runId, "compile error", true) : result(agent, task, runId, "ok"),
			);
			const { run, completions } = await runGraph(harness, {
					name: "fan",
					nodes: [
						{ id: "map", agent: "scout", task: "Map it" },
						{ id: "broken", agent: "artisan", task: "Break it", dependsOn: ["map"] },
						{ id: "gate", agent: "artisan", task: "Gate", dependsOn: ["broken"] },
						{ id: "docs", agent: "scout", task: "Docs", dependsOn: ["map"] },
					],
				},
				root,
			);
			assert.equal(run.state, "failed");
			const states = Object.fromEntries(run.nodes.map((node) => [node.id, node.state]));
			assert.deepEqual(states, { map: "completed", broken: "failed", gate: "blocked", docs: "completed", [WORKFLOW_ACCEPTANCE_ID]: "completed" });
			assert.equal(completions.length, 1);
			assert.match(completions[0]!.block, /1 failed/);
			assert.match(completions[0]!.block, /never ran/);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("stops the graph without starting idle dependents", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-subagents-workflow-stop-"));
		try {
			// The first node stays in flight, exactly like a live child process; the
			// dependent must never start once the graph is stopped.
			const harness = fakeRuntime(join(root, "pi-subagents.json"), async (agent, task, runId) =>
				result(agent, task, runId, "settles before the stop"),
			);
			const workflow = compileWorkflow(
				{
					name: "stoppable",
					nodes: [
						{ id: "map", agent: "scout", task: "Map it" },
						{ id: "fix", agent: "artisan", task: "Fix it", dependsOn: ["map"] },
					],
				},
				root,
				AGENTS,
			);
			const handle = startWorkflow(
				{
					runtime: harness.runtime,
					startBackground: async () => ({
						agent: "scout",
						task: "in flight",
						exitCode: -1,
						messages: [],
						stderr: "",
						usage: emptyUsage(),
						runId: 41,
					}),
					resolveIsolation: () => "shared",
					resultsRoot: join(root, "results"),
					notify: () => undefined,
				},
				workflow,
			);
			await Promise.resolve();
			await stopWorkflow(harness.runtime, handle.run);
			const run = await handle.done;
			assert.equal(run.state, "stopped");
			assert.deepEqual(run.nodes.map((node) => node.state), ["stopped", "stopped", "stopped"]);
			assert.equal(run.nodes.find((node) => node.id === "fix")?.runId, undefined);
			assert.equal(run.nodes.at(-1)!.runId, undefined, "stopping never launches required acceptance");
			assert.equal(harness.completions.length, 1);
			assert.match(harness.completions[0]!.block, /stopped/);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("retains the shape of an unfinished graph for the next session", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-subagents-workflow-retain-"));
		try {
			const harness = fakeRuntime(join(root, "pi-subagents.json"), async (agent, task, runId) =>
				result(agent, task, runId, "ok"),
			);
			const handle = startWorkflow(
				{
					runtime: harness.runtime,
					startBackground: async () => ({
						agent: "scout",
						task: "never settles",
						exitCode: -1,
						messages: [],
						stderr: "",
						usage: emptyUsage(),
						runId: 99,
					}),
					resolveIsolation: () => "shared",
					resultsRoot: join(root, "results"),
					notify: () => undefined,
				},
				compileWorkflow({ name: "held", nodes: [{ id: "map", agent: "scout", task: "Map" }] }, root, AGENTS),
			);
			await until(() => handle.run.nodes[0]?.runId === 99);
			await persistInterruptedWorkflows(harness.runtime);
			const retained = await readRetainedWorkflows(harness.runtime, root);
			assert.equal(retained.length, 1);
			assert.equal(retained[0]!.name, "held");
			assert.equal(retained[0]!.state, "interrupted");
			assert.equal(retained[0]!.nodes[0]!.originalRunId, 99);
			assert.equal(retained[0]!.nodes[0]!.runId, undefined);
			await stopWorkflow(harness.runtime, handle.run);
			await handle.done;
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});

function parkedThread(id: number, cwd: string, phaseId: string) {
	return {
		id,
		generation: 1,
		agentName: "scout",
		task: "an interrupted phase",
		phaseId,
		cwd,
		executionCwd: cwd,
		isolation: "shared",
		state: "parked",
		lifecycleVersion: 0,
		elapsedMs: 0,
	} as never;
}

describe("subagent_workflow tool", () => {
	function toolHarness(configPath: string) {
		type RegisteredTool = {
			execute: (...args: unknown[]) => Promise<unknown>;
			exposure?: string;
			executionMode?: string;
		};
		const tools = new Map<string, RegisteredTool>();
		const messages: Array<{ content: string }> = [];
		const started: string[] = [];
		let nextRunId = 1;
		const pi = {
			getActiveTools: () => ["read", "write"],
			getAllTools: () => [],
			on: () => undefined,
			registerTool: (tool: { name: string }) => tools.set(tool.name, tool as unknown as RegisteredTool),
			sendMessage: (message: { content: string }) => messages.push(message),
		} as unknown as Parameters<typeof createRuntime>[0];
		const runtime = createRuntime(pi, configPath);
		const core = {
			setEnvironment: () => undefined,
			startBackground: async (agent: string, task: string) => {
				started.push(task);
				const runId = nextRunId++;
				const output = task.startsWith("Act as the independent acceptance officer") ? "Checked evidence.\nWORKFLOW_ACCEPTANCE: PASS" : "answer from " + agent;
				setTimeout(() => runtime.registerRunResult(runId, result(agent, task, runId, output)), 0);
				return { agent, task, exitCode: -1, messages: [], stderr: "", usage: emptyUsage(), runId };
			},
			finishRun: () => undefined,
			makeLiveHandler: () => () => undefined,
			makeDetails: () => () => ({ mode: "single" as const, results: [] }),
		};
		registerWorkflowTool(pi, runtime, core as never);
		return { runtime, tool: tools.get("subagent_workflow")!, messages, started };
	}

	const ctx = (cwd: string) => ({
		cwd,
		isProjectTrusted: () => false,
		ui: { notify: () => undefined },
	});

	async function execute(tool: { execute: (...args: unknown[]) => Promise<unknown> }, params: Record<string, unknown>, cwd: string): Promise<any> {
		return tool.execute("call-1", params, new AbortController().signal, () => undefined, ctx(cwd));
	}


	it("registers as a model-only parallel tool and delivers one accepted built-in summary", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-subagents-workflow-tool-"));
		const h = toolHarness(join(root, "config.json"));
		try {
			assert.equal(h.tool.exposure, "model-only");
			assert.equal(h.tool.executionMode, "parallel");
			const response = await execute(h.tool, { workflow: "research", inputs: { QUESTION: "Explain cache invalidation" } }, root);
			assert.match(response.content[0].text, /workflow #1 research started/);
			assert.match(response.content[0].text, /synthesis \(scout\) · waits for primary, practice, codebase/);
			assert.match(response.content[0].text, /workflow-acceptance \(sentinel\) · required independent acceptance/);
			await until(() => h.messages.length > 0);
			assert.equal(h.messages.length, 1);
			assert.equal(h.started.length, 5, "four research phases and mandatory acceptance");
			assert.match(h.messages[0]!.content, /workflow research completed/);
			assert.match(h.started[3]!, /answer from scout/, "synthesis receives upstream evidence");
		} finally { await h.runtime.shutdown(); await rm(root, { recursive: true, force: true }); }
	});

	it("rejects overlapping migration slices before any child starts", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-workflow-overlap-"));
		const h = toolHarness(join(root, "config.json"));
		try {
			await assert.rejects(execute(h.tool, { workflow: "migration", inputs: {
				TARGET: "v2", CONTRACT: "docs/contract.md", CORE_CHANGE: "Core change", ADAPTER_CHANGE: "Adapter change",
				CORE_SCOPE: "src/core", CORE_TEST_SCOPE: "test/core", ADAPTER_SCOPE: "src/core/adapter", ADAPTER_TEST_SCOPE: "test/adapters",
			} }, root), /overlapping writer scope/);
			assert.deepEqual(h.started, []);
		} finally { await h.runtime.shutdown(); await rm(root, { recursive: true, force: true }); }
	});

	it("names missing inputs and rejects custom definitions without dispatch", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-workflow-preflight-"));
		const h = toolHarness(join(root, "config.json"));
		try {
			await assert.rejects(execute(h.tool, { workflow: "research" }, root), /requires inputs: QUESTION/);
			await assert.rejects(execute(h.tool, { workflow: "custom", inputs: {} }, root), /Unknown built-in workflow/);
			for (const custom of [{ file: "graph.json" }, { nodes: [{ id: "work", agent: "artisan", task: "Custom graph" }] }, { name: "custom" }, { description: "custom" }]) {
				await assert.rejects(execute(h.tool, { workflow: "code-review", inputs: { TARGET: "HEAD" }, ...custom }, root), /Custom workflow fields are unsupported/);
			}
			assert.deepEqual(h.started, []);
		} finally { await h.runtime.shutdown(); await rm(root, { recursive: true, force: true }); }
	});

	it("ignores empty legacy source fields instead of raising an ambiguous-source error", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-workflow-empty-fields-"));
		const h = toolHarness(join(root, "config.json"));
		try {
			await execute(h.tool, { workflow: "code-review", inputs: { TARGET: "HEAD" }, nodes: [], file: "", name: "", description: "" }, root);
			await until(() => h.messages.length === 1);
			assert.equal(h.started.length, 2);
			assert.match(h.messages[0]!.content, /workflow code-review completed/);
		} finally { await h.runtime.shutdown(); await rm(root, { recursive: true, force: true }); }
	});

	it("never loads a project override, even in a trusted project", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-workflow-builtin-only-"));
		const h = toolHarness(join(root, "config.json"));
		try {
			const dir = join(root, ".pi", "workflows");
			await mkdir(dir, { recursive: true });
			const file = join(dir, "code-review.json");
			const content = JSON.stringify({ name: "code-review", nodes: [{ id: "custom", agent: "artisan", task: "Replace the built-in" }] });
			await writeFile(file, content);
			const response = await h.tool.execute("call", { workflow: "code-review", inputs: { TARGET: "HEAD" } }, undefined, undefined, { ...ctx(root), isProjectTrusted: () => true }) as any;
			assert.equal(response.details.workflow.nodes[0].agent, "sentinel");
			assert.equal(await readFile(file, "utf8"), content);
			await until(() => h.messages.length === 1);
			assert.ok(h.started.every((task) => !task.includes("Replace the built-in")));
		} finally { await h.runtime.shutdown(); await rm(root, { recursive: true, force: true }); }
	});

	it("admits different questions while another built-in graph is pending", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-workflow-questions-"));
		const h = toolHarness(join(root, "config.json"));
		try {
			await Promise.all(["Cache invalidation", "Request cancellation"].map((QUESTION) => execute(h.tool, { workflow: "research", inputs: { QUESTION } }, root)));
			await until(() => h.messages.length === 2);
			assert.equal(h.started.length, 10);
			assert.ok(h.messages.every((message) => message.content.includes("research completed")));
		} finally { await h.runtime.shutdown(); await rm(root, { recursive: true, force: true }); }
	});

	it("rejects an already owned built-in deliverable before dispatching any node", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-subagents-workflow-owned-"));
		const h = toolHarness(join(root, "config.json"));
		try {
			const graph = compileBuiltinWorkflow("code-review", { TARGET: "HEAD" }, root, AGENTS);
			(h.runtime.threads as Map<number, never>).set(5, parkedThread(5, root, defaultPhaseId(graph, graph.nodes[0]!)));
			await assert.rejects(execute(h.tool, { workflow: "code-review", inputs: { TARGET: "HEAD" } }, root), /already owned by run #5[\s\S]*subagent_stop/);
			assert.deepEqual(h.started, []);
			assert.equal(h.runtime.workflows.size, 0);
		} finally { await h.runtime.shutdown(); await rm(root, { recursive: true, force: true }); }
	});
});

describe("workflow phase ownership", () => {
	it("names the owner of a phase the session already holds", () => {
		const runtime = {
			configPath: "C:/tmp/pi-subagents.json",
			threads: new Map(),
			workflows: new Map(),
		} as unknown as SubagentRuntime;
		(runtime.threads as Map<number, never>).set(7, parkedThread(7, process.cwd(), "smoke.probe"));
		const workflow = compileWorkflow(
			{
				name: "smoke",
				nodes: [
					{ id: "probe", agent: "scout", task: "Probe" },
					{ id: "report", agent: "scout", task: "Report", dependsOn: ["probe"] },
				],
			},
			process.cwd(),
			AGENTS,
		);
		const owned = findOwnedPhases(runtime, workflow);
		assert.deepEqual(owned, [{ nodeId: "probe", phaseId: "smoke.probe", runId: 7, agent: "scout", state: "parked" }]);
	});

});


describe("required workflow acceptance", () => {
	it("includes the internal acceptance phase in ownership preflight", () => {
		const harness = fakeRuntime("unused.json", async (agent, task, id) => result(agent, task, id, "done"));
		(harness.runtime.threads as Map<number, never>).set(7, parkedThread(7, process.cwd(), `smoke.${WORKFLOW_ACCEPTANCE_ID}`));
		const graph = compileWorkflow({ name: "smoke", nodes: [{ id: "work", agent: "artisan", task: "Implement" }] }, process.cwd(), AGENTS);
		assert.deepEqual(findOwnedPhases(harness.runtime, graph), [{ nodeId: WORKFLOW_ACCEPTANCE_ID, phaseId: `smoke.${WORKFLOW_ACCEPTANCE_ID}`, runId: 7, agent: "scout", state: "parked" }]);
	});

	it("reserves one independent sentinel after all authored nodes without reducing the authored limit", () => {
		const graph = compileWorkflow({ nodes: Array.from({ length: WORKFLOW_NODE_LIMIT }, (_, index) => ({ id: `n${index}`, agent: "artisan", task: `Implement part ${index}`, cwd: `part-${index}`, scope: { paths: ["owned.ts"] } })) }, process.cwd(), AGENTS);
		assert.equal(graph.nodes.length, WORKFLOW_NODE_LIMIT + 1);
		assert.equal(graph.nodes.filter((node) => node.kind === "acceptance").length, 1);
		assert.ok(graph.nodes.slice(0, -1).every((node) => node.kind === undefined));
		const review = graph.nodes.at(-1)!;
		assert.equal(review.id, WORKFLOW_ACCEPTANCE_ID);
		assert.equal(review.agent, "sentinel");
		assert.equal(review.cwd, graph.cwd);
		assert.equal(review.isolation, "shared");
		assert.equal(review.scope, undefined);
		assert.deepEqual(review.dependsOn, graph.nodes.slice(0, -1).map((node) => node.id));
		assert.deepEqual(review.ancestors, review.dependsOn);
		assert.match(review.task, /do not edit project files/i);
		assert.match(review.task, /do not dispatch agents, bump versions, commit, push, publish, tag or release/i);
		assert.throws(() => compileWorkflow({ nodes: [{ id: WORKFLOW_ACCEPTANCE_ID, agent: "scout", task: "Impersonate acceptance" }] }, process.cwd(), AGENTS), /reserved/);
		assert.throws(() => compileWorkflow({ nodes: [{ id: "work", agent: "scout", task: "Inspect" }] }, process.cwd(), ["scout"]), /Required acceptance agent/);
		assert.throws(() => compileWorkflow({ name: "phase", nodes: [{ id: "work", agent: "artisan", task: "Work", phaseId: `phase.${WORKFLOW_ACCEPTANCE_ID}` }] }, process.cwd(), AGENTS), /reuse the same phase/);
	});

	it("rejects compiled graphs that omit or weaken required acceptance before starting", () => {
		const graph = compileWorkflow({ nodes: [{ id: "work", agent: "artisan", task: "Work" }] }, process.cwd(), AGENTS);
		const runtime = fakeRuntime("unused.json", async (agent, task, id) => result(agent, task, id, "done"));
		const deps = { runtime: runtime.runtime, startBackground: runtime.dispatch, resolveIsolation: () => "shared" as const, resultsRoot: "unused", notify: () => undefined };
		assert.throws(() => startWorkflow(deps, { ...graph, nodes: graph.nodes.slice(0, -1) }), /requires exactly one/);
		assert.throws(() => startWorkflow(deps, { ...graph, nodes: graph.nodes.map((node) => node.kind ? { ...node, dependsOn: [] } : node) }), /requires exactly one/);
		assert.equal(runtime.runtime.workflows.size, 0);
	});

	it("requires a unique exact terminal standalone verdict", () => {
		assert.equal(parseAcceptanceVerdict("Inspected files and reused checks.\nWORKFLOW_ACCEPTANCE: PASS\n").verdict, "PASS");
		assert.equal(parseAcceptanceVerdict("src/a.ts:12 is broken.\r\nWORKFLOW_ACCEPTANCE: FAIL").verdict, "FAIL");
		for (const output of [
			"Everything looks good", "WORKFLOW_ACCEPTANCE: pass", "WORKFLOW_ACCEPTANCE: PASSED", "WORKFLOW_ACCEPTANCE: PASS extra",
			"Verdict: WORKFLOW_ACCEPTANCE: PASS", "WORKFLOW_ACCEPTANCE: PASS\nMore text", "WORKFLOW_ACCEPTANCE: PASS\nWORKFLOW_ACCEPTANCE: PASS",
			"WORKFLOW_ACCEPTANCE: FAIL\nWORKFLOW_ACCEPTANCE: PASS", "`WORKFLOW_ACCEPTANCE: PASS`", "WORKFLOW_ACCEPTANCE = PASS",
		]) assert.ok(parseAcceptanceVerdict(output).error, output);
	});

	it("fails the graph for exit-zero rejection or missing verdict while preserving ordinary successes", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-workflow-acceptance-verdict-"));
		try {
			for (const output of ["src/config.ts:8 loses user input.\nWORKFLOW_ACCEPTANCE: FAIL", "Looks complete", "WORKFLOW_ACCEPTANCE: FAIL\nWORKFLOW_ACCEPTANCE: PASS"]) {
				const harness = fakeRuntime(join(root, "config.json"), async (agent, task, id) => result(agent, task, id, "done"), async (agent, task, id) => result(agent, task, id, output));
				const { run, completions } = await runGraph(harness, { nodes: [{ id: "work", agent: "artisan", task: "Implement" }] }, root);
				assert.equal(run.state, "failed");
				assert.equal(run.nodes[0]!.state, "completed");
				const review = run.nodes.at(-1)!;
				assert.equal(review.kind, "acceptance");
				assert.equal(review.result!.exitCode, 0);
				assert.equal(review.state, "failed");
				assert.match(review.error!, /rejected/);
				assert.equal(await readFile(review.result!.resultFile!, "utf8"), output);
				assert.equal(workflowStatus(run).nodes.at(-1)!.kind, "acceptance");
				assert.equal(completions.length, 1);
				assert.match(completions[0]!.block, /required acceptance rejected/);
				assert.match(completions[0]!.block, /Full acceptance review:/);
				assert.match(formatWorkflowStatus(run).join("\n"), /required acceptance rejected/);
			}
		} finally { await rm(root, { recursive: true, force: true }); }
	});

	it("does not accept a failed reviewer process even when its output ends in PASS", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-workflow-review-crash-"));
		try {
			const harness = fakeRuntime(join(root, "config.json"), async (agent, task, id) => result(agent, task, id, "done"), async (agent, task, id) => result(agent, task, id, "WORKFLOW_ACCEPTANCE: PASS", true));
			const { run } = await runGraph(harness, { nodes: [{ id: "work", agent: "artisan", task: "Implement" }] }, root);
			assert.equal(run.state, "failed");
			assert.equal(run.nodes.at(-1)!.state, "failed");
		} finally { await rm(root, { recursive: true, force: true }); }
	});

	it("waits for integrated settlement of every branch and reviews failed and blocked work", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-workflow-review-settlement-"));
		try {
			let integrate!: () => void;
			const integrated = new Promise<void>((resolve) => { integrate = resolve; });
			let reviewing = false;
			let reviewTask = "";
			const harness = fakeRuntime(join(root, "config.json"), async (agent, task, id) => {
				if (task === "Broken branch") return { ...result(agent, task, id, "type error", true), integrationPatchPath: join(root, "retained.patch") };
				await integrated;
				return { ...result(agent, task, id, "Verification: focused checks passed"), integrationStatus: "integrated" };
			}, async (agent, task, id) => {
				reviewing = true;
				reviewTask = task;
				return result(agent, task, id, "WORKFLOW_ACCEPTANCE: PASS");
			});
			const handle = startWorkflow({ runtime: harness.runtime, startBackground: harness.dispatch, resolveIsolation: () => "worktree", resultsRoot: join(root, "results"), notify: () => undefined }, compileWorkflow({ description: "Fix every branch", nodes: [{ id: "broken", agent: "artisan", task: "Broken branch" }, { id: "blocked", agent: "artisan", task: "Dependent gate", dependsOn: ["broken"] }, { id: "slow", agent: "artisan", task: "Still integrating" }] }, root, AGENTS));
			await until(() => handle.run.nodes[0]!.state === "failed");
			assert.equal(reviewing, false);
			assert.equal(handle.run.nodes.at(-1)!.state, "pending");
			integrate();
			const run = await handle.done;
			assert.equal(reviewing, true);
			assert.equal(run.state, "failed", "a PASS never erases failed or blocked authored work");
			assert.deepEqual(run.nodes.map((node) => node.state), ["failed", "blocked", "completed", "completed"]);
			assert.match(reviewTask, /broken \(artisan\) · failed/);
			assert.match(reviewTask, /blocked \(artisan\) · blocked/);
			assert.match(reviewTask, /type error/);
			assert.match(reviewTask, /Verification: focused checks passed/);
			assert.match(reviewTask, /retained.patch/);
			assert.equal(harness.completions.length, 1);
		} finally { await rm(root, { recursive: true, force: true }); }
	});

	it("dispatches acceptance only in shared cwd with no scope and quiet graph delivery", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-workflow-review-context-"));
		try {
			const harness = fakeRuntime(join(root, "config.json"), async (agent, task, id) => result(agent, task, id, "done"));
			const calls: Array<{ agent: string; cwd?: string; isolation: unknown; options: Parameters<Parameters<typeof startWorkflow>[0]["startBackground"]>[4] }> = [];
			const handle = startWorkflow({ runtime: harness.runtime, startBackground: async (agent, task, cwd, isolation, options) => {
				calls.push({ agent, cwd, isolation, options });
				return harness.dispatch(agent, task);
			}, resolveIsolation: () => "worktree", resultsRoot: join(root, "results"), notify: () => undefined }, compileWorkflow({ nodes: [{ id: "work", agent: "artisan", task: "Implement", cwd: "child", scope: { paths: ["owned.ts"] } }] }, root, AGENTS));
			const run = await handle.done;
			assert.equal(run.state, "completed");
			assert.equal(calls.length, 2);
			assert.equal(calls[0]!.isolation, "worktree");
			assert.equal(calls[1]!.agent, "sentinel");
			assert.equal(calls[1]!.cwd, root);
			assert.equal(calls[1]!.isolation, "shared");
			assert.equal(calls[1]!.options!.scope, undefined);
			assert.equal(calls[1]!.options!.automaticIsolation, false);
			assert.equal(calls[1]!.options!.quiet, true);
			assert.equal(calls[1]!.options!.workflow!.nodeId, WORKFLOW_ACCEPTANCE_ID);
			assert.match(formatWorkflowReport(run), /required acceptance accepted/);
		} finally { await rm(root, { recursive: true, force: true }); }
	});

	it("cancels a running acceptance without treating a late PASS as accepted", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-workflow-review-stop-"));
		try {
			let finishReview!: (value: SingleResult) => void;
			let reviewArgs!: [string, string, number];
			const harness = fakeRuntime(join(root, "config.json"), async (agent, task, id) => result(agent, task, id, "done"), async (agent, task, id) => {
				reviewArgs = [agent, task, id];
				return new Promise<SingleResult>((resolve) => { finishReview = resolve; });
			});
			const handle = startWorkflow({ runtime: harness.runtime, startBackground: harness.dispatch, resolveIsolation: () => "shared", resultsRoot: join(root, "results"), notify: () => undefined }, compileWorkflow({ nodes: [{ id: "work", agent: "artisan", task: "Implement" }] }, root, AGENTS));
			await until(() => handle.run.nodes.at(-1)!.runId !== undefined);
			const stopping = stopWorkflow(harness.runtime, handle.run);
			finishReview(result(...reviewArgs, "WORKFLOW_ACCEPTANCE: PASS"));
			await stopping;
			const run = await handle.done;
			assert.equal(run.state, "stopped");
			assert.equal(run.nodes[0]!.state, "completed");
			assert.equal(run.nodes.at(-1)!.state, "stopped");
			assert.equal(harness.completions.length, 1);
		} finally { await rm(root, { recursive: true, force: true }); }
	});

	it("never launches acceptance when session shutdown starts before authored work settles", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-workflow-review-shutdown-"));
		try {
			const harness = fakeRuntime(join(root, "config.json"), async (agent, task, id) => {
				harness.runtime.sessionActive = false;
				return result(agent, task, id, "done during shutdown");
			});
			const { run, tasks } = await runGraph(harness, { nodes: [{ id: "work", agent: "artisan", task: "Implement" }] }, root);
			assert.equal(run.state, "interrupted");
			assert.equal(tasks.length, 1);
			assert.equal(run.nodes.at(-1)!.runId, undefined);
			assert.equal(harness.completions.length, 0);
			const retained = await readRetainedWorkflows(harness.runtime, root);
			assert.equal(retained[0]!.nodes.at(-1)!.kind, "acceptance");
			assert.equal(retained[0]!.nodes.at(-1)!.state, "pending");
		} finally { await rm(root, { recursive: true, force: true }); }
	});

	it("retains running acceptance evidence across interruption without resuming it", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-workflow-review-restore-"));
		try {
			const harness = fakeRuntime(join(root, "config.json"), async (agent, task, id) => result(agent, task, id, "done"), async () => new Promise<SingleResult>(() => undefined));
			const handle = startWorkflow({ runtime: harness.runtime, startBackground: harness.dispatch, resolveIsolation: () => "shared", resultsRoot: join(root, "results"), notify: () => undefined }, compileWorkflow({ nodes: [{ id: "work", agent: "artisan", task: "Implement" }] }, root, AGENTS));
			await until(() => handle.run.nodes.at(-1)!.runId !== undefined);
			harness.runtime.sessionActive = false;
			await persistInterruptedWorkflows(harness.runtime);
			await handle.done;
			const retained = await readRetainedWorkflows(harness.runtime, root);
			assert.equal(retained.length, 1);
			const review = retained[0]!.nodes.at(-1)!;
			assert.equal(review.kind, "acceptance");
			assert.equal(review.state, "running");
			assert.equal(review.originalRunId, handle.run.nodes.at(-1)!.runId);
			assert.equal(review.runId, undefined);
			assert.match(await readFile(review.evidenceFile!, "utf8"), /Task \/ done condition:\nImplement/);
			assert.match(formatRetainedWorkflow(retained[0]!).join("\n"), /required acceptance running/);
			assert.equal(harness.completions.length, 0);
		} finally { await rm(root, { recursive: true, force: true }); }
	});

	it("round-trips acceptance kind, error and artifact paths alongside legacy nodes", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-workflow-review-durable-"));
		try {
			const config = join(root, "config.json");
			await upsertWorkflowRecord(config, { workflowId: 1, name: "retained", cwd: root, state: "interrupted", startedAt: Date.now(), updatedAt: Date.now(), nodes: [
				{ id: "old", agent: "scout", task: "Legacy", dependsOn: [], state: "completed" },
				{ id: WORKFLOW_ACCEPTANCE_ID, kind: "acceptance", agent: "sentinel", task: "Review", dependsOn: ["old"], state: "failed", error: "Acceptance rejected", evidenceFile: join(root, "evidence.md"), resultFile: join(root, "review.md") },
			] });
			const record = (await readWorkflowRecords(config, root))[0]!;
			assert.equal(record.nodes[0]!.kind, undefined);
			assert.equal(record.nodes[1]!.kind, "acceptance");
			assert.equal(record.nodes[1]!.state, "failed");
			assert.equal(record.nodes[1]!.error, "Acceptance rejected");
			assert.equal(record.nodes[1]!.resultFile, join(root, "review.md"));
			assert.equal(record.nodes[1]!.evidenceFile, join(root, "evidence.md"));
		} finally { await rm(root, { recursive: true, force: true }); }
	});

	it("bounds a wide graph's total review prompt and preserves full evidence in a report", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-workflow-review-budget-"));
		try {
			const output = "Verification: focused checks passed.\n" + "x".repeat(UPSTREAM_OUTPUT_MAX_CHARS) + "FULL-RESULT-END";
			const harness = fakeRuntime(join(root, "config.json"), async (agent, task, id) => result(agent, task, id, output));
			const { run, tasks } = await runGraph(harness, { description: "Review all source citations and integrated code", nodes: Array.from({ length: WORKFLOW_NODE_LIMIT }, (_, index) => ({ id: `n${index}`, agent: "scout", task: `Inspect area ${index}: ` + "brief ".repeat(2_000) })) }, root);
			assert.equal(run.state, "completed");
			const brief = tasks.at(-1)!;
			assert.ok(brief.length <= ACCEPTANCE_BRIEF_MAX_CHARS, `${brief.length} characters`);
			assert.doesNotMatch(brief, /FULL-RESULT-END/);
			assert.match(brief, /Reuse checks that remain valid/);
			assert.match(brief, /sources and citations/);
			for (let index = 0; index < WORKFLOW_NODE_LIMIT; index++) assert.ok(brief.includes(`n${index} (scout) · completed`));
			const report = await readFile(run.nodes.at(-1)!.evidenceFile!, "utf8");
			assert.equal(report.split("FULL-RESULT-END").length - 1, WORKFLOW_NODE_LIMIT);
			assert.match(report, /brief brief brief/);
			assert.match(brief, /Full evidence report/);
		} finally { await rm(root, { recursive: true, force: true }); }
	});
});


describe("workflow audit regressions", () => {
	it("normalizes node ids and rejects malformed fields and repeated phases", () => {
		const graph = compileWorkflow({ nodes: [{ id: " map ", agent: "scout", task: "Map" }, { id: "report", agent: "scout", task: "Use {{map}}", dependsOn: [" map "] }] }, process.cwd(), AGENTS);
		assert.deepEqual(graph.nodes[1]!.ancestors, ["map"]);
		for (const node of [null, { id: "bad", agent: "scout", task: "x", dependsOn: "map" }, { id: "bad", agent: "scout", task: "x", dependsOn: [3] }, { id: "bad", agent: "scout", task: "x", isolation: "typo" }]) assert.throws(() => compileWorkflow({ nodes: [node] } as never, process.cwd(), AGENTS));
		assert.throws(() => compileWorkflow({ nodes: [{ id: "one", agent: "scout", task: "First", phaseId: "same" }, { id: "two", agent: "artisan", task: "Second", phaseId: "same", dependsOn: ["one"] }] }, process.cwd(), AGENTS), /reuse the same phase/);
	});

	it("passes transitive outputs, including dotted node ids, into downstream briefs", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-workflow-ancestor-"));
		try {
			const harness = fakeRuntime(join(root, "config.json"), async (agent, task, id) => result(agent, task, id, "source evidence"));
			const { tasks } = await runGraph(harness, { nodes: [{ id: "map.status", agent: "scout", task: "Map facts" }, { id: "middle", agent: "scout", task: "Inspect facts", dependsOn: ["map.status"] }, { id: "report", agent: "scout", task: "Ancestor: {{map.status}}", dependsOn: ["middle"] }] }, root);
			assert.match(tasks[2]!, /Ancestor: source evidence/);
			assert.doesNotMatch(tasks[2]!, /\{\{/);
			assert.match(tasks[2]!, /untrusted evidence/);
		} finally { await rm(root, { recursive: true, force: true }); }
	});

	it("blocks reverse-ordered failure chains without waiting forever", { timeout: 5_000 }, async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-workflow-block-"));
		try {
			const harness = fakeRuntime(join(root, "config.json"), async (agent, task, id) => result(agent, task, id, "broken", true));
			const { run } = await runGraph(harness, { nodes: [{ id: "last", agent: "scout", task: "Final report", dependsOn: ["middle"] }, { id: "middle", agent: "scout", task: "Middle report", dependsOn: ["first"] }, { id: "first", agent: "scout", task: "Initial work" }] }, root);
			assert.equal(run.state, "failed");
			assert.deepEqual(run.nodes.map((node) => node.state), ["blocked", "blocked", "failed", "completed"]);
		} finally { await rm(root, { recursive: true, force: true }); }
	});

	it("bounds upstream output and points to its complete readable artifact", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-workflow-output-"));
		try {
			const output = "x".repeat(UPSTREAM_OUTPUT_MAX_CHARS + 400) + "THE-END";
			const harness = fakeRuntime(join(root, "config.json"), async (agent, task, id) => result(agent, task, id, id === 1 ? output : "done"));
			const { run, tasks } = await runGraph(harness, { nodes: [{ id: "map", agent: "scout", task: "Map everything" }, { id: "report", agent: "scout", task: "Use {{map}}", dependsOn: ["map"] }] }, root);
			assert.ok(tasks[1]!.length < output.length);
			assert.match(tasks[1]!, /Read the full answer:/);
			assert.doesNotMatch(tasks[1]!, /THE-END/);
			assert.equal(await readFile(run.nodes[0]!.result!.resultFile!, "utf8"), output);
		} finally { await rm(root, { recursive: true, force: true }); }
	});

	it("forwards explicit isolation and checkpoints a live graph before shutdown", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-workflow-isolation-"));
		try {
			const harness = fakeRuntime(join(root, "config.json"), async (agent, task, id) => result(agent, task, id, "ok"));
			const modes: unknown[] = [];
			const handle = startWorkflow({ runtime: harness.runtime, resultsRoot: join(root, "results"), notify: () => undefined, resolveIsolation: () => "worktree", startBackground: async (_agent, _task, _cwd, isolation) => {
				modes.push(isolation);
				return { agent: "artisan", task: "held", exitCode: -1, messages: [], stderr: "", usage: emptyUsage(), runId: 90 };
			} }, compileWorkflow({ nodes: [{ id: "gate", agent: "artisan", task: "Run gate", isolation: "shared" }] }, root, AGENTS));
			await until(() => handle.run.nodes[0]?.runId === 90);
			assert.deepEqual(modes, ["shared"]);
			assert.equal((await readRetainedWorkflows(harness.runtime, root))[0]?.state, "interrupted");
			await stopWorkflow(harness.runtime, handle.run);
			await handle.done;
		} finally { await rm(root, { recursive: true, force: true }); }
	});
});
