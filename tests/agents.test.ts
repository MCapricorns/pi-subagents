import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { discoverAgents, loadBuiltinAgents } from "../src/agents.ts";

let builtinDir: string;
let agentDir: string;
let cwd: string;
let savedEnv: string | undefined;

function writeAgent(dir: string, name: string, body: string): void {
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, `${name}.md`), body, "utf8");
}

beforeEach(() => {
	savedEnv = process.env.PI_CODING_AGENT_DIR;
	builtinDir = mkdtempSync(join(tmpdir(), "pi-subagents-builtin-"));
	agentDir = mkdtempSync(join(tmpdir(), "pi-subagents-agentdir-"));
	cwd = mkdtempSync(join(tmpdir(), "pi-subagents-cwd-"));
	// Point getAgentDir() at an empty dir so the user's real agents never leak into tests.
	process.env.PI_CODING_AGENT_DIR = agentDir;
});

afterEach(() => {
	if (savedEnv === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = savedEnv;
});

describe("shipped specialist agents", () => {
	it("makes cleaner apply proven cuts while leaving audits and the gate to reviewer", () => {
		const cleaner = loadBuiltinAgents().find((agent) => agent.name === "cleaner");
		expect(cleaner).toBeDefined();
		expect(cleaner).toMatchObject({
			model: "claude-sonnet-4-5",
			thinking: "high",
			source: "builtin",
		});
		expect(cleaner?.tools).toBeUndefined();
		expect(cleaner?.description).toContain("edit-authorizing cleanup");
		expect(cleaner?.description).toContain("Read-only audits/reviews go to reviewer");
		expect(cleaner?.systemPrompt).toContain("apply every safe, proven, in-scope cleanup end to end");
		expect(cleaner?.systemPrompt).toContain("Finding no safe cut and making zero edits is valid");
		expect(cleaner?.systemPrompt).toContain("Never inherit deletion proof from an `explorer` report");
		expect(cleaner?.systemPrompt).not.toContain("Audit mode");
		expect(cleaner?.systemPrompt).not.toContain("Apply mode");
	});

	it("keeps reviewer advisory reports separate from auto-fix gate verdicts", () => {
		const reviewer = loadBuiltinAgents().find((agent) => agent.name === "reviewer");
		expect(reviewer?.description).toContain("generic audits");
		expect(reviewer?.systemPrompt).toContain("Advisory review");
		expect(reviewer?.systemPrompt).toContain("do **not** emit `VERDICT: REVIEW_*`");
		expect(reviewer?.systemPrompt).toContain("Gate review");
		expect(reviewer?.systemPrompt).toContain("In a gate review, use `VERDICT: REVIEW_FAIL`");
		expect(reviewer?.systemPrompt).toContain("A `REQUEST_CHANGES` gate verdict starts");
	});

	it("keeps runtime model defaults while excluding frontmatter comments from child prompts", () => {
		const agents = loadBuiltinAgents();
		expect(agents.map((agent) => agent.name)).not.toContain("explore");
		expect(Object.fromEntries(agents.map((agent) => [agent.name, agent.model]))).toEqual({
			cleaner: "claude-sonnet-4-5",
			explorer: "claude-haiku-4-5",
			reviewer: "claude-sonnet-4-5",
			worker: "claude-sonnet-4-5",
		});
		for (const agent of agents) {
			expect(agent.systemPrompt).not.toContain("# Model selection:");
		}
	});

	it("keeps explorer retrieval-only and requires critical re-reading", () => {
		const explorer = loadBuiltinAgents().find((agent) => agent.name === "explorer");
		expect(explorer?.tools).toEqual(["read", "grep", "find", "ls", "bash"]);
		expect(explorer?.systemPrompt).toContain("retrieval lead");
		expect(explorer?.systemPrompt).toContain("re-read load-bearing files");
		expect(explorer?.systemPrompt).toContain("plausible guess is more expensive");
	});
});

describe("discoverAgents", () => {
	it("loads builtin agents and skips malformed files", () => {
		writeAgent(builtinDir, "explorer", "---\nname: explorer\ndescription: recon\ntools: read, grep\nmodel: fast\n---\nbody");
		writeAgent(builtinDir, "broken", "---\nname: broken\n---\nno description so skipped");
		writeAgent(builtinDir, "notfrontmatter", "just prose, no frontmatter");

		const { agents } = discoverAgents(cwd, { scope: "user", builtinDir });
		expect(agents.map((a) => a.name)).toEqual(["explorer"]);
		expect(agents[0].tools).toEqual(["read", "grep"]);
		expect(agents[0].model).toBe("fast");
		expect(agents[0].systemPrompt.trim()).toBe("body");
	});

	it("filters by enabledNames", () => {
		writeAgent(builtinDir, "explorer", "---\nname: explorer\ndescription: d\n---\nb");
		writeAgent(builtinDir, "worker", "---\nname: worker\ndescription: d\n---\nb");
		const { agents } = discoverAgents(cwd, { scope: "user", builtinDir, enabledNames: ["worker"] });
		expect(agents.map((a) => a.name)).toEqual(["worker"]);
	});

	it("treats an explicit empty enabledNames list as disabling every agent", () => {
		writeAgent(builtinDir, "explorer", "---\nname: explorer\ndescription: d\n---\nb");
		writeAgent(builtinDir, "worker", "---\nname: worker\ndescription: d\n---\nb");
		const { agents } = discoverAgents(cwd, { scope: "user", builtinDir, enabledNames: [] });
		expect(agents).toEqual([]);
	});

	it("loads project agent prompts only when Pi has trusted the project", () => {
		writeAgent(builtinDir, "worker", "---\nname: worker\ndescription: builtin\n---\nbuiltin prompt");
		writeAgent(
			join(cwd, ".pi", "agents"),
			"worker",
			"---\nname: worker\ndescription: project\n---\nproject-controlled prompt",
		);

		const untrusted = discoverAgents(cwd, {
			scope: "both",
			builtinDir,
			projectTrusted: false,
		}).agents;
		expect(untrusted).toHaveLength(1);
		expect(untrusted[0]).toMatchObject({ name: "worker", source: "builtin" });
		expect(untrusted[0].systemPrompt).not.toContain("project-controlled");

		const trusted = discoverAgents(cwd, {
			scope: "both",
			builtinDir,
			projectTrusted: true,
		}).agents;
		expect(trusted).toHaveLength(1);
		expect(trusted[0]).toMatchObject({ name: "worker", source: "project" });
		expect(trusted[0].systemPrompt).toContain("project-controlled");
	});

	it("parses a valid thinking level and ignores invalid ones", () => {
		writeAgent(builtinDir, "explorer", "---\nname: explorer\ndescription: d\nthinking: low\n---\nb");
		writeAgent(builtinDir, "worker", "---\nname: worker\ndescription: d\nthinking: ultra\n---\nb");
		writeAgent(builtinDir, "reviewer", "---\nname: reviewer\ndescription: d\n---\nb");

		const { agents } = discoverAgents(cwd, { scope: "user", builtinDir });
		const byName = new Map(agents.map((a) => [a.name, a]));
		expect(byName.get("explorer")?.thinking).toBe("low");
		expect(byName.get("worker")?.thinking).toBeUndefined();
		expect(byName.get("reviewer")?.thinking).toBeUndefined();
	});

	it("ignores non-string frontmatter values instead of throwing", () => {
		writeAgent(builtinDir, "explorer", "---\nname: explorer\ndescription: d\nthinking: 5\n---\nb");
		writeAgent(builtinDir, "worker", "---\nname: worker\ndescription: d\ntools: false\n---\nb");
		writeAgent(builtinDir, "broken", "---\nname: 123\ndescription: d\n---\nb");

		const { agents } = discoverAgents(cwd, { scope: "user", builtinDir });
		const byName = new Map(agents.map((a) => [a.name, a]));
		expect(byName.get("explorer")?.thinking).toBeUndefined();
		expect(byName.get("worker")?.tools).toBeUndefined();
		expect(byName.has("broken")).toBe(false);
	});

	it("user agents override builtin agents of the same name", () => {
		writeAgent(builtinDir, "explorer", "---\nname: explorer\ndescription: builtin version\n---\nb");
		writeAgent(join(agentDir, "agents"), "explorer", "---\nname: explorer\ndescription: user version\n---\nb");
		const { agents } = discoverAgents(cwd, { scope: "user", builtinDir });
		expect(agents).toHaveLength(1);
		expect(agents[0].description).toBe("user version");
		expect(agents[0].source).toBe("user");
	});
});
