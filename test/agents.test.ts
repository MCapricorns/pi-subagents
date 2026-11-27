import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	formatCatalogEntry,
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
	it("defines read-only researcher and write-capable worker leaf contracts", () => {
		const agents = loadBuiltinAgents();
		assert.deepEqual(agents.map((agent) => agent.name), ["researcher", "worker"]);
		const [researcher, worker] = agents;
		assert.ok(researcher && worker);
		for (const agent of agents) {
			assert.equal(agent.model, undefined);
			assert.equal(agent.tools, undefined);
			assert.match(agent.systemPrompt, /Leave delegation, version bumps, commits, pushes, publishing, tags, and releases to main/u);
			assert.doesNotMatch(formatCatalogEntry(agent), /[\r\n]/u);
		}
		assert.doesNotMatch(researcher.systemPrompt, /script tool/u);
		assert.match(researcher.systemPrompt, /^Answer: [\s\S]*^Evidence: /mu);

		assert.match(worker.systemPrompt, /Use direct tools or a script tool as declared/u);
		assert.match(worker.systemPrompt, /^Status: done, partial, or blocked[\s\S]*^Changes: [\s\S]*^Checks: /mu);
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

	it("rejects extensions that reuse built-in names without a read-only declaration", () => {
		const researcher = loadBuiltinAgents().find((agent) => agent.name === "researcher")!;
		const resolved = resolveAgentTools(researcher, ["read", "grep", "ls", "find"], [
			{ ...tool("read"), sourceInfo: { source: "local" } },
			tool("grep", { readOnlyHint: false }),
			tool("ls", { readOnlyHint: true, destructiveHint: true }),
			{ ...tool("find"), sourceInfo: { source: "builtin" } },
		]);
		assert.deepEqual(resolved.tools, ["find"]);
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
		const worker = loadBuiltinAgents().find((entry) => entry.name === "worker")!;
		for (const reachingTool of ["codemode", "tool_search"]) {
			assert.deepEqual(resolveAgentTools(worker, ["read", reachingTool, "mcp__direct__search"], infos).tools,
				["read", reachingTool, "mcp__direct__search", "extension_deferred", "mcp__indirect__search"]);
		}
		// Pi keeps registered indirect tools callable independently of activation.
		assert.deepEqual(resolveAgentTools(worker, ["read"], infos).tools, ["read", "extension_deferred", "mcp__indirect__search"]);
	});
});
