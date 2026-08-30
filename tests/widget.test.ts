import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MonitorStore, monitor, type WorkflowStage } from "../src/monitor.ts";
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
		const running = store.addRun("worker", "Fix src/index.ts", "anthropic/claude-sonnet-4-5", "high");
		store.setModel(running, "openai/gpt-5-mini", "anthropic/claude-sonnet-4-5");
		store.setStatus(running, "running");
		store.setActivity(running, "edit src/index.ts");
		store.setUsage(running, { input: 1_200, output: 3400, cacheRead: 91_000, cacheWrite: 1_050, cost: 0.05, contextTokens: 0, turns: 3 });
		const run = store.findRun(running)!;
		run.startedAt = 3_600_000;
		run.activeSince = 3_600_000;
		const done = store.addRun("reviewer", "Review src/index.ts");
		store.setStatus(done, "done");
		const parked = store.addRun("worker", "Park work");
		store.setStatus(parked, "parked");

		const lines = formatActiveRunLines(store.getRuns(), theme, 120, 3_600_000 + 3_725_000);
		// Line 1 is what the run is; line 2 is what it is doing right now.
		expect(lines).toHaveLength(2);
		expect(lines[0]).toContain(`● #${running} worker  src/index.ts`);
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
		const slot = store.addRun("explorer", "Map the cleaner workflow");
		const lane = store.addRun("worker", "Fix src/cache.ts shared");
		store.setWaitReason(lane, "repository-lane");
		const starting = store.addRun("worker", "Spawn immediately", undefined, undefined, { waitReason: "starting" });

		const lines = formatActiveRunLines(store.getRuns(), theme, 120);
		expect(lines).toHaveLength(3);
		// The agent column is padded to the widest name so labels align.
		expect(lines[0]).toContain(`○ #${slot} explorer  Map the cleaner workflow`);
		expect(lines[0].endsWith("queued")).toBe(true);
		expect(lines[1]).toContain(`○ #${lane} worker    src/cache.ts`);
		expect(lines[1].endsWith("repo lane")).toBe(true);
		expect(lines[2]).toContain(`○ #${starting} worker    Spawn immediately`);
		expect(lines[2].endsWith("starting")).toBe(true);
		for (const line of lines) expect(line).not.toContain("undefined");
	});

	it("omits the model on queued rows because the route re-resolves at start", () => {
		const store = new MonitorStore();
		store.addRun("worker", "Queued work", "anthropic/claude-sonnet-4-5", "high");

		const lines = formatActiveRunLines(store.getRuns(), theme, 120);
		expect(lines).toHaveLength(1);
		expect(lines[0]).not.toContain("sonnet");
		expect(lines[0]).not.toContain("/high");
	});

	it("stays within tiny widths without emitting blank lines", () => {
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

	it("renders a managed workflow as a tree chain: parent totals plus one telemetry row per stage", () => {
		const store = new MonitorStore();
		const parent = store.addRun("worker", "Implement src/index.ts", "xai/grok-parent", "xhigh");
		store.setStatus(parent, "running");
		store.setManagedWorkflow(parent, true);
		store.setUsage(parent, { input: 1_000, output: 12_000, cacheRead: 40_000, cacheWrite: 1_200, cost: 0.51, contextTokens: 0, turns: 4 });
		store.setWorkflowStages(parent, [
			{
				agent: "worker",
				relation: "implement",
				status: "done",
				model: "xai/grok-parent",
				usage: { input: 1_000, output: 12_000, cacheRead: 40_000, cacheWrite: 1_200, cost: 0.51, contextTokens: 0, turns: 4 },
				elapsedMs: 161_000,
			},
			{ agent: "reviewer", relation: "review", status: "active" },
			{ agent: "documenter", relation: "docs", status: "pending" },
		]);
		store.setActivity(parent, "managed workflow running");
		const review = store.addRun(
			"reviewer",
			"Fresh code gate for a managed worker workflow.\n- src/index.ts:42 bug",
			"openai/gpt-worker",
			"max",
			{ groupId: `workflow-${parent}`, relationLabel: "review", parentRunId: parent, waitReason: "starting" },
		);
		store.setStatus(review, "running");
		store.setActivity(review, "read src/index.ts");
		store.setUsage(review, { input: 500, output: 2_000, cacheRead: 8_000, cacheWrite: 400, cost: 0.09, contextTokens: 0, turns: 1 });

		const lines = formatActiveRunLines(store.getRuns(), theme, 120);
		// Parent row + one row per stage; internal child rows never repeat as roots.
		expect(lines).toHaveLength(4);
		expect(lines[0]).toContain(`◆ #${parent} worker  src/index.ts`);
		expect(lines[0]).not.toContain("grok-parent");
		expect(lines[0]).not.toContain("/xhigh");
		// Parent totals aggregate the settled snapshot plus the live stage.
		expect(lines[0]).toContain("↑1.5k ↓14.0k R48.0k W1.6k $0.6000");
		expect(lines[1]).toContain("├ ✓ implement");
		expect(lines[1]).toContain("xai/grok-parent");
		expect(lines[1]).toContain("2m41s");
		expect(lines[2]).toContain("├ ● review — read src/index.ts");
		expect(lines[2]).toContain("openai/gpt-worker/max");
		expect(lines[3]).toBe("  └ ○ docs");
		// Telemetry flows inline after each stage label — no blank padding.
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(120);
		expect(lines.join("\n")).not.toContain("managed workflow running");
		expect(lines.join("\n")).not.toContain(`#${review}`);
	});

	it("falls back to the live stage's model when it has no activity yet", () => {
		const store = new MonitorStore();
		const parent = store.addRun("worker", "Implement src/cache.ts");
		store.setStatus(parent, "running");
		store.setManagedWorkflow(parent, true);
		store.setWorkflowStages(parent, [
			{ agent: "worker", relation: "implement", status: "done" },
			{ agent: "reviewer", relation: "review", status: "active" },
		]);
		const review = store.addRun(
			"reviewer",
			"Fresh code gate.",
			"anthropic/claude-sonnet-4-5",
			"high",
			{ relationLabel: "review", parentRunId: parent, waitReason: "starting" },
		);
		store.setStatus(review, "running");

		const lines = formatActiveRunLines(store.getRuns(), theme, 120);
		expect(lines).toHaveLength(3);
		expect(lines[2]).toContain("claude-sonnet-4-5");
	});

	it("labels the fix stage as reviewer-owned work, not a separate fixer", () => {
		const store = new MonitorStore();
		const parent = store.addRun("worker", "Implement src/cache.ts");
		store.setStatus(parent, "running");
		store.setManagedWorkflow(parent, true);
		store.setWorkflowStages(parent, [
			{ agent: "worker", relation: "implement", status: "done" },
			{ agent: "reviewer", relation: "review", status: "changes" },
			{ agent: "reviewer", relation: "review fix", status: "active" },
		]);
		store.setActivity(parent, "managed workflow running");

		const lines = formatActiveRunLines(store.getRuns(), theme, 120);
		expect(lines).toHaveLength(4);
		expect(lines[1]).toContain("├ ✓ implement");
		expect(lines[2]).toContain("├ ! review");
		expect(lines[3]).toContain("└ ● review fix");
	});

	it("removes conditionally skipped docs and distinguishes process failure from review changes", () => {
		const store = new MonitorStore();
		const parent = store.addRun("worker", "Implement src/cache.ts");
		store.setStatus(parent, "running");
		store.setManagedWorkflow(parent, true);
		store.setWorkflowStages(parent, [
			{ agent: "worker", relation: "implement", status: "done" },
			{ agent: "reviewer", relation: "review", status: "failed" },
		]);
		store.setActivity(parent, "managed workflow running");

		const lines = formatActiveRunLines(store.getRuns(), theme, 100);
		expect(lines).toHaveLength(3);
		expect(lines[1]).toContain("├ ✓ implement");
		expect(lines[2]).toContain("└ ✗ review");
		expect(lines.join("\n")).not.toContain("docs");
		expect(lines.join("\n")).not.toContain("managed workflow running");
	});

	it("keeps the active stage and workflow elapsed visible on narrow layouts", () => {
		const store = new MonitorStore();
		const parent = store.addRun("worker", "Implement src/cache.ts");
		store.setStatus(parent, "running");
		store.setManagedWorkflow(parent, true);
		store.setWorkflowStages(parent, [
			{ agent: "worker", relation: "implement", status: "done" },
			{ agent: "reviewer", relation: "review", status: "changes" },
			{ agent: "documenter", relation: "docs", status: "active" },
		]);
		store.findRun(parent)!.startedAt = 1_000;
		store.findRun(parent)!.activeSince = 1_000;

		const lines = formatActiveRunLines(store.getRuns(), theme, 34, 62_000);
		expect(lines).toHaveLength(4);
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(34);
		expect(lines[0]).toContain("1m01s");
		expect(lines.at(-1)).toContain("● docs");
	});

	it("anchors an oversized stage chain on the live stage with overflow markers", () => {
		const store = new MonitorStore();
		const parent = store.addRun("worker", "Implement src/cache.ts");
		store.setStatus(parent, "running");
		store.setManagedWorkflow(parent, true);
		const stages: WorkflowStage[] = Array.from({ length: 12 }, (_unused, index) => ({
			agent: "reviewer",
			relation: index === 7 ? "review fix" : `review ${index}`,
			status: index === 7 ? "active" : index < 7 ? "done" : "pending",
		}));
		store.setWorkflowStages(parent, stages);

		const lines = formatActiveRunLines(store.getRuns(), theme, 120);
		// Nine rows for the group (the tenth stays reserved for the hidden-roots
		// marker): parent + `… +5` marker + a seven-stage window.
		expect(lines).toHaveLength(9);
		expect(lines[1]).toContain("… +5");
		expect(lines.some((line) => line.includes("● review fix"))).toBe(true);
		expect(lines.some((line) => line.includes("✓ review 0"))).toBe(false);
	});

	it("renders a chain child at root level with its relation when the parent row is gone", () => {
		const store = new MonitorStore();
		const orphan = store.addRun(
			"documenter",
			"Final documentation sync.\n- src/widget.ts:10 issue",
			undefined,
			undefined,
			{ groupId: "workflow-999", relationLabel: "docs sync", parentRunId: 999, waitReason: "starting" },
		);
		store.setStatus(orphan, "running");

		const lines = formatActiveRunLines(store.getRuns(), theme, 120);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain(`● #${orphan} documenter  docs sync · src/widget.ts`);
	});

	it("leads with the parent model's own live line while its agent loop runs", () => {
		const store = new MonitorStore();
		const run = store.addRun("explorer", "Map src/models.ts", "google/gemini-2.5-pro");
		store.setStatus(run, "running");
		const main = { model: "openai/gpt-5", thinking: "max", activity: "subagent Map src/models.ts", activeSince: 1_000 };

		const lines = formatActiveRunLines(store.getRuns(), theme, 120, 42_000, main);
		expect(lines).toHaveLength(2);
		expect(lines[0]).toContain("subagent Map src/models.ts · openai/gpt-5/max · 41s");
		// The parent line joins the identity layout: its label starts at the
		// same column as the run rows' labels.
		expect(lines[0].indexOf("subagent")).toBe(lines[1].indexOf("src/models.ts"));
	});

	it("renders the parent model line alone before any run exists", () => {
		const main = { model: "openai/gpt-5", activity: "thinking", activeSince: 40_000 };
		const lines = formatActiveRunLines([], theme, 80, 42_000, main);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("openai/gpt-5");
		expect(lines[0].endsWith("2s")).toBe(true);
	});

	it("hides the parent model's line once its loop settles", () => {
		const store = new MonitorStore();
		const id = store.addRun("explorer", "Map src/models.ts");
		store.setStatus(id, "running");

		const lines = formatActiveRunLines(store.getRuns(), theme, 120, 42_000);
		expect(lines).toHaveLength(1);
		expect(lines.join("\n")).not.toContain("pi");
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
			"worker",
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
		const id = store.addRun("worker", "Original objective");
		store.removeRun(id);
		store.restartRun(
			id,
			"worker",
			"Finish the cache invalidation tests in src/cache.ts and verify the retained thread behavior",
			"anthropic/claude-sonnet-4-5",
			"high",
			"shared",
			{ elapsedMs: 61_000, continuationKind: "resume-appended" },
		);
		const [line] = formatActiveRunLines(store.getRuns(), theme, 80, 100_000);
		expect(visibleWidth(line)).toBeLessThanOrEqual(80);
		expect(line).toContain("worker ↻");
		expect(line).toContain("queued · 1m01s");
		expect(line).toContain(".ts");
	});

	it("shows an auto-fix parent as running with cumulative live elapsed after its review settles", () => {
		const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
		const store = new MonitorStore();
		const id = store.addRun("reviewer", "Review the change");
		store.setStatus(id, "running");
		const run = store.findRun(id)!;
		now.mockReturnValue(2_000);
		store.setStatus(id, "done");
		expect(run.endedAt).toBe(2_000);

		// Auto-fix takes ownership of the same logical run after a one-second gap.
		now.mockReturnValue(3_000);
		store.setStatus(id, "running");
		store.setActivity(id, "auto-fix chain running");
		expect(run.endedAt).toBeUndefined();

		const lines = formatActiveRunLines(store.getRuns(), theme, 120, 63_000);
		// The activity moves to the second line; line 1 stays what the run is.
		expect(lines).toHaveLength(2);
		expect(lines[0]).toContain("Review the change");
		expect(lines[0]).toContain("1m01s");
		expect(lines[0]).not.toContain("auto-fix chain running");
		expect(lines[1]).toContain("↳ auto-fix chain running");
		expect(lines[0]).not.toContain("done");
	});

	it("keeps a meaningful activity tail on the second line within a moderate width", () => {
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
			"worker",
			"Implement a deliberately long cleanup task summary",
			"anthropic/claude-sonnet-4-5",
			"high",
		);
		store.setStatus(id, "running");
		store.findRun(id)!.startedAt = 1_000;
		store.findRun(id)!.activeSince = 1_000;

		const [line] = formatActiveRunLines(store.getRuns(), theme, 26, 62_000);
		expect(visibleWidth(line)).toBeLessThanOrEqual(26);
		expect(line).toContain(`#${id} worker`);
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

		const id = monitor.addRun("reviewer", "Review the change");
		expect(vi.getTimerCount()).toBe(0); // queued rows have no elapsed clock yet
		monitor.setStatus(id, "running");
		expect(vi.getTimerCount()).toBe(1);
		vi.advanceTimersByTime(1_000);
		expect(requestRender).toHaveBeenCalled();

		monitor.setStatus(id, "done");
		expect(vi.getTimerCount()).toBe(0);
		// The parent model's own loop keeps the clock ticking too.
		monitor.setMainAgentActive(true);
		expect(vi.getTimerCount()).toBe(1);
		monitor.setMainAgentActive(false);
		expect(vi.getTimerCount()).toBe(0);
		expect(component.render(80)).toEqual([]);
		component.dispose();
		expect(vi.getTimerCount()).toBe(0);
	});
});
