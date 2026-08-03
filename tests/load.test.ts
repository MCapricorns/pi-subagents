import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import register from "../src/index.ts";

interface StubPi {
	tools: any[];
	commands: string[];
	hooks: Record<string, (event: any, ctx: any) => Promise<any>>;
	api: any;
}

function makeStub(): StubPi {
	const stub: StubPi = { tools: [], commands: [], hooks: {} , api: null};
	stub.api = {
		registerTool: (tool: any) => stub.tools.push(tool),
		registerCommand: (name: string) => stub.commands.push(name),
		registerShortcut: (_key: string, _opts: any) => {},
		on: (event: string, handler: any) => {
			stub.hooks[event] = handler;
		},
	};
	return stub;
}

let savedDepth: string | undefined;
let savedAgentDir: string | undefined;

beforeEach(() => {
	savedDepth = process.env.PI_SUBAGENT_DEPTH;
	savedAgentDir = process.env.PI_CODING_AGENT_DIR;
	// Isolate config + user agents from the real home directory.
	process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "pi-subagents-load-"));
});

afterEach(() => {
	if (savedDepth === undefined) delete process.env.PI_SUBAGENT_DEPTH;
	else process.env.PI_SUBAGENT_DEPTH = savedDepth;
	if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
});

describe("extension registration", () => {
	it("registers the subagent tool, setup command, and injection hook", () => {
		const stub = makeStub();
		register(stub.api);
		expect(stub.tools.map((t) => t.name)).toContain("subagent");
		expect(stub.commands).toContain("subagents-setup");
		expect(typeof stub.hooks["before_agent_start"]).toBe("function");

		const tool = stub.tools.find((t) => t.name === "subagent");
		expect(tool.promptGuidelines.length).toBeGreaterThan(0);
		expect(tool.description).toContain("explore");
	});

	it("does not register the tool inside any child sub-agent process", () => {
		process.env.PI_SUBAGENT_DEPTH = "1";
		const stub = makeStub();
		register(stub.api);
		expect(stub.tools.map((t) => t.name)).not.toContain("subagent");
		expect(stub.commands).toContain("subagents-setup");
	});

	it("also blocks a deeper inherited depth", () => {
		process.env.PI_SUBAGENT_DEPTH = "2";
		const stub = makeStub();
		register(stub.api);
		expect(stub.tools.map((t) => t.name)).not.toContain("subagent");
	});
});

describe("before_agent_start injection", () => {
	it("appends a delegation directive built from the shipped agents", async () => {
		const stub = makeStub();
		register(stub.api);
		const hook = stub.hooks["before_agent_start"];
		const result = await hook({ systemPrompt: "BASE PROMPT" }, { cwd: process.cwd() });
		expect(result).toBeDefined();
		expect(result.systemPrompt.startsWith("BASE PROMPT")).toBe(true);
		expect(result.systemPrompt).toContain("Sub-agent delegation");
		// Default enabled set: explore, worker, reviewer (plan is opt-in).
		expect(result.systemPrompt).toContain("- explore:");
		expect(result.systemPrompt).toContain("- worker:");
		expect(result.systemPrompt).toContain("- reviewer:");
		expect(result.systemPrompt).not.toContain("- plan:");
	});
});
