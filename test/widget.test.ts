import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { MonitorStore, type RunView } from "../src/presentation/monitor.ts";
import { emptyUsage } from "../src/execution/run-control.ts";
import { visibleWidth } from "@earendil-works/pi-tui";
import { compileWorkflow, defaultPhaseId } from "../src/workflow/plan.ts";
import type { WorkflowRun } from "../src/workflow/state.ts";
import { formatActiveRunLines, formatSubagentWidgetLines } from "../src/presentation/widget.ts";

function graphFixture(count = 4): WorkflowRun {
	const plan = compileWorkflow({ name: "auth-fix", nodes: Array.from({ length: count }, (_,index) => ({ id: "step" + index, agent: "artisan", task: "Task " + index, ...(index ? { dependsOn: ["step" + (index - 1)] } : {}) })) }, process.cwd(), ["artisan"]);
	return { id: 3, name: plan.name, slug: plan.slug, cwd: plan.cwd, state: "running", startedAt: 1000, controller: new AbortController(), nodes: plan.nodes.map((node) => ({ ...node, phaseId: defaultPhaseId(plan, node), state: "pending" })) };
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
		const live: RunView = { id: 7, agent: "artisan", task: "Apply fix", status: "queued", waitReason: "repository-lane", usage: emptyUsage(), elapsedMs: 0, workflow: { workflowId: 3, name: "auth-fix", nodeId: "step1" } };
		const lines = formatSubagentWidgetLines([live], [graph], plainTheme, 160, 10000);
		assert.match(lines[0]!, /Subagents.*1 queued.*1 workflow/u);
		assert.match(lines[1]!, /Workflow #3 · auth-fix.*1\/4 completed.*2 waiting/u);
		assert.match(lines.join("\n"), /step1.*#7.*repo lane/);
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
		assert.match(text, /step0.*failed: typecheck failed/);
		assert.match(text, /step1.*blocked: dependency step0 failed/);
		assert.match(text, /… \+17 tasks/u);
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
		assert.match(lines[2]!, /step19.*failed: build failed/u);
		assert.match(lines.join("\n"), /Workflow #3/u);
		assert.ok(lines.length <= 10);
	});

	it("reserves elapsed time and truthful queue state in a narrow row", () => {
		const queued = { ...run(7, "queued"), waitReason: "repository-lane" as const };
		const lines = formatActiveRunLines([queued], plainTheme, 42, 10_000);
		assert.match(lines[0]!, /repo lane.*9s$/u);
		assert.ok(lines.every((line) => visibleWidth(line) <= 42));
		const busy = { ...run(8), activity: "read src/configuration/config.ts" };
		const narrow = formatActiveRunLines([busy], plainTheme, 48, 10_000);
		assert.match(narrow[1]!, /read src\/configuration\/config.ts/u);
		assert.doesNotMatch(narrow[1]!, /test\//u, "omit metadata rather than showing half a model id");
	});

	it("summarizes completed graphs without flooding the board with finished nodes", () => {
		const graph = graphFixture(20);
		graph.state = "completed";
		for (const node of graph.nodes) node.state = "completed";
		const lines = formatSubagentWidgetLines([], [graph], plainTheme, 80, 10_000);
		assert.equal(lines.length, 2);
		assert.match(lines[1]!, /20\/20 completed/u);
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
