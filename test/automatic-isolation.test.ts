import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, type TestContext } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { defaultIsolationMode, registerSubagentTool } from "../src/delegation/dispatch.ts";
import { createRuntime, type SubagentThread } from "../src/lifecycle/runtime.ts";
import { monitor } from "../src/presentation/monitor.ts";
import { getResultOutput, type SingleResult } from "../src/execution/spawn.ts";

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
import { readFileSync, writeFileSync } from "node:fs";
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const promptFlag = process.argv.indexOf("--append-system-prompt");
createInterface({ input: process.stdin }).on("line", (line) => {
  const command = JSON.parse(line);
  if (command.type !== "prompt") return;
  send({ type: "response", id: command.id, command: "prompt", success: true, data: { disposition: "started" } });
  send({ type: "agent_start" });
  if (command.message.includes("Write output")) writeFileSync("output.txt", "isolated result");
  const text = command.message.includes("Report prompt") ? readFileSync(process.argv[promptFlag + 1], "utf8") : process.cwd();
  send({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }], stopReason: "stop" } });
  send({ type: "agent_settled" });
});`);
	const previousScript = process.argv[1];
	process.argv[1] = script;
	let tool: any;
	const pi = { on: () => undefined, getActiveTools: () => ["read", "write"], getAllTools: () => [], sendMessage: () => undefined,
		registerTool: (value: any) => { tool = value; } } as unknown as ExtensionAPI;
	const runtime = createRuntime(pi, join(root, "config.json"));
	registerSubagentTool(pi, runtime);
	const ctx = { cwd: project, scopedModels: [], modelRegistry: { getAvailable: () => [] }, ui: { notify: () => undefined } } as unknown as ExtensionContext;
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
		assert.equal(defaultIsolationMode("worker"), "worktree");
		assert.equal(defaultIsolationMode("researcher"), "shared");
		assert.equal(defaultIsolationMode("worker", "shared"), "shared");
		assert.equal(defaultIsolationMode("worker", "worktree"), "worktree");
	});

	it("uses and integrates a worktree for a single implementation without an override", async (t) => {
		const h = await harness(t, "committed");
		const head = git(h.project, "rev-parse", "HEAD");
		let dispatchedIdentity: string | undefined;
		const { thread, result } = await h.run({ agent: "worker", task: "Write output" }, (pending) => {
			assert.equal(pending.worktree, undefined, "dispatch returns before asynchronous worktree preparation finishes");
			assert.ok(pending.durableId);
			dispatchedIdentity = pending.durableId;
		});
		assert.equal(thread.durableId, dispatchedIdentity, "preparation and settlement preserve the dispatched identity");
		assert.equal(result.exitCode, 0, result.errorMessage ?? result.stderr);
		assert.equal(thread.isolation, "worktree");
		assert.notEqual(thread.executionCwd.toLowerCase(), h.project.toLowerCase());
		assert.equal(result.integrationStatus, "integrated");
		assert.equal(await readFile(join(h.project, "output.txt"), "utf8"), "isolated result");
		assert.equal(git(h.project, "rev-parse", "HEAD"), head);
		assert.equal(git(h.project, "diff", "--cached", "--name-only"), "");
	});

	it("tells an isolated child where its worktree mirrors the original checkout", async (t) => {
		const h = await harness(t, "committed");
		const { thread, result } = await h.run({ agent: "worker", task: "Report prompt" });
		const prompt = getResultOutput(result);
		assert.equal(result.exitCode, 0, result.errorMessage ?? result.stderr);
		assert.ok(prompt.includes(`temporary detached Git worktree at ${thread.executionCwd}, a snapshot of the original checkout ${await realpath(h.project)}.`), prompt);
		assert.match(prompt, /map every brief path under the original checkout to the same relative path here/u);
	});

	it("fails a queued launch if settings become invalid during worktree preparation", async (t) => {
		const h = await harness(t, "committed");
		const { result } = await h.run({ agent: "worker", task: "Write output" }, () => {
			writeFileSync(h.runtime.configPath, "{unfinished edit");
		});
		assert.equal(result.exitCode, 1);
		assert.match(result.errorMessage ?? "", /Subagent settings are invalid or unsupported/u);
		assert.equal(existsSync(join(h.project, "output.txt")), false);
	});

	for (const repository of ["none", "unborn"] as const) {
		it(`reports automatic shared fallback for ${repository} repositories`, async (t) => {
			const h = await harness(t, repository);
			const { thread, result } = await h.run({ agent: "worker", task: "Write output" });
			assert.equal(result.exitCode, 0);
			assert.equal(thread.isolation, "shared");
			assert.equal(thread.executionCwd, h.project);
			assert.match(result.isolationNote ?? "", repository === "none" ? /not a Git repository/ : /no committed HEAD/);
			assert.equal(result.integrationStatus, undefined);
		});

		it(`does not fall back when worktree isolation is explicitly required in ${repository}`, async (t) => {
			const h = await harness(t, repository);
			const { result } = await h.run({ agent: "worker", task: "Write output", isolation: "worktree" });
			assert.equal(result.exitCode, 1);
			assert.equal(existsSync(join(h.project, "output.txt")), false);
			assert.match(result.errorMessage ?? result.stderr, /Worktree isolation/);
		});
	}

	it("rejects retired role names before dispatch and accepts only current names", async (t) => {
		const h = await harness(t, "none");
		for (const name of ["scout", "artisan", "reviewer", "critic", "skeptic", "sentinel"]) {
			await assert.rejects(h.run({ agent: name, task: `Verify ${name} routing` }), /Unknown agent/);
		}
		assert.equal(h.runtime.threads.size, 0);
		const { thread, result } = await h.run({ agent: "researcher", task: "Verify researcher routing" });
		assert.equal(thread.agentName, "researcher");
		assert.equal(thread.isolation, "shared");
		assert.equal(result.agent, "researcher");
		// Resolve macOS /var aliases and Windows short paths on both sides.
		assert.equal(await realpath(getResultOutput(result)), await realpath(h.project));
	});
});
