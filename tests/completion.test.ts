import { afterEach, describe, expect, it, vi } from "vitest";
import {
	completionGroupTriggersTurn,
	createCompletionBatcher,
	formatActiveRunsFooter,
	formatCompletionMessage,
	type ActiveRunFoot,
	type CompletionMessageItem,
} from "../src/completion.ts";
import type { UsageStats } from "../src/rpc-run.ts";

function useFakeClock(): void {
	vi.useFakeTimers();
	vi.setSystemTime(0);
}

function messageItem(agent: string, triggerTurn: boolean, usage?: UsageStats): CompletionMessageItem {
	return { agent, block: `### [${agent}] completed\n\nTask: task\n\noutput`, triggerTurn, ...(usage ? { usage } : {}) };
}

const usage = (overrides: Partial<UsageStats> = {}): UsageStats => ({
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	cost: 0,
	contextTokens: 0,
	turns: 0,
	...overrides,
});

afterEach(() => {
	vi.useRealTimers();
});

describe("createCompletionBatcher", () => {
	it("groups two pushes that arrive within the debounce window", () => {
		useFakeClock();
		const emitted: string[][] = [];
		const batcher = createCompletionBatcher<string>({ emit: (items) => emitted.push(items) });

		batcher.push("executor");
		vi.advanceTimersByTime(100);
		batcher.push("explorer");
		vi.advanceTimersByTime(149);
		expect(emitted).toEqual([]);
		vi.advanceTimersByTime(1);
		expect(emitted).toEqual([["executor", "explorer"]]);
		batcher.dispose();
	});

	it("emits a lone item at the hard max-wait cap", () => {
		useFakeClock();
		const emitted: string[][] = [];
		const batcher = createCompletionBatcher<string>({
			emit: (items) => emitted.push(items),
			timings: { debounceMs: 2_000, maxWaitMs: 1_000 },
		});

		batcher.push("executor");
		vi.advanceTimersByTime(999);
		expect(emitted).toEqual([]);
		vi.advanceTimersByTime(1);
		expect(emitted).toEqual([["executor"]]);
		batcher.dispose();
	});

	it("measures max wait from the first item while debounce keeps resetting", () => {
		useFakeClock();
		const emitted: string[][] = [];
		const batcher = createCompletionBatcher<string>({ emit: (items) => emitted.push(items) });

		batcher.push("first");
		for (let index = 1; index <= 9; index++) {
			vi.advanceTimersByTime(100);
			batcher.push(`late-${index}`);
		}
		vi.advanceTimersByTime(99);
		expect(emitted).toEqual([]);
		vi.advanceTimersByTime(1);
		expect(emitted).toEqual([["first", ...Array.from({ length: 9 }, (_, index) => `late-${index + 1}`)]]);
		batcher.dispose();
	});

	it("flush emits held items immediately and cancels deferred emission", () => {
		useFakeClock();
		const emitted: string[][] = [];
		const batcher = createCompletionBatcher<string>({ emit: (items) => emitted.push(items) });

		batcher.push("executor");
		batcher.push("explorer");
		batcher.flush();
		expect(emitted).toEqual([["executor", "explorer"]]);
		vi.advanceTimersByTime(1_000);
		expect(emitted).toEqual([["executor", "explorer"]]);
		batcher.dispose();
	});

	it("dispose clears held items without emitting", () => {
		useFakeClock();
		const emitted: string[][] = [];
		const batcher = createCompletionBatcher<string>({ emit: (items) => emitted.push(items) });

		batcher.push("executor");
		expect(batcher.dispose()).toEqual(["executor"]);
		expect(batcher.dispose()).toEqual([]);
		vi.advanceTimersByTime(1_000);
		expect(emitted).toEqual([]);
	});
});

describe("completion trigger decisions", () => {
	it("wakes a mixed group when any item requires a turn", () => {
		expect(completionGroupTriggersTurn([messageItem("explorer", false), messageItem("executor", true)])).toBe(true);
		expect(completionGroupTriggersTurn([messageItem("explorer", false), messageItem("explorer", false)])).toBe(false);
	});
});

describe("formatCompletionMessage", () => {
	it("keeps the existing single-result block unchanged", () => {
		const item = messageItem("executor", true);
		expect(formatCompletionMessage([item])).toBe(item.block);
	});

	it("adds a group header and retains each result block", () => {
		const executor = messageItem("executor", true);
		const explorer = messageItem("explorer", false);
		expect(formatCompletionMessage([executor, explorer])).toBe(
			`### Subagents completed (2): executor, explorer\n\n${executor.block}\n\n${explorer.block}`,
		);
	});

	it("appends aggregate token/cost totals for a group with usage", () => {
		const executor = messageItem("executor", true, usage({ input: 1_000, output: 500, cacheRead: 5_000, cost: 0.25, turns: 3 }));
		const explorer = messageItem("explorer", false, usage({ input: 2_000, output: 100, cacheWrite: 200, cost: 0.125, turns: 2 }));
		const text = formatCompletionMessage([executor, explorer]);
		expect(text).toContain(`\n\nTotals: 2 runs · ↑3.0k ↓600 R5.0k W200 $0.3750`);
	});
});

describe("formatActiveRunsFooter", () => {
	it("returns empty when no runs are active", () => {
		expect(formatActiveRunsFooter([])).toBe("");
	});

	it("names each active run with its label and warns against concluding", () => {
		const runs: ActiveRunFoot[] = [
			{ id: 3, agent: "executor", label: "src/index.ts" },
			{ id: 4, agent: "explorer" },
		];
		const footer = formatActiveRunsFooter(runs);
		expect(footer).toContain("2 other runs still active");
		expect(footer).toContain("#3 executor·src/index.ts");
		expect(footer).toContain("#4 explorer");
		expect(footer).toContain("Do not conclude the overall task yet");
	});

	it("collapses a long active list behind a +N more", () => {
		const runs: ActiveRunFoot[] = Array.from({ length: 6 }, (_, i) => ({ id: i + 1, agent: "executor" }));
		const footer = formatActiveRunsFooter(runs);
		expect(footer).toContain("6 other runs still active");
		expect(footer).toContain("+2 more");
	});

	it("tags each waiting run with its true wait so pacing is never read as a stall or a full pool", () => {
		const runs: ActiveRunFoot[] = [
			{ id: 1, agent: "executor", wait: "process-slot" },
			{ id: 2, agent: "executor", wait: "repository-lane" },
			{ id: 3, agent: "executor", wait: "starting" },
			{ id: 4, agent: "executor" },
		];
		const footer = formatActiveRunsFooter(runs);
		expect(footer).toContain("#1 executor (queued, starts when a process slot frees)");
		expect(footer).toContain("#2 executor (waiting for the repository write lane, not for a slot)");
		expect(footer).toContain("#3 executor (starting)");
		expect(footer).toContain("#4 executor.");
		expect(footer).not.toContain("#4 executor (");
	});
});
