import { describe, expect, it } from "vitest";
import {
	buildFinalReviewBrief,
	buildReviewerFixBrief,
	canStartManagedWorkflow,
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

describe("managed workflow planning", () => {
	const role = (name: string, tools?: string[]) => ({ name, tools });
	const available = (...names: string[]) => workflowAgentAvailability(names.map((name) => role(name)));

	it.each(["worker", "cleaner"])("routes a successful %s through the gate only when a reviewer exists", (agent) => {
		const result = reviewResult("done", { agent });
		expect(getManagedWorkflowPlan(result, available("reviewer"))).toBeDefined();
		expect(getManagedWorkflowPlan(result, available("documenter"))).toBeUndefined();
		expect(getManagedWorkflowPlan(result, available())).toBeUndefined();
	});

	it.each(["worker", "cleaner"])("skips the gate for a %s dispatch that opted out with review none", (agent) => {
		const result = reviewResult("done", { agent });
		expect(getManagedWorkflowPlan(result, available("reviewer"), "none")).toBeUndefined();
		expect(getManagedWorkflowPlan(result, available("reviewer"), "gate")).toBeDefined();
	});

	it("delivers a successful top-level documenter directly", () => {
		const result = reviewResult("docs done", { agent: "documenter" });
		expect(getManagedWorkflowPlan(result, available("reviewer"))).toBeUndefined();
		expect(getManagedWorkflowPlan(result, available("documenter", "reviewer"))).toBeUndefined();
	});

	it("never turns any reviewer output — pass, fail, or advisory — into a chained child", () => {
		const roles = available("worker", "documenter", "reviewer");
		expect(getManagedWorkflowPlan(reviewResult("advisory only"), roles)).toBeUndefined();
		expect(getManagedWorkflowPlan(reviewResult("DOCUMENTATION: NEEDED\nadvisory only"), roles)).toBeUndefined();
		expect(getManagedWorkflowPlan(reviewResult("DOCUMENTATION: NEEDED\nAPPROVE\nVERDICT: REVIEW_PASS"), roles)).toBeUndefined();
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
		// A documenter is itself write-capable, so a reviewer still needs the lane.
		expect(canStartManagedWorkflow(role("reviewer", ["read"]), available("documenter"))).toBe(true);
		expect(canStartManagedWorkflow(role("reviewer", ["read"]), available("worker"))).toBe(true);
		expect(canStartManagedWorkflow(role("reviewer", ["read"]), available("cleaner"))).toBe(true);
		expect(canStartManagedWorkflow(role("reviewer", ["read"]), available("custom-writer"))).toBe(true);
		expect(canStartManagedWorkflow(role("explorer", ["read"]), available("worker", "documenter", "reviewer"))).toBe(false);
	});
});

describe("managed handoff briefs", () => {
	it("gives the gate reviewer the writer report and an executable fix contract", () => {
		const brief = buildFinalReviewBrief(reviewResult("worker report", { agent: "worker" }));
		expect(brief).toContain("worker report");
		expect(brief).toContain("actual pending code");
		expect(brief).toContain("Scale the gate to the change");
		expect(brief).toContain("Remain read-only");
		expect(brief).toContain("fix instruction to EVERY gate finding");
		expect(brief).toContain("continues into your own write-enabled fix stage");
		expect(brief).toContain("VERDICT: REVIEW_PASS");
		expect(brief).toContain("including documentation drift");
		expect(brief).not.toContain("Documentation notes");
		expect(brief).not.toContain("DOCUMENTATION:");
	});

	it("briefs the reviewer fix stage on its own failing review", () => {
		const brief = buildReviewerFixBrief("- src/a.ts:10 — race on shutdown — Fix: await the controller");
		expect(brief).toContain("full write access in this same session");
		expect(brief).toContain("Apply every one of your own fix instructions");
		expect(brief).toContain("- src/a.ts:10 — race on shutdown — Fix: await the controller");
		expect(brief).toContain("narrowest decisive checks");
		expect(brief).toContain("Do not emit another VERDICT");
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
		]);
		expect(summary).toContain("## Managed workflow: worker → reviewer — final PASS");
		expect(summary).toContain("- #2 worker · initial implementation · completed");
		expect(summary).toContain("- #3 reviewer · final review · PASS");
		expect(summary).not.toContain("src/index.ts");
		expect(summary).not.toContain("changed:");
		expect(summary).toContain("Totals: 2 runs");
		expect(summary).not.toContain("Per-run details");
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

	it("renders a reviewer fix stage as completed work, not a missing verdict", () => {
		const summary = formatManagedWorkflowSummary([
			step({ agent: "worker", messages: [assistant("changed src/a.ts")] }, "initial implementation", 1),
			step({ messages: [assistant("VERDICT: REVIEW_FAIL")] }, "final review", 2),
			step({ messages: [assistant("## Fixed\n- src/a.ts — guarded the empty range")] }, "review fix", 3),
		]);
		expect(summary).toContain("worker → reviewer → reviewer — final completed");
		expect(summary).toContain("- #2 reviewer · final review · FAIL");
		expect(summary).toContain("- #3 reviewer · review fix · completed");
		expect(summary).toContain("Totals: 3 runs");
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
