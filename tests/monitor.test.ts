import { describe, expect, it } from "vitest";
import { MonitorStore, formatDuration, formatElapsed, formatToolActivity, statusLabel } from "../src/monitor.ts";

describe("MonitorStore", () => {
	it("addRun creates a queued run with zero usage", () => {
		const store = new MonitorStore();
		const id = store.addRun("worker", "anthropic/claude-sonnet-4-5");
		const runs = store.getRuns();
		expect(runs).toHaveLength(1);
		expect(runs[0].id).toBe(id);
		expect(runs[0].agent).toBe("worker");
		expect(runs[0].model).toBe("anthropic/claude-sonnet-4-5");
		expect(runs[0].status).toBe("queued");
		expect(runs[0].usage.input).toBe(0);
		expect(runs[0].activity).toBeUndefined();
	});

	it("beginTurn clears finished runs but keeps active ones", () => {
		const store = new MonitorStore();
		const done = store.addRun("explore");
		store.setStatus(done, "done");
		const active = store.addRun("worker");
		store.setStatus(active, "running");
		store.beginTurn();
		const runs = store.getRuns();
		expect(runs).toHaveLength(1);
		expect(runs[0].id).toBe(active);
	});

	it("setUsage updates usage and model; setStatus updates status", () => {
		const store = new MonitorStore();
		const id = store.addRun("worker");
		store.setStatus(id, "running");
		store.setUsage(id, { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0.5, contextTokens: 0, turns: 1 }, "openai/gpt-x");
		const run = store.getRuns()[0];
		expect(run.status).toBe("running");
		expect(run.model).toBe("openai/gpt-x");
		expect(run.usage.input).toBe(10);
		expect(run.usage.cost).toBe(0.5);
	});
});

describe("MonitorStore activity", () => {
	it("setActivity records the current one-line activity, last writer wins", () => {
		const store = new MonitorStore();
		const id = store.addRun("worker");
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
		const id = store.addRun("worker");
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
		store.addRun("worker");
		expect(count).toBe(1);
		unsub();
		store.addRun("explore");
		expect(count).toBe(1);
	});

	it("summarize produces a compact one-liner", () => {
		const store = new MonitorStore();
		const id = store.addRun("worker", "anthropic/claude-sonnet-4-5");
		store.setUsage(id, { input: 1200, output: 300, cacheRead: 0, cacheWrite: 0, cost: 0.04, contextTokens: 0, turns: 2 });
		const line = store.summarize(store.getRuns()[0]);
		expect(line).toContain("worker");
		expect(line).toContain("anthropic/claude-sonnet-4-5");
		expect(line).toContain("↑1.2k");
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
		const id = store.addRun("worker");
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
		const id = store.addRun("worker");
		store.setStatus(id, "running");
		expect(store.summarize(store.getRuns()[0])).toMatch(/\d+s/);
	});
});
