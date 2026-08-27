import { describe, expect, it } from "vitest";
import {
	buildFinalDocumenterBrief,
	buildFinalReviewBrief,
	buildFixTaskBrief,
	buildReReviewBrief,
	canStartManagedWorkflow,
	documentationDisposition,
	formatChainSummary,
	formatManagedWorkflowSummary,
	getManagedWorkflowPlan,
	shouldTriggerFixLoop,
	workflowAgentAvailability,
	type ChainStep,
} from "../src/fixloop.ts";
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

describe("shouldTriggerFixLoop", () => {
	it("triggers on a healthy reviewer REVIEW_FAIL", () => {
		expect(shouldTriggerFixLoop(reviewResult("REQUEST_CHANGES\nVERDICT: REVIEW_FAIL"))).toBe(true);
	});

	it("does not trigger on a passing review", () => {
		expect(shouldTriggerFixLoop(reviewResult("APPROVE\nVERDICT: REVIEW_PASS"))).toBe(false);
	});

	it("does not trigger on a failed reviewer process (exit code != 0)", () => {
		expect(shouldTriggerFixLoop(reviewResult("VERDICT: REVIEW_FAIL", { exitCode: 1 }))).toBe(false);
	});

	it("does not trigger for non-reviewer agents", () => {
		expect(shouldTriggerFixLoop(reviewResult("VERDICT: REVIEW_FAIL", { agent: "worker" }))).toBe(false);
	});

	it("does not trigger when no verdict marker is present", () => {
		expect(shouldTriggerFixLoop(reviewResult("just a plain report"))).toBe(false);
	});
});

describe("documentationDisposition", () => {
	it("accepts only standalone lines and lets the last valid marker win", () => {
		expect(documentationDisposition("DOCUMENTATION: CLEAN")).toBe("clean");
		expect(documentationDisposition("\tDOCUMENTATION: needed\r")).toBe("needed");
		expect(documentationDisposition("Use DOCUMENTATION: CLEAN when done")).toBeUndefined();
		expect(documentationDisposition("DOCUMENTATION: NEEDED is one option")).toBeUndefined();
		expect(documentationDisposition("DOCUMENTATION: NEEDED\nnotes\nDOCUMENTATION: CLEAN")).toBe("clean");
	});
});

describe("managed workflow planning", () => {
	const role = (name: string, tools?: string[]) => ({ name, tools });
	const available = (...names: string[]) => workflowAgentAvailability(names.map((name) => role(name)));

	it.each(["worker", "cleaner"])("routes a successful %s through whichever downstream role exists", (agent) => {
		const result = reviewResult("done", { agent });
		expect(getManagedWorkflowPlan(result, available("documenter", "reviewer"))?.kind).toBe("post-writer");
		expect(getManagedWorkflowPlan(result, available("reviewer"))?.kind).toBe("post-writer");
		expect(getManagedWorkflowPlan(result, available("documenter"))?.kind).toBe("post-writer");
		expect(getManagedWorkflowPlan(result, available())).toBeUndefined();
	});

	it("delivers a successful top-level documenter directly", () => {
		const result = reviewResult("docs done", { agent: "documenter" });
		expect(getManagedWorkflowPlan(result, available("reviewer"))).toBeUndefined();
		expect(getManagedWorkflowPlan(result, available("documenter", "reviewer"))).toBeUndefined();
	});

	it("runs direct-pass docs only for NEEDED or a conservatively missing marker", () => {
		const missing = reviewResult("APPROVE\nVERDICT: REVIEW_PASS");
		const needed = reviewResult("DOCUMENTATION: NEEDED\nAPPROVE\nVERDICT: REVIEW_PASS");
		const clean = reviewResult("DOCUMENTATION: CLEAN\nAPPROVE\nVERDICT: REVIEW_PASS");
		const roles = available("worker", "documenter", "reviewer");
		expect(getManagedWorkflowPlan(missing, roles)?.kind).toBe("review-pass-sync");
		expect(getManagedWorkflowPlan(needed, roles)?.kind).toBe("review-pass-sync");
		expect(getManagedWorkflowPlan(clean, roles)).toBeUndefined();
		expect(getManagedWorkflowPlan(missing, available("worker", "reviewer"))).toBeUndefined();
	});

	it("never turns advisory or failed reviewer output into writes", () => {
		const roles = available("worker", "documenter", "reviewer");
		expect(getManagedWorkflowPlan(reviewResult("advisory only"), roles)).toBeUndefined();
		expect(getManagedWorkflowPlan(reviewResult("DOCUMENTATION: NEEDED\nadvisory only"), roles)).toBeUndefined();
		expect(getManagedWorkflowPlan(reviewResult("VERDICT: REVIEW_FAIL", { exitCode: 1 }), roles)).toBeUndefined();
	});

	it("starts direct auto-fix only with an enabled worker", () => {
		const failedGate = reviewResult("VERDICT: REVIEW_FAIL");
		expect(getManagedWorkflowPlan(failedGate, available("worker", "reviewer"))?.kind).toBe("auto-fix");
		expect(getManagedWorkflowPlan(failedGate, available("reviewer"))).toBeUndefined();
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

	it("lets the worker implement instructions or push back with its own fix", () => {
		const brief = buildFixTaskBrief(reviewResult("## Findings\n- file.ts:10 minor issue\nVERDICT: REVIEW_FAIL"), 1, 2);
		expect(brief).toContain("carries a fix instruction");
		expect(brief).toContain("Close EVERY finding");
		expect(brief).toContain("no severity triage");
		expect(brief).toContain("push back per finding");
	});

	it("notes a re-review will follow and requires directly affected docs to stay synchronized", () => {
		const brief = buildFixTaskBrief(reviewResult("VERDICT: REVIEW_FAIL"), 1, 2);
		expect(brief).toContain("re-review your changes automatically");
		expect(brief).toContain("directly affected by your fixes");
	});
});

describe("buildFinalDocumenterBrief", () => {
	it("hands the terminal writer and gate review to a non-releasing final sync", () => {
		const brief = buildFinalDocumenterBrief(
			reviewResult("Fixed src/cache.ts", { agent: "worker" }),
			reviewResult("## Documentation notes\n- README stale\nAPPROVE\nVERDICT: REVIEW_PASS"),
		);
		expect(brief).toContain("Final documentation sync");
		expect(brief).toContain("Fixed src/cache.ts");
		expect(brief).toContain("README stale");
		expect(brief).toContain("Apply every documentation note");
		expect(brief).toContain("Inspect the actual git diff");
		expect(brief).toContain("Change documentation surfaces only");
		expect(brief).toContain("make zero edits");
		expect(brief).toContain("no fresh reviewer runs");
	});

	it("accepts a single lead: review-only for a direct pass, writer-only when reviewer is disabled", () => {
		const reviewOnly = buildFinalDocumenterBrief(undefined, reviewResult("pass report\nVERDICT: REVIEW_PASS"));
		expect(reviewOnly).toContain("pass report");
		expect(reviewOnly).not.toContain("The last writer");
		const writerOnly = buildFinalDocumenterBrief(reviewResult("writer report", { agent: "worker" }), undefined);
		expect(writerOnly).toContain("writer report");
		expect(writerOnly).not.toContain("final gate review");
	});
});

describe("managed handoff briefs", () => {
	it("gives the gate reviewer the writer report and an explicit verdict contract", () => {
		const brief = buildFinalReviewBrief(
			reviewResult("worker report", { agent: "worker" }),
			{ documenterPending: false },
		);
		expect(brief).toContain("worker report");
		expect(brief).toContain("actual pending code");
		expect(brief).toContain("Remain read-only");
		expect(brief).toContain("fix instruction to EVERY gate finding");
		expect(brief).toContain("VERDICT: REVIEW_PASS");
		expect(brief).toContain("documentation drift is an ordinary gate finding");
		expect(brief).not.toContain("Documentation notes");
	});

	it("routes documentation drift to the pending final documenter instead of the gate", () => {
		const brief = buildFinalReviewBrief(
			reviewResult("worker report", { agent: "worker" }),
			{ documenterPending: true },
		);
		expect(brief).toContain("conditional documentation sync");
		expect(brief).toContain("## Documentation notes");
		expect(brief).toContain("DOCUMENTATION: NEEDED");
		expect(brief).toContain("DOCUMENTATION: CLEAN");
		expect(brief).toContain("not a code-gate finding");
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

	it("asks the reviewer to carry documentation notes forward when the final documenter is pending", () => {
		const brief = buildReReviewBrief(
			reviewResult("README drift\nVERDICT: REVIEW_FAIL"),
			1,
			workerResult("Fixed runtime behavior."),
			{ documenterPending: true },
		);
		expect(brief).toContain("Documentation notes");
		expect(brief).toContain("DOCUMENTATION: NEEDED");
		expect(brief).toContain("DOCUMENTATION: CLEAN");
		const noDocumenter = buildReReviewBrief(
			reviewResult("README drift\nVERDICT: REVIEW_FAIL"),
			1,
			workerResult("Fixed runtime behavior."),
		);
		expect(noDocumenter).not.toContain("Documentation notes");
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

	it("carries the convergence contract: judge the result, adjudicate pushback once, no unrelated findings", () => {
		const brief = buildReReviewBrief(
			reviewResult("## Findings\n- file.ts:10 minor\nVERDICT: REVIEW_FAIL"),
			2,
			workerResult("file.ts:10: your instruction breaks X; shipped the guard on Y instead."),
		);
		expect(brief).toContain("pushback where it replaced your fix instruction");
		expect(brief).toContain("Judge the code as it now stands");
		expect(brief).toContain("whether or not the worker followed your fix instruction");
		expect(brief).toContain("Adjudicate each pushback once");
		expect(brief).toContain("defects this round's");
		expect(brief).toContain("never opens findings unrelated to this round's edits");
		expect(brief).not.toContain("genuinely missed");
		expect(brief).toContain("Do NOT re-open a finding you verified as resolved");
	});
});

describe("formatChainSummary", () => {
	const step = (overrides: Partial<SingleResult>, relation: string, runId = 1): ChainStep => ({
		runId,
		result: reviewResult("x", overrides),
		relation,
	});

	it("renders one result-only line per step with verdicts and totals", () => {
		const summary = formatChainSummary([
			step({ messages: [assistant("found src/index.ts\nVERDICT: REVIEW_FAIL")] }, "initial review", 2),
			step({ agent: "worker", messages: [assistant("fixed src/index.ts")] }, "fix round 1", 3),
			step({ messages: [assistant("APPROVE\nVERDICT: REVIEW_PASS")] }, "re-review round 1", 4),
			step({ agent: "documenter", messages: [assistant("updated README.md")] }, "final documentation sync", 5),
		]);
		expect(summary).toContain("## Auto-fix chain: 1 round — final completed");
		expect(summary).toContain("- #2 reviewer · initial review · FAIL");
		expect(summary).toContain("- #3 worker · fix round 1 · completed");
		expect(summary).toContain("- #4 reviewer · re-review round 1 · PASS");
		expect(summary).toContain("- #5 documenter · final documentation sync · completed");
		expect(summary).not.toContain("src/index.ts");
		expect(summary).not.toContain("README.md");
		expect(summary).not.toContain("changed:");
		expect(summary).toContain("Totals: 4 runs");
		expect(summary).toContain("Per-run details: subagent_status #2 #3 #4 #5");
		expect(summary).not.toContain("failed tools");
	});

	it("renders a managed workflow route and marks a missing reviewer verdict", () => {
		const steps = [
			step({ agent: "worker", messages: [assistant("changed src/a.ts")] }, "initial implementation", 10),
			step({ messages: [assistant("advisory-shaped final output")] }, "final review", 11),
		];
		const summary = formatManagedWorkflowSummary(steps);
		expect(summary).toContain("worker → reviewer");
		expect(summary).toContain("final NO_VERDICT");
		expect(summary).toContain("reviewer · final review · NO_VERDICT");
	});

	it("shows the reviewer gate before the final documentation sync", () => {
		const steps = [
			step({ agent: "worker", messages: [assistant("changed src/a.ts")] }, "initial implementation", 12),
			step({ messages: [assistant("APPROVE\nVERDICT: REVIEW_PASS")] }, "final review", 13),
			step({ agent: "documenter", messages: [assistant("updated README.md")] }, "final documentation sync", 14),
		];
		const summary = formatManagedWorkflowSummary(steps);
		expect(summary).toContain("worker → reviewer → documenter");
		expect(summary).toContain("final completed");
		expect(summary.indexOf("final review · PASS")).toBeLessThan(
			summary.indexOf("final documentation sync · completed"),
		);
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
