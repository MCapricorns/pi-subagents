import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	isWriteCapableAgent,
	loadBuiltinAgents,
	resolveAgentTools,
} from "../src/agents.ts";

describe("loadBuiltinAgents", () => {
	it("ships scout, artisan, and steward without frontmatter thinking", () => {
		const agents = loadBuiltinAgents();
		assert.deepEqual(agents.map((agent) => agent.name).sort(), ["artisan", "scout", "steward"]);
		for (const agent of agents) {
			assert.equal(agent.model, undefined);
			assert.ok(!("thinking" in agent));
		}
	});

	it("keeps scout read-only and retrieval-only", () => {
		const scout = loadBuiltinAgents().find((agent) => agent.name === "scout");
		assert.ok(scout);
		assert.deepEqual(scout.tools, ["read", "grep", "find", "ls"]);
		assert.ok(scout.systemPrompt.includes("retrieval lead"));
		assert.ok(scout.systemPrompt.includes("Stay read-only"));
		assert.ok(scout.systemPrompt.includes("broad reconnaissance phase"));
		assert.ok(scout.systemPrompt.includes("Atomic lookups and known locations stay with main"));
		assert.ok(scout.systemPrompt.includes("Cluster related questions"));
		assert.ok(!isWriteCapableAgent(scout));
	});

	it("keeps artisan on implementation and out of tidy work", () => {
		const artisan = loadBuiltinAgents().find((agent) => agent.name === "artisan");
		assert.ok(artisan);
		assert.equal(artisan.tools, undefined);
		assert.ok(isWriteCapableAgent(artisan));
		assert.ok(artisan.systemPrompt.includes("confirm the defect before editing"));
		assert.ok(artisan.systemPrompt.includes("directly affected tests, README/docs, comments"));
		assert.ok(artisan.systemPrompt.includes("local diff hygiene"));
		assert.ok(artisan.systemPrompt.includes("cross-cutting pre-commit cleanup"));
		assert.ok(artisan.systemPrompt.includes("do not dispatch agents"));
	});

	it("keeps steward on final hygiene and cross-cutting docs", () => {
		const steward = loadBuiltinAgents().find((agent) => agent.name === "steward");
		assert.ok(steward);
		assert.ok(isWriteCapableAgent(steward));
		assert.ok(steward.systemPrompt.includes("final hygiene phase"));
		assert.ok(steward.systemPrompt.includes("cross-cutting comments, README, examples, and user docs"));
		assert.ok(steward.systemPrompt.includes("never repeat implementation or reconnaissance"));
		assert.ok(steward.systemPrompt.includes("without changing product behavior"));
		assert.ok(!steward.systemPrompt.includes("Merging inputs"));
	});

	it("keeps shell guidance portable", () => {
		const posixOnly = /`(?:cat|sed|awk|which|touch|rm|cp|mv)\b/u;
		for (const agent of loadBuiltinAgents()) {
			assert.ok(!posixOnly.test(agent.systemPrompt), `${agent.name} names a POSIX-only command`);
			if (/\bshell\b/iu.test(agent.systemPrompt)) {
				assert.ok(agent.systemPrompt.includes("PowerShell"), `${agent.name} assumes one shell flavor`);
			}
		}
	});
});

describe("resolveAgentTools", () => {
	it("enforces the scout read-only boundary", () => {
		const scout = loadBuiltinAgents().find((agent) => agent.name === "scout");
		assert.ok(scout);
		const resolved = resolveAgentTools(scout, ["read", "bash", "edit", "write", "web_search", "subagent"]);
		assert.deepEqual(resolved.tools, ["read"]);
		assert.deepEqual(resolveAgentTools({ ...scout, tools: undefined }, ["read", "edit", "custom_mutator"]).tools, ["read"]);
	});

	it("adapts a declared shell to the parent's active shell", () => {
		const resolved = resolveAgentTools({
			name: "reviewer",
			description: "review",
			tools: ["read", "bash"],
			systemPrompt: "review",
			source: "project",
			filePath: "reviewer.md",
		}, ["read", "powershell"]);
		assert.deepEqual(resolved.tools, ["read", "powershell"]);
	});

	it("treats unknown explicitly allowed tools as potentially write-capable", () => {
		assert.equal(isWriteCapableAgent({ name: "reviewer", tools: ["read", "grep"] }), false);
		assert.equal(isWriteCapableAgent({ name: "reviewer", tools: ["read", "custom_repository_tool"] }), true);
	});

	it("keeps only explicitly declared active custom tools", () => {
		const resolved = resolveAgentTools({
			name: "reviewer",
			description: "review",
			tools: ["read", "review_db"],
			systemPrompt: "review",
			source: "project",
			filePath: "reviewer.md",
		}, ["read", "review_db", "repository_mutator"]);
		assert.deepEqual(resolved.tools, ["read", "review_db"]);
	});
});
