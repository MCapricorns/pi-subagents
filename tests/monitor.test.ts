import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import {
	ACTIVE_LONG_RUNNING_AFTER_MS,
	NEEDS_ATTENTION_AFTER_MS,
	MonitorStore,
	activityStateLabel,
	compactModelRef,
	deriveActivityState,
	extractKeyFragments,
	formatDuration,
	formatElapsed,
	formatTaskSummary,
	formatToolActivity,
	formatUsageCompact,
	runLabel,
	rightAlign,
	compactLine,
	statusLabel,
} from "../src/monitor.ts";

describe("MonitorStore", () => {
	it("addRun creates a queued run with zero usage and preserves its task", () => {
		const store = new MonitorStore();
		const task = "  Implement the monitor\nwithout rewriting the brief.  ";
		const id = store.addRun("worker", task, "anthropic/claude-sonnet-4-5");
		const runs = store.getRuns();
		expect(runs).toHaveLength(1);
		expect(runs[0].id).toBe(id);
		expect(runs[0].agent).toBe("worker");
		expect(runs[0].task).toBe(task);
		expect(runs[0].model).toBe("anthropic/claude-sonnet-4-5");
		expect(runs[0].status).toBe("queued");
		expect(runs[0].usage.input).toBe(0);
		expect(runs[0].activity).toBeUndefined();
	});

	it("addRun derives a content label from the task", () => {
		const store = new MonitorStore();
		store.addRun("worker", "Fix the bug in src/index.ts and add tests");
		store.addRun("explore", "Find where fixGridLayout is defined");
		const [a, b] = store.getRuns();
		expect(a.label).toBe("src/index.ts");
		expect(b.label).toBe("fixGridLayout");
	});

	it("beginTurn clears finished runs but keeps active ones", () => {
		const store = new MonitorStore();
		const done = store.addRun("explore", "Map the codebase");
		store.setStatus(done, "done");
		const active = store.addRun("worker", "Implement the change");
		store.setStatus(active, "running");
		store.beginTurn();
		const runs = store.getRuns();
		expect(runs).toHaveLength(1);
		expect(runs[0].id).toBe(active);
	});

	it("beginTurn preserves retained runs (auto-fix chain parent)", () => {
		const store = new MonitorStore();
		const parent = store.addRun("reviewer", "Review the change");
		store.setStatus(parent, "done");
		store.setRetained(parent, true);
		const active = store.addRun("worker", "Fix the findings");
		store.setStatus(active, "running");
		store.beginTurn();
		const runs = store.getRuns();
		expect(runs).toHaveLength(2);
		expect(runs.map((r) => r.id)).toContain(parent);
		expect(runs.map((r) => r.id)).toContain(active);
	});

	it("setUsage updates usage and model; setStatus updates status", () => {
		const store = new MonitorStore();
		const id = store.addRun("worker", "Implement the change");
		store.setStatus(id, "running");
		store.setUsage(id, { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0.5, contextTokens: 0, turns: 1 }, "openai/gpt-x");
		const run = store.getRuns()[0];
		expect(run.status).toBe("running");
		expect(run.model).toBe("openai/gpt-x");
		expect(run.usage.input).toBe(10);
		expect(run.usage.cost).toBe(0.5);
	});

	it("setAnnotation records a widget note without touching status", () => {
		const store = new MonitorStore();
		const id = store.addRun("reviewer", "Review the change");
		store.setStatus(id, "done");
		store.setAnnotation(id, "auto-fix chain running");
		expect(store.getRuns()[0].annotation).toBe("auto-fix chain running");
		expect(store.getRuns()[0].status).toBe("done");
	});

	it("setRetained marks a run so beginTurn keeps it", () => {
		const store = new MonitorStore();
		const id = store.addRun("reviewer", "Review the change");
		store.setStatus(id, "done");
		store.setRetained(id, true);
		expect(store.findRun(id)?.retained).toBe(true);
		store.beginTurn();
		expect(store.getRuns()).toHaveLength(1);
		store.setRetained(id, false);
		store.beginTurn();
		expect(store.getRuns()).toHaveLength(0);
	});

	it("clear removes all runs without resetting the id counter", () => {
		const store = new MonitorStore();
		const first = store.addRun("worker", "Task A");
		store.addRun("explore", "Task B");
		store.clear();
		expect(store.getRuns()).toHaveLength(0);
		const next = store.addRun("worker", "Task C");
		expect(next).toBeGreaterThan(first);
	});

	it("findRun looks up a run without removing it; removeRun then makes it undefined", () => {
		const store = new MonitorStore();
		const id = store.addRun("worker", "Implement the change");
		expect(store.findRun(id)?.id).toBe(id);
		const removed = store.removeRun(id);
		expect(removed?.id).toBe(id);
		expect(store.findRun(id)).toBeUndefined();
		expect(store.removeRun(id)).toBeUndefined();
	});

	it("addRun carries chain metadata (groupId, relationLabel) and an empty annotation", () => {
		const store = new MonitorStore();
		const id = store.addRun("worker", "Fix the findings", undefined, undefined, {
			groupId: "fix-3",
			relationLabel: "fix round 1",
		});
		const run = store.findRun(id);
		expect(run?.groupId).toBe("fix-3");
		expect(run?.relationLabel).toBe("fix round 1");
		expect(run?.annotation).toBeUndefined();
	});
});

describe("MonitorStore activity", () => {
	it("setActivity records the current one-line activity, last writer wins", () => {
		const store = new MonitorStore();
		const id = store.addRun("worker", "Implement the change");
		store.setActivity(id, "thinking");
		expect(store.getRuns()[0].activity).toBe("thinking");
		store.setActivity(id, "read src/index.ts");
		expect(store.getRuns()[0].activity).toBe("read src/index.ts");
	});

	it("ignores activity for unknown runs", () => {
		const store = new MonitorStore();
		store.setActivity(999, "thinking");
		expect(store.getRuns()).toHaveLength(0);
	});
});

describe("MonitorStore.removeRun", () => {
	it("removes the run and returns it for the completion notification", () => {
		const store = new MonitorStore();
		const id = store.addRun("worker", "Implement the change");
		store.setStatus(id, "running");
		store.setStatus(id, "done");
		const removed = store.removeRun(id);
		expect(removed?.agent).toBe("worker");
		expect(removed?.endedAt).toBeTypeOf("number");
		expect(store.getRuns()).toHaveLength(0);
	});

	it("returns undefined for unknown ids, so finishing twice is a no-op", () => {
		const store = new MonitorStore();
		expect(store.removeRun(42)).toBeUndefined();
	});
});

describe("formatTaskSummary", () => {
	it("collapses whitespace and trims the task", () => {
		expect(formatTaskSummary("  Review\n\tsrc/index.ts   carefully.  ")).toBe("Review src/index.ts carefully.");
	});

	it("strips ANSI, OSC, and other VT control sequences", () => {
		const task = "\x1b[31mReview\x1b[0m\n\x1b]8;;https://example.com\x07src/index.ts\x1b]8;;\x07 \x1b[2Kcarefully.";
		expect(formatTaskSummary(task)).toBe("Review src/index.ts carefully.");
	});

	it("strips VT controls before display-width truncation", () => {
		const summary = formatTaskSummary(`${"a".repeat(78)}\x1b[31m界\x1b[0mz`);
		expect(summary).toBe(`${"a".repeat(51)}…${"a".repeat(25)}界z`);
		expect(summary).not.toContain("\x1b");
		expect(visibleWidth(summary)).toBe(80);
	});

	it("truncates CJK text by terminal display columns", () => {
		expect(formatTaskSummary("界".repeat(40))).toBe("界".repeat(40));
		const summary = formatTaskSummary("界".repeat(41));
		expect(summary).toBe(`${"界".repeat(25)}…${"界".repeat(14)}`);
		expect(visibleWidth(summary)).toBeLessThanOrEqual(80);
	});

	it("does not split a ZWJ emoji when truncating", () => {
		const family = "👨‍👩‍👧‍👦";
		const summary = formatTaskSummary(`${"a".repeat(78)}${family}z`);
		expect(summary).toBe(`${"a".repeat(51)}…${"a".repeat(25)}${family}z`);
		expect(visibleWidth(summary)).toBe(80);
	});

	it("keeps a combining sequence intact at the truncation boundary", () => {
		const combining = "e\u0301";
		const summary = formatTaskSummary(`${"a".repeat(78)}${combining}zz`);
		expect(summary).toBe(`${"a".repeat(51)}…${"a".repeat(25)}${combining}zz`);
		expect(visibleWidth(summary)).toBe(80);
	});

	it("shows only the distinctive path, dropping templated prose", () => {
		const summary = formatTaskSummary(
			"explore: survey the widget rendering pipeline and completion batching paths to find every place that interacts with the footer data provider, then report how they connect src/footer-data-provider.ts",
		);
		expect(summary).toBe("src/footer-data-provider.ts");
	});

	it("shows the differing keyword for near-identical explore tasks", () => {
		const a = formatTaskSummary(
			"explore: trace how the batching pipeline drains and how completion messages are grouped, then report src/completion.ts",
		);
		const b = formatTaskSummary(
			"explore: trace how the batching pipeline drains and how completion messages are grouped, then report src/fixloop.ts",
		);
		expect(a).toBe("src/completion.ts");
		expect(b).toBe("src/fixloop.ts");
	});

	it("keeps the tail of an over-long single fragment", () => {
		const longPath = `src/${"x".repeat(90)}/component.ts`;
		const summary = formatTaskSummary(`explore: trace the deeply nested widget state and how it renders, look at ${longPath}`, 40);
		expect(summary.startsWith("…")).toBe(true);
		expect(summary.endsWith("component.ts")).toBe(true);
		expect(visibleWidth(summary)).toBeLessThanOrEqual(40);
	});

	it("joins multiple fragments with the separator, keeping the first", () => {
		const summary = formatTaskSummary(
			"worker: implement the new render path in src/ui/render.ts, wire up fixGridLayout, and add tests",
			60,
		);
		expect(summary).toBe("src/ui/render.ts · fixGridLayout");
	});

	it("honors a custom maxWidth when showing keywords", () => {
		const summary = formatTaskSummary(`${"a".repeat(60)} tail-keyword`, 40);
		expect(summary).toBe("tail-keyword");
		expect(visibleWidth(summary)).toBeLessThanOrEqual(40);
	});
});

describe("extractKeyFragments", () => {
	it("extracts paths, quoted phrases and symbols in order of appearance", () => {
		expect(
			extractKeyFragments('check "the focus manager" in src/ui/render.ts and fixGridLayout'),
		).toEqual(["the focus manager", "src/ui/render.ts", "fixGridLayout"]);
	});

	it("dedupes fragments that are substrings of longer paths", () => {
		expect(extractKeyFragments("look at src/footer-data-provider.ts and data-provider.ts")).toEqual([
			"src/footer-data-provider.ts",
		]);
	});

	it("drops kebab-case boilerplate words", () => {
		expect(extractKeyFragments("a self-contained read-only review of main.ts")).toEqual(["main.ts"]);
	});
});

describe("runLabel", () => {
	it("uses the top distinguishing fragment as the label", () => {
		expect(runLabel("Fix the bug in src/index.ts and add tests")).toBe("src/index.ts");
		expect(runLabel("Find where fixGridLayout is defined")).toBe("fixGridLayout");
	});

	it("falls back to a head slice of the prose when no fragments are found", () => {
		expect(runLabel("a quick check of things")).toBe("a quick check of things");
	});

	it("caps a long path, keeping the recognisable tail", () => {
		const label = runLabel("Review src/very-long-component-name-here.ts end to end");
		expect(visibleWidth(label)).toBeLessThanOrEqual(32);
		expect(label.startsWith("…")).toBe(true);
		expect(label.endsWith(".ts")).toBe(true);
	});
});

describe("formatUsageCompact", () => {
	it("formats cache read/write tokens with R and W", () => {
		expect(
			formatUsageCompact({
				input: 0,
				output: 0,
				cacheRead: 1200,
				cacheWrite: 9000,
				cost: 0,
				contextTokens: 0,
				turns: 0,
			}),
		).toBe("R1.2k W9.0k");
	});
});

describe("formatToolActivity", () => {
	it("shows the file being read, not a JSON args blob", () => {
		expect(formatToolActivity("read", { path: "src/index.ts" })).toBe("read src/index.ts");
	});

	it("shows the command being run", () => {
		expect(formatToolActivity("bash", { command: "npm test" })).toBe("bash npm test");
	});

	it("shows grep patterns and search queries", () => {
		expect(formatToolActivity("grep", { pattern: "finishRun", path: "src/" })).toBe("grep finishRun");
		expect(formatToolActivity("web_search", { query: "pi thinking levels" })).toBe("web_search pi thinking levels");
	});

	it("falls back to the bare tool name when no telling argument exists", () => {
		expect(formatToolActivity("todo", {})).toBe("todo");
		expect(formatToolActivity("read", undefined)).toBe("read");
		expect(formatToolActivity("read", 42)).toBe("read");
	});

	it("collapses whitespace and truncates long targets", () => {
		expect(formatToolActivity("bash", { command: "a\nb   c" })).toBe("bash a b c");
		const out = formatToolActivity("bash", { command: "x".repeat(100) });
		expect(out.length).toBeLessThanOrEqual("bash ".length + 60);
		expect(out).toContain("…");
	});
});

describe("MonitorStore.subscribe", () => {
	it("notifies on mutation and stops after unsubscribe", () => {
		const store = new MonitorStore();
		let count = 0;
		const unsub = store.subscribe(() => {
			count++;
		});
		store.addRun("worker", "Implement the change");
		expect(count).toBe(1);
		unsub();
		store.addRun("explore", "Map the codebase");
		expect(count).toBe(1);
	});

	it("summarize produces a compact one-liner", () => {
		const store = new MonitorStore();
		const id = store.addRun("worker", "Implement the change", "anthropic/claude-sonnet-4-5");
		store.setUsage(id, { input: 1200, output: 300, cacheRead: 0, cacheWrite: 0, cost: 0.04, contextTokens: 0, turns: 2 });
		const line = store.summarize(store.getRuns()[0]);
		expect(line).toContain("worker");
		expect(line).toContain("anthropic/claude-sonnet-4-5");
		expect(line).toContain("↑1.2k");
	});

	it("records and summarizes the thinking strength", () => {
		const store = new MonitorStore();
		const id = store.addRun("worker", "Implement the change", "anthropic/claude-sonnet-4-5", "high");
		const run = store.getRuns()[0];
		expect(run.thinking).toBe("high");
		expect(store.summarize(run)).toContain("thinking high");
		store.setUsage(id, { input: 1200, output: 300, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 2 });
		expect(store.summarize(run)).toContain("thinking high");
		expect(store.summarize(run)).toContain("↑1.2k");
	});

	it("omits the thinking segment when absent", () => {
		const store = new MonitorStore();
		store.addRun("explore", "Map the codebase");
		const run = store.getRuns()[0];
		expect(store.summarize(run)).not.toContain("thinking");
	});

	it("records chain metadata and surfaces the relationLabel in summarize", () => {
		const store = new MonitorStore();
		store.addRun("worker", "Fix the bug", undefined, undefined, {
			groupId: "fix-1",
			relationLabel: "fix round 1",
		});
		const run = store.getRuns()[0];
		expect(run.groupId).toBe("fix-1");
		expect(run.relationLabel).toBe("fix round 1");
		expect(store.summarize(run)).toContain("fix round 1");
	});

	it("omits chain metadata when not provided", () => {
		const store = new MonitorStore();
		store.addRun("worker", "Fix the bug");
		const run = store.getRuns()[0];
		expect(run.groupId).toBeUndefined();
		expect(run.relationLabel).toBeUndefined();
	});
});

describe("MonitorStore tool tracking", () => {
	it("recordToolStart counts tools, marks the tool current, and sets activity", () => {
		const store = new MonitorStore();
		const id = store.addRun("worker", "Implement the change");
		store.setStatus(id, "running");
		store.recordToolStart(id, "read", "read src/index.ts");
		const run = store.getRuns()[0];
		expect(run.toolCount).toBe(1);
		expect(run.currentTool).toBe("read");
		expect(run.activity).toBe("read src/index.ts");
		expect(run.lastActivityAt).toBeTypeOf("number");
		store.recordToolStart(id, "bash", "bash npm test");
		expect(store.getRuns()[0].toolCount).toBe(2);
		expect(store.getRuns()[0].currentTool).toBe("bash");
	});

	it("recordToolEnd clears the current tool and notes failures", () => {
		const store = new MonitorStore();
		const id = store.addRun("worker", "Implement the change");
		store.setStatus(id, "running");
		store.recordToolStart(id, "bash", "bash npm test");
		store.recordToolEnd(id, "bash", false);
		const run = store.getRuns()[0];
		expect(run.currentTool).toBeUndefined();
		// A successful end keeps the last activity; a failed end overwrites it.
		expect(run.activity).toBe("bash npm test");
		store.recordToolEnd(id, "bash", true);
		expect(store.getRuns()[0].activity).toBe("✗ bash failed");
	});

	it("ignores tool tracking for unknown runs", () => {
		const store = new MonitorStore();
		store.recordToolStart(999, "read", "read x");
		store.recordToolEnd(999, "read", false);
		expect(store.getRuns()).toHaveLength(0);
	});
});

describe("deriveActivityState", () => {
	it("returns undefined for non-running runs", () => {
		const store = new MonitorStore();
		const id = store.addRun("worker", "Implement the change");
		store.setStatus(id, "done");
		expect(deriveActivityState(store.getRuns()[0], Date.now())).toBeUndefined();
	});

	it("returns needs_attention when idle (no tool) past the threshold", () => {
		const store = new MonitorStore();
		const id = store.addRun("worker", "Implement the change");
		store.setStatus(id, "running");
		const startedAt = store.getRuns()[0].startedAt as number;
		expect(deriveActivityState(store.getRuns()[0], startedAt + NEEDS_ATTENTION_AFTER_MS + 1)).toBe("needs_attention");
	});

	it("does not flag needs_attention while a tool is running", () => {
		const store = new MonitorStore();
		const id = store.addRun("worker", "Implement the change");
		store.setStatus(id, "running");
		store.recordToolStart(id, "bash", "bash npm test");
		const startedAt = store.getRuns()[0].startedAt as number;
		expect(deriveActivityState(store.getRuns()[0], startedAt + NEEDS_ATTENTION_AFTER_MS + 1)).toBeUndefined();
	});

	it("resets the idle clock on activity after a tool ends", () => {
		const store = new MonitorStore();
		const id = store.addRun("worker", "Implement the change");
		store.setStatus(id, "running");
		const startedAt = store.getRuns()[0].startedAt as number;
		// Far past the threshold while idle.
		expect(deriveActivityState(store.getRuns()[0], startedAt + NEEDS_ATTENTION_AFTER_MS + 5)).toBe("needs_attention");
		// A tool start refreshes lastActivityAt; just under the threshold after it.
		store.recordToolStart(id, "read", "read src/index.ts");
		const afterTool = store.getRuns()[0].lastActivityAt as number;
		store.recordToolEnd(id, "read", false);
		expect(deriveActivityState(store.getRuns()[0], afterTool + 100)).toBeUndefined();
	});

	it("returns active_long_running when total elapsed passes its threshold", () => {
		const store = new MonitorStore();
		const id = store.addRun("worker", "Implement the change");
		store.setStatus(id, "running");
		// Keep it "busy" with a tool so needs_attention cannot fire.
		store.recordToolStart(id, "bash", "bash long-test");
		const startedAt = store.getRuns()[0].startedAt as number;
		expect(deriveActivityState(store.getRuns()[0], startedAt + ACTIVE_LONG_RUNNING_AFTER_MS + 1)).toBe("active_long_running");
	});

	it("needs_attention takes priority over active_long_running", () => {
		const store = new MonitorStore();
		const id = store.addRun("worker", "Implement the change");
		store.setStatus(id, "running");
		const startedAt = store.getRuns()[0].startedAt as number;
		// Both thresholds exceeded, but no tool running → needs_attention wins.
		expect(deriveActivityState(store.getRuns()[0], startedAt + ACTIVE_LONG_RUNNING_AFTER_MS + 1)).toBe("needs_attention");
	});
});

describe("compactModelRef", () => {
	it("strips the provider prefix", () => {
		expect(compactModelRef("anthropic/claude-sonnet-4-5")).toBe("claude-sonnet-4-5");
		expect(compactModelRef("openai-codex/gpt-5.6-sol")).toBe("gpt-5.6-sol");
	});
	it("returns empty for undefined and leaves a bare id unchanged", () => {
		expect(compactModelRef(undefined)).toBe("");
		expect(compactModelRef("claude-sonnet-4-5")).toBe("claude-sonnet-4-5");
	});
	it("only drops the last slash segment", () => {
		expect(compactModelRef("org/provider/model-x")).toBe("model-x");
	});
});

describe("activityStateLabel", () => {
	it("maps states to short labels", () => {
		expect(activityStateLabel("needs_attention")).toBe("idle");
		expect(activityStateLabel("active_long_running")).toBe("long-running");
	});
});

describe("rightAlign", () => {
	it("places right at the far edge and pads the gap", () => {
		const line = rightAlign("left side", "right", 20);
		expect(line.endsWith("right")).toBe(true);
		expect(visibleWidth(line)).toBeLessThanOrEqual(20);
		expect(line.startsWith("left side")).toBe(true);
	});
	it("clips the left when it overflows, keeping the right fully visible", () => {
		const line = rightAlign("a very long left side that does not fit", "RIGHT", 20);
		expect(line.endsWith("RIGHT")).toBe(true);
		expect(line).toContain("RIGHT");
		expect(visibleWidth(line)).toBeLessThanOrEqual(20);
	});
	it("handles ANSI-styled strings by display width", () => {
		// styled left/right must still align by visible columns, not byte length.
		const line = rightAlign("\x1b[31mred\x1b[0m left", "\x1b[32mgreen\x1b[0m", 20);
		expect(visibleWidth(line)).toBeLessThanOrEqual(20);
		expect(line).toContain("green");
	});
});

describe("compactLine", () => {
	it("places the right side directly after the left with no center gap", () => {
		const line = compactLine("left", " · right", 20);
		expect(line.startsWith("left")).toBe(true);
		expect(line).toContain("left · right");
		expect(visibleWidth(line)).toBeLessThanOrEqual(20);
	});
	it("clips the combined line to width on overflow", () => {
		const line = compactLine("a very long left side", " · RIGHT", 20);
		expect(visibleWidth(line)).toBeLessThanOrEqual(20);
	});
	it("returns just the left when the right is empty", () => {
		const line = compactLine("left", "", 20);
		expect(line).toBe("left");
	});
	it("handles ANSI-styled strings by display width", () => {
		const line = compactLine("\x1b[31mred\x1b[0m left", " \x1b[32mgreen\x1b[0m", 20);
		expect(visibleWidth(line)).toBeLessThanOrEqual(20);
		expect(line).toContain("green");
	});
});

describe("status labels and timing", () => {
	it("statusLabel maps statuses to user-facing words", () => {
		expect(statusLabel("queued")).toBe("ready");
		expect(statusLabel("running")).toBe("running");
		expect(statusLabel("done")).toBe("done");
		expect(statusLabel("failed")).toBe("stopped");
	});

	it("formatDuration renders seconds, minutes and hours", () => {
		expect(formatDuration(0)).toBe("0s");
		expect(formatDuration(5_000)).toBe("5s");
		expect(formatDuration(65_000)).toBe("1m05s");
		expect(formatDuration(3_725_000)).toBe("1h02m");
	});

	it("records startedAt on running and endedAt on completion", () => {
		const store = new MonitorStore();
		const id = store.addRun("worker", "Implement the change");
		expect(store.getRuns()[0].startedAt).toBeUndefined();
		store.setStatus(id, "running");
		const startedAt = store.getRuns()[0].startedAt;
		expect(startedAt).toBeTypeOf("number");
		store.setStatus(id, "done");
		const run = store.getRuns()[0];
		expect(run.endedAt).toBeTypeOf("number");
		expect(formatElapsed(run)).toBe(formatDuration((run.endedAt as number) - (run.startedAt as number)));
	});

	it("summarize includes elapsed time once running", () => {
		const store = new MonitorStore();
		const id = store.addRun("worker", "Implement the change");
		store.setStatus(id, "running");
		expect(store.summarize(store.getRuns()[0])).toMatch(/\d+s/);
	});
});
