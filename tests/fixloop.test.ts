import { describe, expect, it } from "vitest";
import { buildFixTaskBrief, buildReReviewBrief, shouldTriggerFixLoop } from "../src/fixloop.ts";
import { DEFAULT_CONFIG, type SubagentsConfig } from "../src/config.ts";
import type { SingleResult } from "../src/spawn.ts";

function assistant(text: string): any {
	return { role: "assistant", content: [{ type: "text", text }] };
}

function reviewResult(text: string, overrides: Partial<SingleResult> = {}): SingleResult {
	return {
		agent: "reviewer",
		agentSource: "builtin",
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
