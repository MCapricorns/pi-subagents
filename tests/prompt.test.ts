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
		const directive = buildDelegationDirective([agent("explorer"), agent("executor")]);
		expect(directive).toContain("- explorer: explorer description");
		expect(directive).toContain("isolated leaf Pi child processes");
		expect(directive).toContain("goal, exact paths, constraints, expected output");
		expect(directive).toContain("cannot delegate");
		expect(directive).toContain("subagent_control resume");
	});

	it("keeps the default injected directive below the prompt budget", () => {
		const directive = buildDelegationDirective(loadBuiltinAgents());
		expect(directive.length).toBeLessThan(2_600);
	});

	it("states default-parallel fan-out with queue pacing for any agent count", () => {
		const single = buildDelegationDirective([agent("executor")]);
		expect(single).toContain("Parallelize by default");
		expect(single).toContain("ONE `tasks` dispatch");
		expect(single).toContain("One child owns one deliverable");
		expect(single).not.toContain("explorer");
		const multi = buildDelegationDirective([agent("explorer"), agent("executor")]);
		expect(multi).toContain("only genuinely dependent work waits for its prerequisite");
	});

	it("pushes delegation with an inline trivial-work boundary", () => {
		const directive = buildDelegationDirective([agent("explorer"), agent("executor")]);
		expect(directive).toContain("Delegate aggressively");
		expect(directive).toContain("Inline only trivial work");
		expect(directive).toContain("default every non-trivial delegated task");
		expect(directive).toContain("split a broad question into parallel explorers with disjoint scopes");
		expect(directive).toContain("delegation saves search, not that read");
		expect(directive).toContain("leads, never proof");
		expect(directive).toContain("re-read the cited line ranges before acting on them");
		expect(directive).toContain("a child you brief re-verifies");

		const withoutExplorer = buildDelegationDirective([agent("executor")]);
		expect(withoutExplorer).not.toContain("explorer");
	});

	it("briefs the executor as the edit authorization with cleanup scope and fan-out merging", () => {
		const directive = buildDelegationDirective([agent("executor")]);
		expect(directive).toContain("brief it as the edit authorization");
		expect(directive).toContain("name the scope (uncommitted diff, Git range, directory)");
		expect(directive).toContain("every safe proven cut applies without per-item approval");
		expect(directive).toContain("finding no safe cut is a valid result");
		expect(directive).toContain("pass the result-artifact paths to one executor");
		expect(directive).toContain("read its merged brief instead of every result yourself");
	});

	it("does not advertise explorer routing when the role is disabled", () => {
		const directive = buildDelegationDirective([agent("executor")]);
		expect(directive).not.toContain("`explorer`");
	});

	it("carries no isolation guidance — defaults and role frontmatter own it", () => {
		const directive = buildDelegationDirective([agent("explorer"), agent("executor")]);
		expect(directive).not.toContain("isolation");
		expect(directive).not.toContain("committed HEAD");
	});

	it("preserves non-blocking dispatch, automatic handoff, and no result restatement", () => {
		const directive = buildDelegationDirective([agent("explorer"), agent("executor")]);
		expect(directive).toContain("Dispatch never blocks or ends your turn");
		expect(directive).toContain("each completion resumes you automatically");
		expect(directive).toContain("Never sleep or poll for it");
		expect(directive).toContain("never a restatement");
		expect(directive).toContain("Never declare the overall task done while a dispatched run is still active");
	});

	it("keeps verification honest without any gate vocabulary", () => {
		const directive = buildDelegationDirective(loadBuiltinAgents());
		expect(directive).toContain("Never report an unrun check as passed");
		expect(directive).toContain("inspect the actual diff before reporting completion");
		expect(directive).toContain("Commit or push only when explicitly requested");
		expect(directive).not.toContain("REVIEW_");
		expect(directive).not.toContain("VERDICT");
		expect(directive).not.toContain("reviewer");
	});

	it("does not reintroduce removed vision routing", () => {
		const directive = buildDelegationDirective([agent("explorer"), agent("executor")]);
		expect(directive).not.toContain("vision");
	});
});
