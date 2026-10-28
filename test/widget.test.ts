import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { MonitorStore, monitor, type RunView } from "../src/presentation/monitor.ts";
import { emptyUsage } from "../src/execution/run-control.ts";
import { visibleWidth, type Component, type TUI } from "@earendil-works/pi-tui";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { WorkflowRun } from "../src/workflow/state.ts";
import { formatActiveRunLines, formatSubagentWidgetLines, installActiveRunsWidget } from "../src/presentation/widget.ts";

function graphFixture(count = 4): WorkflowRun {
	return {
		id: 3, name: "auth-fix", slug: "auth-fix", cwd: process.cwd(), state: "running", startedAt: 1000,
		controller: new AbortController(), nodes: Array.from({ length: count }, (_, index) => ({
			id: "step" + index, agent: "artisan", task: "Task " + index, phaseId: "phase" + index,
			cwd: process.cwd(), ancestors: [], dependsOn: index ? ["step" + (index - 1)] : [], state: "pending",
		})),
	};
}

const plainTheme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as unknown as Theme;

describe("formatActiveRunLines", () => {
	it("shows the current thinking strength for an active run", () => {
		const now = 10_000;
		const run: RunView = {
			id: 7,
			agent: "artisan",
			task: "Implement the config migration",
			model: "openai/gpt-5.4",
			thinking: "high",
			status: "running",
			usage: emptyUsage(),
			startedAt: now - 1_000,
			activeSince: now - 1_000,
			elapsedMs: 0,
		};

		const lines = formatActiveRunLines([run], plainTheme, 160, now);
		assert.equal(lines.length, 2);
		assert.match(lines[0]!, /#7.*artisan.*running/u);
		assert.match(lines[1]!, /openai\/gpt-5.4.*think:high/u);
	});
});

describe("workflow widget", () => {
	it("shows graph progress, waiting nodes, and actual queue reasons without duplicating runs", () => {
		const graph = graphFixture();
		graph.nodes[0]!.state = "completed";
		graph.nodes[1]!.state = "running";
		graph.nodes[1]!.runId = 7;
		const live: RunView = { id: 7, agent: "artisan", task: "Apply fix", status: "queued", waitReason: "starting", usage: emptyUsage(), elapsedMs: 0, workflow: { workflowId: 3, name: "auth-fix", nodeId: "step1" } };
		const lines = formatSubagentWidgetLines([live], [graph], plainTheme, 160, 10000);
		assert.match(lines[0]!, /Subagents.*1 queued.*1 workflow/u);
		assert.match(lines[1]!, /Workflow #3 · auth-fix.*1\/4 work passed/u);
		assert.match(lines[0]!, /2 waiting/u);
		assert.match(lines.join("\n"), /step1.*#7.*starting/);
		assert.match(lines.join("\n"), /step2.*waits for step1/);
		assert.equal(lines.filter((line) => line.includes("#7")).length, 1);
	});

	it("keeps failures and blocked dependencies visible and bounds narrow or wide graphs", () => {
		const graph = graphFixture(24);
		graph.name = "迁移 workflow";
		graph.nodes[0]!.state = "failed";
		graph.nodes[0]!.error = "typecheck failed";
		graph.nodes[1]!.state = "blocked";
		graph.nodes[1]!.error = "dependency step0 failed";
		for (const width of [0, 1, 20, 45, 160]) {
			const lines = formatSubagentWidgetLines([], [graph], plainTheme, width);
			assert.ok(lines.length <= 10);
			assert.ok(lines.every((line) => visibleWidth(line) <= width));
		}
		const text = formatSubagentWidgetLines([], [graph], plainTheme, 160).join("\n");
		assert.match(text, /step0.*failed\n.*typecheck failed/u);
		assert.match(text, /step1.*blocked\n.*dependency step0 failed/u);
		assert.match(text, /… \+19 tasks/u);
	});

	it("notifies on graph-only transitions and sweeps settled graphs at the next dispatch", () => {
		const store = new MonitorStore();
		const graph = graphFixture();
		let changes = 0;
		store.subscribe(() => changes++);
		store.updateWorkflow(graph);
		assert.equal(changes, 1);
		store.beginTurn();
		assert.equal(store.getWorkflows().length, 1);
		const beforeCompletion = changes;
		graph.state = "completed";
		for (const node of graph.nodes) node.state = "completed";
		store.updateWorkflow(graph);
		assert.equal(changes, beforeCompletion + 1);
		assert.equal(store.getWorkflows().length, 1, "completion remains available in monitor state");
		assert.deepEqual(formatSubagentWidgetLines(store.getRuns(), store.getWorkflows(), plainTheme, 80), []);
		graph.state = "failed";
		store.updateWorkflow(graph);
		assert.equal(store.getWorkflows()[0]!.state, "failed");
		store.beginTurn();
		assert.equal(store.getWorkflows().length, 0);
	});
});

describe("widget layout priorities", () => {
	function run(id: number, status: RunView["status"] = "running"): RunView {
		return { id, agent: "artisan", task: "Implement src/feature" + id + ".ts", status,
			model: "test/reasoning", thinking: "high", activity: "read src/feature.ts",
			usage: emptyUsage(), elapsedMs: 0, activeSince: 1_000, startedAt: 1_000 };
	}

	it("keeps sibling identities before allocating detail lines", () => {
		const lines = formatSubagentWidgetLines(Array.from({ length: 8 }, (_, i) => run(i + 1)), [], plainTheme, 100, 10_000);
		assert.equal(lines.length, 10);
		for (let id = 1; id <= 8; id++) assert.match(lines.join("\n"), new RegExp("#" + id + " "));
		assert.match(lines[0]!, /Subagents.*8 running/u);
	});

	it("shows a late failed task ahead of a full running batch", () => {
		const runs = [...Array.from({ length: 14 }, (_, i) => run(i + 1)), run(99, "failed")];
		const lines = formatSubagentWidgetLines(runs, [], plainTheme, 80, 10_000);
		assert.match(lines[1]!, /#99.*failed/u);
		assert.match(lines.at(-1)!, /tasks/u);
		assert.ok(lines.length <= 10);
	});

	it("keeps a failure from a later workflow visible and shares space between groups", () => {
		const first = graphFixture(20);
		const failed = graphFixture(20);
		failed.id = 4;
		failed.name = "later-failure";
		failed.nodes[19]!.state = "failed";
		failed.nodes[19]!.error = "build failed";
		const lines = formatSubagentWidgetLines([], [first, failed], plainTheme, 120, 10_000);
		assert.match(lines[1]!, /Workflow #4/u);
		assert.match(lines[2]!, /step19.*failed/u);
		assert.match(lines[3]!, /build failed/u);
		assert.match(lines.join("\n"), /Workflow #3/u);
		assert.ok(lines.length <= 10);
	});

	it("reserves elapsed time and truthful queue state in a narrow row", () => {
		const queued = { ...run(7, "queued"), waitReason: "starting" as const };
		const lines = formatActiveRunLines([queued], plainTheme, 42, 10_000);
		assert.match(lines[0]!, /starting.*9s$/u);
		assert.ok(lines.every((line) => visibleWidth(line) <= 42));
		const busy = { ...run(8), activity: "read src/configuration/config.ts" };
		const narrow = formatActiveRunLines([busy], plainTheme, 48, 10_000);
		assert.match(narrow[1]!, /read src\/configuration\/config.ts/u);
		assert.doesNotMatch(narrow[1]!, /test\//u, "omit metadata rather than showing half a model id");
	});

	it("fits ANSI-styled CJK identities and causes at every width without dropping the line bound", () => {
		const graph = graphFixture(15);
		graph.name = "\x1b[31m认证迁移 · auth-fix\x1b[0m";
		graph.nodes[14]!.state = "failed";
		graph.nodes[14]!.error = "\x1b[31m类型检查失败：缺少必需的 export\x1b[0m";
		const ansiTheme = { fg: (_color: string, value: string) => "\x1b[38;2;220;220;220m" + value + "\x1b[39m",
			bold: (value: string) => "\x1b[1m" + value + "\x1b[22m" } as unknown as Theme;
		for (const width of [0, 1, 2, 20, 40, 80, 120]) {
			const lines = formatSubagentWidgetLines([], [graph], ansiTheme, width);
			assert.ok(lines.length <= 10);
			assert.ok(lines.every((line) => visibleWidth(line) <= width));
		}
	});

	it("hides a stopped graph and its failed node rows", () => {
		const graph = graphFixture();
		graph.state = "stopped";
		graph.nodes[0]!.state = "failed";
		graph.nodes[0]!.runId = 7;
		const run: RunView = { id: 7, agent: "artisan", task: "Stopped", status: "failed", usage: emptyUsage(), elapsedMs: 0, workflow: { workflowId: 3, name: "auth-fix", nodeId: "step0" } };
		assert.deepEqual(formatSubagentWidgetLines([run], [graph], plainTheme, 80), []);
	});

	it("hides completed graphs and their retained child rows", () => {
		const graph = graphFixture(20);
		graph.state = "completed";
		for (const node of graph.nodes) node.state = "completed";
		const child = { ...run(7), workflow: { workflowId: graph.id, name: graph.name, nodeId: "step0" } };
		assert.deepEqual(formatSubagentWidgetLines([child], [graph], plainTheme, 80, 10_000), []);
	});

	it("removes completed summaries while keeping other active work and failures", () => {
		const completed = graphFixture(1);
		completed.state = "completed";
		completed.nodes[0]!.state = "completed";
		const active = graphFixture(1);
		active.id = 4;
		const failed = graphFixture(2);
		failed.id = 5;
		failed.state = "failed";
		failed.nodes[0]!.state = "failed";
		failed.nodes[0]!.error = "build failed";
		failed.nodes[1]!.state = "blocked";
		failed.nodes[1]!.error = "dependency step0 failed";
		const text = formatSubagentWidgetLines([run(99)], [completed, active, failed], plainTheme, 120, 10_000).join("\n");
		assert.doesNotMatch(text, /Workflow #3/u);
		assert.match(text, /2 workflows/u);
		assert.match(text, /Workflow #4/u);
		assert.match(text, /Workflow #5/u);
		assert.match(text, /step0.*failed\n.*build failed/u);
		assert.match(text, /step1.*blocked/u);
		assert.match(text, /#99.*running/u);
	});
});

describe("acceptance presentation", () => {
	function acceptance(graph: WorkflowRun, state: WorkflowRun["nodes"][number]["state"]) {
		const node = { ...graph.nodes[0]!, id: "acceptance", kind: "acceptance" as const, agent: "sentinel",
			state, dependsOn: graph.nodes.map((work) => work.id), runId: undefined as number | undefined,
			startedAt: undefined as number | undefined, error: undefined as string | undefined };
		graph.nodes.push(node);
		return node;
	}

	it("counts work separately and waits for settlement rather than dependency success", () => {
		const graph = graphFixture(2);
		const reviewer = acceptance(graph, "pending");
		graph.nodes[0]!.state = "completed";
		graph.nodes[1]!.state = "running";
		let text = formatSubagentWidgetLines([], [graph], plainTheme, 80, 10_000).join("\n");
		assert.match(text, /1\/2 work passed/u);
		assert.match(text, /Acceptance required · pending\n.*after 1 work node settles/u);
		graph.nodes[1]!.state = "failed";
		graph.nodes[1]!.error = "build failed";
		text = formatSubagentWidgetLines([], [graph], plainTheme, 80, 10_000).join("\n");
		assert.match(text, /Acceptance required · pending\n.*ready · all work settled/u);
		assert.doesNotMatch(text, /waits for step1/u);
		assert.equal(reviewer.state, "pending", "rendering must not advance acceptance");
	});

	it("shows the acceptance officer once and never counts it as ordinary live or failed work", () => {
		const graph = graphFixture(2);
		for (const work of graph.nodes) work.state = "completed";
		const reviewer = acceptance(graph, "running");
		reviewer.runId = 12;
		reviewer.startedAt = 1000;
		const live: RunView = { id: 12, agent: "sentinel", task: "Required acceptance", status: "running", usage: emptyUsage(), elapsedMs: 0,
			activeSince: 1000, startedAt: 1000, workflow: { workflowId: graph.id, name: graph.name, nodeId: reviewer.id } };
		let lines = formatSubagentWidgetLines([live], [graph], plainTheme, 80, 10_000);
		assert.doesNotMatch(lines[0]!, /running/u);
		assert.match(lines.join("\n"), /2\/2 work passed/u);
		assert.match(lines.join("\n"), /Acceptance required · running/u);
		assert.equal(lines.filter((line) => line.includes("#12")).length, 1);
		reviewer.state = "failed";
		reviewer.error = "No explicit PASS: regression check failed";
		graph.state = "failed";
		lines = formatSubagentWidgetLines([live], [graph], plainTheme, 40, 10_000);
		assert.doesNotMatch(lines[0]!, /1 failed/u);
		assert.equal(lines.filter((line) => line.includes("Acceptance required")).length, 1);
		assert.match(lines.join("\n"), /Acceptance required · FAIL.*\n.*No explicit PASS/u);
	});

	it("retains PASS beside failed work and hides the panel only when the whole graph completes", () => {
		const graph = graphFixture(2);
		graph.nodes[0]!.state = "failed";
		graph.nodes[0]!.error = "build failed";
		graph.nodes[1]!.state = "blocked";
		graph.nodes[1]!.error = "dependency step0 failed";
		acceptance(graph, "completed");
		graph.state = "failed";
		const lines = formatSubagentWidgetLines([], [graph], plainTheme, 80);
		assert.match(lines[0]!, /1 failed · 1 blocked/u);
		assert.match(lines.join("\n"), /Acceptance required · PASS/u);
		graph.state = "completed";
		assert.deepEqual(formatSubagentWidgetLines([], [graph], plainTheme, 80), []);
	});

	it("budgets required acceptance and failure causes before overflow, excluding the officer from hidden tasks", () => {
		const graph = graphFixture(30);
		graph.nodes[0]!.state = "failed";
		graph.nodes[0]!.error = "typecheck failed";
		graph.nodes[1]!.state = "blocked";
		graph.nodes[1]!.error = "dependency step0 failed";
		graph.nodes[2]!.state = "running";
		acceptance(graph, "pending");
		for (const width of [40, 80, 120]) {
			const lines = formatSubagentWidgetLines([], [graph], plainTheme, width);
			assert.equal(lines.length, 10);
			assert.match(lines.join("\n"), /typecheck failed/u);
			assert.match(lines.join("\n"), /dependency step0 failed/u);
			assert.match(lines.join("\n"), /step2/u);
			assert.match(lines.join("\n"), /Acceptance required · pending/u);
			assert.match(lines.at(-1)!, /\+27 tasks/u);
			assert.ok(lines.every((line) => visibleWidth(line) <= width));
		}
	});

	it("reports hidden empty workflows without inventing zero hidden tasks", () => {
		const graphs = Array.from({ length: 20 }, (_, index) => ({ ...graphFixture(0), id: index + 1 }));
		const lines = formatSubagentWidgetLines([], graphs, plainTheme, 80);
		assert.equal(lines.length, 10);
		assert.match(lines.at(-1)!, /12 workflows hidden/u);
		assert.doesNotMatch(lines.at(-1)!, /tasks/u);
	});
});

describe("widget clocks", () => {
	it("ticks only changing clocks and cleans up its timer and subscription", (t) => {
		monitor.clear();
		t.mock.timers.enable({ apis: ["setInterval"] });
		let renders = 0;
		let widget: Component & { dispose(): void };
		const context = { mode: "tui", ui: { setWidget(_id: string, factory: (tui: TUI, theme: Theme) => typeof widget) {
			widget = factory({ requestRender() { renders++; } } as TUI, plainTheme);
		} } } as unknown as ExtensionContext;
		installActiveRunsWidget(context);
		t.after(() => { widget.dispose(); monitor.clear(); });
		const graph = graphFixture(1);
		monitor.updateWorkflow(graph);
		let before = renders;
		t.mock.timers.tick(3000);
		assert.equal(renders, before, "a pending graph has no changing elapsed time");
		graph.nodes[0]!.state = "running";
		graph.nodes[0]!.startedAt = 1000;
		monitor.updateWorkflow(graph);
		before = renders;
		t.mock.timers.tick(2000);
		assert.equal(renders, before + 2, "orphan live nodes still have a clock");
		graph.nodes[0]!.state = "failed";
		monitor.updateWorkflow(graph);
		before = renders;
		t.mock.timers.tick(3000);
		assert.equal(renders, before, "a failure without endedAt must not keep a clock alive");
		graph.state = "completed";
		monitor.updateWorkflow(graph);
		const hidden = monitor.addRun("artisan", "Retained child", undefined, undefined, {
			workflow: { workflowId: graph.id, name: graph.name, nodeId: "step0" },
		});
		monitor.setStatus(hidden, "running");
		before = renders;
		t.mock.timers.tick(2000);
		assert.equal(renders, before, "hidden children of a completed graph must not keep the widget ticking");
		monitor.removeRun(hidden);
		const id = monitor.addRun("artisan", "Start worker");
		before = renders;
		t.mock.timers.tick(2000);
		assert.equal(renders, before, "queued workers do not tick");
		monitor.setStatus(id, "running");
		before = renders;
		t.mock.timers.tick(1000);
		assert.equal(renders, before + 1);
		monitor.setStatus(id, "parked");
		before = renders;
		t.mock.timers.tick(2000);
		assert.equal(renders, before);
		monitor.setStatus(id, "running");
		widget!.dispose();
		before = renders;
		monitor.setActivity(id, "thinking");
		t.mock.timers.tick(2000);
		assert.equal(renders, before, "disposing removes both the clock and monitor subscription");
	});
});

describe("MonitorStore activity notifications", () => {
	it("notifies once for a run of identical streamed activity deltas", () => {
		const store = new MonitorStore();
		const id = store.addRun("scout", "Map src/index.ts");
		let notifications = 0;
		store.subscribe(() => notifications++);
		for (let index = 0; index < 50; index++) store.setActivity(id, "thinking");
		assert.equal(notifications, 1);
		store.setActivity(id, "responding");
		store.setActivity(id, "thinking");
		assert.equal(notifications, 3);
		assert.deepEqual(store.findRun(id)?.recentActivity, ["thinking", "responding", "thinking"]);
	});
});
