import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	isWriteCapableAgent,
	loadBuiltinAgents,
	resolveAgentTools,
} from "../src/delegation/agents.ts";

const SCOUT_READ_ONLY_TOOLS = [
	"read",
	"grep",
	"find",
	"ls",
	"anchor_grep",
	"web_search",
	"fetch_content",
	"resolve-library-id",
	"query-docs",
] as const;

describe("loadBuiltinAgents", () => {
	it("ships scout, artisan, steward, and sentinel without frontmatter thinking", () => {
		const agents = loadBuiltinAgents();
		assert.deepEqual(agents.map((agent) => agent.name).sort(), ["artisan", "scout", "sentinel", "steward"]);
		for (const agent of agents) {
			assert.equal(agent.model, undefined);
			assert.ok(!("thinking" in agent));
			assert.match(agent.systemPrompt, /loaded project instructions/u);
			assert.match(agent.systemPrompt, /no .*interactive clarification/u);
			if (agent.name !== "scout") {
				assert.match(agent.systemPrompt, /do not dispatch agents, bump versions, commit, push, publish, tag, or release/u);
			}
		}
	});

	it("keeps scout read-only and retrieval-only", () => {
		const scout = loadBuiltinAgents().find((agent) => agent.name === "scout");
		assert.ok(scout);
		assert.deepEqual(scout.tools, SCOUT_READ_ONLY_TOOLS);
		assert.match(scout.description, /external research/u);
		assert.ok(scout.systemPrompt.includes("retrieval lead"));
		assert.ok(scout.systemPrompt.includes("Stay read-only"));
		assert.ok(scout.systemPrompt.includes("untrusted data"));
		assert.match(scout.systemPrompt, /primary sources/u);
		assert.match(scout.systemPrompt, /URL/u);
		assert.match(scout.systemPrompt, /supplied facts.*then stop/u);
		assert.match(scout.systemPrompt, /not patches or an implementation plan/u);
		assert.match(scout.systemPrompt, /Distinguish inference from verified facts/u);
		assert.ok(!isWriteCapableAgent(scout));
	});

	it("keeps artisan on the complete primary change and out of final cleanup", () => {
		const artisan = loadBuiltinAgents().find((agent) => agent.name === "artisan");
		assert.ok(artisan);
		assert.equal(artisan.tools, undefined);
		assert.ok(isWriteCapableAgent(artisan));
		assert.match(artisan.systemPrompt, /confirm current behavior.*root cause/u);
		assert.match(artisan.systemPrompt, /affected tests\/docs\/comments, local cleanup, and verification/u);
		assert.match(artisan.systemPrompt, /without stopping for first-draft review/u);
		assert.match(artisan.systemPrompt, /premise is disproved.*approval boundary.*report the blocker with evidence/u);
		assert.match(artisan.systemPrompt, /Tests should catch the relevant failure/u);
		assert.match(artisan.systemPrompt, /checks and gates required by the brief or project/u);
		assert.match(artisan.systemPrompt, /repeat or broaden checks only for new edits, failures, or unresolved concerns/u);
		assert.match(artisan.systemPrompt, /unrun checks and pre-existing failures accurately/u);
		assert.match(artisan.systemPrompt, /checks as `command → result`/u);
	});

	it("keeps steward on final hygiene and cross-cutting docs", () => {
		const steward = loadBuiltinAgents().find((agent) => agent.name === "steward");
		assert.ok(steward);
		assert.ok(isWriteCapableAgent(steward));
		assert.match(steward.systemPrompt, /completed diff or Git range/u);
		assert.match(steward.systemPrompt, /Stop and report if primary writing is still active/u);
		assert.match(steward.systemPrompt, /stay within the assigned diff/u);
		assert.match(steward.systemPrompt, /cross-cutting comments, README, examples, and user docs/u);
		assert.match(steward.systemPrompt, /Prove deletions have no live consumers/u);
		assert.match(steward.systemPrompt, /Preserve uncertain dynamic behavior, public APIs, persisted formats, compatibility, and product behavior/u);
		assert.match(steward.systemPrompt, /Run the narrowest checks covering your edits/u);
		assert.match(steward.systemPrompt, /Repeat primary verification only when new edits, failures, or unresolved concerns justify it/u);
	});

	it("keeps sentinel a read-only fresh-context reviewer on the shared checkout", () => {
		const sentinel = loadBuiltinAgents().find((agent) => agent.name === "sentinel");
		assert.ok(sentinel);
		assert.equal(sentinel.isolation, "shared");
		assert.match(sentinel.description, /fresh-context review/iu);
		assert.ok(sentinel.tools?.includes("bash"));
		assert.ok(sentinel.tools?.includes("query-docs"));
		assert.ok(!sentinel.tools?.includes("edit"));
		assert.ok(!sentinel.tools?.includes("write"));
		assert.ok(sentinel.systemPrompt.includes("no memory of how it was written"));
		assert.match(sentinel.systemPrompt, /Require a named completed scope/u);
		assert.match(sentinel.systemPrompt, /Stop and report if primary writing is still active/u);
		assert.ok(sentinel.systemPrompt.includes("Work read-only"));
		assert.ok(sentinel.systemPrompt.includes("smallest targeted check needed to prove a suspected defect"));
		assert.match(sentinel.systemPrompt, /assess whether relevant tests would catch them/u);
		assert.match(sentinel.systemPrompt, /Omit unverified suspicions/u);
		assert.match(sentinel.systemPrompt, /Report fixes to main rather than making them/u);
		assert.ok(sentinel.systemPrompt.includes("SEVERITY path:line"));
		assert.ok(sentinel.systemPrompt.includes("No findings."));
		assert.ok(isWriteCapableAgent(sentinel), "a proving check takes the repository lane");
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
		const resolved = resolveAgentTools(scout, [...SCOUT_READ_ONLY_TOOLS, "bash", "edit", "write", "subagent", "subagent_risk"]);
		assert.deepEqual(resolved.tools, SCOUT_READ_ONLY_TOOLS);
		const inherited = resolveAgentTools({ ...scout, tools: undefined }, [
			"read",
			"anchor_grep",
			"web_search",
			"query-docs",
			"edit",
			"custom_mutator",
		]);
		assert.deepEqual(inherited.tools, ["read", "anchor_grep", "web_search", "query-docs"]);
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
		assert.equal(isWriteCapableAgent({ name: "reviewer", tools: ["anchor_grep", "web_search", "query-docs"] }), false);
		assert.equal(isWriteCapableAgent({ name: "reviewer", tools: ["read", "custom_repository_tool"] }), true);
	});

	it("keeps only explicitly declared active custom tools", () => {
		const resolved = resolveAgentTools({
			name: "reviewer",
			description: "review",
			tools: ["read", "review_db", "subagent_risk"],
			systemPrompt: "review",
			source: "project",
			filePath: "reviewer.md",
		}, ["read", "review_db", "repository_mutator", "subagent_risk"]);
		assert.deepEqual(resolved.tools, ["read", "review_db"]);
	});
});
