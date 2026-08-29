import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	discoverAgents,
	isWriteCapableAgent,
	loadBuiltinAgents,
	resolveAgentTools,
} from "../src/agents.ts";
import { defaultIsolationMode } from "../src/dispatch.ts";

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
			thinking: "high",
			source: "builtin",
		});
		expect(cleaner?.tools).toBeUndefined();
		expect(cleaner?.description).toContain("edit-authorizing cleanup");
		expect(cleaner?.systemPrompt).toContain("apply every safe, proven, in-scope cleanup end to end");
		expect(cleaner?.systemPrompt).toContain("Finding no safe cut and making zero edits is valid");
		expect(cleaner?.systemPrompt).toContain("without asking for approval item by item");
		expect(cleaner?.systemPrompt).toContain("proactively extract the smallest stable shared");
		expect(cleaner?.systemPrompt).toContain("Do not merely report a safe consolidation");
		expect(cleaner?.systemPrompt).toContain("different domain boundaries");
		expect(cleaner?.systemPrompt).toContain("Never inherit deletion proof from an `explorer` report");
		expect(cleaner?.systemPrompt).not.toContain("Audit mode");
		expect(cleaner?.systemPrompt).not.toContain("Apply mode");
		expect(cleaner?.systemPrompt).toContain("directly affected by the cleanup");
		expect(cleaner?.systemPrompt).toContain("Never commit, push, publish, tag, release, or bump");
		expect(cleaner?.systemPrompt).toContain("deleting whole categories of complexity");
	});

	it("keeps release ownership out of implementation children", () => {
		const worker = loadBuiltinAgents().find((agent) => agent.name === "worker");
		expect(worker?.systemPrompt).toContain("Never commit, push, publish, tag, release, or bump");
		expect(worker?.systemPrompt).toContain("parent workflow owns the independent review gate");
		expect(worker?.systemPrompt).toContain("directly affected by your change");
		expect(worker?.systemPrompt).toContain("deletes complexity rather than rearranges it");
	});

	it("ships documenter as a low-cost write-capable drift-sync specialist", () => {
		const documenter = loadBuiltinAgents().find((agent) => agent.name === "documenter");
		expect(documenter).toMatchObject({
			thinking: "low",
			source: "builtin",
		});
		expect(documenter?.tools).toEqual(["read", "grep", "find", "ls", "bash", "edit", "write"]);
		expect(documenter?.description).toContain("explicitly requested or drift-driven");
		expect(documenter?.systemPrompt).toContain("Post-change diff sync");
		expect(documenter?.systemPrompt).toContain("Standalone documentation maintenance");
		expect(documenter?.systemPrompt).toContain("never change runtime behavior");
		expect(documenter?.systemPrompt).toContain("Never commit, push, publish, tag, or release");
		expect(documenter?.systemPrompt).toContain("zero edits is valid");
		expect(documenter?.systemPrompt).toContain("delivers directly after you");
		expect(documenter?.systemPrompt).toContain("no fresh reviewer runs");
	});

	it("requires gate fix instructions and hands direct-gate findings back to the caller", () => {
		const reviewer = loadBuiltinAgents().find((agent) => agent.name === "reviewer");
		expect(reviewer?.systemPrompt).toContain("concrete fix instruction");
		expect(reviewer?.systemPrompt).toContain("how to verify the fix");
		expect(reviewer?.systemPrompt).toContain("Scale scrutiny to the change");
		expect(reviewer?.systemPrompt).toContain("Complete finding set in ONE pass");
		expect(reviewer?.systemPrompt).toContain("never ration findings across rounds");
		expect(reviewer?.systemPrompt).toContain("Fix stage (runtime-granted)");
		expect(reviewer?.systemPrompt).toContain("a fix stage never emits a verdict");
		const worker = loadBuiltinAgents().find((agent) => agent.name === "worker");
		expect(worker?.systemPrompt).toContain("reviewer findings");
		expect(worker?.systemPrompt).toContain("push back in your report");
		expect(worker?.systemPrompt).toContain("A deviation without reasoning will be re-opened");
	});

	it("keeps reviewer advisory reports separate from gate verdicts", () => {
		const reviewer = loadBuiltinAgents().find((agent) => agent.name === "reviewer");
		expect(reviewer?.description).toContain("generic audits");
		expect(reviewer?.systemPrompt).toContain("Advisory review");
		expect(reviewer?.systemPrompt).toContain("do **not** emit `VERDICT: REVIEW_*`");
		expect(reviewer?.systemPrompt).toContain("Gate review");
		expect(reviewer?.systemPrompt).toContain("Use `VERDICT: REVIEW_FAIL` when any gate finding remains");
		expect(reviewer?.systemPrompt).toContain("continues into your write-enabled fix stage");
		expect(reviewer?.systemPrompt).toContain("Documentation drift is an ordinary finding");
		expect(reviewer?.systemPrompt).not.toContain("DOCUMENTATION:");
		expect(reviewer?.systemPrompt).toContain("code judo");
		expect(reviewer?.systemPrompt).toContain("Do not approve merely because behavior seems correct");
		expect(reviewer?.systemPrompt).not.toMatch(/\bBash\b/u);
	});

	it("requires result-only handoffs without recovered tool noise", () => {
		for (const agent of loadBuiltinAgents()) {
			expect(agent.systemPrompt).toContain("Do not repeat the task brief");
			expect(agent.systemPrompt).not.toContain("transient tool failures");
			expect(agent.systemPrompt).toContain("40-line delivery cap");
		}
		const explorer = loadBuiltinAgents().find((agent) => agent.name === "explorer");
		expect(explorer?.systemPrompt).toContain("## Findings");
		expect(explorer?.systemPrompt).not.toContain("## Files Retrieved");
		expect(explorer?.systemPrompt).not.toContain("## Architecture");
	});

	it("leaves the model to dispatch routing and keeps frontmatter comments out of child prompts", () => {
		const agents = loadBuiltinAgents();
		expect(agents.map((agent) => agent.name)).not.toContain("explore");
		// Models come only from /subagents-setup; no agent file pins one.
		for (const agent of agents) {
			expect(agent.model).toBeUndefined();
			expect(agent.systemPrompt).not.toContain("permission boundary");
		}
	});

	it("keeps explorer retrieval-only and requires critical re-reading", () => {
		const explorer = loadBuiltinAgents().find((agent) => agent.name === "explorer");
		expect(explorer?.tools).toEqual(["read", "grep", "find", "ls", "bash"]);
		expect(explorer?.systemPrompt).toContain("retrieval lead");
		expect(explorer?.systemPrompt).toContain("re-read load-bearing files");
		expect(explorer?.systemPrompt).toContain("plausible guess is more expensive");
		expect(explorer?.systemPrompt).not.toMatch(/\bBash\b/u);
	});
});

describe("parent tool inheritance", () => {
	it.each([
		["powershell only", ["read", "powershell", "edit", "write", "web_search", "query_docs"], ["powershell"]],
		["bash only", ["read", "bash", "edit", "write", "web_search", "query_docs"], ["bash"]],
		["both", ["read", "bash", "powershell", "edit", "write", "web_search", "query_docs"], ["bash", "powershell"]],
		["neither", ["read", "edit", "write", "web_search", "query_docs"], []],
	] as const)("keeps restricted built-ins while inheriting the parent %s shell and plugins", (_label, activeTools, expectedShells) => {
		const builtins = loadBuiltinAgents().filter((agent) =>
			["explorer", "documenter", "reviewer"].includes(agent.name)
		);
		expect(builtins).toHaveLength(3);
		for (const agent of builtins) {
			const resolved = resolveAgentTools(agent, [...activeTools, "subagent", "subagent_status"]);
			expect(resolved.tools?.filter((tool) => tool === "bash" || tool === "powershell")).toEqual(expectedShells);
			expect(resolved.tools).toEqual(expect.arrayContaining(["web_search", "query_docs"]));
			expect(resolved.tools).not.toContain("subagent");
			expect(resolved.tools).not.toContain("subagent_status");
			if (agent.name !== "documenter") {
				expect(resolved.tools).not.toContain("edit");
				expect(resolved.tools).not.toContain("write");
			}
		}
	});

	it("preserves a custom agent's built-in boundary while adapting its shell and adding only active plugins", () => {
		const builtin = loadBuiltinAgents().find((agent) => agent.name === "explorer")!;
		const custom = {
			...builtin,
			source: "project" as const,
			tools: ["read", "inactive_plugin", "bash"],
		};
		const resolved = resolveAgentTools(custom, ["read", "powershell", "write", "web_search", "subagent_control"]);
		expect(resolved.tools).toEqual(["read", "powershell", "web_search"]);
		expect(custom.tools).toEqual(["read", "inactive_plugin", "bash"]);
	});

	it("gives roles without an allowlist the complete active set except recursive controls", () => {
		const builtins = loadBuiltinAgents();
		for (const name of ["worker", "cleaner"]) {
			const agent = builtins.find((candidate) => candidate.name === name)!;
			expect(agent.tools).toBeUndefined();
			expect(resolveAgentTools(agent, ["read", "powershell", "edit", "write", "web_search", "subagent_stop"]).tools)
				.toEqual(["read", "powershell", "edit", "write", "web_search"]);
			expect(agent.tools).toBeUndefined();
		}
	});

	it("represents an empty inherited active set explicitly", () => {
		const worker = loadBuiltinAgents().find((agent) => agent.name === "worker")!;
		expect(resolveAgentTools(worker, ["subagent", "subagent_status"]).tools).toEqual([]);
	});
});

describe("agent write capability", () => {
	it("classifies custom writers while preserving built-in read-only roles", () => {
		expect(isWriteCapableAgent({ name: "custom", tools: ["read", "write"] })).toBe(true);
		expect(isWriteCapableAgent({ name: "custom" })).toBe(true);
		expect(isWriteCapableAgent({ name: "custom", tools: ["read", "grep"] })).toBe(false);
		expect(isWriteCapableAgent({ name: "reviewer", tools: ["write"] })).toBe(false);
		expect(isWriteCapableAgent({ name: "explorer" })).toBe(false);
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
		// A frontmatter model declaration is ignored: dispatch routing owns the model.
		expect(agents[0].model).toBeUndefined();
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

	it("defaults parallel write-capable dispatches to worktree isolation", () => {
		// Built-in writer roles default to a detached worktree in parallel mode.
		for (const writer of ["worker", "cleaner", "documenter"]) {
			expect(defaultIsolationMode("parallel", writer)).toBe("worktree");
		}
		// Read-only roles and single dispatches stay on the caller's checkout.
		expect(defaultIsolationMode("parallel", "explorer")).toBe("shared");
		expect(defaultIsolationMode("parallel", "reviewer")).toBe("shared");
		expect(defaultIsolationMode("single", "worker")).toBe("shared");
		// A custom write-capable agent joins the worktree default when the
		// execute path passes the catalog verdict; explicit requests win.
		expect(defaultIsolationMode("parallel", "custom-writer", undefined, true)).toBe("worktree");
		expect(defaultIsolationMode("parallel", "custom-reader", undefined, false)).toBe("shared");
		expect(defaultIsolationMode("parallel", "worker", "shared")).toBe("shared");
		expect(defaultIsolationMode("single", "explorer", "worktree")).toBe("worktree");
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
