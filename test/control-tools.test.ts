import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import fsPromises, { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { getProjectRoot } from "../src/execution/spawn.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { emptyUsage, RunControl, type AttemptControl } from "../src/execution/run-control.ts";
import { createRuntime, type SubagentRuntime, type SubagentThread, type ThreadState } from "../src/lifecycle/runtime.ts";
import { registerLookupTools } from "../src/lifecycle/tools.ts";
import { createDispatchCore, type DispatchCore } from "../src/lifecycle/dispatch-core.ts";
import { formatCompletionBlock } from "../src/presentation/format.ts";
import { monitor } from "../src/presentation/monitor.ts";

type RegisteredTool = {
	exposure?: string;
	executionMode?: string;
	annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean };
	execute: (toolCallId: string, params: any, signal: AbortSignal, onUpdate: (update: unknown) => void, ctx: any) => Promise<any>;
};

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => { resolve = done; });
	return { promise, resolve };
}

function harness(configPath = join(tmpdir(), `pi-subagents-control-${process.pid}.json`), dispatchCore?: DispatchCore) {
	const tools = new Map<string, RegisteredTool>();
	const sent: unknown[] = [];
	const pi = {
		getActiveTools: () => [],
		getAllTools: () => [],
		on: () => undefined,
		registerTool: (tool: RegisteredTool & { name: string }) => tools.set(tool.name, tool),
		sendMessage: (message: unknown) => sent.push(message),
	} as unknown as ExtensionAPI;
	const runtime = createRuntime(pi, configPath);
	registerLookupTools(pi, runtime, dispatchCore ?? createDispatchCore(runtime));
	return { runtime, tools, sent };
}

function resultText(result: any): string {
	return result.content.map((part: { text?: string }) => part.text ?? "").join("\n");
}

function makeThread(id: number, state: ThreadState = "running"): SubagentThread {
	return {
		id,
		generation: 1,
		agentName: "worker",
		task: "Implement the original objective",
		cwd: process.cwd(),
		executionCwd: process.cwd(),
		isolation: "shared",
		state,
		control: new RunControl("Implement the original objective"),
		generationCompletion: Promise.resolve(),
		lifecycleVersion: 0,
		elapsedMs: 0,
		finalizeIsolation: async () => undefined,
	};
}

async function execute(tool: RegisteredTool, params: Record<string, unknown> = {}, signal = new AbortController().signal): Promise<any> {
	return tool.execute("call-1", params, signal, () => undefined, {
		cwd: process.cwd(), scopedModels: [], modelRegistry: { getAvailable: () => [] }, ui: { notify: () => undefined },
	});
}

async function shutdown(runtime: SubagentRuntime): Promise<void> {
	runtime.threads.clear();
	await runtime.shutdown();
}

function attachRunning(control: RunControl, attempt: AttemptControl): void {
	const token = control.beginAttempt();
	control.attach(token, attempt);
	control.updateAttemptPhase(token, "running");
}

describe("subagent_status", () => {
	it("registers status, message, and destructive stop controls", async () => {
		const { runtime, tools } = harness();
		try {
			assert.deepEqual([...tools.keys()].sort(), ["subagent_message", "subagent_status", "subagent_stop"]);
			const status = tools.get("subagent_status")!;
			assert.equal(status.exposure, "model-only");
			assert.equal(status.executionMode, "parallel");
			assert.equal(status.annotations?.readOnlyHint, true);
			assert.equal(status.annotations?.destructiveHint, false);
			const stop = tools.get("subagent_stop")!;
			assert.equal(stop.exposure, "model-only");
			assert.equal(stop.executionMode, "sequential");
			assert.equal(stop.annotations?.destructiveHint, true);
			assert.equal(stop.annotations?.readOnlyHint, false);
		} finally { await shutdown(runtime); }
	});

	it("returns an empty list and an explicit unknown-id error", async () => {
		const { runtime, tools } = harness();
		try {
			assert.ok(tools.has("subagent_status"), "the status interface must be registered");
			const status = tools.get("subagent_status")!;
			const empty = await execute(status);
			assert.deepEqual(empty.details, { runs: [] });
			assert.match(resultText(empty), /no subagent runs/i);
			const missing = await execute(status, { id: 999 });
			assert.equal(missing.isError, true);
			assert.deepEqual(missing.details, { runs: [] });
			assert.match(resultText(missing), /#999/);
		} finally { await shutdown(runtime); }
	});

	it("waits for existing durable restoration before reporting a run missing", async () => {
		const { runtime, tools } = harness();
		const restored = deferred();
		runtime.durableRestore = restored.promise;
		let answered = false;
		const lookup = execute(tools.get("subagent_status")!, { id: 6 }).then((response) => {
			answered = true;
			return response;
		});
		try {
			await Promise.resolve();
			assert.equal(answered, false);
			runtime.threads.set(6, makeThread(6, "parked"));
			restored.resolve();
			const response = await lookup;
			assert.equal(response.isError, undefined);
			assert.equal(response.details.runs[0].state, "interrupted");
		} finally { restored.resolve(); await shutdown(runtime); }
	});

	it("returns the existing full-result artifact without rewriting it or redelivering completion", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-subagents-status-result-"));
		const { runtime, tools, sent } = harness(join(root, "config.json"));
		const thread = makeThread(8, "completed");
		const output = Array.from({ length: 80 }, (_, index) => `Result line ${index}`).join("\n");
		thread.lastResult = {
			agent: "worker", task: thread.task, exitCode: 0, stderr: "", usage: emptyUsage(),
			messages: [{ role: "assistant", content: [{ type: "text", text: output }], stopReason: "stop" } as never],
		};
		runtime.threads.set(8, thread);
		runtime.registerRunResult(8, thread.lastResult);
		const resultRoot = join(root, "results");
		formatCompletionBlock(thread.lastResult, 2, { resultRoot });
		try {
			for (let index = 0; index < 2; index++) {
				const response = await execute(tools.get("subagent_status")!, { id: 8 });
				const [run] = response.details.runs;
				assert.equal(typeof run.resultFile, "string", "status must expose the full result's recorded path");
				assert.equal(await readFile(run.resultFile, "utf8"), output);
				assert.equal(run.cwd, process.cwd());
			}
			assert.equal((await readdir(resultRoot)).length, 1);
			assert.equal(sent.length, 0);
		} finally { await shutdown(runtime); await rm(root, { recursive: true, force: true }); }
	});

	it("returns settled evidence on exact lookup without repeating it in the run list", async () => {
		const { runtime, tools, sent } = harness();
		const thread = makeThread(9, "completed");
		thread.lastResult = {
			agent: "worker", task: thread.task, exitCode: 0, stderr: "", usage: emptyUsage(),
			messages: [{ role: "assistant", content: [{ type: "text", text: "Fixed parser. node --test test/parser.test.ts → 4 passed." }], stopReason: "stop" } as never],
		};
		runtime.threads.set(thread.id, thread);
		try {
			const status = tools.get("subagent_status")!;
			assert.doesNotMatch(resultText(await execute(status)), /4 passed/);
			const selected = resultText(await execute(status, { id: 9 }));
			assert.match(selected, /4 passed/);
			assert.equal(sent.length, 0);
		} finally { await shutdown(runtime); }
	});

	it("reads live progress without waiting for settlement, mutating the run, or delivering results", async () => {
		const { runtime, tools, sent } = harness();
		const thread = makeThread(7);
		const pending = deferred();
		thread.generationCompletion = pending.promise;
		let stops = 0;
		attachRunning(thread.control, { stop: async () => { stops++; } });
		runtime.threads.set(thread.id, thread);
		monitor.restoreRun({ id: 7, agent: "worker", task: thread.task, status: "running", elapsedMs: 1200 });
		monitor.recordToolStart(7, "read", "read src/index.ts");
		try {
			assert.ok(tools.has("subagent_status"), "the status interface must be registered");
			const response = await execute(tools.get("subagent_status")!, { id: 7 });
			const [run] = response.details.runs;
			assert.equal(run.id, 7);
			assert.equal(run.state, "running");
			assert.match(run.activity, /read src\/index.ts/);
			assert.ok(run.elapsedMs >= 1200);
			assert.equal(thread.state, "running");
			assert.equal(thread.generation, 1);
			assert.equal(thread.lifecycleVersion, 0);
			assert.equal(thread.control.getPhase(), "running");
			assert.equal(thread.task, "Implement the original objective");
			assert.equal(stops, 0);
			assert.equal(sent.length, 0);
			assert.equal(runtime.settledRuns.size, 0);
		} finally { pending.resolve(); await shutdown(runtime); }
	});

	it("keeps terminal failures queryable after monitor rows are swept and uses exact ids", async () => {
		const { runtime, tools } = harness();
		const thread = makeThread(1, "failed");
		thread.elapsedMs = 440_000;
		thread.lastResult = {
			agent: "worker", task: thread.task, runId: 1, exitCode: 17, stopReason: "error",
			errorMessage: "Subagent RPC process exited before settling (code=17).",
			messages: [], stderr: "", usage: emptyUsage(), sessionDir: "/retained/session-1",
		};
		runtime.threads.set(1, thread);
		runtime.threads.set(10, makeThread(10, "queued"));
		runtime.registerRunResult(1, thread.lastResult);
		monitor.restoreRun({ id: 1, agent: "worker", task: thread.task, status: "failed" });
		monitor.beginTurn();
		try {
			assert.ok(tools.has("subagent_status"), "the status interface must be registered");
			const response = await execute(tools.get("subagent_status")!, { id: 1 });
			assert.equal(response.details.runs.length, 1);
			const [run] = response.details.runs;
			assert.equal(run.state, "failed");
			assert.equal(run.elapsedMs, 440_000);
			assert.equal(run.exitCode, 17);
			assert.match(run.errorMessage, /code=17/);
			assert.equal(run.sessionDir, "/retained/session-1");
			assert.match(resultText(response), /code=17/);
			const all = await execute(tools.get("subagent_status")!);
			assert.deepEqual(all.details.runs.map((item: any) => item.id), [1, 10]);
		} finally { await shutdown(runtime); }
	});

	it("distinguishes queue waits, Git settlement, and recovered interrupted work", async () => {
		const { runtime, tools } = harness();
		const queued = makeThread(21, "queued");
		const settling = makeThread(22);
		settling.lifecycleOperation = "settle";
		settling.isolation = "worktree";
		runtime.threads.set(21, queued);
		runtime.threads.set(22, settling);
		runtime.threads.set(23, makeThread(23, "parked"));
		const stopping = makeThread(24, "stopped");
		stopping.retired = true;
		stopping.lifecycleOperation = "stop";
		runtime.threads.set(24, stopping);
		monitor.restoreRun({ id: 21, agent: "worker", task: queued.task, status: "queued" });
		try {
			assert.ok(tools.has("subagent_status"), "the status interface must be registered");
			const response = await execute(tools.get("subagent_status")!);
			assert.deepEqual(response.details.runs.map((run: any) => run.state), ["queued", "settling", "interrupted", "interrupting"]);
			assert.match(resultText(response), /^#21 worker · queued · \S+ — starting$/mu);
		} finally { await shutdown(runtime); }
	});
});

describe("subagent_message", () => {
	it("routes steering to the selected active run and reports acknowledgement", async () => {
		const { runtime, tools } = harness();
		const thread = makeThread(61);
		let received = "";
		attachRunning(thread.control, { stop: async () => {}, steer: async (message) => { received = message; return { disposition: "queued", acknowledgedAt: Date.now(), requestId: "steer-61" }; } });
		runtime.threads.set(61, thread);
		try {
			const response = await execute(tools.get("subagent_message")!, { id: 61, message: "Check the caller too" });
			assert.equal(received, "Check the caller too");
			assert.match(resultText(response), /Received by #61.*queued.*Model execution is not yet confirmed/u);
			assert.equal(response.details.steering.requestId, "steer-61");
			const status = await execute(tools.get("subagent_status")!, { id: 61 });
			assert.match(resultText(status), /last steering: queued.*request steer-61.*Check the caller too/u);
			const tool = tools.get("subagent_message")! as any;
			const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
			assert.match(tool.renderResult(response, { expanded: false }, theme).render(120).join("\n"), /Received by #61.*queued/u);
			const unknown = await execute(tools.get("subagent_message")!, { id: 62, message: "Check" });
			assert.equal(unknown.isError, true);
		} finally { await shutdown(runtime); }
	});

	it("does not report receipt before the child acknowledges or call a handled input queued", async () => {
		const { runtime, tools } = harness();
		const received = deferred();
		const acknowledge = deferred();
		const thread = makeThread(62);
		attachRunning(thread.control, { stop: async () => {}, steer: async () => {
			received.resolve();
			await acknowledge.promise;
			return { disposition: "handled", acknowledgedAt: Date.now(), requestId: "steer-62" };
		} });
		runtime.threads.set(62, thread);
		let returned = false;
		try {
			const pending = execute(tools.get("subagent_message")!, { id: 62, message: "Handle this input" }).then((result) => { returned = true; return result; });
			await received.promise;
			assert.equal(returned, false);
			assert.equal(thread.lastSteering, undefined);
			acknowledge.resolve();
			const result = await pending;
			assert.match(resultText(result), /Received by #62.*handled by an input hook/u);
			assert.doesNotMatch(resultText(result), /queued/u);
			assert.equal(runtime.threads.get(62)?.lastSteering?.disposition, "handled");
		} finally { acknowledge.resolve(); await shutdown(runtime); }
	});

	it("preserves the last acknowledged message when later steering is rejected", async () => {
		const { runtime, tools } = harness();
		const thread = makeThread(62);
		attachRunning(thread.control, { stop: async () => {}, steer: async () => ({ disposition: "queued", acknowledgedAt: Date.now() }) });
		runtime.threads.set(62, thread);
		try {
			const result = await execute(tools.get("subagent_message")!, { id: 62, message: "Check" });
			assert.match(resultText(result), /queued for the next steering boundary/u);
			attachRunning(thread.control, { stop: async () => {}, steer: async () => { throw new Error("child rejected message"); } });
			const rejected = await execute(tools.get("subagent_message")!, { id: 62, message: "Another check" });
			assert.equal(rejected.isError, true);
			assert.match(resultText(rejected), /child rejected message/u);
			assert.equal(thread.lastSteering?.message, "Check");
		} finally { await shutdown(runtime); }
	});

	it("copies the completed session and preserves role and workspace for the new run", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-subagents-followup-"));
		let captured: any;
		const core = { setEnvironment() {}, async startBackground(...args: any[]) { captured = args; return { runId: 77 }; } } as unknown as DispatchCore;
		const { runtime, tools } = harness(join(root, "config.json"), core);
		const source = makeThread(63, "completed");
		source.agentName = "researcher";
		source.sessionId = "test-session";
		source.sessionDir = join(root, "source");
		await mkdir(source.sessionDir);
		await writeFile(join(source.sessionDir, "2026_test-session.jsonl"), "original context");
		runtime.threads.set(63, source);
		try {
			const response = await execute(tools.get("subagent_message")!, { id: 63, message: "Find the missing evidence" });
			assert.equal(response.isError, undefined);
			assert.equal(response.details.id, 77);
			assert.equal(captured[0], "researcher");
			assert.equal(captured[1], "Follow-up to run #63:\nFind the missing evidence", "a deterministic objective keeps duplicate admission");
			assert.equal(captured[2], source.cwd);
			assert.notEqual(captured[4].resumeSession.sessionDir, source.sessionDir);
			assert.equal(await readFile(join(captured[4].resumeSession.sessionDir, "2026_test-session.jsonl"), "utf8"), "original context");
		} finally { await shutdown(runtime); await rm(root, { recursive: true, force: true }); }
	});

	for (const context of [undefined, "auto", "session"] as const) {
		it(`defaults to summary when history is unavailable; context=${context ?? "omitted"}`, async () => {
			const root = await mkdtemp(join(tmpdir(), "pi-subagents-missing-session-"));
			let captured: any;
			const core = { setEnvironment() {}, async startBackground(...args: any[]) { captured = args; return { runId: 80 }; } } as unknown as DispatchCore;
			const { runtime, tools } = harness(join(root, "config.json"), core);
			const source = makeThread(65, "completed");
			source.sessionId = "expired-session";
			source.sessionDir = join(root, "expired");
			source.lastResult = {
				agent: source.agentName, task: source.task, exitCode: 0, stderr: "", usage: emptyUsage(),
				messages: [{ role: "assistant", content: [{ type: "text", text: "Implemented the cache fix; next verify callers." }], stopReason: "stop" } as never],
			};
			runtime.threads.set(source.id, source);
			try {
				const status = await execute(tools.get("subagent_status")!, { id: source.id });
				assert.equal(status.details.runs[0].followUpContext, "summary");
				assert.match(resultText(status), /follow-up: summary/u);
				const response = await execute(tools.get("subagent_message")!, { id: source.id, message: "Verify the callers", context });
				if (context === "session") {
					assert.equal(response.isError, true);
					assert.equal(captured, undefined, "strict session continuation must never silently discard history");
					assert.match(resultText(response), /context: "auto"|context: "summary"/u);
				} else {
					assert.equal(response.isError, undefined);
					assert.equal(response.details.context, "summary");
					assert.match(response.details.fallbackReason, /session.*unavailable/iu);
					assert.match(resultText(response), /summary.*session.*unavailable/iu);
					assert.equal(captured[4].resumeSession, undefined);
					assert.equal(captured[1], "Follow-up to run #65:\nVerify the callers");
					assert.match(captured[4].stdinText, /Verify the callers[\s\S]*Implemented the cache fix/u);
				}
				assert.equal(existsSync(join(getProjectRoot(join(root, "config.json"), source.cwd), "sessions")), false);
			} finally { await shutdown(runtime); await rm(root, { recursive: true, force: true }); }
		});
	}

	it("falls back once when the retained file disappears during copying", async (t) => {
		const root = await mkdtemp(join(tmpdir(), "pi-subagents-copy-race-"));
		let starts = 0;
		const core = { setEnvironment() {}, async startBackground(...args: any[]) {
			starts++;
			assert.equal(args[4].resumeSession, undefined);
			return { runId: 81 };
		} } as unknown as DispatchCore;
		const { runtime, tools } = harness(join(root, "config.json"), core);
		const source = makeThread(66, "completed");
		source.sessionDir = join(root, "source");
		source.sessionId = "copy-race";
		await mkdir(source.sessionDir);
		const sessionFile = join(source.sessionDir, "2026_copy-race.jsonl");
		await writeFile(sessionFile, "retained history");
		runtime.threads.set(source.id, source);
		const originalCopy = fsPromises.copyFile;
		t.mock.method(fsPromises, "copyFile", async (...args: Parameters<typeof fsPromises.copyFile>) => {
			await rm(sessionFile);
			return originalCopy(...args);
		});
		syncBuiltinESMExports();
		try {
			const response = await execute(tools.get("subagent_message")!, { id: source.id, message: "Continue" });
			assert.equal(response.isError, undefined);
			assert.equal(response.details.context, "summary");
			assert.equal(starts, 1);
			assert.deepEqual(await readdir(join(getProjectRoot(join(root, "config.json"), source.cwd), "sessions")), []);
		} finally {
			t.mock.restoreAll(); syncBuiltinESMExports();
			await shutdown(runtime); await rm(root, { recursive: true, force: true });
		}
	});

	it("does not dispatch a summary if the source is retired while preparing the follow-up", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-subagents-retired-followup-"));
		const source = makeThread(67, "completed");
		let starts = 0;
		const core = { setEnvironment() { source.retired = true; }, async startBackground() { starts++; return { runId: 82 }; } } as unknown as DispatchCore;
		const { runtime, tools } = harness(join(root, "config.json"), core);
		runtime.threads.set(source.id, source);
		try {
			const response = await execute(tools.get("subagent_message")!, { id: source.id, message: "Continue", context: "summary" });
			assert.equal(response.isError, true);
			assert.equal(starts, 0);
		} finally { await shutdown(runtime); await rm(root, { recursive: true, force: true }); }
	});

	it("does not start a follow-up after the parent call is cancelled", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-subagents-cancelled-followup-"));
		const abort = new AbortController();
		let starts = 0;
		const core = { setEnvironment() { abort.abort(); }, async startBackground() { starts++; return { runId: 83 }; } } as unknown as DispatchCore;
		const { runtime, tools } = harness(join(root, "config.json"), core);
		runtime.threads.set(68, makeThread(68, "completed"));
		try {
			const response = await execute(tools.get("subagent_message")!, { id: 68, message: "Continue" }, abort.signal);
			assert.equal(response.isError, true);
			assert.match(resultText(response), /cancelled/iu);
			assert.equal(starts, 0);
		} finally { await shutdown(runtime); await rm(root, { recursive: true, force: true }); }
	});

	it("gives recovery guidance for interrupted and failed runs without waiting or restarting", async () => {
		const { runtime, tools } = harness();
		try {
			for (const state of ["parked", "failed"] as const) {
				runtime.threads.set(69, makeThread(69, state));
				const response = await execute(tools.get("subagent_message")!, { id: 69, message: "Continue" });
				assert.equal(response.isError, true);
				assert.match(resultText(response), /subagent_status.*unfinished work in main/u);
				assert.doesNotMatch(resultText(response), /wait/u);
			}
		} finally { await shutdown(runtime); }
	});

	it("sends evidence to a summary child and rejects a second launch of the objective with session history", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-subagents-summary-"));
		const { runtime, tools } = harness(join(root, "config.json"));
		const source = makeThread(64, "completed");
		source.cwd = source.executionCwd = root;
		source.sessionId = "summary-source";
		source.sessionDir = join(root, "source");
		await mkdir(source.sessionDir);
		await writeFile(join(source.sessionDir, "2026_summary-source.jsonl"), "context");
		source.lastResult = {
			agent: "worker", task: source.task, exitCode: 0, stderr: "", usage: emptyUsage(),
			messages: [
				{ role: "assistant", content: [{ type: "text", text: "Found a race in src/cache.ts" }, { type: "toolCall", name: "read", arguments: { path: "src/cache.ts" } }], stopReason: "stop" } as never,
			],
		};
		runtime.threads.set(64, source);
		const previousScript = process.argv[1];
		try {
			const child = join(root, "echo-brief.mjs");
			await writeFile(child, `
import { createInterface } from "node:readline";
const send = (event) => process.stdout.write(JSON.stringify(event) + "\\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (request.type !== "prompt") return;
  send({ type: "agent_start" });
  send({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: request.message }], stopReason: "stop" } });
  send({ type: "agent_settled" });
});`);
			process.argv[1] = child;
			const tool = tools.get("subagent_message")!;
			const request = { id: 64, message: "Now add the regression test", wait: true };
			const response = await execute(tool, { ...request, context: "summary" });
			assert.equal(response.isError, undefined, resultText(response));
			const followUp = runtime.threads.get(response.details.id)!;
			assert.equal(followUp.task, "Follow-up to run #64:\nNow add the regression test");
			assert.equal(followUp.lastResult?.task, followUp.task);
			assert.match(resultText(response), /Now add the regression test[\s\S]*Found a race in src\/cache\.ts/u);
			assert.match(resultText(response), /Files referenced in earlier tool calls:\n- src\/cache\.ts/u);
			const sessions = join(getProjectRoot(runtime.configPath, root), "sessions");
			const beforeRetry = await readdir(sessions);
			const retry = await execute(tool, { ...request, context: "session" });
			assert.equal(retry.isError, true);
			assert.ok(resultText(retry).includes(`Run #${followUp.id} (worker) already owns this logical phase`));
			assert.equal(runtime.threads.size, 2);
			assert.deepEqual(await readdir(sessions), beforeRetry, "the rejected session copy must be reclaimed");
		} finally {
			process.argv[1] = previousScript;
			await runtime.shutdown();
			monitor.clear();
			await rm(root, { recursive: true, force: true });
		}
	});

	it("allows steering an active run at 5/5 capacity while blocking a 6th follow-up continuation", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-subagents-followup-cap-"));
		let starts = 0;
		const core = { setEnvironment() {}, async startBackground() { starts++; return { runId: 90 }; } } as unknown as DispatchCore;
		const { runtime, tools } = harness(join(root, "config.json"), core);
		for (const id of [1, 2, 3, 4, 5]) {
			const active = makeThread(id, "running");
			attachRunning(active.control, { stop: async () => {}, steer: async () => ({ disposition: "queued", acknowledgedAt: Date.now(), requestId: `steer-${id}` }) });
			runtime.threads.set(id, active);
		}
		const completed = makeThread(6, "completed");
		completed.sessionId = "retained";
		completed.sessionDir = join(root, "source");
		await mkdir(completed.sessionDir);
		await writeFile(join(completed.sessionDir, "2026_retained.jsonl"), "history");
		runtime.threads.set(6, completed);
		try {
			const steered = await execute(tools.get("subagent_message")!, { id: 3, message: "Refine boundary" });
			assert.equal(steered.isError, undefined);
			assert.match(resultText(steered), /Received by #3/u);

			const blocked = await execute(tools.get("subagent_message")!, { id: 6, message: "Spawn sixth run" });
			assert.equal(blocked.isError, true);
			assert.match(resultText(blocked), /concurrency limit of 5 active subagents is full/u);
			assert.equal(starts, 0);
			assert.equal(existsSync(join(getProjectRoot(join(root, "config.json"), completed.cwd), "sessions")), false, "rejected follow-up must not copy session files");
		} finally { await shutdown(runtime); await rm(root, { recursive: true, force: true }); }
	});
});

describe("subagent_stop", () => {
	it("stops an active attempt and delivers its partial result once without inventing shared-checkout integration work", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-subagents-stop-"));
		const { runtime, tools, sent } = harness(join(root, "config.json"));
		const thread = makeThread(31);
		thread.lastResult = {
			agent: "worker", task: thread.task, exitCode: 1,
			messages: [{ role: "assistant", content: [{ type: "text", text: "Partial edits are in src/index.ts" }], stopReason: "toolUse" } as never],
			stderr: "", usage: emptyUsage(),
		};
		let stops = 0;
		attachRunning(thread.control, { stop: async () => { stops++; } });
		runtime.threads.set(31, thread);
		monitor.restoreRun({ id: 31, agent: "worker", task: thread.task, status: "running" });
		try {
			const response = await execute(tools.get("subagent_stop")!, { id: "31" });
			assert.equal(thread.state, "stopped");
			assert.equal(thread.retired, true);
			assert.equal(monitor.findRun(31), undefined);
			assert.equal(stops, 1);
			assert.equal(runtime.settledRuns.get(31)?.stopReason, "aborted");
			assert.match(JSON.stringify(sent), /Partial edits are in src\/index.ts/);
			assert.equal(sent.length, 1);
			assert.doesNotMatch(resultText(response), /Integration is still settling/);
			await execute(tools.get("subagent_stop")!, { id: "31" });
			assert.equal(sent.length, 1, "retiring the same run twice must not redeliver its result");
		} finally { await shutdown(runtime); await rm(root, { recursive: true, force: true }); }
	});

	it("keeps per-model usage totals when stopped runs are delivered together", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-subagents-stop-models-"));
		const { runtime, tools, sent } = harness(join(root, "config.json"));
		for (const [id, model] of [[51, "test/alpha"], [52, "test/beta"]] as const) {
			const thread = makeThread(id);
			thread.lastResult = {
				agent: "worker", task: thread.task, exitCode: 1, messages: [], stderr: "", model,
				usage: { ...emptyUsage(), input: 1_000, cost: 0.01 },
			};
			attachRunning(thread.control, { stop: async () => {} });
			runtime.threads.set(id, thread);
		}
		try {
			await execute(tools.get("subagent_stop")!, { all: true });
			assert.equal(sent.length, 1);
			const content = (sent[0] as { content: string }).content;
			assert.match(content, /Totals: 2 runs · test\/alpha: .* · test\/beta: /u);
			assert.doesNotMatch(content, /unknown model/u);
		} finally { await shutdown(runtime); await rm(root, { recursive: true, force: true }); }
	});

	it("claims and interrupts all active runs before waiting for any one to quiesce", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-subagents-stop-all-"));
		const { runtime, tools } = harness(join(root, "config.json"));
		const release = deferred();
		const started = deferred();
		const order: number[] = [];
		const first = makeThread(41);
		const second = makeThread(42);
		attachRunning(first.control, { stop: async () => { order.push(41); await release.promise; } });
		attachRunning(second.control, { stop: async () => { order.push(42); started.resolve(); } });
		runtime.threads.set(41, first);
		runtime.threads.set(42, second);
		try {
			const stopping = execute(tools.get("subagent_stop")!, { all: true, id: "" });
			await started.promise;
			assert.deepEqual(order, [41, 42]);
			assert.equal(first.retired, true);
			assert.equal(second.retired, true);
			release.resolve();
			await stopping;
			assert.equal(runtime.settledRuns.size, 2);
		} finally { release.resolve(); await shutdown(runtime); await rm(root, { recursive: true, force: true }); }
	});

	it("requires an exact numeric id and does not prefix-match other runs", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-subagents-stop-exact-"));
		const { runtime, tools, sent } = harness(join(root, "config.json"));
		const thread12 = makeThread(12);
		let stops12 = 0;
		attachRunning(thread12.control, { stop: async () => { stops12++; } });
		runtime.threads.set(12, thread12);
		try {
			const miss = await execute(tools.get("subagent_stop")!, { id: "1" });
			assert.match(resultText(miss), /No subagent thread matches "1"/u);
			assert.equal(thread12.state, "running");
			assert.equal(thread12.retired, undefined);
			assert.equal(stops12, 0);
			assert.equal(sent.length, 0);

			const hit = await execute(tools.get("subagent_stop")!, { id: " #12 " });
			assert.match(resultText(hit), /Stopped 1 thread: #12/u);
			assert.equal(thread12.state, "stopped");
			assert.equal(thread12.retired, true);
			assert.equal(stops12, 1);
		} finally { await shutdown(runtime); await rm(root, { recursive: true, force: true }); }
	});
});
