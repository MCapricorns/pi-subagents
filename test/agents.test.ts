import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	formatCatalogEntry,
	isWriteCapableAgent,
	loadBuiltinAgents,
	resolveAgentTools,
	type ToolMetadata,
} from "../src/delegation/agents.ts";

function tool(
	name: string,
	annotations?: ToolMetadata["annotations"],
	reachesTools?: ToolMetadata["reachesTools"],
	exposure?: ToolMetadata["exposure"],
): ToolMetadata {
	return {
		name,
		...(annotations ? { annotations } : {}),
		...(reachesTools ? { reachesTools } : {}),
		...(exposure ? { exposure } : {}),
	};
}

const READ_ONLY = tool("docs_search", { readOnlyHint: true });
const CODEMODE = tool("codemode", undefined, () => "all", "direct");

describe("loadBuiltinAgents", () => {
	it("ships two worker scopes without frontmatter thinking", () => {
		const agents = loadBuiltinAgents();
		assert.deepEqual(agents.map((agent) => agent.name), ["researcher", "worker"]);
		for (const agent of agents) {
			assert.equal(agent.model, undefined);
			assert.ok(!("thinking" in agent));
			assert.match(agent.systemPrompt, /loaded project instructions/u);
			assert.match(agent.systemPrompt, /no interactive clarification/u);
			assert.match(agent.systemPrompt, /Follow the brief within loaded project instructions/u);
			assert.match(agent.systemPrompt, /do not dispatch agents, bump versions, commit, push, publish, tag, or release/u);
			// Researcher receives only direct read-only tools, never a script tool.
			if (agent.name === "researcher") assert.doesNotMatch(agent.systemPrompt, /script tool/u);
			else assert.match(agent.systemPrompt, /directly, or through its script tool/u);
			assert.doesNotMatch(formatCatalogEntry(agent), /[\r\n]/u);
		}
	});

	it("keeps researcher read-only and retrieval-only", () => {
		const researcher = loadBuiltinAgents().find((agent) => agent.name === "researcher");
		assert.ok(researcher);
		// The surface is derived from live tool metadata, so no role file carries
		// a list of extension, MCP, or vendor tool names.
		assert.equal(researcher.tools, undefined);
		assert.match(researcher.description, /external facts/u);
		assert.ok(researcher.systemPrompt.includes("retrieval lead"));
		assert.ok(researcher.systemPrompt.includes("Stay read-only"));
		assert.ok(researcher.systemPrompt.includes("untrusted data"));
		assert.match(researcher.systemPrompt, /primary sources/u);
		assert.match(researcher.systemPrompt, /URL/u);
		assert.match(researcher.systemPrompt, /Follow relevant leads until the question is answered or the evidence runs out, then stop/u);
		assert.match(researcher.systemPrompt, /read-only boundary still wins/u);
		assert.match(researcher.systemPrompt, /Distinguish inference from verified facts/u);
		assert.match(researcher.systemPrompt, /^Answer: /mu);
		assert.match(researcher.systemPrompt, /^Evidence: /mu);
		assert.ok(!isWriteCapableAgent(researcher));
	});

	it("keeps worker on one complete change through verification", () => {
		const worker = loadBuiltinAgents().find((agent) => agent.name === "worker");
		assert.ok(worker);
		assert.equal(worker.tools, undefined);
		assert.ok(isWriteCapableAgent(worker));
		assert.match(worker.systemPrompt, /confirm current behavior.*root cause/u);
		assert.match(worker.systemPrompt, /affected tests, docs, comments, local cleanup, and verification/u);
		assert.match(worker.systemPrompt, /Do not stop at a plan or a first draft/u);
		assert.match(worker.systemPrompt, /premise is disproved.*approval boundary.*Report the blocker with evidence/u);
		assert.match(worker.systemPrompt, /Tests should catch the relevant failure/u);
		assert.match(worker.systemPrompt, /checks and gates the brief or project requires/u);
		assert.match(worker.systemPrompt, /reversible, low-impact edit/u);
		assert.match(worker.systemPrompt, /Repeat or broaden checks only for new edits, failures, or unresolved concerns/u);
		assert.match(worker.systemPrompt, /unrun checks and pre-existing failures accurately/u);
		assert.match(worker.systemPrompt, /one per line as `command → result`/u);
		assert.match(worker.systemPrompt, /leaf boundary below still wins/u);
		// A fixed handoff shape keeps weaker workers predictable and main's review cheap.
		assert.match(worker.systemPrompt, /^Status: done, partial, or blocked/mu);
		assert.match(worker.systemPrompt, /^Changes: /mu);
		assert.match(worker.systemPrompt, /^Checks: /mu);
	});

	it("preserves evidence reuse for research and implementation", () => {
		const researcher = loadBuiltinAgents().find((agent) => agent.name === "researcher");
		const worker = loadBuiltinAgents().find((agent) => agent.name === "worker");
		assert.ok(researcher && worker);
		assert.match(researcher.systemPrompt, /Fill gaps in main or upstream findings instead of repeating their research/u);
		assert.match(worker.systemPrompt, /Reuse completed main or upstream work; implement only the remaining delta/u);
		assert.match(worker.systemPrompt, /Reuse supplied passing checks when they cover the current files/u);
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
	it("derives the researcher boundary from live read-only metadata", () => {
		const researcher = loadBuiltinAgents().find((agent) => agent.name === "researcher");
		assert.ok(researcher);
		const infos = [
			READ_ONLY,
			tool("mcp__docs__search", { readOnlyHint: true }),
			tool("db_write", { readOnlyHint: false }),
			tool("unannotated_retrieval"),
			tool("codemode", { readOnlyHint: true }, () => "all"),
			tool("tool_search", undefined, () => "all"),
		];
		const resolved = resolveAgentTools(researcher, [
			"read",
			"grep",
			"mcp__docs__search",
			"docs_search",
			"db_write",
			"unannotated_retrieval",
			"codemode",
			"tool_search",
			"bash",
			"edit",
			"write",
			"subagent",
			"subagent_status",
		], infos);
		assert.deepEqual(resolved.tools, ["read", "grep", "mcp__docs__search", "docs_search"]);
	});

	it("keeps codemode for broad roles and out of read-only roles", () => {
		const worker = loadBuiltinAgents().find((agent) => agent.name === "worker");
		const researcher = loadBuiltinAgents().find((agent) => agent.name === "researcher");
		assert.ok(worker && researcher);
		const infos = [CODEMODE, READ_ONLY];
		const active = ["read", "edit", "codemode", "docs_search"];
		assert.deepEqual(resolveAgentTools(worker, active, infos).tools, active);
		assert.deepEqual(resolveAgentTools(researcher, active, infos).tools, ["read", "docs_search"]);
	});

	it("lets worker run checks through the active tools while keeping it a leaf", () => {
		const agent = loadBuiltinAgents().find((entry) => entry.name === "worker");
		assert.ok(agent);
		assert.deepEqual(resolveAgentTools(agent, ["read", "powershell", "codemode", "edit", "subagent", "subagent_status", "subagent_message", "subagent_stop"], [CODEMODE]).tools,
			["read", "powershell", "codemode", "edit"]);
	});

	it("hands a read-only role the script-only read-only tools the session can reach", () => {
		const researcher = loadBuiltinAgents().find((agent) => agent.name === "researcher");
		assert.ok(researcher);
		const infos = [
			CODEMODE,
			READ_ONLY,
			// An MCP server the user cannot reconfigure: script-only by default.
			tool("mcp__search__search", { readOnlyHint: true }, undefined, "codemode"),
			tool("mcp__search__extract", { readOnlyHint: true }, undefined, "deferred"),
			// Write-capable, unannotated, or reaching tools stay out.
			tool("mcp__repo__push", { readOnlyHint: false }, undefined, "codemode"),
			tool("mcp__repo__unknown", undefined, undefined, "codemode"),
		];
		const active = ["read", "codemode"];
		assert.deepEqual(resolveAgentTools(researcher, active, infos).tools, [
			"read",
			"mcp__search__extract",
			"mcp__search__search",
		]);
		// Without an indirect tool in the session, nothing can reach them.
		assert.deepEqual(resolveAgentTools(researcher, ["read"], infos).tools, ["read"]);
	});

	it("inherits active and callable indirect tools without widening inactive direct tools", () => {
		const infos = [
			CODEMODE,
			tool("tool_search", undefined, () => "all"),
			tool("mcp__direct__search", { readOnlyHint: true }, undefined, "direct"),
			tool("mcp__indirect__search", { readOnlyHint: true }, undefined, "codemode"),
			tool("extension_deferred", undefined, undefined, "deferred"),
			tool("inactive_direct", undefined, undefined, "direct"),
			tool("mcp__inactive__direct", undefined, undefined, "direct"),
			tool("hidden_tool", undefined, undefined, "hidden"),
			tool("subagent", undefined, undefined, "codemode"),
			tool("subagent_message", undefined, undefined, "deferred"),
		];
		for (const name of ["worker"]) {
			const agent = loadBuiltinAgents().find((entry) => entry.name === name)!;
			for (const reachingTool of ["codemode", "tool_search"]) {
				assert.deepEqual(resolveAgentTools(agent, ["read", reachingTool, "mcp__direct__search"], infos).tools,
					["read", reachingTool, "mcp__direct__search", "extension_deferred", "mcp__indirect__search"]);
			}
			// Pi keeps registered indirect tools callable independently of activation.
			assert.deepEqual(resolveAgentTools(agent, ["read"], infos).tools, ["read", "extension_deferred", "mcp__indirect__search"]);
		}
	});

	it("treats tools without a read-only proof as potentially write-capable", () => {
		const infos = [READ_ONLY, tool("db_write", { readOnlyHint: false }), tool("codemode", undefined, () => "all")];
		assert.equal(isWriteCapableAgent({ name: "custom", tools: ["read", "grep"] }), false);
		assert.equal(isWriteCapableAgent({ name: "custom", tools: ["read", "docs_search"] }, infos), false);
		assert.equal(isWriteCapableAgent({ name: "custom", tools: ["read", "custom_repository_tool"] }), true);
		assert.equal(isWriteCapableAgent({ name: "custom", tools: ["read", "db_write"] }, infos), true);
		assert.equal(isWriteCapableAgent({ name: "custom", tools: ["read", "codemode"] }, infos), true);
	});
});
