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
	vi.restoreAllMocks();
	monitor.clear();
});

describe("formatActiveRunLines", () => {
	it("renders a running run with provider model, token flow, cost, and seconds-precision elapsed", () => {
		const store = new MonitorStore();
		const running = store.addRun("executor", "Fix src/index.ts", "anthropic/claude-sonnet-4-5", "high");
		store.setModel(running, "openai/gpt-5-mini", "anthropic/claude-sonnet-4-5");
		store.setStatus(running, "running");
		store.setActivity(running, "edit src/index.ts");
		store.setUsage(running, { input: 1_200, output: 3400, cacheRead: 91_000, cacheWrite: 1_050, cost: 0.05, contextTokens: 0, turns: 3 });
		const run = store.findRun(running)!;
		run.startedAt = 3_600_000;
		run.activeSince = 3_600_000;
		const done = store.addRun("explorer", "Map src/index.ts");
		store.setStatus(done, "done");
		const parked = store.addRun("executor", "Park work");
		store.setStatus(parked, "parked");

		const lines = formatActiveRunLines(store.getRuns(), theme, 120, 3_600_000 + 3_725_000);
		// Line 1 is what the run is; line 2 is what it is doing right now.
		expect(lines).toHaveLength(2);
		expect(lines[0]).toContain(`● #${running} executor  src/index.ts`);
		expect(lines[0]).not.toContain("— edit src/index.ts");
		// Full provider/model ref — which provider served the run is exactly
		// what a multi-provider session needs to see; the thinking level is
		// not part of the identity line.
		expect(lines[0]).toContain("openai/gpt-5-mini");
		expect(lines[0]).not.toContain("/high");
		expect(lines[0]).toContain("↑1.2k ↓3.4k R91.0k W1.1k $0.0500");
		// Elapsed carries seconds even at hour magnitude.
		expect(lines[0].endsWith("1h02m05s")).toBe(true);
		expect(lines[1]).toContain("↳ edit src/index.ts");
		// The activity line hangs under the label column of line 1.
		expect(lines[1].indexOf("↳")).toBe(lines[0].indexOf("src/index.ts"));
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(120);
		expect(lines[0]).not.toContain(`#${done}`);
		expect(lines[0]).not.toContain(`#${parked}`);
	});

	it("labels queued rows with what they actually wait for in the telemetry column", () => {
		const store = new MonitorStore();
		const slot = store.addRun("explorer", "Map the repository lane");
		const lane = store.addRun("executor", "Fix src/cache.ts shared");
		store.setWaitReason(lane, "repository-lane");
		const starting = store.addRun("executor", "Spawn immediately", undefined, undefined, { waitReason: "starting" });

		const lines = formatActiveRunLines(store.getRuns(), theme, 120);
		expect(lines).toHaveLength(3);
		// The agent column is padded to the widest name so labels align.
		expect(lines[0]).toContain(`○ #${slot} explorer  Map the repository lane`);
		expect(lines[0].endsWith("queued")).toBe(true);
		expect(lines[1]).toContain(`○ #${lane} executor  src/cache.ts`);
		expect(lines[1].endsWith("repo lane")).toBe(true);
		expect(lines[2]).toContain(`○ #${starting} executor  Spawn immediately`);
		expect(lines[2].endsWith("starting")).toBe(true);
		for (const line of lines) expect(line).not.toContain("undefined");
	});

	it("omits the model on queued rows because the route re-resolves at start", () => {
		const store = new MonitorStore();
		store.addRun("executor", "Queued work", "anthropic/claude-sonnet-4-5", "high");

		const lines = formatActiveRunLines(store.getRuns(), theme, 120);
		expect(lines).toHaveLength(1);
		expect(lines[0]).not.toContain("sonnet");
		expect(lines[0]).not.toContain("/high");
	});

	it("stays within tiny widths without emitting blank lines", () => {
		const store = new MonitorStore();
		const id = store.addRun("executor", "Fix the narrow widget");
		store.setActivity(id, "edit src/widget.ts");

		for (const width of [1, 2]) {
			const lines = formatActiveRunLines(store.getRuns(), theme, width);
			expect(lines).toHaveLength(1);
			expect(lines[0].trim()).not.toBe("");
			expect(visibleWidth(lines[0])).toBeLessThanOrEqual(width);
		}
	});

	it("caps output at the host widget budget with an overflow marker counting hidden runs", () => {
		const store = new MonitorStore();
		for (let index = 0; index < 12; index++) {
			const id = store.addRun("explorer", `Map src/module-${index}.ts`);
			store.setStatus(id, "running");
			store.setActivity(id, `grep pattern-${index}`);
		}

		const lines = formatActiveRunLines(store.getRuns(), theme, 120);
		// Four two-line groups fill nine lines, a fifth shows its identity line
		// only, and the marker accounts for the seven hidden runs.
		expect(lines).toHaveLength(10);
		expect(lines.at(-1)).toContain("+7 more");
	});

	it("shows the worktree group identity and integration state on the owning root", () => {
		const store = new MonitorStore();
		const isolated = store.addRun(
			"executor",
			"Implement src/cache.ts",
			undefined,
			undefined,
			{ isolation: "worktree", worktreeId: "a91f3c" },
		);
		store.setStatus(isolated, "running");

		const [pending] = formatActiveRunLines(store.getRuns(), theme, 120);
		expect(pending).toContain("wt:a91f3c");
		expect(pending).not.toContain("applying");

		store.setIsolation(isolated, "worktree", "finalizing", "a91f3c");
		const [applying] = formatActiveRunLines(store.getRuns(), theme, 120);
		expect(applying).toContain("wt:a91f3c applying");

		store.setIsolation(isolated, "worktree", "retained", "a91f3c");
		const [retained] = formatActiveRunLines(store.getRuns(), theme, 120);
		expect(retained).toContain("wt:a91f3c retained");
	});

	it("marks a resumed thread with a compact resume glyph and its cumulative time", () => {
		const store = new MonitorStore();
		const id = store.addRun("executor", "Original objective");
		store.removeRun(id);
		store.restartRun(
			id,
			"executor",
			"Finish the cache invalidation tests in src/cache.ts and verify the retained thread behavior",
			"anthropic/claude-sonnet-4-5",
			"high",
			"shared",
			{ elapsedMs: 61_000, continuationKind: "resume-appended" },
		);
		const [line] = formatActiveRunLines(store.getRuns(), theme, 80, 100_000);
		expect(visibleWidth(line)).toBeLessThanOrEqual(80);
		expect(line).toContain("executor ↻");
		expect(line).toContain("queued · 1m01s");
		expect(line).toContain(".ts");
	});

	it("shows a reactivated run as running with cumulative live elapsed after settling", () => {
		const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
		const store = new MonitorStore();
		const id = store.addRun("executor", "Fix the change");
		store.setStatus(id, "running");
		const run = store.findRun(id)!;
		now.mockReturnValue(2_000);
		store.setStatus(id, "done");
		expect(run.endedAt).toBe(2_000);

		// A resumed generation takes ownership of the same logical run after a gap.
		now.mockReturnValue(3_000);
		store.setStatus(id, "running");
		store.setActivity(id, "edit src/index.ts");
		expect(run.endedAt).toBeUndefined();

		const lines = formatActiveRunLines(store.getRuns(), theme, 120, 63_000);
		// The activity moves to the second line; line 1 stays what the run is.
		expect(lines).toHaveLength(2);
		expect(lines[0]).toContain("Fix the change");
		expect(lines[0]).toContain("1m01s");
		expect(lines[0]).not.toContain("edit src/index.ts");
		expect(lines[1]).toContain("↳ edit src/index.ts");
		expect(lines[0]).not.toContain("done");
	});

	it("keeps a meaningful activity tail on the second line within a moderate width", () => {
		const store = new MonitorStore();
		const id = store.addRun(
			"executor",
			`Change ${"deep/path/".repeat(12)}file.ts`,
			"anthropic/claude-sonnet-4-5",
			"high",
		);
		store.setStatus(id, "running");
		store.setActivity(id, `read ${"very/long/path/".repeat(8)}meaningful-file.ts`);
		store.findRun(id)!.startedAt = 1_000;
		store.findRun(id)!.activeSince = 1_000;

		const lines = formatActiveRunLines(store.getRuns(), theme, 76, 62_000);
		expect(lines).toHaveLength(2);
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(76);
		expect(lines[0]).not.toContain("/high");
		expect(lines[0]).toContain("1m01s");
		expect(lines[0]).toContain("file.ts");
		// The activity keeps its distinguishing tail on the second line.
		expect(lines[1]).toContain("↳");
		expect(lines[1]).toContain("meaningful-file.ts");
	});

	it("keeps identity and elapsed on a very narrow primary line", () => {
		const store = new MonitorStore();
		const id = store.addRun(
			"executor",
			"Implement a deliberately long cleanup task summary",
			"anthropic/claude-sonnet-4-5",
			"high",
		);
		store.setStatus(id, "running");
		store.findRun(id)!.startedAt = 1_000;
		store.findRun(id)!.activeSince = 1_000;

		const [line] = formatActiveRunLines(store.getRuns(), theme, 26, 62_000);
		expect(visibleWidth(line)).toBeLessThanOrEqual(26);
		expect(line).toContain(`#${id} executor`);
		expect(line).toContain("1m01s");
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

		const id = monitor.addRun("executor", "Fix the change");
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
