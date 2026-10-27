import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { getResultOutput, isFailedResult, runSingleAgentWithMainFallback } from "../src/execution/spawn.ts";

// Exercise the actual installed Pi CLI with a local provider that never makes
// network requests. The temporary agent directory contains no user credentials.
describe("native Pi CLI integration", () => {
	for (const fallback of [false, true]) {
		it(fallback ? "resumes the same Pi session on main-model fallback" : "runs through Pi's own CLI, loader, provider, and JSON events", { timeout: 30_000 }, async () => {
			const root = await mkdtemp(join(tmpdir(), "pi-subagents-native-pi-"));
			const agentDir = join(root, "agent");
			const previousScript = process.argv[1];
			try {
				await mkdir(join(agentDir, "extensions"), { recursive: true });
				await writeFile(join(agentDir, "extensions", "fixture.js"), `
import { createAssistantMessageEventStream } from ${JSON.stringify(import.meta.resolve("@earendil-works/pi-ai"))};
export default (pi) => pi.registerProvider("fixture", {
 baseUrl: "http://127.0.0.1", apiKey: "fixture-not-a-secret", api: "fixture-native",
 models: ["selected", "main"].map((id) => ({ id, name: id, reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 1000 })),
 streamSimple(model, context) {
  const stream = createAssistantMessageEventStream();
  queueMicrotask(() => {
   const failed = model.id === "selected";
   const text = "native completed; " + context.messages.filter((m) => m.role === "user").length + " user messages";
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
  });
  return stream;
 }
});
`, "utf8");
				process.argv[1] = fileURLToPath(new URL("./cli.js", import.meta.resolve("@earendil-works/pi-coding-agent")));
				const result = await runSingleAgentWithMainFallback({
					defaultCwd: root, cwd: root, agent: { name: "artisan", description: "fixture", systemPrompt: "Return the fixture answer.", model: "fixture/" + (fallback ? "selected" : "main"), tools: [] },
					agentName: "artisan", task: "Test native session preservation", thinkingLevel: "off", idleTimeoutMs: 0,
					sessionRoot: join(root, "sessions"), scratchRoot: join(root, "scratch"),
					env: { ...process.env, PI_CODING_AGENT_DIR: agentDir }, signal: AbortSignal.timeout(25_000),
					makeDetails: (results) => ({ mode: "single", results }),
				}, fallback ? "fixture/main" : undefined);
				assert.equal(isFailedResult(result), false, getResultOutput(result) + "\n" + result.stderr);
				assert.match(getResultOutput(result), /native completed/);
				assert.equal(result.model, "fixture/main");
				assert.ok(result.sessionDir && result.sessionId);
				assert.equal((await readdir(result.sessionDir)).filter((file) => file.endsWith("_" + result.sessionId + ".jsonl")).length, 1);
				if (fallback) {
					assert.equal(result.modelFallbackFrom, "fixture/selected");
					assert.match(getResultOutput(result), /2 user messages/);
				}
			} finally {
				process.argv[1] = previousScript;
				await rm(root, { recursive: true, force: true });
			}
		});
	}
});
