import assert from "node:assert/strict";
import { describe, it } from "node:test";
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
		assert.equal(buildDelegationDirective([]), "");
	});

	it("lists the catalog and keeps leaf-brief rules", () => {
		const directive = buildDelegationDirective([agent("scout"), agent("artisan"), agent("steward")]);
		assert.ok(directive.includes("- scout: scout description"));
		assert.ok(directive.includes("- artisan: artisan description"));
		assert.ok(directive.includes("- steward: steward description"));
		assert.ok(directive.includes("isolated leaf Pi child processes"));
		assert.ok(directive.includes("goal, exact paths, constraints, expected output"));
		assert.ok(directive.includes("cannot delegate"));
		assert.ok(directive.includes("subagent_control resume"));
	});

	it("keeps the default injected directive below the prompt budget", () => {
		const directive = buildDelegationDirective(loadBuiltinAgents());
		assert.ok(directive.length < 3_200, `directive is ${directive.length} characters`);
	});

	it("routes code changes to artisan and tidy work to steward only when needed", () => {
		const directive = buildDelegationDirective([agent("scout"), agent("artisan"), agent("steward")]);
		assert.ok(directive.includes("when the unit is a code change, default it to `artisan`"));
		assert.ok(directive.includes("split a broad question into parallel scouts"));
		assert.ok(directive.includes("leads, never proof"));
		assert.ok(directive.includes("brief it as the edit authorization for implement, fix, refactor, or test"));
		assert.ok(directive.includes("dispatch only when the work is cleanup, documentation sync, or merging named result artifacts"));
		assert.ok(directive.includes("do not invent a tidy pass"));
		assert.ok(directive.includes("pass the result-artifact paths to one steward"));
		assert.ok(!directive.includes("`explorer`"));
		assert.ok(!directive.includes("`executor`"));
	});

	it("omits a role's routing line when that role is disabled", () => {
		const artisanOnly = buildDelegationDirective([agent("artisan")]);
		assert.ok(!artisanOnly.includes("`scout`"));
		assert.ok(!artisanOnly.includes("`steward`"));
		assert.ok(artisanOnly.includes("`artisan`"));
	});

	it("preserves non-blocking dispatch and honest verification", () => {
		const directive = buildDelegationDirective(loadBuiltinAgents());
		assert.ok(directive.includes("Dispatch never blocks or ends your turn"));
		assert.ok(directive.includes("Never report an unrun check as passed"));
		assert.ok(!directive.includes("REVIEW_"));
		assert.ok(!directive.includes("vision"));
		assert.ok(!directive.includes("isolation"));
	});
});
