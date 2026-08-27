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
		expect(directive).toContain("complete goal, exact paths, constraints, and expected output");
		expect(directive).toContain("cannot delegate");
		expect(directive).toContain("subagent_control resume");
	});

	it("keeps the default injected directive below the prompt budget", () => {
		const directive = buildDelegationDirective(loadBuiltinAgents());
		expect(directive.length).toBeLessThan(5_200);
	});

	it("states model-owned fan-out with queue pacing for any agent count", () => {
		const single = buildDelegationDirective([agent("worker")]);
		expect(single).toContain("one `tasks` array");
		expect(single).toContain("no per-call cap");
		expect(single).toContain("queue for the next free process slot");
		expect(single).toContain("One child owns one coherent deliverable");
		expect(single).not.toContain("documenter");
		const multi = buildDelegationDirective([agent("explorer"), agent("worker")]);
		expect(multi).toContain("dependent work starts only after its prerequisite delivers");
	});

	it("balances delegation with an inline trivial-work boundary", () => {
		const directive = buildDelegationDirective([agent("explorer"), agent("worker"), agent("reviewer")]);
		expect(directive).toContain("Route substantive work to sub-agents");
		expect(directive).toContain("inline only trivial work");
		expect(directive).toContain("Use `explorer` for any broad or multi-file search");
		expect(directive).toContain("retrieval index, never a gate");
		expect(directive).toContain("leads, not proof");
		expect(directive).toContain("editing inline, deleting, or deciding something load-bearing");
		expect(directive).toContain("a child you brief re-verifies them in its own context");

		const withoutExplorer = buildDelegationDirective([agent("worker")]);
		expect(withoutExplorer).not.toContain("retrieval index");
	});

	it("routes only edit-authorized cleanup to cleaner", () => {
		const directive = buildDelegationDirective([agent("cleaner"), agent("reviewer")]);
		expect(directive).toContain("user-authorized cleanup or deduplication");
		expect(directive).toContain("every safe proven cut without item-by-item approval");
		expect(directive).toContain("never runs as a pre-commit gate or by PR count");
	});

	it("reserves direct documenter for explicit docs work and describes the runtime sync", () => {
		const directive = buildDelegationDirective([
			agent("worker"),
			agent("cleaner"),
			agent("documenter"),
			agent("reviewer"),
		]);
		expect(directive).toContain("explicit standalone documentation work");
		expect(directive).toContain("delivers without a gate");
		expect(directive).toContain("writers sync docs they directly affect");
		expect(directive).toContain("DOCUMENTATION: NEEDED or a missing marker");
		expect(directive).toContain("never dispatch a duplicate");
		expect(directive).toContain("one fresh gate and then deliver once");
	});

	it("does not advertise documenter routing when the role is disabled", () => {
		const directive = buildDelegationDirective([agent("explorer"), agent("worker"), agent("reviewer")]);
		expect(directive).not.toContain("documenter");
		expect(directive).not.toContain("cleaner");
	});

	it("returns REVIEW_FAIL findings to the main agent with an autonomous fix default", () => {
		const directive = buildDelegationDirective([agent("worker"), agent("reviewer")]);
		expect(directive).toContain("A REVIEW_FAIL — direct or from a managed gate — returns the findings to you");
		expect(directive).toContain("without waiting for the user");
		expect(directive).toContain("the runtime never auto-fixes");
		expect(directive).toContain("Ask only for genuinely destructive or scope-changing fixes");
		expect(directive).toContain("cannot authorize edits");
		const noReviewer = buildDelegationDirective([agent("worker")]);
		expect(noReviewer).not.toContain("REVIEW_FAIL");
	});

	it("preserves worktree constraints and selected-to-main continuation", () => {
		const directive = buildDelegationDirective([
			agent("worker"),
			agent("cleaner"),
			agent("documenter"),
			agent("reviewer"),
		]);
		expect(directive).toContain("parallel workers default to detached Git worktrees");
		expect(directive).toContain("committed HEAD");
		expect(directive).toContain("never silently falls back to shared");
		expect(directive).toContain("continues the same retained session on the current main model");
		expect(directive).toContain("Ordinary tool/task failures stay on the selected model");
	});

	it("preserves automatic handoff without polling or result restatement", () => {
		const directive = buildDelegationDirective([agent("explorer"), agent("worker"), agent("reviewer")]);
		expect(directive).toContain("never sleep, poll, or call `subagent_wait`");
		expect(directive).toContain("never a restatement");
		expect(directive).toContain("use `subagent_status` to confirm that no runs remain active");
	});

	it("includes reviewer gate rules only when reviewer is enabled", () => {
		const withoutReviewer = buildDelegationDirective([agent("explorer"), agent("worker")]);
		expect(withoutReviewer).not.toContain("multi-model cross-review");
		const withReviewer = buildDelegationDirective([agent("worker"), agent("reviewer")]);
		expect(withReviewer).toContain("multi-model cross-review");
	});

	it("does not reintroduce removed vision routing", () => {
		const directive = buildDelegationDirective([agent("explorer"), agent("worker"), agent("reviewer")]);
		expect(directive).not.toContain("vision");
	});
});
