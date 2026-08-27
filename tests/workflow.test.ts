import { describe, expect, it } from "vitest";
import {
	buildFinalDocumenterBrief,
	buildFinalReviewBrief,
	canStartManagedWorkflow,
	documentationDisposition,
	formatManagedWorkflowSummary,
	getManagedWorkflowPlan,
	workflowAgentAvailability,
	type ChainStep,
} from "../src/workflow.ts";
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

	it("delivers a direct REVIEW_FAIL to the main agent even with a worker enabled", () => {
		const failedGate = reviewResult("VERDICT: REVIEW_FAIL");
		expect(getManagedWorkflowPlan(failedGate, available("worker", "reviewer"))).toBeUndefined();
		expect(getManagedWorkflowPlan(failedGate, available("worker", "documenter", "reviewer"))).toBeUndefined();
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
		expect(brief).toContain("the report returns to the main agent");
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

describe("formatManagedWorkflowSummary", () => {
	const step = (overrides: Partial<SingleResult>, relation: string, runId = 1): ChainStep => ({
		runId,
		result: reviewResult("x", overrides),
		relation,
	});

	it("renders one result-only line per step with verdicts and totals", () => {
		const summary = formatManagedWorkflowSummary([
			step({ agent: "worker", messages: [assistant("changed src/index.ts")] }, "initial implementation", 2),
			step({ messages: [assistant("APPROVE\nVERDICT: REVIEW_PASS")] }, "final review", 3),
			step({ agent: "documenter", messages: [assistant("updated README.md")] }, "final documentation sync", 4),
		]);
		expect(summary).toContain("## Managed workflow: worker → reviewer → documenter — final completed");
		expect(summary).toContain("- #2 worker · initial implementation · completed");
		expect(summary).toContain("- #3 reviewer · final review · PASS");
		expect(summary).toContain("- #4 documenter · final documentation sync · completed");
		expect(summary).not.toContain("src/index.ts");
		expect(summary).not.toContain("README.md");
		expect(summary).not.toContain("changed:");
		expect(summary).toContain("Totals: 3 runs");
		expect(summary).toContain("Per-run details: subagent_status #2 #3 #4");
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
});
