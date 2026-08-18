import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import {
	MonitorStore,
	extractKeyFragments,
	formatDuration,
	formatElapsed,
	formatTaskSummary,
	formatToolActivity,
	formatUsageCompact,
	runLabel,
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

	it("beginTurn preserves parked threads", () => {
		const store = new MonitorStore();
		const id = store.addRun("worker", "Checkpoint work");
		store.setStatus(id, "running");
		store.setStatus(id, "parked");
		store.beginTurn();
		expect(store.getRuns()).toHaveLength(1);
		expect(store.getRuns()[0].status).toBe("parked");
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

	it("setModel records the main handoff and failed selection", () => {
		const store = new MonitorStore();
		const id = store.addRun("worker", "Implement the change", "anthropic/primary");
		store.setModel(id, "openai/main", "anthropic/selected");
		expect(store.getRuns()[0].model).toBe("openai/main");
		expect(store.getRuns()[0].modelFallbackFrom).toBe("anthropic/selected");
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

	it("addRun carries chain metadata (groupId and relationLabel)", () => {
		const store = new MonitorStore();
		const id = store.addRun("worker", "Fix the findings", undefined, undefined, {
			groupId: "fix-3",
			relationLabel: "fix round 1",
		});
		const run = store.findRun(id);
		expect(run?.groupId).toBe("fix-3");
		expect(run?.relationLabel).toBe("fix round 1");
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

	it("redacts credentials and strips terminal controls from commands", () => {
		const activity = formatToolActivity("bash", {
			command: "\x1b]8;;https://attacker.test\x07curl\x1b]8;;\x07 -H 'Authorization: Bearer DO_NOT_LEAK_TEST_TOKEN' x?token=DO_NOT_LEAK_QUERY",
		});
		expect(activity).toContain("Authorization: Bearer <redacted>");
		expect(activity).not.toContain("DO_NOT_LEAK");
		expect(activity).not.toContain("\x1b");
		expect(activity).not.toContain("\x07");
		expect(formatToolActivity("bash", { command: "echo token=DO_NOT_LEAK_TEST_TOKEN" })).toBe(
			"bash echo token=<redacted>",
		);
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
	it("recordToolStart updates visible activity", () => {
		const store = new MonitorStore();
		const id = store.addRun("worker", "Implement the change");
		store.setStatus(id, "running");
		store.recordToolStart(id, "read", "read src/index.ts");
		expect(store.getRuns()[0].activity).toBe("read src/index.ts");
		store.recordToolStart(id, "bash", "bash npm test");
		expect(store.getRuns()[0].activity).toBe("bash npm test");
	});

	it("sanitizes activity again at the monitor storage boundary", () => {
		const store = new MonitorStore();
		const id = store.addRun("worker", "Implement the change");
		store.recordToolStart(
			id,
			"\x1b[31mbash\x1b[0m",
			"bash curl -H 'Authorization: Bearer DO_NOT_LEAK_TEST_TOKEN' x?token=DO_NOT_LEAK_QUERY \x1b[2K",
		);
		const run = store.findRun(id);
		expect(run?.activity).toContain("Authorization: Bearer <redacted>");
		expect(run?.activity).not.toContain("DO_NOT_LEAK");
		expect(run?.activity).not.toContain("\x1b");
	});

	it("recordToolEnd keeps successful activity and notes failures", () => {
		const store = new MonitorStore();
		const id = store.addRun("worker", "Implement the change");
		store.setStatus(id, "running");
		store.recordToolStart(id, "bash", "bash npm test");
		store.recordToolEnd(id, "bash", false);
		const run = store.getRuns()[0];
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

describe("status labels and timing", () => {
	it("statusLabel maps statuses to user-facing words", () => {
		expect(statusLabel("queued")).toBe("ready");
		expect(statusLabel("running")).toBe("running");
		expect(statusLabel("steering")).toBe("steering");
		expect(statusLabel("interrupting")).toBe("interrupting");
		expect(statusLabel("parked")).toBe("parked");
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
