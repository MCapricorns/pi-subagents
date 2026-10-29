import assert from "node:assert/strict";
import { copyFile, mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { getResultOutput, isFailedResult, runSingleAgentWithMainFallback } from "../src/execution/spawn.ts";
import { RunControl, type SteeringReceipt } from "../src/execution/run-control.ts";
import { loadBuiltinAgents, resolveAgentTools } from "../src/delegation/agents.ts";

// Exercise the actual installed Pi CLI with a local provider that never makes
// network requests. The temporary agent directory contains no user credentials.
describe("native Pi CLI integration", () => {
	for (const mode of ["normal", "fallback", "fallback-alias", "steering", "handled", "dialogs", "followup", "followup-alias"] as const) {
		const fallback = mode === "fallback" || mode === "fallback-alias";
		const followup = mode === "followup" || mode === "followup-alias";
		const aliased = mode.endsWith("-alias");
		it((fallback ? "resumes the same Pi session on main-model fallback" : mode === "steering" ? "delivers steering through the real Pi RPC process" : mode === "handled" ? "reports native input-hook handling without claiming the steer was queued" : mode === "dialogs" ? "cancels real extension dialogs and leaves approval denied" : followup ? "continues a private session in a new workspace after the old workspace is removed" : "runs through Pi's own CLI, loader, provider, and RPC events") + (aliased ? " through a directory alias" : ""), { timeout: 30_000 }, async () => {
			const root = await mkdtemp(join(tmpdir(), "pi-subagents-native-pi-"));
			const agentDir = join(root, "agent");
			const previousScript = process.argv[1];
			try {
				await mkdir(join(agentDir, "extensions"), { recursive: true });
				await writeFile(join(agentDir, "extensions", "fixture.js"), `
import { createAssistantMessageEventStream } from ${JSON.stringify(import.meta.resolve("@earendil-works/pi-ai"))};
export default async (pi) => {
 let dialogs;
 if (${mode === "handled"}) pi.on("input", (event) => event.text === "Additional instruction" ? { action: "handled" } : undefined);
 if (${mode === "dialogs"}) pi.on("before_agent_start", async (_event, ctx) => {
  dialogs = [await ctx.ui.confirm("Fixture permission", "Allow a write?"), await ctx.ui.select("Fixture select", ["Allow"]),
   await ctx.ui.input("Fixture input"), await ctx.ui.editor("Fixture editor", "prefill")];
 });
 if (${mode === "normal"}) {
  const windows = process.platform === "win32";
  const shell = await pi.exec(windows ? "powershell.exe" : "/bin/sh", windows
   ? ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "[Console]::Write('fixture shell')"]
   : ["-c", "printf 'fixture shell'"]);
  if (shell.code !== 0 || shell.stdout !== "fixture shell") throw new Error("Extension shell failed: " + JSON.stringify(shell));
 }
 pi.registerProvider("fixture", {
 baseUrl: "http://127.0.0.1", apiKey: "fixture-not-a-secret", api: "fixture-native",
 models: ["selected", "main"].map((id) => ({ id, name: id, reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 1000 })),
 streamSimple(model, context) {
  const stream = createAssistantMessageEventStream();
  setTimeout(() => {
   const failed = model.id === "selected";
   const text = "native completed; " + context.messages.filter((m) => m.role === "user").length + " user messages; resume guard=" + context.messages.some((m) => m.role === "user" && JSON.stringify(m.content).includes("workspace may have changed")) + "; dialogs=" + JSON.stringify(dialogs);
   const message = { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), stopReason: "pending", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
   stream.push({ type: "start", partial: message });
   if (failed) {
    message.stopReason = "error"; message.errorMessage = "Fixture selected model unavailable";
    stream.push({ type: "error", reason: "error", error: message });
   } else {
    message.content.push({ type: "text", text: "" });
    stream.push({ type: "text_start", contentIndex: 0, partial: message });
    message.content[0].text = text;
    stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: message });
    stream.push({ type: "text_end", contentIndex: 0, content: text, partial: message });
    message.stopReason = "stop";
    stream.push({ type: "done", reason: "stop", message });
   }
   stream.end();
  }, 250);
  return stream;
 }
 });
};
`, "utf8");
				process.argv[1] = fileURLToPath(new URL("./cli.js", import.meta.resolve("@earendil-works/pi-coding-agent")));
				const control = new RunControl("Test native session preservation", 1);
				let workspaceRoot = root;
				if (aliased) {
					const target = join(root, "workspace");
					await mkdir(target);
					workspaceRoot = join(root, "workspace-alias");
					await symlink(target, workspaceRoot, process.platform === "win32" ? "junction" : "dir");
				}
				const cwd = followup ? join(workspaceRoot, "first-worktree") : workspaceRoot;
				await mkdir(cwd, { recursive: true });
				let steering: Promise<SteeringReceipt> | undefined;
				const result = await runSingleAgentWithMainFallback({
					defaultCwd: cwd, cwd, agent: { name: "artisan", description: "fixture", systemPrompt: "Return the fixture answer.", model: "fixture/" + (fallback ? "selected" : "main"), tools: [] },
					agentName: "artisan", task: "Test native session preservation", thinkingLevel: "off", idleTimeoutMs: 0,
					sessionRoot: join(root, "sessions"), scratchRoot: join(root, "scratch"),
					env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1" }, signal: AbortSignal.timeout(25_000), control,
					onLive: (event) => {
						if ((mode === "steering" || mode === "handled") && !steering && event.kind === "status" && event.status === "running") steering = control.steer("Additional instruction");
					},
				}, fallback ? "fixture/main" : undefined);
				if (steering) {
					const receipt = await steering;
					assert.equal(receipt.requestId, "steer-1");
					assert.equal(receipt.disposition, mode === "handled" ? "handled" : "queued");
					assert.ok(receipt.acknowledgedAt <= Date.now());
				}
				assert.equal(isFailedResult(result), false, getResultOutput(result) + "\n" + result.stderr);
				if (mode === "steering") assert.match(getResultOutput(result), /2 user messages/);
				if (mode === "handled") assert.match(getResultOutput(result), /1 user messages/);
				if (mode === "dialogs") {
					assert.match(getResultOutput(result), /dialogs=\[false,null,null,null\]/u);
					for (const method of ["confirm", "select", "input", "editor"]) assert.match(result.stderr, new RegExp(`Cancelled child extension ${method} dialog`));
				}
				assert.match(getResultOutput(result), /native completed/);
				assert.equal(result.model, "fixture/main");
				assert.ok(result.sessionDir && result.sessionId);
				const sessionFiles = (await readdir(result.sessionDir)).filter((file) => file.endsWith("_" + result.sessionId + ".jsonl"));
				assert.equal(sessionFiles.length, 1);
				const session = await readFile(join(result.sessionDir, sessionFiles[0]!), "utf8");
				assert.equal(JSON.parse(session.split("\n")[0]!).cwd, await realpath(cwd));
				if (fallback) {
					assert.equal(result.modelFallbackFrom, "fixture/selected");
					assert.match(getResultOutput(result), /2 user messages/);
				}
				if (followup) {
					const file = (await readdir(result.sessionDir)).find((name) => name.endsWith(`_${result.sessionId}.jsonl`))!;
					const originalFile = join(result.sessionDir, file);
					const original = await readFile(originalFile, "utf8");
					const privateDir = join(root, "copied-session");
					const nextCwd = join(workspaceRoot, "next-worktree");
					await mkdir(privateDir);
					await mkdir(nextCwd);
					await copyFile(originalFile, join(privateDir, file));
					await rm(cwd, { recursive: true, force: true });
					const continued = await runSingleAgentWithMainFallback({
						defaultCwd: nextCwd, cwd: nextCwd,
						agent: { name: "artisan", description: "fixture", systemPrompt: "Return the fixture answer.", model: "fixture/main", tools: [] },
						agentName: "artisan", task: "Verify the next step", thinkingLevel: "off", idleTimeoutMs: 0,
						sessionRoot: join(root, "sessions"), scratchRoot: join(root, "scratch"),
						sessionDir: privateDir, sessionId: result.sessionId,
						env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1" }, signal: AbortSignal.timeout(15_000),
					});
					assert.equal(isFailedResult(continued), false, getResultOutput(continued) + "\n" + continued.stderr);
					assert.match(getResultOutput(continued), /2 user messages; resume guard=true/u);
					assert.equal(continued.sessionId, result.sessionId, "a private continuation keeps its provider cache key");
					const copied = await readFile(join(privateDir, file), "utf8");
					assert.equal(JSON.parse(copied.split("\n")[0]).cwd, await realpath(nextCwd));
					assert.ok(copied.includes(original.slice(original.indexOf("\n") + 1)), "prior history survives the cwd update");
					assert.equal(await readFile(originalFile, "utf8"), original, "the source transcript is never modified");
				}
			} finally {
				process.argv[1] = previousScript;
				await rm(root, { recursive: true, force: true });
			}
		});
	}
});


describe("native child tool inheritance", () => {
	for (const [role, registration] of [["artisan", "during-turn"], ["scout", "during-turn"], ["scout", "startup"]] as const) {
		it(`inherits ${role} tools across asynchronous ${registration} registration`, { timeout: 30_000 }, async () => {
			const root = await mkdtemp(join(tmpdir(), "pi-subagents-native-tools-"));
			const agentDir = join(root, "agent");
			const previousScript = process.argv[1];
			const indirect = [
				{ name: "mcp__late__search", exposure: "codemode" as const, annotations: { readOnlyHint: true } },
				{ name: "fixture_deferred", exposure: "deferred" as const, annotations: { readOnlyHint: true } },
				{ name: "fixture_writer", exposure: "codemode" as const },
			];
			try {
				await mkdir(join(agentDir, "extensions"), { recursive: true });
				const document = join(root, "fixture.txt");
				await writeFile(document, "fixture document");
				await writeFile(join(agentDir, "extensions", "tools.js"), `
import assert from "node:assert/strict";
import { Type } from ${JSON.stringify(import.meta.resolve("typebox"))};
import { createAssistantMessageEventStream } from ${JSON.stringify(import.meta.resolve("@earendil-works/pi-ai"))};
export default function (pi) {
 const scout = ${role === "scout"};
 const indirect = ${JSON.stringify(indirect)};
 const startup = ${registration === "startup"};
 const register = (info) => pi.registerTool({ ...info, label: info.name, description: "fixture lookup " + info.name,
  parameters: Type.Object({}), async execute() { return { content: [{ type: "text", text: "executed " + info.name }], details: undefined }; } });
 register({ name: "mcp__visible__search", exposure: "direct", annotations: { readOnlyHint: true } });
 register({ name: "inactive_direct", exposure: "direct" });
 register({ name: "mcp__inactive__direct", exposure: "direct" });
 register({ name: "subagent", exposure: "codemode" });
 if (startup) {
  let timer;
  pi.on("session_start", () => { timer = setTimeout(() => { for (const info of indirect) register(info); }, 150); });
  pi.on("session_shutdown", () => clearTimeout(timer));
 } else {
  // Withdrawn entries are present but inactive until the first model request
  // restores their exposure. This also checks activation after startup.
  for (const info of indirect) register({ ...info, exposure: "hidden" });
 }
 let turn = 0;
 pi.registerProvider("fixture", {
  baseUrl: "http://127.0.0.1", apiKey: "fixture-not-a-secret", api: "fixture-tools",
  models: [{ id: "tools", name: "tools", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 1000 }],
  streamSimple(model, context) {
   const stream = createAssistantMessageEventStream();
   const current = ++turn;
   setTimeout(async () => {
    const message = { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), stopReason: "pending", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    stream.push({ type: "start", partial: message });
    try {
     const declared = new Set();
     for (const entry of context.messages) if (entry.role === "system") {
      for (const tool of entry.toolsRemoved ?? []) declared.delete(tool.name);
      for (const tool of entry.toolsAdded ?? []) declared.add(tool.name);
     }
     assert.ok(declared.has("read") && declared.has("mcp__visible__search"), "Parent active tools must survive");
     assert.ok(!declared.has("inactive_direct") && !declared.has("mcp__inactive__direct") && !declared.has("subagent"));
     let content;
     if (current === 1 && startup) {
      assert.ok(!declared.has("codemode") && !declared.has("fixture_writer"));
      assert.ok(declared.has("mcp__late__search") && declared.has("fixture_deferred"), "Scout must await and activate late registration before its first request");
      content = ["mcp__late__search", "fixture_deferred", "mcp__visible__search"].map((name, i) => ({ type: "toolCall", id: "lookup-" + i, name, arguments: {} }));
     } else if (current === 1) {
      assert.ok(!declared.has("mcp__late__search") && !declared.has("fixture_deferred"));
      // Register while the first model request is in flight, after CLI selection
      // and before the next model request snapshots its tool declarations.
      await new Promise(resolve => setTimeout(resolve, 30));
      for (const info of indirect) register(info);
      content = [{ type: "toolCall", id: "read-fixture", name: "read", arguments: { path: ${JSON.stringify(document)} } }];
     } else if (current === 2 && scout && !startup) {
      assert.ok(!declared.has("codemode") && !declared.has("fixture_writer"));
      assert.ok(declared.has("mcp__late__search") && declared.has("fixture_deferred"), "Late approved indirect tools must be declared for scout");
      content = ["mcp__late__search", "fixture_deferred", "mcp__visible__search"].map((name, i) => ({ type: "toolCall", id: "lookup-" + i, name, arguments: {} }));
     } else if (current === 2 && !scout) {
      assert.ok(declared.has("codemode"));
      for (const info of indirect) assert.ok(!declared.has(info.name), "Indirect exposure must remain indirect");
      content = [{ type: "toolCall", id: "discover-fixture", name: "codemode", arguments: { code:
       'const names = ALL_TOOLS.map(t => t.name); if (names.includes("subagent") || names.includes("inactive_direct") || names.includes("mcp__inactive__direct")) throw new Error("Child tool boundary widened"); ' +
       'for (const name of ["mcp__late__search", "fixture_deferred", "fixture_writer", "mcp__visible__search"]) { if (!names.includes(name) || !(await describeTool(name))) throw new Error("Missing inherited tool: " + name); } ' +
       'text(await tools.mcp__late__search({})); text(await tools.fixture_deferred({})); text(await tools.fixture_writer({})); text(await tools.mcp__visible__search({}));'
      } }];
     } else {
      assert.equal(current, startup ? 2 : 3, "No unexpected retry or extra turn");
      const results = context.messages.filter(m => m.role === "toolResult");
      assert.ok(results.every(m => !m.isError), JSON.stringify(results));
      const text = JSON.stringify(results);
      for (const name of ["mcp__late__search", "fixture_deferred", "mcp__visible__search"]) assert.ok(text.includes("executed " + name));
      if (!scout) assert.ok(text.includes("executed fixture_writer"));
      content = [{ type: "text", text: "native tools completed" }];
     }
     for (const block of content) {
      const i = message.content.length;
      if (block.type === "toolCall") {
       stream.push({ type: "toolcall_start", contentIndex: i, partial: message });
       message.content.push(block);
       stream.push({ type: "toolcall_end", contentIndex: i, toolCall: block, partial: message });
      } else {
       stream.push({ type: "text_start", contentIndex: i, partial: message });
       message.content.push(block);
       stream.push({ type: "text_delta", contentIndex: i, delta: block.text, partial: message });
       stream.push({ type: "text_end", contentIndex: i, content: block.text, partial: message });
      }
     }
     message.stopReason = content.some(block => block.type === "toolCall") ? "toolUse" : "stop";
     stream.push({ type: "done", reason: message.stopReason, message });
    } catch (error) {
     message.stopReason = "error"; message.errorMessage = String(error.stack ?? error);
     stream.push({ type: "error", reason: "error", error: message });
    }
    stream.end();
   }, 20);
   return stream;
  }
 });
}
`, "utf8");
				process.argv[1] = fileURLToPath(new URL("./cli.js", import.meta.resolve("@earendil-works/pi-coding-agent")));
				const agent = resolveAgentTools(loadBuiltinAgents().find(entry => entry.name === role)!,
					["read", "codemode", "mcp__visible__search"], [
						{ name: "codemode", reachesTools: () => "all" },
						{ name: "mcp__visible__search", annotations: { readOnlyHint: true } }, ...indirect,
					]);
				const result = await runSingleAgentWithMainFallback({
					defaultCwd: root, cwd: root, agent: { ...agent, model: "fixture/tools", systemPrompt: "Exercise inherited tools." },
					agentName: role, task: "Exercise inherited tools", thinkingLevel: "off", idleTimeoutMs: 0,
					sessionRoot: join(root, "sessions"), scratchRoot: join(root, "scratch"),
					env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1" }, signal: AbortSignal.timeout(25_000),
				});
				assert.equal(isFailedResult(result), false, getResultOutput(result) + "\n" + result.stderr);
				assert.equal(getResultOutput(result), "native tools completed");
				assert.deepEqual(result.failedTools ?? [], []);
				assert.deepEqual(await readdir(join(root, "scratch")), [], "Temporary child activation extension is removed");
			} finally {
				process.argv[1] = previousScript;
				await rm(root, { recursive: true, force: true });
			}
		});
	}
});
