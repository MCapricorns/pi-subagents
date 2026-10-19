import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { MonitorStore, type RunView } from "../src/presentation/monitor.ts";
import { emptyUsage } from "../src/execution/rpc-control.ts";
import { formatActiveRunLines } from "../src/presentation/widget.ts";

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
