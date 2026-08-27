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
		expect(lines[0]).toContain(`● #${running} worker · Fix src/index.ts`);
		expect(lines[0]).toContain("gpt-5-mini/high");
		expect(lines[0]).not.toContain("openai/");
		expect(lines[0]).not.toContain("edit src/index.ts");
		expect(lines[1]).toBe("  edit src/index.ts");
		expect(lines.join("\n")).not.toContain(`#${done}`);
		expect(lines.join("\n")).not.toContain(`#${parked}`);
	});

	it("omits a blank activity line and handles missing model/thinking", () => {
		const store = new MonitorStore();
		store.addRun("explorer", "Map the cleaner workflow");

		const lines = formatActiveRunLines(store.getRuns(), theme, 120);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("explorer · queued · Map the cleaner workflow");
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
		store.addRun("explorer", "Map config");
		store.addRun("reviewer", "Review config");

		const lines = formatActiveRunLines(store.getRuns(), theme, 80);
		expect(lines).toHaveLength(2);
		expect(lines[0]).toContain("explorer · queued · Map config");
		expect(lines[1]).toContain("reviewer · queued · Review config");
		expect(lines.every((line) => line.length > 0)).toBe(true);
	});

	it("renders an auto-fix timeline and nests current child telemetry under its stable parent", () => {
		const store = new MonitorStore();
		const parent = store.addRun("reviewer", "Review src/index.ts", "xai/grok-parent", "xhigh");
		store.setStatus(parent, "running");
		store.setManagedWorkflow(parent, true);
		store.setWorkflowStages(parent, [
			{ agent: "reviewer", relation: "review", status: "changes" },
			{ agent: "worker", relation: "fix 1/2", status: "active" },
			{ agent: "reviewer", relation: "re-review 1/2", status: "pending" },
			{ agent: "documenter", relation: "docs", status: "pending" },
		]);
		store.setActivity(parent, "auto-fix chain running");
		const fix = store.addRun(
			"worker",
			"Auto-fix round 1 of 2 (triggered by a failed review).\n- src/index.ts:42 bug",
			"openai/gpt-worker",
			"max",
			{ groupId: `fix-${parent}`, relationLabel: "fix 1/2", parentRunId: parent },
		);
		store.setStatus(fix, "running");
		store.setActivity(fix, "edit src/index.ts");
		const reReview = store.addRun(
			"reviewer",
			"Re-review after auto-fix round 1.",
			"anthropic/claude-reviewer",
			"high",
			{ groupId: `fix-${parent}`, relationLabel: "re-review 1/2", parentRunId: parent },
		);
		store.setStatus(reReview, "queued");

		const lines = formatActiveRunLines(store.getRuns(), theme, 120);
		expect(lines).toHaveLength(5);
		expect(lines[0]).toContain(`◆ #${parent} reviewer workflow · src/index.ts`);
		expect(lines[0]).not.toContain("grok-parent");
		expect(lines[0]).not.toContain("/xhigh");
		expect(lines[1]).toContain("! review ─ ● fix 1/2 ─ ○ re-review 1/2 ─ ○ docs");
		// The timeline replaces the parent's generic workflow placeholder.
		expect(lines.join("\n")).not.toContain("auto-fix chain running");
		expect(lines[2]).toContain(`├ ● #${fix} worker · fix 1/2 · src/index.ts · gpt-worker/max`);
		expect(lines[3]).toBe("      edit src/index.ts");
		expect(lines[4]).toContain(`└ ○ #${reReview} reviewer · queued · re-review 1/2`);
		expect(lines.join("\n")).not.toContain("claude-reviewer");
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
			{ agent: "worker", relation: "fix 2/2", status: "active" },
			{ agent: "reviewer", relation: "re-review 2/2", status: "pending" },
		]);
		store.findRun(parent)!.startedAt = 1_000;
		store.findRun(parent)!.activeSince = 1_000;

		const lines = formatActiveRunLines(store.getRuns(), theme, 34, 62_000);
		expect(lines).toHaveLength(2);
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(34);
		expect(lines[0]).toContain("1m01s");
		expect(lines[1]).toContain("● fix 2/2");
	});

	it("renders a chain child at root level with its relation when the parent row is gone", () => {
		const store = new MonitorStore();
		const orphan = store.addRun(
			"worker",
			"Auto-fix round 2 of 2.\n- src/widget.ts:10 issue",
			undefined,
			undefined,
			{ groupId: "fix-999", relationLabel: "fix round 2", parentRunId: 999 },
		);
		store.setStatus(orphan, "running");

		const lines = formatActiveRunLines(store.getRuns(), theme, 120);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain(`● #${orphan} worker · fix round 2 · src/widget.ts`);
		expect(lines[0]).not.toContain("└");
	});

	it("marks queued runs as not started", () => {
		const store = new MonitorStore();
		const queued = store.addRun("worker", "Waiting for a slot to fix src/cache.ts");

		const lines = formatActiveRunLines(store.getRuns(), theme, 120);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain(`○ #${queued} worker`);
		expect(lines[0]).toContain("queued");
		expect(lines[0]).not.toContain("undefined");
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

	it("keeps the worktree badge on the group owner while stage children inherit it via the tree", () => {
		const store = new MonitorStore();
		const parent = store.addRun(
			"worker",
			"Implement src/cache.ts",
			undefined,
			undefined,
			{ isolation: "worktree", worktreeId: "b2c4d6" },
		);
		store.setStatus(parent, "running");
		store.setManagedWorkflow(parent, true);
		store.setWorkflowStages(parent, [
			{ agent: "worker", relation: "implement", status: "done" },
			{ agent: "reviewer", relation: "review", status: "active" },
		]);
		const review = store.addRun(
			"reviewer",
			"Fresh code gate for a managed worker workflow.",
			undefined,
			undefined,
			{ relationLabel: "review", parentRunId: parent, isolation: "worktree", worktreeId: "b2c4d6" },
		);
		store.setStatus(review, "running");

		const lines = formatActiveRunLines(store.getRuns(), theme, 120);
		expect(lines[0]).toContain(`◆ #${parent} worker workflow`);
		expect(lines[0]).toContain("wt:b2c4d6");
		expect(lines[2]).toContain(`└ ● #${review} reviewer`);
		expect(lines[2]).not.toContain("wt:");
	});

	it.each([
		["retarget", "retarget", "retarget: replacement objective"],
		["retained resume", "resume-retained", "resume: current objective"],
		["appended resume", "resume-appended", "resume: appended objective"],
	] as const)("keeps %s semantics visible beside a path-heavy task at 80 columns", (_name, kind, label) => {
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
			{ elapsedMs: 61_000, continuationKind: kind },
		);
		const [line] = formatActiveRunLines(store.getRuns(), theme, 80, 100_000);
		expect(visibleWidth(line)).toBeLessThanOrEqual(80);
		expect(line).toContain(label);
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

		const [primary, activity] = formatActiveRunLines(store.getRuns(), theme, 120, 63_000);
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
		store.findRun(id)!.activeSince = 1_000;

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
		store.findRun(id)!.activeSince = 1_000;

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
