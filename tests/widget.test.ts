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
	it("renders a running run as one line with inline activity and a right-aligned telemetry tail", () => {
		const store = new MonitorStore();
		const running = store.addRun("worker", "Fix src/index.ts", "anthropic/claude-sonnet-4-5", "high");
		store.setModel(running, "openai/gpt-5-mini", "anthropic/claude-sonnet-4-5");
		store.setStatus(running, "running");
		store.setActivity(running, "edit src/index.ts");
		store.findRun(running)!.startedAt = 1_000;
		store.findRun(running)!.activeSince = 1_000;
		const done = store.addRun("reviewer", "Review src/index.ts");
		store.setStatus(done, "done");
		const parked = store.addRun("worker", "Park work");
		store.setStatus(parked, "parked");

		const lines = formatActiveRunLines(store.getRuns(), theme, 120, 62_000);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain(`● #${running} worker · src/index.ts — edit src/index.ts`);
		expect(lines[0]).toContain("gpt-5-mini/high");
		expect(lines[0]).not.toContain("openai/");
		// Telemetry column is right-aligned: the line ends at the width with elapsed.
		expect(visibleWidth(lines[0])).toBe(120);
		expect(lines[0].endsWith("1m01s")).toBe(true);
		expect(lines[0]).not.toContain(`#${done}`);
		expect(lines[0]).not.toContain(`#${parked}`);
	});

	it("labels queued rows with what they actually wait for", () => {
		const store = new MonitorStore();
		const slot = store.addRun("explorer", "Map the cleaner workflow");
		const lane = store.addRun("worker", "Fix src/cache.ts shared");
		store.setWaitReason(lane, "repository-lane");
		const starting = store.addRun("worker", "Spawn immediately", undefined, undefined, { waitReason: "starting" });

		const lines = formatActiveRunLines(store.getRuns(), theme, 120);
		expect(lines).toHaveLength(3);
		expect(lines[0]).toContain(`○ #${slot} explorer · queued · Map the cleaner workflow`);
		expect(lines[1]).toContain(`○ #${lane} worker · waiting on repo lane`);
		expect(lines[2]).toContain(`○ #${starting} worker · starting`);
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

	it("renders a managed workflow as two lines: parent identity and a timeline carrying live stage telemetry", () => {
		const store = new MonitorStore();
		const parent = store.addRun("worker", "Implement src/index.ts", "xai/grok-parent", "xhigh");
		store.setStatus(parent, "running");
		store.setManagedWorkflow(parent, true);
		store.setWorkflowStages(parent, [
			{ agent: "worker", relation: "implement", status: "done" },
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
		const docs = store.addRun(
			"documenter",
			"Final documentation sync.",
			"anthropic/claude-reviewer",
			"high",
			{ groupId: `workflow-${parent}`, relationLabel: "docs", parentRunId: parent, waitReason: "starting" },
		);
		store.setStatus(docs, "queued");

		const lines = formatActiveRunLines(store.getRuns(), theme, 120);
		expect(lines).toHaveLength(2);
		expect(lines[0]).toContain(`◆ #${parent} worker · src/index.ts`);
		expect(lines[0]).not.toContain("grok-parent");
		expect(lines[0]).not.toContain("/xhigh");
		expect(lines[1]).toContain("✓ implement ─ ● review ─ ○ docs");
		// The live stage's doing-now rides on the timeline instead of extra rows.
		expect(lines[1]).toContain("read src/index.ts");
		expect(lines.join("\n")).not.toContain("managed workflow running");
		expect(lines.join("\n")).not.toContain(`#${review}`);
		expect(lines.join("\n")).not.toContain(`#${docs}`);
		expect(lines.join("\n")).not.toContain("claude-reviewer");
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
		expect(lines).toHaveLength(2);
		expect(lines[1]).toContain("claude-sonnet-4-5");
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
		expect(lines[1]).toContain("! review ─ ● review fix");
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
		expect(lines).toHaveLength(2);
		expect(lines[1]).toContain("✓ implement ─ ✗ review");
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
		expect(lines).toHaveLength(2);
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(34);
		expect(lines[0]).toContain("1m01s");
		expect(lines[1]).toContain("● docs");
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
		expect(lines[0]).toContain(`● #${orphan} documenter · docs sync · src/widget.ts`);
	});

	it("caps output at the host widget budget with an overflow marker counting hidden runs", () => {
		const store = new MonitorStore();
		for (let index = 0; index < 12; index++) {
			const id = store.addRun("explorer", `Map src/module-${index}.ts`);
			store.setActivity(id, `grep pattern-${index}`);
		}

		const lines = formatActiveRunLines(store.getRuns(), theme, 120);
		expect(lines).toHaveLength(10);
		expect(lines.at(-1)).toContain("+3 more");
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
		expect(line).toContain("↻ resumed");
		expect(line).toContain("queued");
		expect(line).toContain(".ts");
		expect(line).toContain("1m01s");
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
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("Review the change — auto-fix chain running");
		expect(lines[0]).toContain("1m01s");
		expect(lines[0]).not.toContain("done");
	});

	it("keeps a meaningful activity tail beside model/thinking within a moderate width", () => {
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
		expect(lines).toHaveLength(1);
		expect(visibleWidth(lines[0])).toBeLessThanOrEqual(76);
		expect(lines[0]).toContain("/high");
		expect(lines[0]).toContain("1m01s");
		expect(lines[0]).toContain("file.ts");
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
		expect(component.render(80)).toEqual([]);
		component.dispose();
		expect(vi.getTimerCount()).toBe(0);
	});
});
