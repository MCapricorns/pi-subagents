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
	it("renders only genuinely active runs", () => {
		const store = new MonitorStore();
		const running = store.addRun("worker", "Fix src/index.ts");
		store.setStatus(running, "running");
		store.setActivity(running, "edit src/index.ts");
		const done = store.addRun("reviewer", "Review src/index.ts");
		store.setStatus(done, "done");
		const parked = store.addRun("worker", "Park work");
		store.setStatus(parked, "parked");

		const lines = formatActiveRunLines(store.getRuns(), theme, 120);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain(`#${running} worker`);
		expect(lines[0]).toContain("edit src/index.ts");
		expect(lines[0]).not.toContain(`#${done}`);
		expect(lines[0]).not.toContain(`#${parked}`);
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

		const [line] = formatActiveRunLines(store.getRuns(), theme, 120, 62_000);
		expect(line).toContain("auto-fix chain running");
		expect(line).toContain("1m01s");
		expect(line).not.toContain("done");
	});

	it("keeps every rendered line within the terminal width", () => {
		const store = new MonitorStore();
		const id = store.addRun("worker", `Change ${"deep/path/".repeat(12)}file.ts`, undefined, undefined, {
			relationLabel: "fix round 12",
		});
		store.setStatus(id, "running");
		store.setActivity(id, `bash ${"very-long-command ".repeat(12)}`);
		store.findRun(id)!.startedAt = 1_000;

		const lines = formatActiveRunLines(store.getRuns(), theme, 36, 62_000);
		expect(lines).toHaveLength(1);
		expect(visibleWidth(lines[0])).toBeLessThanOrEqual(36);
		expect(lines[0]).toContain("1m01s");
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
