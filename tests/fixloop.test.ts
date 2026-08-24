import { describe, expect, it } from "vitest";
import {
	buildDocumenterTaskBrief,
	buildFinalReviewBrief,
	buildFixTaskBrief,
	buildPostWriterDocumenterBrief,
	buildReReviewBrief,
	buildReviewPassDocumenterBrief,
	canStartManagedWorkflow,
	formatChainSummary,
	formatManagedWorkflowSummary,
	getManagedWorkflowPlan,
	shouldTriggerFixLoop,
	workflowAgentAvailability,
	type ChainStep,
} from "../src/fixloop.ts";
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

describe("managed workflow planning", () => {
	const role = (name: string, tools?: string[]) => ({ name, tools });
	const available = (...names: string[]) => workflowAgentAvailability(names.map((name) => role(name)));

	it.each(["worker", "cleaner"])("routes a successful %s through whichever downstream role exists", (agent) => {
		const result = reviewResult("done", { agent });
		expect(getManagedWorkflowPlan(result, config(0), available("documenter", "reviewer"))?.kind).toBe("post-writer");
		expect(getManagedWorkflowPlan(result, config(0), available("reviewer"))?.kind).toBe("post-writer");
		expect(getManagedWorkflowPlan(result, config(0), available("documenter"))?.kind).toBe("post-writer");
		expect(getManagedWorkflowPlan(result, config(0), available())).toBeUndefined();
	});

	it("routes a successful top-level documenter only to reviewer", () => {
		const result = reviewResult("docs done", { agent: "documenter" });
		expect(getManagedWorkflowPlan(result, config(0), available("reviewer"))?.kind).toBe("post-writer");
		expect(getManagedWorkflowPlan(result, config(0), available("documenter"))).toBeUndefined();
	});

	it("forces a direct pass through documenter/fresh review independent of maxFixRounds", () => {
		const result = reviewResult("APPROVE\nVERDICT: REVIEW_PASS");
		expect(getManagedWorkflowPlan(result, config(0), available("worker", "documenter", "reviewer"))?.kind)
			.toBe("review-pass-sync");
	});

	it("never turns advisory or failed reviewer output into writes", () => {
		const roles = available("worker", "documenter", "reviewer");
		expect(getManagedWorkflowPlan(reviewResult("advisory only"), config(2), roles)).toBeUndefined();
		expect(getManagedWorkflowPlan(reviewResult("VERDICT: REVIEW_FAIL", { exitCode: 1 }), config(2), roles)).toBeUndefined();
	});

	it("starts direct auto-fix only with an enabled worker and positive fix budget", () => {
		const failedGate = reviewResult("VERDICT: REVIEW_FAIL");
		expect(getManagedWorkflowPlan(failedGate, config(1), available("worker", "reviewer"))?.kind).toBe("auto-fix");
		expect(getManagedWorkflowPlan(failedGate, config(0), available("worker", "reviewer"))).toBeUndefined();
		expect(getManagedWorkflowPlan(failedGate, config(2), available("reviewer"))).toBeUndefined();
	});

	it("reserves shared lanes for writers and reviewers that need a stable diff", () => {
		expect(canStartManagedWorkflow(role("worker"), available())).toBe(true);
		expect(canStartManagedWorkflow(role("cleaner"), available())).toBe(true);
		expect(canStartManagedWorkflow(role("documenter", ["edit"]), available())).toBe(true);
		expect(canStartManagedWorkflow(role("custom-writer", ["write"]), available())).toBe(true);
		expect(canStartManagedWorkflow(role("custom-reader", ["read"]), available())).toBe(false);
		expect(canStartManagedWorkflow(role("reviewer", ["read"]), available("documenter"))).toBe(true);
		expect(canStartManagedWorkflow(role("reviewer", ["read"]), available("worker"))).toBe(true);
		expect(canStartManagedWorkflow(role("reviewer", ["read"]), available("cleaner"))).toBe(true);
		expect(canStartManagedWorkflow(role("reviewer", ["read"]), available("custom-writer"))).toBe(true);
		expect(canStartManagedWorkflow(role("explorer", ["read"]), available("worker", "documenter", "reviewer"))).toBe(false);
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

	it("instructs the worker to fix every finding, not only blockers", () => {
		const brief = buildFixTaskBrief(reviewResult("## Findings\n- file.ts:10 minor issue\nVERDICT: REVIEW_FAIL"), 1, 2);
		expect(brief).toContain("Fix EVERY finding");
		expect(brief).toContain("no severity triage");
		expect(brief).toContain("factually wrong or clearly out of scope");
	});

	it("notes a re-review will follow when rounds remain", () => {
		const brief = buildFixTaskBrief(reviewResult("VERDICT: REVIEW_FAIL"), 1, 2);
		expect(brief).toContain("re-review your changes automatically");
		expect(brief).toContain("Do NOT commit, push, publish, tag, or release");
	});
});

describe("buildDocumenterTaskBrief", () => {
	it("hands the actual diff and worker report to a non-releasing docs sync", () => {
		const brief = buildDocumenterTaskBrief(
			reviewResult("Fixed src/cache.ts", { agent: "worker" }),
			2,
			reviewResult("Original finding in src/cache.ts\nVERDICT: REVIEW_FAIL"),
		);
		expect(brief).toContain("Documentation sync after auto-fix round 2");
		expect(brief).toContain("Fixed src/cache.ts");
		expect(brief).toContain("Original finding in src/cache.ts");
		expect(brief).toContain("Inspect the actual git diff");
		expect(brief).toContain("Change documentation surfaces only");
		expect(brief).toContain("Do NOT commit, push, publish, tag, or release");
		expect(brief).toContain("Make zero edits");
	});
});

describe("managed handoff briefs", () => {
	it("passes full writer and preliminary-review reports without permitting release actions", () => {
		const writer = reviewResult("worker full report src/a.ts", { agent: "worker" });
		const postWriter = buildPostWriterDocumenterBrief(writer);
		const postPass = buildReviewPassDocumenterBrief(reviewResult("preliminary pass\nVERDICT: REVIEW_PASS"));
		for (const brief of [postWriter, postPass]) {
			expect(brief).toContain("Inspect the actual git diff");
			expect(brief).toContain("Do NOT commit, push, publish, tag, or release");
			expect(brief).toContain("do not bump versions");
		}
		expect(postWriter).toContain("worker full report src/a.ts");
		expect(postPass).toContain("preliminary pass");
	});

	it("gives the final reviewer every full upstream report and an explicit gate contract", () => {
		const brief = buildFinalReviewBrief(
			reviewResult("worker report", { agent: "worker" }),
			reviewResult("documenter report", { agent: "documenter" }),
		);
		expect(brief).toContain("worker report");
		expect(brief).toContain("documenter report");
		expect(brief).toContain("actual pending code and documentation");
		expect(brief).toContain("Remain read-only");
		expect(brief).toContain("VERDICT: REVIEW_PASS");
	});
});

describe("buildReReviewBrief", () => {
	const workerResult = (text: string): SingleResult =>
		reviewResult(text, { agent: "worker" });

	it("embeds the prior review and the worker report, then asks for a verdict", () => {
		const brief = buildReReviewBrief(
			reviewResult("## Findings\n- file.ts:42 bug\nVERDICT: REVIEW_FAIL"),
			1,
			workerResult("Fixed file.ts:42 by guarding the null case."),
		);
		expect(brief).toContain("round 1");
		expect(brief).toContain("file.ts:42 bug");
		expect(brief).toContain("guarding the null case");
		expect(brief).toContain("VERDICT: REVIEW_PASS / REVIEW_FAIL");
	});

	it("includes the optional documenter report before final review", () => {
		const brief = buildReReviewBrief(
			reviewResult("README drift\nVERDICT: REVIEW_FAIL"),
			1,
			workerResult("Fixed runtime behavior."),
			reviewResult("Updated README.md and cache comments.", { agent: "documenter" }),
		);
		expect(brief).toContain("documenter's pre-commit sync report");
		expect(brief).toContain("Updated README.md and cache comments");
	});

	it("requires every finding resolved, including warnings", () => {
		const brief = buildReReviewBrief(
			reviewResult("## Findings\n- file.ts:10 minor\nVERDICT: REVIEW_FAIL"),
			1,
			workerResult("Fixed file.ts:10."),
		);
		expect(brief).toContain("Rule on EVERY previous finding");
		expect(brief).toContain("REQUEST_CHANGES only while an open finding remains");
	});

	it("carries the convergence contract: adjudicate rejections once, no re-opening resolved items", () => {
		const brief = buildReReviewBrief(
			reviewResult("## Findings\n- file.ts:10 minor\nVERDICT: REVIEW_FAIL"),
			2,
			workerResult("file.ts:10 is intended behavior; rejected as out of scope."),
		);
		expect(brief).toContain("adjudicated ONCE");
		expect(brief).toContain("never simply restate the finding");
		expect(brief).toContain("defects this round's");
		expect(brief).toContain("Do NOT re-open a finding you verified as resolved");
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
			step({ agent: "documenter", messages: [assistant("updated README.md")] }, "docs round 1", 4),
			step({ messages: [assistant("APPROVE\nVERDICT: REVIEW_PASS")] }, "re-review round 1", 5),
		]);
		expect(summary).toContain("## Auto-fix chain: 1 round — final PASS");
		expect(summary).toContain("- #2 reviewer · initial review · FAIL — src/index.ts");
		expect(summary).toContain("- #3 worker · fix round 1 · completed — changed: src/index.ts");
		expect(summary).toContain("- #4 documenter · docs round 1 · completed — changed: README.md");
		expect(summary).toContain("- #5 reviewer · re-review round 1 · PASS");
		expect(summary).toContain("Totals: 4 runs");
		expect(summary).toContain("subagent_status #2 #3 #4 #5");
	});

	it("renders a managed workflow route and marks a missing reviewer verdict", () => {
		const steps = [
			step({ agent: "worker", messages: [assistant("changed src/a.ts")] }, "initial implementation", 10),
			step({ agent: "documenter", messages: [assistant("updated README.md")] }, "documentation sync", 11),
			step({ messages: [assistant("advisory-shaped final output")] }, "final review", 12),
		];
		const summary = formatManagedWorkflowSummary(steps);
		expect(summary).toContain("worker → documenter → reviewer");
		expect(summary).toContain("final NO_VERDICT");
		expect(summary).toContain("reviewer · final review · NO_VERDICT");
	});

	it("lets terminal integration/process failure override a stray reviewer pass", () => {
		const steps = [
			step({ agent: "worker", messages: [assistant("changed src/a.ts")] }, "initial implementation", 20),
			step({ messages: [assistant("VERDICT: REVIEW_PASS")] }, "final review", 21),
		];
		const terminal = reviewResult("VERDICT: REVIEW_PASS", {
			exitCode: 1,
			stopReason: "error",
			errorMessage: "worktree integration failed",
		});
		expect(formatManagedWorkflowSummary(steps, terminal)).toContain("final failed");
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
