import { afterEach, describe, expect, it, vi } from "vitest";
import {
	completionGroupTriggersTurn,
	completionTriggersTurn,
	createCompletionBatcher,
	formatCompletionMessage,
	type CompletionMessageItem,
} from "../src/completion.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";
import type { SingleResult } from "../src/spawn.ts";

function useFakeClock(): void {
	vi.useFakeTimers();
	vi.setSystemTime(0);
}

function result(
	agent: string,
	output: string,
	overrides: Partial<SingleResult> = {},
): SingleResult {
	return {
		agent,
		agentSource: "builtin",
		task: "Review the change",
		exitCode: 0,
		messages: [{ role: "assistant", content: [{ type: "text", text: output }] } as any],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 },
		...overrides,
	};
}

function messageItem(agent: string, triggerTurn: boolean): CompletionMessageItem {
	return { agent, block: `### [${agent}] completed\n\nTask: task\n\noutput`, triggerTurn };
}

afterEach(() => {
	vi.useRealTimers();
});

describe("createCompletionBatcher", () => {
	it("groups two pushes that arrive within the debounce window", () => {
		useFakeClock();
		const emitted: string[][] = [];
		const batcher = createCompletionBatcher<string>({ emit: (items) => emitted.push(items) });

		batcher.push("worker");
		vi.advanceTimersByTime(100);
		batcher.push("reviewer");
		vi.advanceTimersByTime(149);
		expect(emitted).toEqual([]);
		vi.advanceTimersByTime(1);
		expect(emitted).toEqual([["worker", "reviewer"]]);
		batcher.dispose();
	});

	it("emits a lone item at the hard max-wait cap", () => {
		useFakeClock();
		const emitted: string[][] = [];
		const batcher = createCompletionBatcher<string>({
			emit: (items) => emitted.push(items),
			timings: { debounceMs: 2_000, maxWaitMs: 1_000 },
		});

		batcher.push("worker");
		vi.advanceTimersByTime(999);
		expect(emitted).toEqual([]);
		vi.advanceTimersByTime(1);
		expect(emitted).toEqual([["worker"]]);
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

		batcher.push("worker");
		batcher.push("reviewer");
		batcher.flush();
		expect(emitted).toEqual([["worker", "reviewer"]]);
		vi.advanceTimersByTime(1_000);
		expect(emitted).toEqual([["worker", "reviewer"]]);
		batcher.dispose();
	});

	it("dispose clears held items without emitting", () => {
		useFakeClock();
		const emitted: string[][] = [];
		const batcher = createCompletionBatcher<string>({ emit: (items) => emitted.push(items) });

		batcher.push("worker");
		expect(batcher.dispose()).toEqual(["worker"]);
		expect(batcher.dispose()).toEqual([]);
		vi.advanceTimersByTime(1_000);
		expect(emitted).toEqual([]);
	});

	it("uses the shorter debounce for a straggler group", () => {
		useFakeClock();
		const emitted: string[][] = [];
		const batcher = createCompletionBatcher<string>({ emit: (items) => emitted.push(items) });

		batcher.push("first");
		vi.advanceTimersByTime(150);
		expect(emitted).toEqual([["first"]]);

		vi.advanceTimersByTime(100);
		batcher.push("straggler-1");
		vi.advanceTimersByTime(50);
		batcher.push("straggler-2");
		vi.advanceTimersByTime(74);
		expect(emitted).toEqual([["first"]]);
		vi.advanceTimersByTime(1);
		expect(emitted).toEqual([["first"], ["straggler-1", "straggler-2"]]);
		batcher.dispose();
	});

	it("caps a straggler group at the shorter max-wait", () => {
		useFakeClock();
		const emitted: string[][] = [];
		const batcher = createCompletionBatcher<string>({
			emit: (items) => emitted.push(items),
			timings: {
				debounceMs: 2_000,
				maxWaitMs: 1_000,
				stragglerDebounceMs: 2_000,
				stragglerMaxWaitMs: 400,
				stragglerWindowMs: 2_000,
			},
		});

		batcher.push("first");
		vi.advanceTimersByTime(1_000);
		expect(emitted).toEqual([["first"]]);

		batcher.push("straggler");
		vi.advanceTimersByTime(399);
		expect(emitted).toEqual([["first"]]);
		vi.advanceTimersByTime(1);
		expect(emitted).toEqual([["first"], ["straggler"]]);
		batcher.dispose();
	});

	it("treats an item at the exact straggler window edge as a fresh group", () => {
		useFakeClock();
		const emitted: string[][] = [];
		const batcher = createCompletionBatcher<string>({ emit: (items) => emitted.push(items) });

		batcher.push("first");
		vi.advanceTimersByTime(150);
		expect(emitted).toEqual([["first"]]);

		// Exactly 2000ms after the emit: not a straggler → normal 150ms debounce.
		vi.advanceTimersByTime(2_000);
		batcher.push("fresh");
		vi.advanceTimersByTime(74);
		expect(emitted).toEqual([["first"]]);
		vi.advanceTimersByTime(1);
		expect(emitted).toEqual([["first"]]); // 75 < 150 → still pending
		vi.advanceTimersByTime(75);
		expect(emitted).toEqual([["first"], ["fresh"]]);
		batcher.dispose();
	});

	it("handles a push made from inside the emit callback", () => {
		useFakeClock();
		const emitted: string[][] = [];
		let reentered = false;
		const batcher = createCompletionBatcher<string>({
			emit: (items) => {
				emitted.push(items);
				if (!reentered) {
					reentered = true;
					batcher.push("reentrant");
				}
			},
		});

		batcher.push("first");
		vi.advanceTimersByTime(150);
		expect(emitted).toEqual([["first"]]);
		vi.advanceTimersByTime(150);
		expect(emitted).toEqual([["first"], ["reentrant"]]);
		batcher.dispose();
	});
});

describe("completion trigger decisions", () => {
	it("does not wake for an opted-in passing reviewer result", () => {
		expect(completionTriggersTurn(result("reviewer", "VERDICT: REVIEW_PASS"), true)).toBe(false);
	});

	it("wakes for a failed reviewer result", () => {
		expect(completionTriggersTurn(result("reviewer", "VERDICT: REVIEW_FAIL"), true)).toBe(true);
		expect(
			completionTriggersTurn(result("reviewer", "VERDICT: REVIEW_PASS", { exitCode: 1 }), true),
		).toBe(true);
	});

	it("keeps passing reviews waking under the default config", () => {
		expect(DEFAULT_CONFIG.notifyOnReviewPass).toBe(false);
		expect(
			completionTriggersTurn(
				result("reviewer", "VERDICT: REVIEW_PASS"),
				DEFAULT_CONFIG.notifyOnReviewPass,
			),
		).toBe(true);
	});

	it("wakes a mixed group when any item requires a turn", () => {
		expect(completionGroupTriggersTurn([messageItem("reviewer", false), messageItem("worker", true)])).toBe(true);
		expect(completionGroupTriggersTurn([messageItem("reviewer", false), messageItem("reviewer", false)])).toBe(false);
	});
});

describe("formatCompletionMessage", () => {
	it("keeps the existing single-result block unchanged", () => {
		const item = messageItem("worker", true);
		expect(formatCompletionMessage([item])).toBe(item.block);
	});

	it("adds a group header and retains each result block", () => {
		const worker = messageItem("worker", true);
		const reviewer = messageItem("reviewer", false);
		expect(formatCompletionMessage([worker, reviewer])).toBe(
			`### Subagents completed (2): worker, reviewer\n\n${worker.block}\n\n${reviewer.block}`,
		);
	});
});
