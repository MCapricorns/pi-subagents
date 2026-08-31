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
	it("ships executor as the full-capability generalist", () => {
		const executor = loadBuiltinAgents().find((agent) => agent.name === "executor");
		expect(executor).toMatchObject({
			thinking: "high",
			source: "builtin",
		});
		// No `tools` field => the child inherits the parent's complete active set.
		expect(executor?.tools).toBeUndefined();
		expect(executor?.description).toContain("implement, fix, refactor, test, clean up, sync docs, or merge fan-out results");
		// Absorbed cleaner discipline: prove a cut before applying it.
		expect(executor?.systemPrompt).toContain("a candidate is not a deletion");
		expect(executor?.systemPrompt).toContain("repeat the decisive searches yourself");
		expect(executor?.systemPrompt).toContain("Finding no safe cut and making zero edits is valid");
		expect(executor?.systemPrompt).toContain("keep a candidate when a real consumer exists");
		// Absorbed documenter boundary: docs follow behavior, never the reverse.
		expect(executor?.systemPrompt).toContain("Never change runtime behavior to make documentation true");
		// Absorbed synthesizer workflow: attributed, deduplicated merging of named inputs.
		expect(executor?.systemPrompt).toContain("read every input fully before writing");
		expect(executor?.systemPrompt).toContain("report surviving conflicts side by side");
	});

	it("gives executor a scope contract keyed to the brief", () => {
		const executor = loadBuiltinAgents().find((agent) => agent.name === "executor");
		expect(executor?.systemPrompt).toContain("the task brief is your source of truth");
		expect(executor?.systemPrompt).toContain("limit edits to the request plus required validation");
		expect(executor?.systemPrompt).toContain("smallest coherent root-cause change");
	});

	it("keeps release ownership out of implementation children", () => {
		const executor = loadBuiltinAgents().find((agent) => agent.name === "executor");
		expect(executor?.systemPrompt).toContain("Never commit, push, publish, tag, release, or bump");
		expect(executor?.systemPrompt).toContain("the caller owns every release action");
		expect(executor?.systemPrompt).toContain("directly affects");
		expect(executor?.systemPrompt).toContain("deletes complexity");
	});

	it("requires result-only handoffs without recovered tool noise", () => {
		for (const agent of loadBuiltinAgents()) {
			expect(agent.systemPrompt).toContain("Do not repeat the task brief");
			expect(agent.systemPrompt).not.toContain("transient tool failures");
			expect(agent.systemPrompt).toContain("40-line delivery cap");
		}
		const explorer = loadBuiltinAgents().find((agent) => agent.name === "explorer");
		expect(explorer?.systemPrompt).toContain("one bare bullet per finding");
		expect(explorer?.systemPrompt).not.toContain("## Findings");
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
		expect(explorer?.systemPrompt).toContain("re-read the cited line ranges");
		expect(explorer?.systemPrompt).toContain("plausible guess is more expensive");
		expect(explorer?.systemPrompt).not.toMatch(/\bBash\b/u);
	});

	it("keeps shell guidance portable, since a child's terminal follows the host", () => {
		// A child's shell slot follows the parent, so on Windows it is PowerShell,
		// where these either do not exist or take different flags. Naming one
		// teaches the child to burn turns on a command its terminal cannot run.
		// `grep`/`find`/`ls` are exempt: those are Pi's own portable tools.
		const posixOnly = /`(?:cat|sed|awk|which|touch|rm|cp|mv)\b/u;
		for (const agent of loadBuiltinAgents()) {
			expect(agent.systemPrompt, `${agent.name} names a POSIX-only command`).not.toMatch(posixOnly);
			const constrainsShell = /\bshell\b/iu.test(agent.systemPrompt);
			if (!constrainsShell) continue;
			// A role that budgets shell use has to say the shell is not always Bash.
			expect(agent.systemPrompt, `${agent.name} assumes one shell flavor`).toContain("PowerShell");
		}
	});
});

describe("parent tool inheritance", () => {
	it.each([
		["powershell only", ["read", "powershell", "edit", "write", "web_search", "query_docs"], ["powershell"]],
		["bash only", ["read", "bash", "edit", "write", "web_search", "query_docs"], ["bash"]],
		// One declared shell slot stays one shell: a parent running both leaves the
		// choice to the host, so a Windows child gets pwsh and everyone else bash.
		[
			"both",
			["read", "bash", "powershell", "edit", "write", "web_search", "query_docs"],
			[process.platform === "win32" ? "powershell" : "bash"],
		],
		["neither", ["read", "edit", "write", "web_search", "query_docs"], []],
	] as const)("keeps restricted built-ins while inheriting the parent %s shell and plugins", (_label, activeTools, expectedShells) => {
		const builtins = loadBuiltinAgents().filter((agent) => agent.name === "explorer");
		expect(builtins).toHaveLength(1);
		for (const agent of builtins) {
			const resolved = resolveAgentTools(agent, [...activeTools, "subagent", "subagent_control"]);
			expect(resolved.tools?.filter((tool) => tool === "bash" || tool === "powershell")).toEqual(expectedShells);
			expect(resolved.tools).toEqual(expect.arrayContaining(["web_search", "query_docs"]));
			expect(resolved.tools).not.toContain("subagent");
			expect(resolved.tools).not.toContain("subagent_control");
			expect(resolved.tools).not.toContain("edit");
			expect(resolved.tools).not.toContain("write");
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
		const agent = builtins.find((candidate) => candidate.name === "executor")!;
		expect(agent.tools).toBeUndefined();
		expect(resolveAgentTools(agent, ["read", "powershell", "edit", "write", "web_search", "subagent_stop"]).tools)
			.toEqual(["read", "powershell", "edit", "write", "web_search"]);
		expect(agent.tools).toBeUndefined();
	});
});

describe("agent write capability", () => {
	it("classifies custom writers while preserving built-in read-only roles", () => {
		expect(isWriteCapableAgent({ name: "custom", tools: ["read", "write"] })).toBe(true);
		expect(isWriteCapableAgent({ name: "custom" })).toBe(true);
		expect(isWriteCapableAgent({ name: "custom", tools: ["read", "grep"] })).toBe(false);
		// Built-in classifications survive user overrides of the same name.
		expect(isWriteCapableAgent({ name: "executor" })).toBe(true);
		expect(isWriteCapableAgent({ name: "executor", tools: ["read", "grep"] })).toBe(true);
		expect(isWriteCapableAgent({ name: "explorer", tools: ["write"] })).toBe(false);
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
		// The built-in writer role defaults to a detached worktree in parallel mode.
		expect(defaultIsolationMode("parallel", "executor")).toBe("worktree");
		// Read-only roles and single dispatches stay on the caller's checkout.
		expect(defaultIsolationMode("parallel", "explorer")).toBe("shared");
		expect(defaultIsolationMode("single", "executor")).toBe("shared");
		// A custom write-capable agent joins the worktree default when the
		// execute path passes the catalog verdict; explicit requests win.
		expect(defaultIsolationMode("parallel", "custom-writer", undefined, true)).toBe("worktree");
		expect(defaultIsolationMode("parallel", "custom-reader", undefined, false)).toBe("shared");
		expect(defaultIsolationMode("parallel", "executor", "shared")).toBe("shared");
		expect(defaultIsolationMode("single", "explorer", "worktree")).toBe("worktree");
	});

	it("honors role-declared isolation between explicit requests and mode defaults", () => {
		// A write-capable role that declares worktree self-isolates in every mode.
		expect(defaultIsolationMode("single", "migrator", undefined, true, "worktree")).toBe("worktree");
		expect(defaultIsolationMode("parallel", "migrator", undefined, true, "worktree")).toBe("worktree");
		// A declared shared opts a writer out of the parallel worktree default.
		expect(defaultIsolationMode("parallel", "worker", undefined, true, "shared")).toBe("shared");
		// A worktree declaration on a read-only role is inert, not an error.
		expect(defaultIsolationMode("parallel", "reader", undefined, false, "worktree")).toBe("shared");
		// An explicit per-call request still beats the declaration.
		expect(defaultIsolationMode("single", "migrator", "shared", true, "worktree")).toBe("shared");
	});

	it("parses a valid isolation declaration and ignores invalid ones", () => {
		writeAgent(builtinDir, "explorer", "---\nname: explorer\ndescription: d\nisolation: worktree\n---\nb");
		writeAgent(builtinDir, "worker", "---\nname: worker\ndescription: d\nisolation: shared\n---\nb");
		writeAgent(builtinDir, "cleaner", "---\nname: cleaner\ndescription: d\nisolation: chroot\n---\nb");
		writeAgent(builtinDir, "reviewer", "---\nname: reviewer\ndescription: d\n---\nb");

		const { agents } = discoverAgents(cwd, { scope: "user", builtinDir });
		const byName = new Map(agents.map((a) => [a.name, a]));
		expect(byName.get("explorer")?.isolation).toBe("worktree");
		expect(byName.get("worker")?.isolation).toBe("shared");
		expect(byName.get("cleaner")?.isolation).toBeUndefined();
		expect(byName.get("reviewer")?.isolation).toBeUndefined();
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
