import { describe, expect, it, vi } from "vitest";
import {
	TrajectoryStore,
	TOOL_ARG_SUMMARY_MAX,
	TOOL_ARG_VALUE_MAX,
	TrajectoryLog,
	summarizeToolArgs,
	TRAJECTORY_VERSION,
} from "../src/trajectory.ts";

const noop = (): void => {};

describe("TrajectoryLog", () => {
	it("appends events in order across generations without overwriting prior events", () => {
		const log = new TrajectoryLog(7, noop);
		log.append({ kind: "dispatch", agent: "worker", task: "first objective" }, 1_000);
		log.append({ kind: "status", status: "running" }, 1_100);
		expect(log.generation).toBe(1);

		const next = log.restart();
		expect(next).toBe(2);
		log.append({ kind: "resume" }, 2_000);
		log.append({ kind: "dispatch", agent: "worker", task: "second objective", resumed: true }, 2_100);

		const events = log.getEvents();
		expect(events).toHaveLength(4);
		// Append order + per-event generation + source timestamps are preserved.
		expect(events.map((event) => event.generation)).toEqual([1, 1, 2, 2]);
		expect(events.map((event) => event.at)).toEqual([1_000, 1_100, 2_000, 2_100]);
		expect(events.map((event) => event.kind)).toEqual(["dispatch", "status", "resume", "dispatch"]);
		expect(events.every((event) => event.v === TRAJECTORY_VERSION && event.runId === 7)).toBe(true);

		// Current-generation view contains only generation-2 events.
		expect(log.getGenerationEvents().map((event) => event.kind)).toEqual(["resume", "dispatch"]);
	});

	it("does not overwrite summary state across restarts; clears summary but never history", () => {
		const log = new TrajectoryLog(1, noop);
		log.append({ kind: "tool_start", tool: "read", summary: "path=src/index.ts" }, 100);
		log.append({ kind: "candidate", model: "anthropic/claude-sonnet-4-5", fallbackFrom: "openai/gpt-5" }, 200);
		expect(log.summary().toolCount).toBe(1);
		expect(log.summary().model).toBe("anthropic/claude-sonnet-4-5");
		expect(log.summary().modelFallbackFrom).toBe("openai/gpt-5");

		log.restart();
		// Mutable summary resets for the new generation…
		expect(log.summary().toolCount).toBe(0);
		expect(log.summary().model).toBeUndefined();
		expect(log.summary().modelFallbackFrom).toBeUndefined();
		// …but the history is append-only.
		expect(log.getEvents()).toHaveLength(2);
	});

	it("tracks model/status/tool events in the mutable summary", () => {
		const log = new TrajectoryLog(2, noop);
		log.append({ kind: "dispatch", agent: "explore", task: "map the repo", model: "a/primary", thinking: "low", pool: ["b/backup"] }, 10);
		expect(log.summary().model).toBe("a/primary");
		expect(log.summary().thinking).toBe("low");

		log.append({ kind: "tool_start", tool: "grep", summary: "pattern=foo" }, 20);
		log.append({ kind: "tool_start", tool: "read", summary: "path=x" }, 30);
		expect(log.summary().toolCount).toBe(2);
		expect(log.summary().currentTool).toBe("read");

		log.append({ kind: "tool_end", tool: "read", isError: false }, 40);
		expect(log.summary().currentTool).toBeUndefined();

		log.append({ kind: "settled", status: "done", model: "a/primary" }, 50);
		expect(log.summary().endedAt).toBe(50);

		log.append({ kind: "usage", usage: { input: 3, output: 4, cacheRead: 0, cacheWrite: 0, cost: 0.1, contextTokens: 7, turns: 1 }, model: "a/primary" }, 60);
		const usage = log.getEvents().find((event) => event.kind === "usage");
		expect(usage).toMatchObject({ kind: "usage", model: "a/primary" });
	});

	it("notifies observers on append and survives throwing observers", () => {
		const boom = vi.fn(() => {
			throw new Error("observer exploded");
		});
		const log = new TrajectoryLog(3, boom);
		expect(() => log.append({ kind: "status", status: "running" })).not.toThrow();
		expect(boom).toHaveBeenCalledOnce();
		expect(log.getEvents()).toHaveLength(1);
	});

	it("clearAll wipes history and summary (parent-session teardown)", () => {
		const log = new TrajectoryLog(4, noop);
		log.append({ kind: "dispatch", agent: "worker", task: "t" });
		log.append({ kind: "tool_start", tool: "bash", summary: "command=npm test" });
		log.clearAll();
		expect(log.getEvents()).toHaveLength(0);
		expect(log.summary().toolCount).toBe(0);
	});
});

describe("summarizeToolArgs", () => {
	it("redacts obvious secret fields while keeping normal arguments", () => {
		const summary = summarizeToolArgs({
			path: "src/index.ts",
			token: "ghp_secret123",
			password: "hunter2",
			Authorization: "Bearer abc",
			apiKey: "sk-1234",
			client_secret: "shh",
		});
		expect(summary).toContain("path=src/index.ts");
		expect(summary).toContain("token=<redacted>");
		expect(summary).toContain("password=<redacted>");
		expect(summary).toContain("Authorization=<redacted>");
		expect(summary).toContain("apiKey=<redacted>");
		// Field lists are capped and marked with an ellipsis; redaction of the
		// visible entries still holds and no secret value ever leaks.
		expect(summary).toContain("…");
		expect(summary).not.toContain("ghp_secret123");
		expect(summary).not.toContain("hunter2");
		expect(summary).not.toContain("sk-1234");
		expect(summary).not.toContain("shh");
	});

	it("truncates long scalar values and omits deep payloads", () => {
		const summary = summarizeToolArgs({
			command: "x".repeat(500),
			config: { nested: { deep: true } },
			items: [1, 2, 3],
		});
		expect(summary).toContain("command=");
		expect(summary.length).toBeLessThanOrEqual(TOOL_ARG_SUMMARY_MAX + 1);
		expect(summary).toContain("config={…}");
		expect(summary).toContain("items={…}");
		expect(summary).not.toContain('"deep"');
		// The single value never exceeds its scalar budget (plus key + ellipsis).
		const commandValue = /^command=([^ ]+)/.exec(summary)?.[1] ?? "";
		expect([...commandValue].length).toBeLessThanOrEqual(TOOL_ARG_VALUE_MAX);
		expect(commandValue.endsWith("…")).toBe(true);
	});

	it("redacts credentials embedded inside ordinary command values", () => {
		const summary = summarizeToolArgs({
			command: "curl -H 'Authorization: Bearer super-secret-token' https://example.test?token=query-secret",
		});
		expect(summary).toContain("Authorization: Bearer <redacted>");
		expect(summary).not.toContain("super-secret-token");
		expect(summary).not.toContain("query-secret");
	});

	it("handles non-object and missing args without throwing", () => {
		expect(summarizeToolArgs(undefined)).toBe("");
		expect(summarizeToolArgs(null)).toBe("");
		expect(summarizeToolArgs("plain string")).toBe("plain string");
		expect(summarizeToolArgs(42)).toBe("42");
	});
});

describe("TrajectoryStore", () => {
	it("keeps one trajectory per thread id and clears on parent-session teardown", () => {
		const store = new TrajectoryStore();
		const state = store.get(1);
		state.trajectory.append({ kind: "dispatch", agent: "worker", task: "x" });
		expect(store.get(1)).toBe(state);
		expect(state.trajectory.getEvents()).toHaveLength(1);

		store.clearAll();
		expect(state.trajectory.getEvents()).toHaveLength(0);
		expect(store.get(1)).not.toBe(state);
	});
});
