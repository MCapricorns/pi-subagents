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
		assert.equal(lines.length, 1);
		assert.match(lines[0], /think:high/u);
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
		assert.match(lines[0]!, /workflow #3 auth-fix.*1\/4 completed.*2 waiting/);
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
		assert.match(text, /more|rows/);
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
