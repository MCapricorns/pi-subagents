import assert from "node:assert/strict";
import { copyFile, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { getResultOutput, isFailedResult, runSingleAgentWithMainFallback } from "../src/execution/spawn.ts";
import { RunControl } from "../src/execution/run-control.ts";

// Exercise the actual installed Pi CLI with a local provider that never makes
// network requests. The temporary agent directory contains no user credentials.
describe("native Pi CLI integration", () => {
	for (const mode of ["normal", "fallback", "steering", "followup"] as const) {
		const fallback = mode === "fallback";
		it(mode === "fallback" ? "resumes the same Pi session on main-model fallback" : mode === "steering" ? "delivers steering through the real Pi RPC process" : mode === "followup" ? "continues a private session in a new workspace after the old workspace is removed" : "runs through Pi's own CLI, loader, provider, and RPC events", { timeout: 30_000 }, async () => {
			const root = await mkdtemp(join(tmpdir(), "pi-subagents-native-pi-"));
			const agentDir = join(root, "agent");
			const previousScript = process.argv[1];
			try {
				await mkdir(join(agentDir, "extensions"), { recursive: true });
				await writeFile(join(agentDir, "extensions", "fixture.js"), `
import { createAssistantMessageEventStream } from ${JSON.stringify(import.meta.resolve("@earendil-works/pi-ai"))};
export default async (pi) => {
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
   const text = "native completed; " + context.messages.filter((m) => m.role === "user").length + " user messages; resume guard=" + context.messages.some((m) => m.role === "user" && JSON.stringify(m.content).includes("workspace may have changed"));
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
				const cwd = mode === "followup" ? join(root, "first-worktree") : root;
				await mkdir(cwd, { recursive: true });
				let steering: Promise<void> | undefined;
				const result = await runSingleAgentWithMainFallback({
					defaultCwd: cwd, cwd, agent: { name: "artisan", description: "fixture", systemPrompt: "Return the fixture answer.", model: "fixture/" + (fallback ? "selected" : "main"), tools: [] },
					agentName: "artisan", task: "Test native session preservation", thinkingLevel: "off", idleTimeoutMs: 0,
					sessionRoot: join(root, "sessions"), scratchRoot: join(root, "scratch"),
					env: { ...process.env, PI_CODING_AGENT_DIR: agentDir }, signal: AbortSignal.timeout(25_000), control,
					onLive: (event) => {
						if (mode === "steering" && !steering && event.kind === "status" && event.status === "running") steering = control.steer("Additional instruction");
					},
				}, fallback ? "fixture/main" : undefined);
				if (steering) await steering;
				assert.equal(isFailedResult(result), false, getResultOutput(result) + "\n" + result.stderr);
				if (mode === "steering") assert.match(getResultOutput(result), /2 user messages/);
				assert.match(getResultOutput(result), /native completed/);
				assert.equal(result.model, "fixture/main");
				assert.ok(result.sessionDir && result.sessionId);
				assert.equal((await readdir(result.sessionDir)).filter((file) => file.endsWith("_" + result.sessionId + ".jsonl")).length, 1);
				if (fallback) {
					assert.equal(result.modelFallbackFrom, "fixture/selected");
					assert.match(getResultOutput(result), /2 user messages/);
				}
				if (mode === "followup") {
					const file = (await readdir(result.sessionDir)).find((name) => name.endsWith(`_${result.sessionId}.jsonl`))!;
					const originalFile = join(result.sessionDir, file);
					const original = await readFile(originalFile, "utf8");
					const privateDir = join(root, "copied-session");
					const nextCwd = join(root, "next-worktree");
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
						env: { ...process.env, PI_CODING_AGENT_DIR: agentDir }, signal: AbortSignal.timeout(15_000),
					});
					assert.equal(isFailedResult(continued), false, getResultOutput(continued) + "\n" + continued.stderr);
					assert.match(getResultOutput(continued), /2 user messages; resume guard=true/u);
					assert.equal(continued.sessionId, result.sessionId, "a private continuation keeps its provider cache key");
					const copied = await readFile(join(privateDir, file), "utf8");
					assert.equal(JSON.parse(copied.split("\n")[0]).cwd, nextCwd);
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
