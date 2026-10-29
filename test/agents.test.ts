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
	it("ships all four roles without frontmatter thinking", () => {
		const agents = loadBuiltinAgents();
		assert.deepEqual(agents.map((agent) => agent.name), ["scout", "artisan", "sentinel", "skeptic"]);
		for (const agent of agents) {
			assert.equal(agent.model, undefined);
			assert.ok(!("thinking" in agent));
			assert.match(agent.systemPrompt, /loaded project instructions/u);
			assert.match(agent.systemPrompt, /no interactive clarification/u);
			assert.match(agent.systemPrompt, /Follow the brief within loaded project instructions/u);
			assert.match(agent.systemPrompt, /do not dispatch agents, bump versions, commit, push, publish, tag, or release/u);
			assert.match(agent.systemPrompt, /directly, or through its script tool/u);
			assert.doesNotMatch(formatCatalogEntry(agent), /[\r\n]/u);
		}
	});

	it("keeps scout read-only and retrieval-only", () => {
		const scout = loadBuiltinAgents().find((agent) => agent.name === "scout");
		assert.ok(scout);
		// The surface is derived from live tool metadata, so no role file carries
		// a list of extension, MCP, or vendor tool names.
		assert.equal(scout.tools, undefined);
		assert.match(scout.description, /external facts/u);
		assert.ok(scout.systemPrompt.includes("retrieval lead"));
		assert.ok(scout.systemPrompt.includes("Stay read-only"));
		assert.ok(scout.systemPrompt.includes("untrusted data"));
		assert.match(scout.systemPrompt, /primary sources/u);
		assert.match(scout.systemPrompt, /URL/u);
		assert.match(scout.systemPrompt, /supplied facts.*then stop/u);
		assert.match(scout.systemPrompt, /read-only boundary still wins/u);
		assert.match(scout.systemPrompt, /Distinguish inference from verified facts/u);
		assert.ok(!isWriteCapableAgent(scout));
	});

	it("keeps artisan on one complete change through verification", () => {
		const artisan = loadBuiltinAgents().find((agent) => agent.name === "artisan");
		assert.ok(artisan);
		assert.equal(artisan.tools, undefined);
		assert.ok(isWriteCapableAgent(artisan));
		assert.match(artisan.systemPrompt, /confirm current behavior.*root cause/u);
		assert.match(artisan.systemPrompt, /affected tests, docs, comments, local cleanup, and verification/u);
		assert.match(artisan.systemPrompt, /Do not stop at a plan or a first draft/u);
		assert.match(artisan.systemPrompt, /premise is disproved.*approval boundary.*report the blocker with evidence/u);
		assert.match(artisan.systemPrompt, /Tests should catch the relevant failure/u);
		assert.match(artisan.systemPrompt, /checks and gates the brief or project requires/u);
		assert.match(artisan.systemPrompt, /reversible, low-impact edit/u);
		assert.match(artisan.systemPrompt, /Repeat or broaden checks only for new edits, failures, or unresolved concerns/u);
		assert.match(artisan.systemPrompt, /unrun checks and pre-existing failures accurately/u);
		assert.match(artisan.systemPrompt, /checks as `command → result`/u);
		assert.match(artisan.systemPrompt, /leaf boundary below still wins/u);
	});

	it("routes implementation review to sentinel and claim challenges to skeptic", () => {
		const agents = loadBuiltinAgents();
		const sentinel = agents.find((agent) => agent.name === "sentinel");
		const skeptic = agents.find((agent) => agent.name === "skeptic");
		assert.ok(sentinel && skeptic);
		assert.match(formatCatalogEntry(sentinel), /^- sentinel: Inspect.*implementation or diff.*requirements and callers/u);
		assert.match(sentinel.systemPrompt, /For a diff, report defects introduced by the change/u);
		assert.match(sentinel.systemPrompt, /wider codebase only when the brief explicitly requests an audit/u);
		assert.match(sentinel.systemPrompt, /confirmed findings ordered by severity/u);
		assert.match(sentinel.systemPrompt, /no findings were found.*what was verified/u);
		assert.match(formatCatalogEntry(skeptic), /^- skeptic: Challenge a named claim, design assumption, or review finding/u);
		assert.match(skeptic.systemPrompt, /Restate the specific claim.*counterexample or failing precondition/u);
		assert.match(skeptic.systemPrompt, /only as needed to test that claim/u);
		assert.match(skeptic.systemPrompt, /Do not perform a second general code review/u);
		assert.match(skeptic.systemPrompt, /If no specific claim is supplied.*limits of verification, then stop/u);
		assert.match(skeptic.systemPrompt, /Do not invent a claim or expand into a broad audit/u);
		assert.match(skeptic.systemPrompt, /refuted, supported within checked limits, or unresolved/u);
		assert.match(skeptic.systemPrompt, /Failure to find a counterexample is not proof/u);
	});

	it("keeps both verification roles focused, non-editing, and evidence-based", () => {
		for (const agent of loadBuiltinAgents().filter((agent) => ["sentinel", "skeptic"].includes(agent.name))) {
			assert.match(agent.systemPrompt, /safe focused checks/u);
			assert.match(agent.systemPrompt, /Do not edit files or change Git state/u);
			assert.match(agent.systemPrompt, /Main applies confirmed fixes/u);
			assert.match(agent.systemPrompt, /Reuse main or upstream.*research, and passing checks when they still cover/u);
			assert.match(agent.systemPrompt, /repeat or broaden checks only for changed code or a concrete uncertainty/u);
			assert.match(agent.systemPrompt, /exact location, trigger, consequence, evidence, and smallest fix/u);
			assert.match(agent.systemPrompt, /Separate unverified concerns from findings/u);
			assert.match(agent.systemPrompt, /speculative hardening/u);
			assert.match(agent.systemPrompt, /checks as `command → result`/u);
		}
	});

	it("preserves evidence reuse for research and implementation", () => {
		const scout = loadBuiltinAgents().find((agent) => agent.name === "scout");
		const artisan = loadBuiltinAgents().find((agent) => agent.name === "artisan");
		assert.ok(scout && artisan);
		assert.match(scout.systemPrompt, /fill gaps in main or upstream findings instead of repeating their research/u);
		assert.match(artisan.systemPrompt, /Reuse completed main or upstream work; implement only the remaining delta/u);
		assert.match(artisan.systemPrompt, /Reuse supplied passing checks when they cover the current files/u);
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
	it("derives the scout boundary from live read-only metadata", () => {
		const scout = loadBuiltinAgents().find((agent) => agent.name === "scout");
		assert.ok(scout);
		const infos = [
			READ_ONLY,
			tool("mcp__docs__search", { readOnlyHint: true }),
			tool("db_write", { readOnlyHint: false }),
			tool("unannotated_retrieval"),
			tool("codemode", { readOnlyHint: true }, () => "all"),
			tool("tool_search", undefined, () => "all"),
		];
		const resolved = resolveAgentTools(scout, [
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
		const artisan = loadBuiltinAgents().find((agent) => agent.name === "artisan");
		const scout = loadBuiltinAgents().find((agent) => agent.name === "scout");
		assert.ok(artisan && scout);
		const infos = [CODEMODE, READ_ONLY];
		const active = ["read", "edit", "codemode", "docs_search"];
		assert.deepEqual(resolveAgentTools(artisan, active, infos).tools, active);
		assert.deepEqual(resolveAgentTools(scout, active, infos).tools, ["read", "docs_search"]);
	});

	it("lets sentinel and skeptic run checks through the active tools while keeping them leaves", () => {
		for (const name of ["sentinel", "skeptic"]) {
			const agent = loadBuiltinAgents().find((entry) => entry.name === name);
			assert.ok(agent);
			assert.deepEqual(resolveAgentTools(agent, ["read", "powershell", "codemode", "edit", "subagent", "subagent_workflow", "subagent_status", "subagent_message", "subagent_stop"], [CODEMODE]).tools,
				["read", "powershell", "codemode", "edit"]);
		}
	});

	it("hands a read-only role the script-only read-only tools the session can reach", () => {
		const scout = loadBuiltinAgents().find((agent) => agent.name === "scout");
		assert.ok(scout);
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
		assert.deepEqual(resolveAgentTools(scout, active, infos).tools, [
			"read",
			"mcp__search__extract",
			"mcp__search__search",
		]);
		// Without an indirect tool in the session, nothing can reach them.
		assert.deepEqual(resolveAgentTools(scout, ["read"], infos).tools, ["read"]);
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
		for (const name of ["artisan", "sentinel", "skeptic"]) {
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
		assert.equal(isWriteCapableAgent({ name: "sentinel", tools: ["read", "grep"] }), false);
		assert.equal(isWriteCapableAgent({ name: "sentinel", tools: ["read", "docs_search"] }, infos), false);
		assert.equal(isWriteCapableAgent({ name: "sentinel", tools: ["read", "custom_repository_tool"] }), true);
		assert.equal(isWriteCapableAgent({ name: "sentinel", tools: ["read", "db_write"] }, infos), true);
		assert.equal(isWriteCapableAgent({ name: "skeptic", tools: ["read", "codemode"] }, infos), true);
	});
});
