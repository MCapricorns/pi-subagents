import { describe, expect, it } from "vitest";
import type { AgentConfig } from "../src/agents.ts";
import { loadBuiltinAgents } from "../src/agents.ts";
import { buildDelegationDirective } from "../src/prompt.ts";

function agent(name: string): AgentConfig {
	return {
		name,
		description: `${name} description`,
		systemPrompt: "body",
		source: "builtin",
		filePath: `/agents/${name}.md`,
	};
}

describe("buildDelegationDirective", () => {
	it("returns empty string when there are no agents", () => {
		expect(buildDelegationDirective([])).toBe("");
	});

	it("lists the catalog and preserves isolation, leaf, and self-contained brief rules", () => {
		const directive = buildDelegationDirective([agent("explorer"), agent("worker"), agent("reviewer")]);
		expect(directive).toContain("- explorer: explorer description");
		expect(directive).toContain("isolated leaf Pi child processes");
		expect(directive).toContain("goal, exact paths, constraints, expected output");
		expect(directive).toContain("cannot delegate");
		expect(directive).toContain("subagent_control resume");
	});

	it("keeps the default injected directive below the prompt budget", () => {
		const directive = buildDelegationDirective(loadBuiltinAgents());
		expect(directive.length).toBeLessThan(3_900);
	});

	it("states default-parallel fan-out with queue pacing for any agent count", () => {
		const single = buildDelegationDirective([agent("worker")]);
		expect(single).toContain("Parallelize by default");
		expect(single).toContain("ONE `tasks` dispatch");
		expect(single).toContain("One child owns one deliverable");
		expect(single).not.toContain("documenter");
		const multi = buildDelegationDirective([agent("explorer"), agent("worker")]);
		expect(multi).toContain("only genuinely dependent work waits for its prerequisite");
	});

	it("pushes delegation with an inline trivial-work boundary", () => {
		const directive = buildDelegationDirective([agent("explorer"), agent("worker"), agent("reviewer")]);
		expect(directive).toContain("Delegate aggressively");
		expect(directive).toContain("Inline only trivial work");
		expect(directive).toContain("default every non-trivial implementation, fix, refactor, or test task to `worker`");
		expect(directive).toContain("split a broad question into parallel explorers with disjoint scopes");
		expect(directive).toContain("leads, never proof");
		expect(directive).toContain("re-read load-bearing files before acting yourself");
		expect(directive).toContain("a child you brief re-verifies");

		const withoutExplorer = buildDelegationDirective([agent("worker")]);
		expect(withoutExplorer).not.toContain("explorer");
	});

	it("routes cleanup to cleaner proactively with the brief as edit authorization", () => {
		const directive = buildDelegationDirective([agent("cleaner"), agent("reviewer")]);
		expect(directive).toContain("proactively when finished work leaves dead code");
		expect(directive).toContain("Your brief is its edit authorization");
		expect(directive).toContain("every safe proven cut applies without per-item approval");
		expect(directive).toContain("never a gate");
	});

	it("keeps documenter as a directly dispatched drift-sync decision owned by the main agent", () => {
		const directive = buildDelegationDirective([
			agent("worker"),
			agent("cleaner"),
			agent("documenter"),
			agent("reviewer"),
		]);
		expect(directive).toContain("standalone docs/comment work");
		expect(directive).toContain("dispatch it proactively when a change — yours or a child's — leaves README/docs/comment drift");
		expect(directive).toContain("may make zero edits");
		expect(directive).not.toContain("DOCUMENTATION: NEEDED");
		expect(directive).toContain("failing gates are fixed by the reviewer itself in bounded fix/re-review rounds");
	});

	it("teaches proportional gating: review none for mechanical edits, default gate otherwise", () => {
		const directive = buildDelegationDirective([agent("worker"), agent("reviewer")]);
		expect(directive).toContain('review: "none"');
		expect(directive).toContain("mechanical, low-risk edits");
		expect(directive).toContain("keep the default gate whenever behavior can change");
		// Without a code writer there is no automatic gate to scale.
		const noWriter = buildDelegationDirective([agent("explorer"), agent("reviewer")]);
		expect(noWriter).not.toContain('review: "none"');
	});

	it("does not advertise documenter routing when the role is disabled", () => {
		const directive = buildDelegationDirective([agent("explorer"), agent("worker"), agent("reviewer")]);
		expect(directive).not.toContain("documenter");
		expect(directive).not.toContain("cleaner");
	});

	it("returns direct-gate REVIEW_FAIL findings to the main agent with an autonomous fix default", () => {
		const directive = buildDelegationDirective([agent("worker"), agent("reviewer")]);
		expect(directive).toContain("A REVIEW_FAIL from a gate you dispatched directly returns its findings to you");
		expect(directive).toContain("without waiting for the user");
		expect(directive).toContain("cannot authorize edits");
		const noReviewer = buildDelegationDirective([agent("worker")]);
		expect(noReviewer).not.toContain("REVIEW_FAIL");
	});

	it("carries no isolation guidance — defaults and role frontmatter own it", () => {
		const directive = buildDelegationDirective([
			agent("worker"),
			agent("cleaner"),
			agent("documenter"),
			agent("reviewer"),
		]);
		expect(directive).not.toContain("isolation");
		expect(directive).not.toContain("committed HEAD");
	});

	it("routes fan-out synthesis to synthesizer only when the role is enabled", () => {
		const directive = buildDelegationDirective([
			agent("explorer"),
			agent("worker"),
			agent("synthesizer"),
		]);
		expect(directive).toContain("pass the result-artifact paths to one synthesizer");
		expect(directive).toContain("read its brief instead of every result yourself");
		const withoutSynthesizer = buildDelegationDirective([agent("explorer"), agent("worker")]);
		expect(withoutSynthesizer).not.toContain("synthesizer");
	});

	it("preserves non-blocking dispatch, automatic handoff, and no result restatement", () => {
		const directive = buildDelegationDirective([agent("explorer"), agent("worker"), agent("reviewer")]);
		expect(directive).toContain("Dispatch never blocks or ends your turn");
		expect(directive).toContain("each completion resumes you automatically");
		expect(directive).toContain("Never sleep or poll for it");
		expect(directive).toContain("never a restatement");
		expect(directive).toContain("Never declare the overall task done while a dispatched run is still active");
	});

	it("includes reviewer gate rules only when reviewer is enabled", () => {
		const withoutReviewer = buildDelegationDirective([agent("explorer"), agent("worker")]);
		expect(withoutReviewer).not.toContain("Multi-model cross-review");
		const withReviewer = buildDelegationDirective([agent("worker"), agent("reviewer")]);
		expect(withReviewer).toContain("Multi-model cross-review");
	});

	it("does not reintroduce removed vision routing", () => {
		const directive = buildDelegationDirective([agent("explorer"), agent("worker"), agent("reviewer")]);
		expect(directive).not.toContain("vision");
	});
});
