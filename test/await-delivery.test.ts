import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { registerSubagentTool } from "../src/delegation/dispatch.ts";
import { emptyUsage, RunControl, type RunResult } from "../src/execution/run-control.ts";
import type { DispatchCore } from "../src/lifecycle/dispatch-core.ts";
import { createRuntime, type SubagentThread } from "../src/lifecycle/runtime.ts";
import { registerLookupTools } from "../src/lifecycle/tools.ts";
import { failedStartResult } from "../src/presentation/format.ts";
import { monitor } from "../src/presentation/monitor.ts";

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => { resolve = done; });
	return { promise, resolve };
}

const theme = { fg: (_name: string, value: string) => value, bold: (value: string) => value } as Theme;

async function harness(unavailableTask?: string) {
	const root = await mkdtemp(join(tmpdir(), "pi-await-delivery-"));
	const tools = new Map<string, any>();
	const messages: any[] = [];
	const stopSummaries: string[][] = [];
	const started = deferred();
	const pi = {
		on() {}, getActiveTools: () => ["read"], getAllTools: () => [],
		registerTool: (tool: any) => tools.set(tool.name, tool),
		sendMessage: (message: any) => messages.push(message),
		appendEntry: (_type: string, stats: string[]) => stopSummaries.push(stats),
	} as unknown as ExtensionAPI;
	const runtime = createRuntime(pi, join(root, "config.json"));
	const ids: number[] = [];
	const routes: string[] = [];
	let stops = 0;
	const thread = (id: number, task: string, state: "running" | "completed", cwd = root): SubagentThread => ({
		id, generation: 1, agentName: "researcher", task, cwd, executionCwd: cwd,
		isolation: "shared", state, control: new RunControl(task),
		generationCompletion: Promise.resolve(), lifecycleVersion: 0, elapsedMs: 0,
		finalizeIsolation: async () => undefined,
	});
	runtime.threads.set(900, thread(900, "Earlier source research", "completed"));
	const core = {
		setEnvironment() {},
		makeDetails: (mode: string) => (results: RunResult[]) => ({ mode, results }),
		async startBackground(agent: string, task: string, cwd: string, _isolation: string, options: any) {
			if (task === unavailableTask) return failedStartResult(agent, task, "Configured model is unavailable");
			const id = monitor.addRun(agent, task);
			ids.push(id);
			routes.push(options.deliveryRoute);
			runtime.claimRunDelivery(id, options.deliveryRoute);
			const current = thread(id, task, "running", cwd);
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
		const task = name === "subagent" ? { agent: "researcher", task: "Verify caller evidence" } : { id: 900, message: "Verify caller evidence", context: "summary" };
		return tools.get(name).execute("call", { ...task, ...params }, signal, (update: any) => updates.push(update), {
			cwd: root, hasUI, mode: hasUI ? "tui" : "print", ui: { notify() {} },
		});
	};
	return {
		root, runtime, messages, stopSummaries, ids, routes, started, finish, invoke, stops: () => stops,
		renderDispatchResult: (result: unknown, options: { expanded: boolean; isPartial: boolean }) =>
			tools.get("subagent").renderResult(result, options, theme).render(120).join("\n"),
		renderDispatchCall: (params: unknown, expanded = false, width = Math.max(120, root.length + 80)) =>
			tools.get("subagent").renderCall(params, theme, { expanded, cwd: root }).render(width)
				.map((line: string) => line.trimEnd()).join("\n"),
		async cleanup() { await runtime.shutdown(); monitor.clear(); await rm(root, { recursive: true, force: true }); },
	};
}

it("returns final states and failure evidence for an awaited parallel batch", async () => {
	const h = await harness();
	try {
		const updates: unknown[] = [];
		const pending = h.invoke("subagent", { agent: undefined, task: undefined, wait: true, tasks: [
			{ agent: "researcher", task: "Inspect first caller" },
			{ agent: "researcher", task: "Inspect second caller" },
		] }, true, undefined, updates);
		await h.started.promise;
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.equal(h.ids.length, 2);
		monitor.setIsolation(h.ids[0]!, "worktree", "finalizing");
		const progress = h.renderDispatchResult(updates.at(-1), { expanded: false, isPartial: true });
		assert.match(progress, /Waiting in-turn on 2 runs.*#\d+ applying.*#\d+ running/u);
		monitor.setStatus(h.ids[0]!, "interrupting");
		assert.match(h.renderDispatchResult(updates.at(-1), { expanded: false, isPartial: true }), /#\d+ interrupting.*#\d+ running/u);
		h.finish(h.ids[0]!);
		h.finish(h.ids[1]!, true);
		const result = await pending;
		assert.equal(result.isError, true);
		assert.deepEqual(result.details.results.map((entry: RunResult) => entry.exitCode), [0, 1]);
		assert.match(result.content[0].text, /Caller verification failed/u);
		assert.match(h.renderDispatchResult(result, { expanded: false, isPartial: false }), /failed · Caller verification failed/u);
		assert.match(h.renderDispatchResult(result, { expanded: true, isPartial: false }), /Verified caller evidence/u);
		assert.equal(h.messages.length, 0);
	} finally { await h.cleanup(); }
});

it("applies a batch cwd and keeps accepted run IDs visible beside launch failures", async () => {
	const h = await harness("Use offline model");
	try {
		const tasks = [
			{ agent: "researcher", task: "Inspect package" },
			{ agent: "worker", task: "Use offline model" },
			{ agent: "researcher", task: "Inspect package", cwd: "nested" },
		];
		const result = await h.invoke("subagent", { agent: undefined, task: undefined, cwd: "packages", tasks }, true);
		assert.deepEqual(h.ids.map((id) => h.runtime.threads.get(id)?.cwd), [join(h.root, "packages"), join(h.root, "packages", "nested")]);
		assert.match(result.content[0].text, /^Accepted 2 subagent runs/u);
		assert.match(result.content[0].text, /Dispatch slots: 3\/5 free/u);
		for (const id of h.ids) assert.ok(result.content[0].text.includes(`#${id} researcher`));
		assert.match(result.content[0].text, /tasks\[1\] \(worker\) failed to start/u);
		assert.match(h.renderDispatchResult(result, { expanded: false, isPartial: false }), /worker · not started · Configured model is unavailable/u);
	} finally { await h.cleanup(); }
});

it("expands the original brief and the directory each task will use, including while arguments stream", async () => {
	const h = await harness();
	try {
		const brief = "Fix the cache in src/cache.ts.\nKeep unrelated keys.\nRun the regression suite.";
		const args = { cwd: "packages", tasks: [
			{ agent: "worker", task: brief, cwd: "api" },
			{ agent: "researcher", task: "\x1b[31mTrace the public caller.\x1b[0m" },
		] };
		const preview = h.renderDispatchCall(args);
		assert.doesNotMatch(preview, /Run the regression suite/u);
		const narrow = h.renderDispatchCall({ tasks: [
			{ agent: "researcher", task: "确认哪些入口会读取派遣结果，并列出每个入口所在的文件和调用位置。" },
			{ agent: "worker", task: brief },
		] }, false, 42).split("\n");
		assert.equal(narrow.length, 3, "keep one preview row per task");
		assert.match(narrow[1]!, /researcher.*确认/u);
		assert.match(narrow[2]!, /worker/u);
		const expanded = h.renderDispatchCall(args, true);
		assert.ok(expanded.includes(join(h.root, "packages", "api")));
		assert.ok(expanded.includes(join(h.root, "packages") + "\n"));
		assert.match(expanded, /auto worktree[\s\S]*Fix the cache in src\/cache\.ts\.\n\s+Keep unrelated keys\.\n\s+Run the regression suite\./u);
		assert.doesNotMatch(expanded, /\x1b/u);
		const single = h.renderDispatchCall({ agent: "worker", task: brief, cwd: "packages", isolation: "shared" }, true);
		assert.ok(single.includes(join(h.root, "packages") + "\n"));
		assert.match(single, /worker \[shared\]/u);
		for (const open of [false, true]) {
			assert.match(h.renderDispatchCall({ tasks: [{ agent: "worker" }, {}] }, open, 42), /parallel \(2\)/u);
		}
	} finally { await h.cleanup(); }
});

it("rejects ambiguous batches before allocation and renders the error text", async () => {
	const h = await harness();
	try {
		const tasks = Array.from({ length: 5 }, (_, index) => ({ agent: "researcher", task: `Inspect module ${index + 1}` }));
		assert.match(h.renderDispatchCall({ tasks }), /Inspect module 5/u);
		await assert.rejects(h.invoke("subagent", { tasks, task: undefined }, true), /omit top-level agent and task/u);
		await assert.rejects(h.invoke("subagent", { tasks: [] }, true), /non-empty tasks array/u);
		assert.deepEqual(h.ids, []);
		const error = { content: [{ type: "text", text: "No runs were started." }] };
		assert.match(h.renderDispatchResult(error, { expanded: false, isPartial: false }), /No runs were started/u);
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
				assert.match(result.content[0].text, /Dispatch slots: 4\/5 free/u);
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
				assert.equal(h.stopSummaries[0]?.[0], "Stopped 1 subagent run");
				assert.equal(h.messages.find((message) => message.customType === "subagent-cancelled")?.display, false);
			} finally { await h.cleanup(); }
		});
	});
}
