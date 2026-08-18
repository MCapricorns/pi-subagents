import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MonitorStore, monitor } from "../src/monitor.ts";
import {
	formatActiveRunLines,
	installActiveRunsWidget,
	SUBAGENTS_WIDGET_ID,
} from "../src/widget.ts";

const theme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as Theme;

afterEach(() => {
	vi.useRealTimers();
	monitor.clear();
});

describe("formatActiveRunLines", () => {
	it("renders one primary line plus optional activity only for active runs", () => {
		const store = new MonitorStore();
		const running = store.addRun("worker", "Fix src/index.ts", "anthropic/claude-sonnet-4-5", "high");
		store.setModel(running, "openai/gpt-5-mini", "anthropic/claude-sonnet-4-5");
		store.setStatus(running, "running");
		store.setActivity(running, "edit src/index.ts");
		const done = store.addRun("reviewer", "Review src/index.ts");
		store.setStatus(done, "done");
		const parked = store.addRun("worker", "Park work");
		store.setStatus(parked, "parked");

		const lines = formatActiveRunLines(store.getRuns(), theme, 120);
		expect(lines).toHaveLength(2);
		expect(lines[0]).toContain(`#${running} worker`);
		expect(lines[0]).toContain("Fix src/index.ts");
		expect(lines[0]).toContain("gpt-5-mini/high");
		expect(lines[0]).not.toContain("openai/");
		expect(lines[0]).not.toContain("edit src/index.ts");
		expect(lines[1]).toBe("  edit src/index.ts");
		expect(lines.join("\n")).not.toContain(`#${done}`);
		expect(lines.join("\n")).not.toContain(`#${parked}`);
	});

	it("omits a blank activity line and handles missing model/thinking", () => {
		const store = new MonitorStore();
		const id = store.addRun("explore", "Map the cleaner workflow");

		const lines = formatActiveRunLines(store.getRuns(), theme, 120);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain(`#${id} explore · Map the cleaner workflow`);
		expect(lines[0]).not.toContain("undefined");
	});

	it("omits activity when indentation leaves no usable width", () => {
		const store = new MonitorStore();
		const id = store.addRun("worker", "Fix the narrow widget");
		store.setActivity(id, "edit src/widget.ts");

		for (const width of [1, 2]) {
			const lines = formatActiveRunLines(store.getRuns(), theme, width);
			expect(lines).toHaveLength(1);
			expect(lines[0].trim()).not.toBe("");
			expect(visibleWidth(lines[0])).toBeLessThanOrEqual(width);
		}
	});

	it("keeps adjacent active groups compact with no blank rows", () => {
		const store = new MonitorStore();
		const first = store.addRun("explore", "Map config");
		const second = store.addRun("reviewer", "Review config");

		const lines = formatActiveRunLines(store.getRuns(), theme, 80);
		expect(lines).toHaveLength(2);
		expect(lines[0]).toContain(`#${first} explore`);
		expect(lines[1]).toContain(`#${second} reviewer`);
		expect(lines.every((line) => line.length > 0)).toBe(true);
	});

	it("shows an auto-fix parent as running with live elapsed after its review settles", () => {
		const store = new MonitorStore();
		const id = store.addRun("reviewer", "Review the change");
		store.setStatus(id, "running");
		const run = store.findRun(id)!;
		run.startedAt = 1_000;
		store.setStatus(id, "done");
		expect(run.endedAt).toBeDefined();

		// Auto-fix takes ownership of the same logical run.
		store.setStatus(id, "running");
		store.setActivity(id, "auto-fix chain running");
		expect(run.endedAt).toBeUndefined();

		const [primary, activity] = formatActiveRunLines(store.getRuns(), theme, 120, 62_000);
		expect(primary).toContain("Review the change");
		expect(primary).toContain("1m01s");
		expect(activity).toBe("  auto-fix chain running");
		expect(primary).not.toContain("done");
	});

	it("keeps model/thinking and a meaningful activity-path tail within the width", () => {
		const store = new MonitorStore();
		const id = store.addRun(
			"worker",
			`Change ${"deep/path/".repeat(12)}file.ts`,
			"anthropic/claude-sonnet-4-5",
			"high",
		);
		store.setStatus(id, "running");
		store.setActivity(id, `read ${"very/long/path/".repeat(8)}meaningful-file.ts`);
		store.findRun(id)!.startedAt = 1_000;

		const lines = formatActiveRunLines(store.getRuns(), theme, 52, 62_000);
		expect(lines).toHaveLength(2);
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(52);
		expect(lines[0]).toContain("/high");
		expect(lines[0]).toContain("1m01s");
		expect(lines[1]).toContain("meaningful-file.ts");
	});

	it("drops the task before model/thinking on a narrow primary line", () => {
		const store = new MonitorStore();
		const id = store.addRun(
			"worker",
			"Implement a deliberately long cleanup task summary",
			"anthropic/claude-sonnet-4-5",
			"high",
		);
		store.setStatus(id, "running");
		store.findRun(id)!.startedAt = 1_000;

		const [line] = formatActiveRunLines(store.getRuns(), theme, 34, 62_000);
		expect(visibleWidth(line)).toBeLessThanOrEqual(34);
		expect(line).toContain("/high");
		expect(line).toContain("1m01s");
		expect(line).not.toContain("Implement");
	});
});

describe("installActiveRunsWidget", () => {
	it("ticks only while a started run is active and disposes cleanly", () => {
		vi.useFakeTimers();
		const setWidget = vi.fn();
		installActiveRunsWidget({ mode: "tui", ui: { setWidget } } as any);
		expect(setWidget).toHaveBeenCalledWith(
			SUBAGENTS_WIDGET_ID,
			expect.any(Function),
			{ placement: "aboveEditor" },
		);

		const factory = setWidget.mock.calls[0][1];
		const requestRender = vi.fn();
		const component = factory({ requestRender }, theme);
		expect(vi.getTimerCount()).toBe(0);

		const id = monitor.addRun("reviewer", "Review the change");
		expect(vi.getTimerCount()).toBe(0); // queued rows have no elapsed clock yet
		monitor.setStatus(id, "running");
		expect(vi.getTimerCount()).toBe(1);
		vi.advanceTimersByTime(1_000);
		expect(requestRender).toHaveBeenCalled();

		monitor.setStatus(id, "done");
		expect(vi.getTimerCount()).toBe(0);
		expect(component.render(80)).toEqual([]);
		component.dispose();
		expect(vi.getTimerCount()).toBe(0);
	});
});
