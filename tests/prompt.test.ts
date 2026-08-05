import { describe, expect, it } from "vitest";
import type { AgentConfig } from "../src/agents.ts";
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

	it("lists the catalog and core discipline rules", () => {
		const directive = buildDelegationDirective([agent("explore"), agent("worker"), agent("reviewer")]);
		expect(directive).toContain("subagent");
		expect(directive).toContain("- explore: explore description");
		expect(directive).toContain("- worker: worker description");
		expect(directive).toContain("Dispatch discipline");
		expect(directive).toContain("Review & verification");
		expect(directive).toContain("Trust but verify");
		expect(directive).toContain("leaf workers");
		expect(directive).toContain("NEVER run sleep");
	});

	it("mentions parallel only when multiple agents are enabled", () => {
		const single = buildDelegationDirective([agent("worker")]);
		expect(single).not.toContain("INDEPENDENT tasks in parallel");
		const multi = buildDelegationDirective([agent("explore"), agent("worker")]);
		expect(multi).toContain("INDEPENDENT tasks in parallel");
	});

	it("steers the model away from over-delegating simple work", () => {
		const directive = buildDelegationDirective([agent("explore"), agent("worker"), agent("reviewer")]);
		expect(directive).toContain("Handle SIMPLE work INLINE");
		expect(directive).toContain("Delegate only when isolation genuinely pays");
		expect(directive).toContain("When in doubt, start with a direct tool call");
		expect(directive).not.toContain("When in doubt, delegate");
	});

	it("includes reviewer-only rules only when a reviewer is enabled", () => {
		const withoutReviewer = buildDelegationDirective([agent("explore"), agent("worker")]);
		expect(withoutReviewer).not.toContain("multi-model cross-review");
		const withReviewer = buildDelegationDirective([agent("worker"), agent("reviewer")]);
		expect(withReviewer).toContain("multi-model cross-review");
	});
});
