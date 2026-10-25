import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { SingleResult } from "../src/execution/spawn.ts";
import type { SubagentRuntime } from "../src/lifecycle/runtime.ts";
import { emptyUsage } from "../src/execution/rpc-control.ts";
import type { CompletionMessageItem } from "../src/lifecycle/completion.ts";
import { compileWorkflow, defaultPhaseId, renderNodeTask, WORKFLOW_NODE_LIMIT } from "../src/workflow/plan.ts";
import { discoverWorkflows, resolveWorkflowDefinition } from "../src/workflow/files.ts";
import { findOwnedPhases, startWorkflow, stopWorkflow, persistInterruptedWorkflows, readRetainedWorkflows } from "../src/workflow/engine.ts";
import type { WorkflowRun } from "../src/workflow/state.ts";
import { createRuntime } from "../src/lifecycle/runtime.ts";
import { registerWorkflowTool } from "../src/workflow/tool.ts";

const AGENTS = ["scout", "artisan"];

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
): DispatchHarness {
	const completions: CompletionMessageItem[] = [];
	let nextRunId = 1;
	let nextWorkflowId = 1;
	const runtime = {
		configPath,
		sessionActive: true,
		threads: new Map(),
		workflows: new Map(),
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
		void settle(agent, task, runId).then((settled) => runtime.registerRunResult(runId, settled));
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
		assert.deepEqual(workflow.nodes.map((node) => node.id), ["map", "fix"]);
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
		assert.equal(workflow.nodes.length, 2);
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

describe("workflow definition files", () => {
	it("discovers project definitions and resolves them by name", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-subagents-workflow-files-"));
		try {
			const dir = join(root, ".pi", "workflows");
			await mkdir(dir, { recursive: true });
			await writeFile(
				join(dir, "review.json"),
				JSON.stringify({
					name: "review",
					description: "Review the diff",
					nodes: [{ id: "map", agent: "scout", task: "Map the diff" }],
				}),
				"utf8",
			);
			await writeFile(
				join(dir, "survey.md"),
				["---", "name: survey", "description: Survey the repo", "---", "", "Prose first.", "", "```json", JSON.stringify([{ id: "map", agent: "scout", task: "Survey" }], null, 2), "```", ""].join("\n"),
				"utf8",
			);
			await writeFile(join(dir, "broken.json"), "{ not json", "utf8");
			const options = { scope: "project" as const, projectTrusted: true, builtinDir: join(root, "no-builtins") };
			const found = discoverWorkflows(root, options);
			assert.deepEqual(found.map((definition) => definition.name).sort(), ["review", "survey"]);
			const resolved = resolveWorkflowDefinition(root, {}, options);
			assert.match(resolved.error ?? "", /provide either/i);
			const byName = resolveWorkflowDefinition(root, { name: "survey" }, options);
			assert.equal(byName.definition?.source, "project");
			assert.equal(byName.definition?.plan.nodes.length, 1);
			const missing = resolveWorkflowDefinition(root, { name: "nope" }, options);
			assert.match(missing.error ?? "", /no workflow named/i);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("does not read project definitions without project trust", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-subagents-workflow-trust-"));
		try {
			const dir = join(root, ".pi", "workflows");
			await mkdir(dir, { recursive: true });
			await writeFile(join(dir, "review.json"), JSON.stringify({ nodes: [{ id: "map", agent: "scout", task: "Map" }] }), "utf8");
			const found = discoverWorkflows(root, { scope: "project", projectTrusted: false, builtinDir: join(root, "none") });
			assert.deepEqual(found, []);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
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
			assert.deepEqual(run.nodes.map((node) => node.state), ["completed", "completed"]);
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
			assert.deepEqual(states, { map: "completed", broken: "failed", gate: "blocked", docs: "completed" });
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
			assert.deepEqual(run.nodes.map((node) => node.state), ["stopped", "stopped"]);
			assert.equal(run.nodes.find((node) => node.id === "fix")?.runId, undefined);
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
			await Promise.resolve();
			await persistInterruptedWorkflows(harness.runtime);
			const retained = await readRetainedWorkflows(harness.runtime, root);
			assert.equal(retained.length, 1);
			assert.equal(retained[0]!.name, "held");
			assert.equal(retained[0]!.state, "interrupted");
			assert.equal(retained[0]!.nodes[0]!.runId, 99);
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
				setTimeout(() => runtime.registerRunResult(runId, result(agent, task, runId, "answer from " + agent)), 0);
				return { agent, task, exitCode: -1, messages: [], stderr: "", usage: emptyUsage(), runId };
			},
			finishRun: () => undefined,
			makeLiveHandler: () => () => undefined,
			makeDetails: () => () => ({ mode: "single" as const, results: [], background: true }),
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

	async function until(check: () => boolean, timeoutMs = 2_000): Promise<void> {
		const deadline = Date.now() + timeoutMs;
		while (!check()) {
			if (Date.now() > deadline) throw new Error("condition not reached");
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
	}

	it("registers as a model-only sequential tool and delivers one graph summary", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-subagents-workflow-tool-"));
		const harness = toolHarness(join(root, "pi-subagents.json"));
		try {
			assert.equal(harness.tool.exposure, "model-only");
			assert.equal(harness.tool.executionMode, "sequential");
			const response = (await execute(harness.tool, {
				name: "smoke",
				nodes: [
					{ id: "map", agent: "scout", task: "Map it" },
					{ id: "fix", agent: "artisan", task: "Fix it from {{map}}", dependsOn: ["map"] },
				],
			}, root)) as unknown as { content: Array<{ text: string }>; details: { workflow: { id: number } } };
			assert.match(response.content[0]!.text, /workflow #1 smoke started/);
			assert.match(response.content[0]!.text, /fix \(artisan\) · waits for map/);
			await until(() => harness.messages.length > 0);
			assert.equal(harness.messages.length, 1, "a graph reports once");
			assert.match(harness.messages[0]!.content, /workflow smoke completed/);
			assert.match(harness.started[1] ?? "", /answer from scout/, "the dependent receives the upstream answer");
		} finally {
			await harness.runtime.shutdown();
			await rm(root, { recursive: true, force: true });
		}
	});

	it("rejects an invalid graph before starting any node", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-subagents-workflow-reject-"));
		const harness = toolHarness(join(root, "pi-subagents.json"));
		try {
			await assert.rejects(
				execute(harness.tool, {
					nodes: [{ id: "map", agent: "artisan", task: "x", scope: { paths: ["src/a.ts"] } }, { id: "other", agent: "artisan", task: "y", scope: { paths: ["src/a.ts"] } }],
				}, root),
				/overlapping writer scope/i,
			);
			assert.deepEqual(harness.started, [], "no child is dispatched for a rejected graph");
		} finally {
			await harness.runtime.shutdown();
			await rm(root, { recursive: true, force: true });
		}
	});

	it("rejects the whole graph before dispatching any node when a phase is owned", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-subagents-workflow-owned-"));
		const harness = toolHarness(join(root, "pi-subagents.json"));
		try {
			(harness.runtime.threads as Map<number, never>).set(5, parkedThread(5, root, "smoke.probe"));
			await assert.rejects(
				execute(harness.tool, {
					name: "smoke",
					nodes: [{ id: "probe", agent: "scout", task: "Probe" }],
				}, root),
				/already owned by run #5[\s\S]*subagent_stop/,
			);
			assert.deepEqual(harness.started, [], "no child is dispatched when a phase is already owned");
			assert.equal(harness.runtime.workflows.size, 0, "no graph is left behind");
		} finally {
			await harness.runtime.shutdown();
			await rm(root, { recursive: true, force: true });
		}
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
