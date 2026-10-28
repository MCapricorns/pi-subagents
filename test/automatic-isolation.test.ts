import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, type TestContext } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { defaultIsolationMode, registerSubagentTool } from "../src/delegation/dispatch.ts";
import { createRuntime, type SubagentThread } from "../src/lifecycle/runtime.ts";
import { monitor } from "../src/presentation/monitor.ts";
import { getResultOutput, type SingleResult } from "../src/execution/spawn.ts";
import { compileWorkflow } from "../src/workflow/plan.ts";

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

async function harness(t: TestContext, repository: "committed" | "unborn" | "none") {
	const root = await mkdtemp(join(tmpdir(), "pi-auto-isolation-"));
	const project = join(root, "project");
	const { mkdir } = await import("node:fs/promises");
	await mkdir(project);
	if (repository !== "none") {
		git(project, "init");
		git(project, "config", "user.name", "Test");
		git(project, "config", "user.email", "test@example.invalid");
		if (repository === "committed") {
			await writeFile(join(project, "baseline.txt"), "baseline");
			git(project, "add", "baseline.txt");
			git(project, "commit", "-m", "test baseline");
		}
	}
	const script = join(root, "child.mjs");
	await writeFile(script, `
import { createInterface } from "node:readline";
import { writeFileSync } from "node:fs";
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  const command = JSON.parse(line);
  if (command.type !== "prompt") return;
  send({ type: "response", id: command.id, command: "prompt", success: true, data: { disposition: "started" } });
  send({ type: "agent_start" });
  if (command.message.includes("Write output")) writeFileSync("output.txt", "isolated result");
  send({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: process.cwd() }], stopReason: "stop" } });
  send({ type: "agent_settled" });
});`);
	const previousScript = process.argv[1];
	process.argv[1] = script;
	let tool: any;
	const pi = { on: () => undefined, getActiveTools: () => ["read", "write"], getAllTools: () => [], sendMessage: () => undefined,
		registerTool: (value: any) => { tool = value; } } as unknown as ExtensionAPI;
	const runtime = createRuntime(pi, join(root, "config.json"));
	registerSubagentTool(pi, runtime);
	const ctx = { cwd: project, modelRegistry: { getAvailable: () => [] }, ui: { notify: () => undefined } } as unknown as ExtensionContext;
	t.after(async () => {
		await runtime.shutdown();
		process.argv[1] = previousScript;
		monitor.clear();
		await rm(root, { recursive: true, force: true });
	});
	return { project, runtime, async run(params: Record<string, unknown>, onPending?: (thread: SubagentThread) => void) {
		const response = await tool.execute("call", params, new AbortController().signal, undefined, ctx);
		const pending = response.details.results[0] as SingleResult;
		const thread = runtime.threads.get(pending.runId!)!;
		onPending?.(thread);
		await thread.generationCompletion;
		return { thread, result: thread.lastResult! };
	} };
}

describe("automatic isolation and current roles", () => {
	it("selects isolation by role and explicit override", () => {
		assert.equal(defaultIsolationMode("artisan"), "worktree");
		for (const name of ["scout", "sentinel", "skeptic"]) {
			assert.equal(defaultIsolationMode(name, undefined, name !== "scout"), "shared");
		}
		assert.equal(defaultIsolationMode("artisan", "shared"), "shared");
		assert.equal(defaultIsolationMode("sentinel", "worktree", true), "worktree");
	});

	it("uses and integrates a worktree for a single implementation without an override", async (t) => {
		const h = await harness(t, "committed");
		const head = git(h.project, "rev-parse", "HEAD");
		let dispatchedIdentity: string | undefined;
		const { thread, result } = await h.run({ agent: "artisan", task: "Write output", scope: { paths: ["output.txt"] } }, (pending) => {
			assert.equal(pending.worktree, undefined, "dispatch returns before asynchronous worktree preparation finishes");
			assert.ok(pending.durableId, "workflow recovery needs the identity as soon as dispatch returns");
			dispatchedIdentity = pending.durableId;
		});
		assert.equal(thread.durableId, dispatchedIdentity, "preparation and settlement preserve the dispatched identity");
		assert.equal(result.exitCode, 0);
		assert.equal(thread.isolation, "worktree");
		assert.notEqual(thread.executionCwd.toLowerCase(), h.project.toLowerCase());
		assert.equal(result.integrationStatus, "integrated");
		assert.equal(await readFile(join(h.project, "output.txt"), "utf8"), "isolated result");
		assert.equal(git(h.project, "rev-parse", "HEAD"), head);
		assert.equal(git(h.project, "diff", "--cached", "--name-only"), "");
	});

	for (const repository of ["none", "unborn"] as const) {
		it(`reports automatic shared fallback for ${repository} repositories`, async (t) => {
			const h = await harness(t, repository);
			const { thread, result } = await h.run({ agent: "artisan", task: "Write output", scope: { paths: ["output.txt"] } });
			assert.equal(result.exitCode, 0);
			assert.equal(thread.isolation, "shared");
			assert.equal(thread.executionCwd, h.project);
			assert.match(result.isolationNote ?? "", repository === "none" ? /not a Git repository/ : /no committed HEAD/);
			assert.equal(result.integrationStatus, undefined);
		});

		it(`does not fall back when worktree isolation is explicitly required in ${repository}`, async (t) => {
			const h = await harness(t, repository);
			const { result } = await h.run({ agent: "artisan", task: "Write output", isolation: "worktree", scope: { paths: ["output.txt"] } });
			assert.equal(result.exitCode, 1);
			assert.equal(existsSync(join(h.project, "output.txt")), false);
			assert.match(result.errorMessage ?? result.stderr, /Worktree isolation/);
		});
	}

	it("rejects retired role names before dispatch and accepts only current names", async (t) => {
		const h = await harness(t, "none");
		for (const name of ["reviewer", "critic"]) {
			await assert.rejects(h.run({ agent: name, task: `Verify ${name} routing` }), /Unknown agent/);
			assert.throws(() => compileWorkflow({ nodes: [{ id: "verify", agent: name, task: "Verify the named claim" }] }, h.project, ["sentinel", "skeptic"]), /not an enabled agent/);
		}
		assert.equal(h.runtime.threads.size, 0);
		for (const name of ["sentinel", "skeptic"]) {
			const { thread, result } = await h.run({ agent: name, task: `Verify ${name} routing` });
			assert.equal(thread.agentName, name);
			assert.equal(thread.isolation, "shared");
			assert.equal(result.agent, name);
			// Resolve macOS /var aliases and Windows short paths on both sides.
			assert.equal(await realpath(getResultOutput(result)), await realpath(h.project));
		}
	});
});
