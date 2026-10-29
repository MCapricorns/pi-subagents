import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerSubagentTool } from "../src/delegation/dispatch.ts";
import { emptyUsage, RunControl, type RunResult } from "../src/execution/run-control.ts";
import type { DispatchCore } from "../src/lifecycle/dispatch-core.ts";
import { createRuntime, type SubagentThread } from "../src/lifecycle/runtime.ts";
import { registerLookupTools } from "../src/lifecycle/tools.ts";
import { monitor } from "../src/presentation/monitor.ts";

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => { resolve = done; });
	return { promise, resolve };
}

async function harness() {
	const root = await mkdtemp(join(tmpdir(), "pi-await-delivery-"));
	const tools = new Map<string, any>();
	const messages: any[] = [];
	const started = deferred();
	const pi = {
		on() {}, getActiveTools: () => ["read"], getAllTools: () => [],
		registerTool: (tool: any) => tools.set(tool.name, tool),
		sendMessage: (message: any) => messages.push(message),
	} as unknown as ExtensionAPI;
	const runtime = createRuntime(pi, join(root, "config.json"));
	const ids: number[] = [];
	const routes: string[] = [];
	let stops = 0;
	const thread = (id: number, task: string, state: "running" | "completed"): SubagentThread => ({
		id, generation: 1, agentName: "scout", task, cwd: root, executionCwd: root,
		isolation: "shared", state, control: new RunControl(task, 1),
		generationCompletion: Promise.resolve(), lifecycleVersion: 0, elapsedMs: 0,
		finalizeIsolation: async () => undefined,
	});
	runtime.threads.set(900, thread(900, "Earlier source research", "completed"));
	const core = {
		setEnvironment() {},
		makeDetails: (mode: string) => (results: RunResult[]) => ({ mode, results }),
		async startBackground(agent: string, task: string, _cwd: string, _isolation: string, options: any) {
			const id = monitor.addRun(agent, task);
			ids.push(id);
			routes.push(options.deliveryRoute);
			runtime.claimRunDelivery(id, options.deliveryRoute);
			const current = thread(id, task, "running");
			const token = current.control.beginAttempt();
			current.control.attach(token, { stop: async () => { stops++; } });
			current.control.updateAttemptPhase(token, "running");
			runtime.threads.set(id, current);
			monitor.setStatus(id, "running");
			started.resolve();
			return { agent, task, runId: id, exitCode: -1, messages: [], stderr: "", usage: emptyUsage() };
		},
	} as unknown as DispatchCore;
	registerSubagentTool(pi, runtime, core);
	registerLookupTools(pi, runtime, core);
	const finish = (id: number, failed = false) => {
		const current = runtime.threads.get(id)!;
		const result: RunResult = {
			agent: current.agentName, task: current.task, runId: id, exitCode: failed ? 1 : 0,
			messages: [{ role: "assistant", content: [{ type: "text", text: "Verified caller evidence" }], stopReason: failed ? "error" : "stop" } as never],
			stderr: "", usage: emptyUsage(), ...(failed ? { errorMessage: "Caller verification failed" } : {}),
		};
		current.state = failed ? "failed" : "completed";
		current.lastResult = result;
		current.control.markSettled();
		runtime.registerRunResult(id, result);
		monitor.setStatus(id, failed ? "failed" : "done");
		runtime.publishRunCompletion(id, { agent: current.agentName, block: "Verified caller evidence" }, true);
	};
	const invoke = (name: string, params: Record<string, unknown>, hasUI: boolean, signal = new AbortController().signal, updates: any[] = []) => {
		const task = name === "subagent" ? { agent: "scout", task: "Verify caller evidence" } : { id: 900, message: "Verify caller evidence", context: "summary" };
		return tools.get(name).execute("call", { ...task, ...params }, signal, (update: any) => updates.push(update), {
			cwd: root, hasUI, ui: { notify() {} },
		});
	};
	return {
		runtime, messages, ids, routes, started, finish, invoke, stops: () => stops,
		async cleanup() { await runtime.shutdown(); monitor.clear(); await rm(root, { recursive: true, force: true }); },
	};
}

it("returns final states and failure evidence for an awaited parallel batch", async () => {
	const h = await harness();
	try {
		const pending = h.invoke("subagent", { agent: undefined, task: undefined, wait: true, tasks: [
			{ agent: "scout", task: "Inspect first caller" },
			{ agent: "scout", task: "Inspect second caller" },
		] }, true);
		await h.started.promise;
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.equal(h.ids.length, 2);
		h.finish(h.ids[0]!);
		h.finish(h.ids[1]!, true);
		const result = await pending;
		assert.equal(result.isError, true);
		assert.deepEqual(result.details.results.map((entry: RunResult) => entry.exitCode), [0, 1]);
		assert.match(result.content[0].text, /Caller verification failed/u);
		assert.equal(h.messages.length, 0);
	} finally { await h.cleanup(); }
});

for (const name of ["subagent", "subagent_message"]) {
	describe(name + " awaited delivery", () => {
		for (const mode of ["explicit", "print-default"] as const) {
			it("returns final evidence once after settlement: " + mode, async () => {
				const h = await harness();
				try {
					const updates: any[] = [];
					let returned = false;
					const pending = h.invoke(name, mode === "explicit" ? { wait: true } : {}, mode === "explicit", undefined, updates)
						.then((result: any) => { returned = true; return result; });
					await h.started.promise;
					await new Promise<void>((resolve) => setImmediate(resolve));
					assert.equal(returned, false);
					assert.deepEqual(h.routes, ["await"]);
					assert.ok(updates.length > 0);
					h.finish(h.ids[0]!);
					const result = await pending;
					assert.match(result.content[0].text, /Verified caller evidence/u);
					assert.equal(result.isError, undefined);
					if (name === "subagent") assert.equal(result.details.results[0].exitCode, 0);
					assert.equal(h.messages.length, 0);
					assert.equal(h.runtime.settledListeners.size, 0);
				} finally { await h.cleanup(); }
			});
		}

		it("honors explicit background delivery in a print session", async () => {
			const h = await harness();
			try {
				const result = await h.invoke(name, { wait: false }, false);
				assert.equal(result.isError, undefined);
				assert.deepEqual(h.routes, ["background"]);
				assert.equal(h.runtime.settledRuns.size, 0);
				h.finish(h.ids[0]!);
				assert.equal(h.messages.filter((message) => message.customType === "subagent-result").length, 1);
			} finally { await h.cleanup(); }
		});

		it("marks a failed awaited run as an error with its final evidence", async () => {
			const h = await harness();
			try {
				const pending = h.invoke(name, { wait: true }, true);
				await h.started.promise;
				h.finish(h.ids[0]!, true);
				const result = await pending;
				assert.equal(result.isError, true);
				assert.match(result.content[0].text, /Caller verification failed/u);
				if (name === "subagent") assert.equal(result.details.results[0].exitCode, 1);
				assert.equal(h.messages.length, 0);
			} finally { await h.cleanup(); }
		});

		it("does not dispatch when the parent signal is already cancelled", async () => {
			const h = await harness();
			const abort = new AbortController();
			abort.abort();
			try {
				if (name === "subagent") {
					await assert.rejects(h.invoke(name, { wait: true }, true, abort.signal), /cancelled before any run started/u);
				} else {
					assert.equal((await h.invoke(name, { wait: true }, true, abort.signal)).isError, true);
				}
				assert.equal(h.ids.length, 0);
			} finally { await h.cleanup(); }
		});

		it("cancels its wait and child without a background wake-up", async () => {
			const h = await harness();
			const abort = new AbortController();
			try {
				const pending = h.invoke(name, { wait: true }, true, abort.signal);
				await h.started.promise;
				abort.abort();
				const result = await pending;
				assert.equal(result.isError, true);
				assert.equal(h.stops(), 1);
				assert.equal(h.runtime.settledListeners.size, 0);
				assert.equal(h.messages.filter((message) => message.customType === "subagent-result").length, 0);
			} finally { await h.cleanup(); }
		});
	});
}
