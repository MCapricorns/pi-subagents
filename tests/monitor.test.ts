import { describe, expect, it } from "vitest";
import { MonitorStore } from "../src/monitor.ts";

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
		expect(runs[0].transcript).toEqual([]);
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

describe("MonitorStore.appendTextDelta", () => {
	it("merges consecutive deltas into a single coherent text line", () => {
		const store = new MonitorStore();
		const id = store.addRun("worker");
		store.appendTextDelta(id, "Hel");
		store.appendTextDelta(id, "lo ");
		store.appendTextDelta(id, "world");
		const t = store.getRuns()[0].transcript;
		expect(t).toEqual([{ kind: "text", text: "Hello world" }]);
	});

	it("splits on real newlines into separate lines", () => {
		const store = new MonitorStore();
		const id = store.addRun("worker");
		store.appendTextDelta(id, "line1\nline2");
		const t = store.getRuns()[0].transcript;
		expect(t).toEqual([
			{ kind: "text", text: "line1" },
			{ kind: "text", text: "line2" },
		]);
	});

	it("does not merge text across an intervening tool line", () => {
		const store = new MonitorStore();
		const id = store.addRun("worker");
		store.appendTextDelta(id, "before");
		store.appendTranscript(id, { kind: "tool", text: "▸ read(x)" });
		store.appendTextDelta(id, "after");
		const t = store.getRuns()[0].transcript;
		expect(t).toEqual([
			{ kind: "text", text: "before" },
			{ kind: "tool", text: "▸ read(x)" },
			{ kind: "text", text: "after" },
		]);
	});

	it("ignores empty deltas", () => {
		const store = new MonitorStore();
		const id = store.addRun("worker");
		store.appendTextDelta(id, "");
		expect(store.getRuns()[0].transcript).toEqual([]);
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
		expect(line).toContain("queued");
	});
});
