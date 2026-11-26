import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_CONFIG } from "../src/configuration/config.ts";
import { loadBuiltinAgents } from "../src/delegation/agents.ts";
import { cancelActiveWork } from "../src/lifecycle/cancellation.ts";
import { createDispatchCore } from "../src/lifecycle/dispatch-core.ts";
import { createRuntime, type SubagentThread } from "../src/lifecycle/runtime.ts";
import { registerLookupTools } from "../src/lifecycle/tools.ts";
import { monitor } from "../src/presentation/monitor.ts";

const CHILD = `
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
    send({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "finished work" }], stopReason: "stop",
      provider: "fixture", model: "bench", usage: { input: 33, output: 7, cost: { total: 0.0003 } } } });
    send({ type: "agent_settled" });
  }
});`;

/** Start a real child that finishes at once, then hold the run in its
 * settlement phase (child done, integration pending) until released. */
async function settlingRun() {
	const root = await mkdtemp(join(tmpdir(), "pi-subagents-settling-"));
	const previousScript = process.argv[1];
	const sent: Array<{ message: any; options: any }> = [];
	const notices: string[] = [];
	const pi = {
		on: () => undefined, getActiveTools: () => ["read", "write"], getAllTools: () => [],
		sendMessage: (message: unknown, options: unknown) => sent.push({ message, options }),
	} as unknown as ExtensionAPI;
	const runtime = createRuntime(pi, join(root, "pi-subagents.json"));
	const child = join(root, "child.mjs");
	await writeFile(child, CHILD, "utf8");
	process.argv[1] = child;
	const core = createDispatchCore(runtime);
	const context = { cwd: root, mode: "tui", scopedModels: [], modelRegistry: { getAvailable: () => [] },
		ui: { notify: (message: string) => notices.push(message) } } as unknown as ExtensionContext;
	core.setEnvironment({
		ctx: context,
		config: DEFAULT_CONFIG,
		agents: loadBuiltinAgents(),
	});
	let release!: () => void;
	const released = new Promise<void>((resolve) => { release = resolve; });
	let entered!: () => void;
	const settling = new Promise<void>((resolve) => { entered = resolve; });
	const started = await core.startBackground("worker", "Finish then integrate", root, "shared");
	assert.ok(started.runId);
	const thread = runtime.threads.get(started.runId) as SubagentThread;
	// Stand in for a worktree integration waiting in the repository lane.
	thread.finalizeIsolation = async (_generation, result) => {
		entered();
		await released;
		if (result) result.integrationStatus = "integrated";
		return { status: "integrated", integrated: true, hadChanges: true };
	};
	const cleanup = async () => {
		release();
		process.argv[1] = previousScript;
		await runtime.shutdown();
		monitor.clear();
		await rm(root, { recursive: true, force: true });
	};
	return { root, pi, runtime, thread, sent, notices, context, settling, release, cleanup };
}

describe("cancellation during settlement", () => {
	it("Escape keeps a finished run's real result and delivers it next turn without waking main", { timeout: 15_000 }, async () => {
		const h = await settlingRun();
		try {
			await h.settling;
			assert.equal(h.thread.lifecycleOperation, "settle");
			h.thread.isolation = "worktree";
			await cancelActiveWork(h.runtime, "Parent run was cancelled.", { context: h.context });
			assert.equal(h.thread.retired, undefined, "a finished run is not cancelled");
			assert.equal(h.sent.some(({ message }) => message.customType === "subagent-cancelled"), false);
			assert.deepEqual(h.notices, [`#${h.thread.id} worker finished and is applying worktree changes.`]);
			h.release();
			await h.thread.generationCompletion;
			h.runtime.completionBatcher.flush();
			assert.equal(h.thread.state, "completed");
			assert.equal(h.runtime.settledRuns.get(h.thread.id)?.exitCode, 0);
			const results = h.sent.filter(({ message }) => message.customType === "subagent-result");
			assert.equal(results.length, 1);
			assert.match(results[0]!.message.content, /finished work/u);
			assert.doesNotMatch(results[0]!.message.content, /aborted|cancelled/iu);
			assert.deepEqual(results[0]!.options, { deliverAs: "nextTurn", triggerTurn: false });
			assert.equal(h.notices.length, 2);
			assert.match(h.notices[1]!, /^✓ #\d+ worker · fixture\/bench.*↑33 ↓7 \$0\.0003/u);
		} finally { await h.cleanup(); }
	});

	it("Escape hands successes already held for delivery to the next turn instead of discarding them", async () => {
		const sent: Array<{ message: any; options: any }> = [];
		const pi = { on: () => undefined, getActiveTools: () => [], getAllTools: () => [], sendMessage: (message: unknown, options: unknown) => sent.push({ message, options }) } as unknown as ExtensionAPI;
		const root = await mkdtemp(join(tmpdir(), "pi-subagents-held-"));
		const runtime = createRuntime(pi, join(root, "pi-subagents.json"));
		const notices: string[] = [];
		const context = { mode: "tui", ui: { notify: (text: string) => notices.push(text) } } as unknown as ExtensionContext;
		try {
			runtime.completionBatcher.push({ agent: "worker", block: "### [worker] completed\n\nheld success" });
			await cancelActiveWork(runtime, "Parent run was cancelled.", { context });
			assert.deepEqual(notices, ["1 completed subagent result ready for your next message."]);
			runtime.completionBatcher.flush();
			assert.equal(sent.length, 1);
			assert.match(sent[0]!.message.content, /held success/u);
			assert.deepEqual(sent[0]!.options, { deliverAs: "nextTurn", triggerTurn: false });
		} finally { await runtime.shutdown(); await rm(root, { recursive: true, force: true }); }
	});

	it("stop-all leaves a settling run alone", { timeout: 15_000 }, async () => {
		const h = await settlingRun();
		try {
			await h.settling;
			let stopTool: any;
			registerLookupTools({ ...h.pi, registerTool: (tool: any) => { if (tool.name === "subagent_stop") stopTool = tool; } } as ExtensionAPI, h.runtime);
			const response = await stopTool.execute("stop-all", { all: true }, undefined, undefined, { cwd: h.root });
			assert.match(response.content[0].text, /No active subagent runs to stop/u);
			h.release();
			await h.thread.generationCompletion;
			assert.equal(h.thread.state, "completed");
		} finally { await h.cleanup(); }
	});

	it("an explicit stop during settlement retires the run but keeps its real result", { timeout: 15_000 }, async () => {
		const h = await settlingRun();
		try {
			await h.settling;
			let stopTool: any;
			registerLookupTools({ ...h.pi, registerTool: (tool: any) => { if (tool.name === "subagent_stop") stopTool = tool; } } as ExtensionAPI, h.runtime);
			const stopping = stopTool.execute("stop-one", { id: String(h.thread.id) }, undefined, undefined, { cwd: h.root });
			h.release();
			const response = await stopping;
			assert.match(response.content[0].text, /already finished; result kept/u);
			const result = h.runtime.settledRuns.get(h.thread.id);
			assert.equal(result?.exitCode, 0);
			assert.notEqual(result?.stopReason, "aborted");
			assert.equal(result?.integrationStatus, "integrated");
			assert.equal(h.thread.retired, true);
		} finally { await h.cleanup(); }
	});
});
