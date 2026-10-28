import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadBuiltinAgents } from "../src/delegation/agents.ts";
import { DEFAULT_CONFIG } from "../src/configuration/config.ts";
import { createDispatchCore } from "../src/lifecycle/dispatch-core.ts";
import { createRuntime } from "../src/lifecycle/runtime.ts";
import { monitor } from "../src/presentation/monitor.ts";

describe("dispatcher completion delivery", () => {
	it("starts eight disjoint shared writers in one repository before any finishes", { timeout: 15_000 }, async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-subagents-concurrent-shared-"));
		const previousScript = process.argv[1];
		const pi = { on: () => undefined, getActiveTools: () => ["write"], getAllTools: () => [], sendMessage: () => undefined } as unknown as ExtensionAPI;
		const runtime = createRuntime(pi, join(root, "config.json"));
		try {
			const child = join(root, "child.mjs");
			await writeFile(child, `
import { writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
process.stdin.setEncoding("utf8");
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\\n")) >= 0) {
    const command = JSON.parse(buffer.slice(0, index));
    buffer = buffer.slice(index + 1);
    if (command.type !== "prompt") continue;
    send({ type: "response", id: command.id, command: "prompt", success: true, data: { disposition: "started" } });
    send({ type: "agent_start" });
    writeFileSync(join(process.cwd(), "started-" + process.pid), "");
    const timer = setInterval(() => {
      if (!existsSync(join(process.cwd(), "release"))) return;
      clearInterval(timer);
      send({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "concurrent execution verified" }], stopReason: "stop" } });
      send({ type: "agent_settled" });
    }, 10);
  }
});`, "utf8");
			process.argv[1] = child;
			const core = createDispatchCore(runtime);
			core.setEnvironment({ ctx: { cwd: root, modelRegistry: { getAvailable: () => [] }, ui: { notify: () => undefined } } as unknown as ExtensionContext, config: DEFAULT_CONFIG, agents: loadBuiltinAgents() });
			const starts = await Promise.all(Array.from({ length: 8 }, (_, id) => core.startBackground("artisan", "Write independent file " + id, root, "shared", { phaseId: "write-" + id, scope: { paths: ["output-" + id] }, quiet: true })));
			assert.ok(starts.every((result) => result.runId !== undefined && result.exitCode === -1));
			const deadline = Date.now() + 8_000;
			while ((await readdir(root)).filter((name) => name.startsWith("started-")).length < 8) {
				assert.ok(Date.now() < deadline, "every writer must start while all earlier writers are still running");
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
			assert.equal(runtime.settledRuns.size, 0);
			await writeFile(join(root, "release"), "");
			await runtime.backgroundQueue.waitForIdle();
			assert.equal(runtime.settledRuns.size, 8);
			assert.ok([...runtime.settledRuns.values()].every((result) => result.exitCode === 0));
		} finally {
			process.argv[1] = previousScript;
			await writeFile(join(root, "release"), "");
			await runtime.shutdown();
			monitor.clear();
			await rm(root, { recursive: true, force: true });
		}
	});

	for (const scenario of ["success", "failure", "await", "quiet"] as const) {
		it("delivers " + scenario + " through its actual dispatcher route", async () => {
			const root = await mkdtemp(join(tmpdir(), "pi-subagents-dispatch-delivery-"));
			const previousScript = process.argv[1];
			const messages: Array<{ content: string }> = [];
			const pi = {
				on: () => undefined,
				getActiveTools: () => ["read"],
				getAllTools: () => [],
				sendMessage: (message: { content: string }) => messages.push(message),
			} as unknown as ExtensionAPI;
			const runtime = createRuntime(pi, join(root, "pi-subagents.json"));
			try {
				const child = join(root, "child.mjs");
				await writeFile(child, `
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
process.stdin.setEncoding("utf8");
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\\n")) >= 0) {
    const command = JSON.parse(buffer.slice(0, index));
    buffer = buffer.slice(index + 1);
    if (command.type !== "prompt") continue;
    send({ type: "response", id: command.id, command: "prompt", success: true, data: { disposition: "started" } });
    send({ type: "agent_start" });
    send({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "delivery verified" }], stopReason: ${scenario === "failure" ? '"error"' : '"stop"'}, ${scenario === "failure" ? 'errorMessage: "provider failed"' : ''} } });
    send({ type: "agent_settled" });
  }
});`, "utf8");
				process.argv[1] = child;
				const core = createDispatchCore(runtime);
				core.setEnvironment({
					ctx: { cwd: root, modelRegistry: { getAvailable: () => [] }, ui: { notify: () => undefined } } as unknown as ExtensionContext,
					config: DEFAULT_CONFIG,
					agents: loadBuiltinAgents(),
				});
				const started = await core.startBackground("scout", "Check completion delivery", root, "shared", {
					deliveryRoute: scenario === "await" ? "await" : "background",
					quiet: scenario === "quiet",
				});
				assert.ok(started.runId);
				await runtime.threads.get(started.runId)!.generationCompletion;
				assert.ok(runtime.settledRuns.has(started.runId), "the dispatcher registered the result");
				runtime.completionBatcher.flush();
				assert.equal(messages.length, scenario === "quiet" || scenario === "await" ? 0 : 1);
				if (scenario === "await") {
					runtime.completeAwaitDelivery([started.runId]);
					runtime.completionBatcher.flush();
					assert.equal(messages.length, 0, "the awaited result is returned only by its tool call");
				}
				if (messages.length) assert.match(messages[0]!.content, scenario === "failure" ? /provider failed/ : /delivery verified/);
			} finally {
				process.argv[1] = previousScript;
				await runtime.shutdown();
				monitor.clear();
				await rm(root, { recursive: true, force: true });
			}
		});
	}
});
