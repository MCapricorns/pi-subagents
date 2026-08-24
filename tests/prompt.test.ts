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
		expect(directive).toContain("isolated Pi child processes and context windows");
		expect(directive).toContain("complete goal, exact paths, constraints, and expected output");
		expect(directive).toContain("leaf processes without delegation tools");
		expect(directive).toContain("subagent_control fork");
	});

	it("keeps the default injected directive below the prompt budget", () => {
		const directive = buildDelegationDirective(loadBuiltinAgents());
		expect(directive.length).toBeLessThan(6_000);
	});

	it("mentions parallel only when multiple agents are enabled", () => {
		const single = buildDelegationDirective([agent("worker")]);
		expect(single).not.toContain("one `tasks` array");
		const multi = buildDelegationDirective([agent("explorer"), agent("worker")]);
		expect(multi).toContain("one `tasks` array");
	});

	it("keeps trivial work inline and treats explorer as a retrieval index", () => {
		const directive = buildDelegationDirective([agent("explorer"), agent("worker"), agent("reviewer")]);
		expect(directive).toContain("Handle simple work inline with direct tools");
		expect(directive).toContain("Use `explorer` proactively");
		expect(directive).toContain("only as a retrieval index");
		expect(directive).toContain("re-read load-bearing files");
		expect(directive).toContain("Use a stronger model/specialist");

		const withoutExplorer = buildDelegationDirective([agent("worker")]);
		expect(withoutExplorer).not.toContain("only as a retrieval index");
	});

	it("routes only edit-authorized cleanup to cleaner and generic audits to reviewer", () => {
		const directive = buildDelegationDirective([agent("cleaner"), agent("reviewer")]);
		expect(directive).toContain("user-authorized cleanup, removal, simplification, duplicate-code consolidation");
		expect(directive).toContain("applies every safe proven in-scope cut without item-by-item approval");
		expect(directive).toContain("Generic or read-only audit, review, code-health, plan");
		expect(directive).toContain("goes to `reviewer`");
		expect(directive).toContain("does not authorize follow-up edits");
		expect(directive).toContain("Never dispatch cleaner by PR count or as the pre-commit gate");
		expect(directive).not.toContain("Audit mode");
		expect(directive).not.toContain("Apply mode");
	});

	it("states automatic diff sync and reserves direct documenter for explicit docs work", () => {
		const directive = buildDelegationDirective([
			agent("worker"),
			agent("cleaner"),
			agent("documenter"),
			agent("reviewer"),
		]);
		expect(directive).toContain("explicit whole-codebase maintenance or standalone documentation work");
		expect(directive).toContain("worker/cleaner runs already auto-sync the actual diff");
		expect(directive).toContain("never dispatch a duplicate");
		expect(directive).toContain("never runtime behavior, versions, release state");
		expect(directive).toContain("documenter → reviewer");
		expect(directive).toContain("direct REVIEW_PASS is preliminary");
	});

	it("advertises auto-fix only when worker exists and rounds are enabled", () => {
		const roles = [agent("worker"), agent("documenter"), agent("reviewer")];
		expect(buildDelegationDirective(roles, { maxFixRounds: 1 })).toContain(
			"direct REVIEW_FAIL keeps auto-fix",
		);
		expect(buildDelegationDirective(roles, { maxFixRounds: 0 })).toContain(
			"cannot start fixes while worker/fix rounds are disabled",
		);
		expect(buildDelegationDirective([agent("documenter"), agent("reviewer")])).toContain(
			"cannot start fixes while worker/fix rounds are disabled",
		);
	});

	it("does not advertise cleaner or documenter routing when each role is disabled", () => {
		const directive = buildDelegationDirective([agent("explorer"), agent("worker"), agent("reviewer")]);
		expect(directive).not.toContain("`cleaner`");
		expect(directive).not.toContain("`documenter`");
	});

	it("preserves worktree constraints and selected-to-main continuation", () => {
		const directive = buildDelegationDirective([
			agent("worker"),
			agent("cleaner"),
			agent("documenter"),
			agent("reviewer"),
		]);
		expect(directive).toContain("parallel worker tasks default to detached Git worktrees");
		expect(directive).toContain("documenter defaults to shared");
		expect(directive).toContain("committed HEAD");
		expect(directive).toContain("never falls back silently to shared");
		expect(directive).toContain("continues the same retained session on the current main model");
		expect(directive).toContain("Ordinary tool/task failures stay on the selected model");
	});

	it("preserves automatic handoff without polling or result restatement", () => {
		const directive = buildDelegationDirective([agent("explorer"), agent("worker"), agent("reviewer")]);
		expect(directive).toContain("Never sleep, poll, or call `subagent_wait`");
		expect(directive).toContain("explicit `timeoutMs`");
		expect(directive).toContain("Do not restate, paraphrase, or re-summarize");
		expect(directive).toContain("use `subagent_status` to confirm that no runs remain active");
	});

	it("includes reviewer gate rules only when reviewer is enabled", () => {
		const withoutReviewer = buildDelegationDirective([agent("explorer"), agent("worker")]);
		expect(withoutReviewer).not.toContain("multi-model cross-review");
		const withReviewer = buildDelegationDirective([agent("worker"), agent("reviewer")]);
		expect(withReviewer).toContain("fresh read-only reviewer gate");
		expect(withReviewer).toContain("multi-model cross-review");
	});

	it("does not reintroduce removed vision routing", () => {
		const directive = buildDelegationDirective([agent("explorer"), agent("worker"), agent("reviewer")]);
		expect(directive).not.toContain("vision");
	});
});
