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
		assert.ok(scout.systemPrompt.includes("broad reconnaissance phase"));
		assert.ok(scout.systemPrompt.includes("Atomic lookups and known locations stay with main"));
		assert.ok(scout.systemPrompt.includes("Cluster related questions"));
		assert.ok(scout.systemPrompt.includes("Start from what the brief already establishes"));
		assert.ok(scout.systemPrompt.includes("Answer the brief's question, then stop"));
		assert.ok(scout.systemPrompt.includes("nobody answers questions"));
		assert.match(scout.systemPrompt, /draft code or patches/u);
		assert.match(scout.systemPrompt, /\(inferred\)/u);
		assert.ok(!isWriteCapableAgent(scout));
	});

	it("keeps artisan on the complete primary change and out of final cleanup", () => {
		const artisan = loadBuiltinAgents().find((agent) => agent.name === "artisan");
		assert.ok(artisan);
		assert.equal(artisan.tools, undefined);
		assert.ok(isWriteCapableAgent(artisan));
		assert.ok(artisan.systemPrompt.includes("confirm the defect before editing"));
		assert.ok(artisan.systemPrompt.includes("root cause"));
		assert.match(artisan.systemPrompt, /fail .*before.*pass/iu);
		assert.ok(artisan.systemPrompt.includes("directly affected tests, README/docs, comments"));
		assert.ok(artisan.systemPrompt.includes("local diff hygiene"));
		assert.ok(artisan.systemPrompt.includes("cross-cutting pre-commit cleanup"));
		assert.ok(artisan.systemPrompt.includes("do not dispatch agents"));
		assert.ok(artisan.systemPrompt.includes("Start from the brief's cited lines and stated facts"));
		assert.match(artisan.systemPrompt, /premise is wrong.*stop and report the conflict with evidence/u);
		assert.ok(artisan.systemPrompt.includes("nobody answers questions"));
		assert.match(artisan.systemPrompt, /each check as `command → result`/u);
		assert.match(artisan.systemPrompt, /disproved assumptions, or out-of-scope follow-ups/u);
	});

	it("keeps steward on final hygiene and cross-cutting docs", () => {
		const steward = loadBuiltinAgents().find((agent) => agent.name === "steward");
		assert.ok(steward);
		assert.ok(isWriteCapableAgent(steward));
		assert.ok(steward.systemPrompt.includes("final hygiene phase"));
		assert.ok(steward.systemPrompt.includes("cross-cutting comments, README, examples, and user docs"));
		assert.ok(steward.systemPrompt.includes("never repeat implementation or reconnaissance"));
		assert.ok(steward.systemPrompt.includes("without changing product behavior"));
		assert.ok(steward.systemPrompt.includes("dead or unreachable code"));
		assert.ok(steward.systemPrompt.includes("tangled conditionals"));
		assert.ok(!steward.systemPrompt.includes("Merging inputs"));
		assert.ok(steward.systemPrompt.includes("nobody answers questions"));
		assert.match(steward.systemPrompt, /narrowest checks that cover your own edits/u);
		assert.match(steward.systemPrompt, /primary change's verification is not yours to repeat/u);
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
		assert.ok(sentinel.systemPrompt.includes("nobody answers questions"));
		assert.ok(sentinel.systemPrompt.includes("Work read-only"));
		assert.ok(sentinel.systemPrompt.includes("smallest targeted check needed to prove a suspected defect"));
		assert.match(sentinel.systemPrompt, /whether each test would fail without the change/u);
		assert.ok(sentinel.systemPrompt.includes("Fixes belong to the implementation owner and cleanup to `steward`"));
		assert.ok(sentinel.systemPrompt.includes("SEVERITY path:line"));
		assert.ok(sentinel.systemPrompt.includes("No findings."));
		assert.ok(sentinel.systemPrompt.includes("do not dispatch agents"));
		assert.ok(!/ferris|Before every commit/u.test(sentinel.systemPrompt));
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
