import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, type TestContext } from "node:test";
import {
	discoverAgents,
	isWriteCapableAgent,
	loadBuiltinAgents,
	resolveAgentTools,
	type ToolMetadata,
} from "../src/delegation/agents.ts";

function tool(
	name: string,
	annotations?: ToolMetadata["annotations"],
	reachesTools?: ToolMetadata["reachesTools"],
): ToolMetadata {
	return { name, ...(annotations ? { annotations } : {}), ...(reachesTools ? { reachesTools } : {}) };
}

const READ_ONLY = tool("docs_search", { readOnlyHint: true });

describe("loadBuiltinAgents", () => {
	it("ships scout and artisan without frontmatter thinking", () => {
		const agents = loadBuiltinAgents();
		assert.deepEqual(agents.map((agent) => agent.name).sort(), ["artisan", "scout"]);
		for (const agent of agents) {
			assert.equal(agent.model, undefined);
			assert.ok(!("thinking" in agent));
			assert.match(agent.systemPrompt, /loaded project instructions/u);
			assert.match(agent.systemPrompt, /no interactive clarification/u);
			assert.match(agent.systemPrompt, /Priority is the brief/u);
			if (agent.name !== "scout") {
				assert.match(agent.systemPrompt, /do not dispatch agents, bump versions, commit, push, publish, tag, or release/u);
			}
		}
	});

	it("keeps scout read-only and retrieval-only", () => {
		const scout = loadBuiltinAgents().find((agent) => agent.name === "scout");
		assert.ok(scout);
		// The surface is derived from live tool metadata, so no role file carries
		// a list of extension, MCP, or vendor tool names.
		assert.equal(scout.tools, undefined);
		assert.equal(scout.filePath, "builtin:scout");
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

describe("discoverAgents", () => {
	it("orders builtins canonically ahead of customs regardless of file order", (t: TestContext) => {
		const dir = mkdtempSync(join(tmpdir(), "pi-subagents-agents-"));
		t.after(() => rmSync(dir, { recursive: true, force: true }));
		const agentsDir = join(dir, ".pi", "agents");
		mkdirSync(agentsDir, { recursive: true });
		// A project file may override a built-in name; it is still ranked as that
		// built-in, and readdir order must not leak into the catalog.
		const write = (name: string) =>
			writeFileSync(join(agentsDir, `${name}.md`), `---\nname: ${name}\ndescription: test\n---\nbody\n`, "utf8");
		for (const name of ["zeta", "artisan", "scout", "alpha"]) write(name);

		const scope = { scope: "project" as const, projectTrusted: true };
		const discovered = discoverAgents(dir, scope);
		assert.deepEqual(discovered.agents.map((agent) => agent.name), ["scout", "artisan", "alpha", "zeta"]);
		assert.ok(discovered.agents.some((agent) => agent.filePath.startsWith(agentsDir)), "project files override built-ins");

		const filtered = discoverAgents(dir, { ...scope, enabledNames: ["zeta", "scout"] });
		assert.deepEqual(filtered.agents.map((agent) => agent.name), ["scout", "zeta"]);
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
		const infos = [tool("codemode", undefined, () => "all"), READ_ONLY];
		const active = ["read", "edit", "codemode", "docs_search"];
		assert.deepEqual(resolveAgentTools(artisan, active, infos).tools, active);
		assert.deepEqual(resolveAgentTools(scout, active, infos).tools, ["read", "docs_search"]);
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

	it("treats tools without a read-only proof as potentially write-capable", () => {
		const infos = [READ_ONLY, tool("db_write", { readOnlyHint: false }), tool("codemode", undefined, () => "all")];
		assert.equal(isWriteCapableAgent({ name: "reviewer", tools: ["read", "grep"] }), false);
		assert.equal(isWriteCapableAgent({ name: "reviewer", tools: ["read", "docs_search"] }, infos), false);
		assert.equal(isWriteCapableAgent({ name: "reviewer", tools: ["read", "custom_repository_tool"] }), true);
		assert.equal(isWriteCapableAgent({ name: "reviewer", tools: ["read", "db_write"] }, infos), true);
		assert.equal(isWriteCapableAgent({ name: "reviewer", tools: ["read", "codemode"] }, infos), true);
	});

	it("keeps only explicitly declared active custom tools", () => {
		const resolved = resolveAgentTools({
			name: "reviewer",
			description: "review",
			tools: ["read", "review_db", "subagent_stop"],
			systemPrompt: "review",
			source: "project",
			filePath: "reviewer.md",
		}, ["read", "review_db", "repository_mutator", "subagent_stop"]);
		assert.deepEqual(resolved.tools, ["read", "review_db"]);
	});
});
