import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { discoverAgents } from "../src/agents.ts";

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

describe("discoverAgents", () => {
	it("loads builtin agents and skips malformed files", () => {
		writeAgent(builtinDir, "explore", "---\nname: explore\ndescription: recon\ntools: read, grep\nmodel: fast\n---\nbody");
		writeAgent(builtinDir, "broken", "---\nname: broken\n---\nno description so skipped");
		writeAgent(builtinDir, "notfrontmatter", "just prose, no frontmatter");

		const { agents } = discoverAgents(cwd, { scope: "user", builtinDir });
		expect(agents.map((a) => a.name)).toEqual(["explore"]);
		expect(agents[0].tools).toEqual(["read", "grep"]);
		expect(agents[0].model).toBe("fast");
		expect(agents[0].systemPrompt.trim()).toBe("body");
	});

	it("filters by enabledNames", () => {
		writeAgent(builtinDir, "explore", "---\nname: explore\ndescription: d\n---\nb");
		writeAgent(builtinDir, "worker", "---\nname: worker\ndescription: d\n---\nb");
		const { agents } = discoverAgents(cwd, { scope: "user", builtinDir, enabledNames: ["worker"] });
		expect(agents.map((a) => a.name)).toEqual(["worker"]);
	});

	it("applies model overrides", () => {
		writeAgent(builtinDir, "explore", "---\nname: explore\ndescription: d\nmodel: original\n---\nb");
		const { agents } = discoverAgents(cwd, {
			scope: "user",
			builtinDir,
			modelOverrides: { explore: "anthropic/override" },
		});
		expect(agents[0].model).toBe("anthropic/override");
	});

	it("user agents override builtin agents of the same name", () => {
		writeAgent(builtinDir, "explore", "---\nname: explore\ndescription: builtin version\n---\nb");
		writeAgent(join(agentDir, "agents"), "explore", "---\nname: explore\ndescription: user version\n---\nb");
		const { agents } = discoverAgents(cwd, { scope: "user", builtinDir });
		expect(agents).toHaveLength(1);
		expect(agents[0].description).toBe("user version");
		expect(agents[0].source).toBe("user");
	});
});
