import { describe, expect, it } from "vitest";
import { buildFixTaskBrief, buildReReviewBrief, formatChainSummary, shouldTriggerFixLoop, type ChainStep } from "../src/fixloop.ts";
import { DEFAULT_CONFIG, type SubagentsConfig } from "../src/config.ts";
import type { SingleResult } from "../src/spawn.ts";

function assistant(text: string): any {
	return { role: "assistant", content: [{ type: "text", text }] };
}

function reviewResult(text: string, overrides: Partial<SingleResult> = {}): SingleResult {
	return {
		agent: "reviewer",
		task: "Review the change",
		exitCode: 0,
		messages: [assistant(text)],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		...overrides,
	};
}

const config = (maxFixRounds: number): SubagentsConfig => ({ ...DEFAULT_CONFIG, maxFixRounds });

describe("shouldTriggerFixLoop", () => {
	it("triggers on a healthy reviewer REVIEW_FAIL when maxFixRounds > 0", () => {
		expect(shouldTriggerFixLoop(reviewResult("REQUEST_CHANGES\nVERDICT: REVIEW_FAIL"), config(2))).toBe(true);
	});

	it("does not trigger when maxFixRounds is 0 (loop disabled)", () => {
		expect(shouldTriggerFixLoop(reviewResult("VERDICT: REVIEW_FAIL"), config(0))).toBe(false);
	});

	it("does not trigger on a passing review", () => {
		expect(shouldTriggerFixLoop(reviewResult("APPROVE\nVERDICT: REVIEW_PASS"), config(2))).toBe(false);
	});

	it("does not trigger on a failed reviewer process (exit code != 0)", () => {
		expect(shouldTriggerFixLoop(reviewResult("VERDICT: REVIEW_FAIL", { exitCode: 1 }), config(2))).toBe(false);
	});

	it("does not trigger for non-reviewer agents", () => {
		expect(shouldTriggerFixLoop(reviewResult("VERDICT: REVIEW_FAIL", { agent: "worker" }), config(2))).toBe(false);
	});

	it("does not trigger when no verdict marker is present", () => {
		expect(shouldTriggerFixLoop(reviewResult("just a plain report"), config(2))).toBe(false);
	});
});

describe("buildFixTaskBrief", () => {
	it("embeds the reviewer's findings and the round number", () => {
		const brief = buildFixTaskBrief(reviewResult("## Critical\n- file.ts:42 bug\nVERDICT: REVIEW_FAIL"), 1, 2);
		expect(brief).toContain("round 1 of 2");
		expect(brief).toContain("file.ts:42 bug");
		expect(brief).toContain("REQUEST_CHANGES");
	});

	it("notes when this is the last round", () => {
		const brief = buildFixTaskBrief(reviewResult("VERDICT: REVIEW_FAIL"), 2, 2);
		expect(brief).toContain("last auto-fix round");
	});

	it("notes a re-review will follow when rounds remain", () => {
		const brief = buildFixTaskBrief(reviewResult("VERDICT: REVIEW_FAIL"), 1, 2);
		expect(brief).toContain("re-review your changes automatically");
	});
});

describe("buildReReviewBrief", () => {
	it("embeds the prior review and asks for a verdict", () => {
		const brief = buildReReviewBrief(reviewResult("## Critical\n- file.ts:42 bug\nVERDICT: REVIEW_FAIL"), 1);
		expect(brief).toContain("round 1");
		expect(brief).toContain("file.ts:42 bug");
		expect(brief).toContain("VERDICT: REVIEW_PASS / REVIEW_FAIL");
	});
});

describe("formatChainSummary", () => {
	const step = (overrides: Partial<SingleResult>, relation: string, runId = 1): ChainStep => ({
		runId,
		result: reviewResult("x", overrides),
		relation,
	});

	it("renders one line per step with verdicts, changed paths, and totals", () => {
		const summary = formatChainSummary([
			step({ messages: [assistant("found src/index.ts\nVERDICT: REVIEW_FAIL")] }, "initial review", 2),
			step({ agent: "worker", messages: [assistant("fixed src/index.ts")] }, "fix round 1", 3),
			step({ messages: [assistant("APPROVE\nVERDICT: REVIEW_PASS")] }, "re-review round 1", 4),
		]);
		expect(summary).toContain("## Auto-fix chain: 1 round — final PASS");
		expect(summary).toContain("- #2 reviewer · initial review · FAIL — src/index.ts");
		expect(summary).toContain("- #3 worker · fix round 1 · completed — changed: src/index.ts");
		expect(summary).toContain("- #4 reviewer · re-review round 1 · PASS");
		expect(summary).toContain("Totals: 3 runs");
		expect(summary).toContain("subagent_status #2 #3 #4");
	});

	it("counts rounds from fix steps and flags a failed final step", () => {
		const summary = formatChainSummary([
			step({ messages: [assistant("VERDICT: REVIEW_FAIL")] }, "initial review", 2),
			step({ agent: "worker", messages: [assistant("fixed")] }, "fix round 1", 3),
			step({ exitCode: 1, messages: [assistant("crashed mid-review")] }, "re-review round 1", 4),
		]);
		expect(summary).toContain("## Auto-fix chain: 1 round — final failed");
		expect(summary).toContain("- #4 reviewer · re-review round 1 · failed");
	});
});
