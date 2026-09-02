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
			assert.ok(agent.systemPrompt.includes("Do not repeat the task brief"));
			assert.ok(agent.systemPrompt.includes("40-line delivery cap"));
			assert.ok(!agent.systemPrompt.includes("permission boundary"));
		}
	});

	it("keeps scout read-only and retrieval-only", () => {
		const scout = loadBuiltinAgents().find((agent) => agent.name === "scout");
		assert.ok(scout);
		assert.deepEqual(scout.tools, ["read", "grep", "find", "ls", "bash"]);
		assert.ok(scout.systemPrompt.includes("retrieval lead"));
		assert.ok(scout.systemPrompt.includes("READ-ONLY"));
		assert.ok(!isWriteCapableAgent(scout));
	});

	it("keeps artisan on implementation and out of tidy work", () => {
		const artisan = loadBuiltinAgents().find((agent) => agent.name === "artisan");
		assert.ok(artisan);
		assert.equal(artisan.tools, undefined);
		assert.ok(isWriteCapableAgent(artisan));
		assert.ok(artisan.systemPrompt.includes("A finding is not a change"));
		assert.ok(artisan.systemPrompt.includes("belong to `steward`"));
		assert.ok(artisan.systemPrompt.includes("Never commit, push, publish, tag, release, or bump"));
		assert.ok(!artisan.systemPrompt.includes("**Cleanup**"));
		assert.ok(!artisan.systemPrompt.includes("**Merging inputs**"));
	});

	it("gives steward cleanup, docs, and merge playbooks", () => {
		const steward = loadBuiltinAgents().find((agent) => agent.name === "steward");
		assert.ok(steward);
		assert.ok(isWriteCapableAgent(steward));
		assert.ok(steward.systemPrompt.includes("## Cleanup"));
		assert.ok(steward.systemPrompt.includes("## Docs sync"));
		assert.ok(steward.systemPrompt.includes("## Merging inputs"));
		assert.ok(steward.systemPrompt.includes("belong to `artisan`"));
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
	it("strips subagent controls and adapts the scout shell to the parent", () => {
		const scout = loadBuiltinAgents().find((agent) => agent.name === "scout");
		assert.ok(scout);
		const resolved = resolveAgentTools(scout, ["read", "bash", "edit", "write", "web_search", "subagent"]);
		assert.ok(resolved.tools?.includes("bash"));
		assert.ok(resolved.tools?.includes("web_search"));
		assert.ok(!resolved.tools?.includes("subagent"));
		assert.ok(!resolved.tools?.includes("edit"));
		assert.ok(!resolved.tools?.includes("write"));
	});
});
