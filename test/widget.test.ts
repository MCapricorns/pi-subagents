import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth, type Component, type TUI } from "@earendil-works/pi-tui";
import { emptyUsage } from "../src/execution/run-control.ts";
import { MonitorStore, monitor, type RunView } from "../src/presentation/monitor.ts";
import { formatSubagentWidgetLines, installActiveRunsWidget } from "../src/presentation/widget.ts";

const plainTheme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as unknown as Theme;

describe("widget run rows", () => {
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

		const lines = formatSubagentWidgetLines([run], plainTheme, 160, now);
		assert.equal(lines.length, 3);
		assert.match(lines[0]!, /Subagents.*1 running/u);
		assert.match(lines[1]!, /#7.*artisan.*running/u);
		assert.match(lines[2]!, /openai\/gpt-5.4.*think:high/u);
	});
});

describe("widget layout priorities", () => {
	function run(id: number, status: RunView["status"] = "running"): RunView {
		return { id, agent: "artisan", task: "Implement src/feature" + id + ".ts", status,
			model: "test/reasoning", thinking: "high", activity: "read src/feature.ts",
			usage: emptyUsage(), elapsedMs: 0, activeSince: 1_000, startedAt: 1_000 };
	}

	it("keeps sibling identities before allocating detail lines", () => {
		const lines = formatSubagentWidgetLines(Array.from({ length: 8 }, (_, i) => run(i + 1)), plainTheme, 100, 10_000);
		assert.equal(lines.length, 10);
		for (let id = 1; id <= 8; id++) assert.match(lines.join("\n"), new RegExp("#" + id + " "));
		assert.match(lines[0]!, /Subagents.*8 running/u);
	});

	it("shows a late failed task ahead of a full running batch", () => {
		const runs = [...Array.from({ length: 14 }, (_, i) => run(i + 1)), run(99, "failed")];
		const lines = formatSubagentWidgetLines(runs, plainTheme, 80, 10_000);
		assert.match(lines[1]!, /#99.*failed/u);
		assert.match(lines.at(-1)!, /tasks/u);
		assert.ok(lines.length <= 10);
	});

	it("reserves elapsed time and truthful queue state in a narrow row", () => {
		const lines = formatSubagentWidgetLines([run(7, "queued")], plainTheme, 42, 10_000);
		assert.match(lines[0]!, /1 starting/u);
		assert.match(lines[1]!, /starting.*9s$/u);
		assert.ok(lines.every((line) => visibleWidth(line) <= 42));
		const busy = { ...run(8), activity: "read src/configuration/config.ts" };
		const narrow = formatSubagentWidgetLines([busy], plainTheme, 48, 10_000);
		assert.match(narrow[2]!, /read src\/configuration\/config.ts/u);
		assert.doesNotMatch(narrow[2]!, /test\//u, "omit metadata rather than showing half a model id");
		const applying = { ...run(9), integrationStatus: "finalizing" as const };
		assert.match(formatSubagentWidgetLines([applying], plainTheme, 42, 10_000)[1]!, /applying/u);
	});

	it("fits ANSI-styled CJK identities and causes at every width without dropping the line bound", () => {
		const failedRun: RunView = {
			...run(15, "failed"),
			task: "\x1b[31m认证迁移 · auth-fix\x1b[0m",
			activity: "\x1b[31m类型检查失败：缺少必需的 export\x1b[0m",
		};
		const runs = [...Array.from({ length: 14 }, (_, i) => run(i + 1)), failedRun];
		const ansiTheme = { fg: (_color: string, value: string) => "\x1b[38;2;220;220;220m" + value + "\x1b[39m",
			bold: (value: string) => "\x1b[1m" + value + "\x1b[22m" } as unknown as Theme;
		for (const width of [0, 1, 2, 20, 40, 80, 120]) {
			const lines = formatSubagentWidgetLines(runs, ansiTheme, width);
			assert.ok(lines.length <= 10);
			assert.ok(lines.every((line) => visibleWidth(line) <= width));
		}
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
		const id = monitor.addRun("artisan", "Start worker");
		let before = renders;
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
