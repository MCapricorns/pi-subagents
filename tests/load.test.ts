import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BackgroundTaskQueue, type BackgroundTask } from "../src/background.ts";
import register, { matchRunIds } from "../src/index.ts";
import { monitor } from "../src/monitor.ts";
import { persistRecoveryRecords } from "../src/recovery.ts";
import * as spawn from "../src/spawn.ts";
import { fakeRpcScript } from "./fake-rpc.ts";
import { captureEnqueue, fakeChild, makeStub, runTool, shutdownExtension, waitFor } from "./test-helpers.ts";

function executionContext(overrides: { uiNotify?: ReturnType<typeof vi.fn> } = {}): any {
	return {
		cwd: process.cwd(),
		model: undefined,
		scopedModels: [],
		modelRegistry: { getAvailable: () => [] },
		ui: { notify: overrides.uiNotify ?? vi.fn() },
	};
}

function renderToolResult(tool: any, result: any): string {
	const theme = {
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
	};
	return tool.renderResult(result, {}, theme).render(240).join("\n");
}

function configureEnabledAgents(enabledAgents: string[], extra: Record<string, unknown> = {}): void {
	if (!testAgentDir) throw new Error("test agent directory was not initialized");
	writeFileSync(join(testAgentDir, "pi-subagents.json"), JSON.stringify({
		enabledAgents,
		announcedFeatures: ["cleanerDefaulted", "documenterDefaulted"],
		...extra,
	}), "utf8");
}

let savedDepth: string | undefined;
let savedAgentDir: string | undefined;
let testAgentDir: string | undefined;

beforeEach(() => {
	savedDepth = process.env.PI_SUBAGENT_DEPTH;
	savedAgentDir = process.env.PI_CODING_AGENT_DIR;
	// The suite must never inherit the runner's own sub-agent depth: this test
	// process can itself be a pi sub-agent child (the parent pi sets
	// PI_SUBAGENT_DEPTH in the child env), which would trip the recursion guard
	// and register nothing. Tests that need a depth set it explicitly.
	delete process.env.PI_SUBAGENT_DEPTH;
	// Isolate config + user agents from the real home directory.
	testAgentDir = mkdtempSync(join(tmpdir(), "pi-subagents-load-"));
	process.env.PI_CODING_AGENT_DIR = testAgentDir;
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	for (const run of [...monitor.getRuns()]) monitor.removeRun(run.id);
	if (savedDepth === undefined) delete process.env.PI_SUBAGENT_DEPTH;
	else process.env.PI_SUBAGENT_DEPTH = savedDepth;
	if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
	if (testAgentDir) rmSync(testAgentDir, { recursive: true, force: true });
	testAgentDir = undefined;
});

describe("extension registration", () => {
	it("registers the subagent tool, setup command, and injection hook", () => {
		const stub = makeStub();
		register(stub.api);
		expect(stub.tools.map((t) => t.name)).toContain("subagent");
		expect(stub.tools.map((t) => t.name)).toContain("subagent_control");
		expect(stub.commands).toContain("subagents-setup");
		expect(stub.commands).not.toContain("subagents-inspect");
		expect(typeof stub.hooks["before_agent_start"]).toBe("function");

		const tool = stub.tools.find((t) => t.name === "subagent");
		expect(tool.promptGuidelines).toBeUndefined();
		expect(tool.description).toContain("fan-out breadth is yours — extra tasks queue for the next free process slot");
		expect(tool.description).toContain("explorer for broad read-only reconnaissance (a retrieval index, never a gate)");
		expect(tool.description).toContain("cleaner as a separate explicitly authorized cleanup/removal/simplification/deduplication entry");
		expect(tool.description).toContain("documenter for explicit docs/comments work or conditional final diff sync");
		expect(tool.description).toContain("reviewer for generic read-only assessments and independent code gates");
		expect(tool.description).toContain("resolve the findings yourself (fix inline or dispatch a briefed worker) without waiting for the user");
		expect(tool.description).toContain("top-level documenter delivers directly");
		expect(tool.description).toContain("DOCUMENTATION: NEEDED");
		expect(tool.description).toContain("do not poll");
		expect(tool.description).toContain("continues the retained session on the current main model");
		expect(tool.promptSnippet).toContain("results resume automatically");
		expect(`${tool.description}\n${tool.promptSnippet}`).not.toMatch(/[\u4e00-\u9fff]/u);
		expect(tool.parameters.properties.task).toMatchObject({ minLength: 1, pattern: "\\S" });
		expect(tool.parameters.properties.tasks.items.properties.task).toMatchObject({ minLength: 1, pattern: "\\S" });
		expect(tool.parameters.properties.isolation).toBeDefined();
		expect(tool.parameters.properties.tasks.items.properties.isolation).toBeDefined();
		const control = stub.tools.find((t) => t.name === "subagent_control");
		expect(control.promptSnippet).toContain("Resume a parked or settled subagent thread");
	});

	it("wires recovery, widget install, and config migration through session_start", async () => {
		if (!testAgentDir) throw new Error("test agent directory was not initialized");
		const configPath = join(testAgentDir, "pi-subagents.json");
		const patchPath = join(testAgentDir, "retained.patch");
		writeFileSync(configPath, JSON.stringify({
			enabledAgents: ["explorer", "worker", "reviewer"],
		}), "utf8");
		writeFileSync(patchPath, "patch", "utf8");
		await persistRecoveryRecords(configPath, [{
			runId: 41,
			createdAt: 1,
			integrated: false,
			patchPath,
			error: "integration conflict",
		}]);

		const stub = makeStub();
		register(stub.api);
		const notify = vi.fn();
		const setWidget = vi.fn();
		const context = { mode: "tui", hasUI: true, ui: { notify, setWidget } };
		expect(typeof stub.hooks["session_start"]).toBe("function");
		await stub.hooks["session_start"]({}, context);

		expect(setWidget).toHaveBeenCalledWith("pi-subagents", expect.any(Function), { placement: "aboveEditor" });
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("recovery for run #41"), "error");
		expect(notify.mock.calls.some((call) => call[1] === "info")).toBe(false);
		const savedConfig = JSON.parse(readFileSync(configPath, "utf8"));
		expect(savedConfig.enabledAgents).toEqual(["explorer", "worker", "reviewer"]);

		// Recovery remains visible while its artifact exists; later session starts
		// add no informational notices.
		notify.mockClear();
		await stub.hooks["session_start"]({}, context);
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("recovery for run #41"), "error");
		expect(notify.mock.calls.some((call) => call[1] === "info")).toBe(false);
	});

	it("runs recovery but skips the widget outside TUI mode", async () => {
		if (!testAgentDir) throw new Error("test agent directory was not initialized");
		const configPath = join(testAgentDir, "pi-subagents.json");
		const patchPath = join(testAgentDir, "non-tui-retained.patch");
		writeFileSync(configPath, JSON.stringify({}), "utf8");
		writeFileSync(patchPath, "patch", "utf8");
		await persistRecoveryRecords(configPath, [{
			runId: 42,
			createdAt: 1,
			integrated: false,
			patchPath,
		}]);

		const stub = makeStub();
		register(stub.api);
		const notify = vi.fn();
		await stub.hooks["session_start"]({}, { mode: "rpc", hasUI: true, ui: { notify } });

		expect(notify).toHaveBeenCalledWith(expect.stringContaining("recovery for run #42"), "error");
		expect(notify.mock.calls.some((call) => call[1] === "info")).toBe(false);
	});

	it("keeps available agent model overrides and drops stale ones at session start", async () => {
		if (!testAgentDir) throw new Error("test agent directory was not initialized");
		const configPath = join(testAgentDir, "pi-subagents.json");
		writeFileSync(configPath, JSON.stringify({
			enabledAgents: ["explorer", "worker", "reviewer"],
			agentModels: {
				worker: "gone/old-model",
				reviewer: "live/current-model",
			},
			agentThinkingLevels: { reviewer: "low" },
		}), "utf8");

		const stub = makeStub();
		register(stub.api);
		const notify = vi.fn();
		const setWidget = vi.fn();
		const context = {
			mode: "tui",
			hasUI: true,
			ui: { notify, setWidget },
			model: { provider: "live", id: "current-model" },
			modelRegistry: { getAvailable: () => [{ provider: "live", id: "current-model" }] },
		};
		await stub.hooks["session_start"]({}, context);

		expect(notify).toHaveBeenCalledWith(
			"pi-subagents: removed stale agent model overrides that are no longer available (worker: gone/old-model). Those agents now follow the current main model; run /subagents-setup to re-pick.",
			"warning",
		);
		const savedConfig = JSON.parse(readFileSync(configPath, "utf8"));
		expect(savedConfig.agentModels).toEqual({ reviewer: "live/current-model" });
		expect(savedConfig.agentThinkingLevels).toEqual({ reviewer: "low" });

		// The stale override is gone from disk, so the notice never repeats.
		notify.mockClear();
		await stub.hooks["session_start"]({}, context);
		expect(notify).not.toHaveBeenCalledWith(expect.stringContaining("stale agent model"), "warning");
	});

	it("does not register the tool inside any child sub-agent process", () => {
		process.env.PI_SUBAGENT_DEPTH = "1";
		const stub = makeStub();
		register(stub.api);
		expect(stub.tools.map((t) => t.name)).not.toContain("subagent");
		expect(stub.tools.map((t) => t.name)).not.toContain("subagent_control");
		expect(stub.commands).toContain("subagents-setup");
	});

	it("also blocks a deeper inherited depth", () => {
		process.env.PI_SUBAGENT_DEPTH = "2";
		const stub = makeStub();
		register(stub.api);
		expect(stub.tools.map((t) => t.name)).not.toContain("subagent");
		expect(stub.tools.map((t) => t.name)).not.toContain("subagent_control");
	});
});

describe("run id matching", () => {
	it("prefers an exact id over prefix matches", () => {
		// "1" must resolve to run 1 only, never fan out to 10/11 (single-digit
		// lookups would otherwise return several full result blocks).
		expect(matchRunIds([1, 10, 11], "1")).toEqual([1]);
	});

	it("falls back to prefix matches only when no exact id exists", () => {
		expect(matchRunIds([10, 11], "1")).toEqual([10, 11]);
	});

	it("returns no matches for an unknown id", () => {
		expect(matchRunIds([1, 2], "9")).toEqual([]);
	});
});

describe("delegated task validation", () => {
	it("rejects a whitespace-only single task before enqueueing", async () => {
		const enqueue = vi.spyOn(BackgroundTaskQueue.prototype, "enqueue").mockImplementation(() => new AbortController());
		const stub = makeStub();
		register(stub.api);
		const tool = stub.tools.find((candidate) => candidate.name === "subagent");

		const result = await runTool(tool, "call-1", { agent: "worker", task: " \n\t " }, executionContext());

		expect(enqueue).not.toHaveBeenCalled();
		expect(result.content[0].text).toContain("Invalid parameters. task must contain at least one non-whitespace character.");
		expect(result.details).toEqual({ mode: "single", results: [], background: false });
	});

	it("rejects an entire parallel batch when one task is whitespace-only", async () => {
		const enqueue = vi.spyOn(BackgroundTaskQueue.prototype, "enqueue").mockImplementation(() => new AbortController());
		const stub = makeStub();
		register(stub.api);
		const tool = stub.tools.find((candidate) => candidate.name === "subagent");

		const result = await runTool(tool, "call-2", {
				tasks: [
					{ agent: "explorer", task: "Inspect the relevant files" },
					{ agent: "worker", task: "\n\t" },
				],
			}, executionContext());

		expect(enqueue).not.toHaveBeenCalled();
		expect(result.content[0].text).toContain("Invalid parameters. tasks[1].task must contain at least one non-whitespace character.");
		expect(result.content[0].text).toContain("No background tasks were started.");
		expect(result.details).toEqual({ mode: "parallel", results: [], background: false });
	});
});

describe("subagent control lookup", () => {
	it("rejects control for an unknown logical run without dispatching", async () => {
		const enqueue = vi.spyOn(BackgroundTaskQueue.prototype, "enqueue").mockImplementation(() => new AbortController());
		const stub = makeStub();
		register(stub.api);
		const control = stub.tools.find((candidate) => candidate.name === "subagent_control");

		const result = await runTool(control, "call-control", { action: "resume", id: 999 }, executionContext());

		expect(enqueue).not.toHaveBeenCalled();
		expect(result.content[0].text).toContain("No subagent thread matches run #999");
	});
});

describe("registered tool background dispatch", () => {
	it("reports its summary with cache reads on completion", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		configureEnabledAgents(["worker"]);
		const stub = makeStub();
		const { tasks: capturedTasks, controllers } = captureEnqueue();

			const restoreChild = fakeChild(`send({
	type: "message_end",
	message: {
		role: "assistant",
		content: [{ type: "text", text: "fake child completed" }],
		usage: { input: 0, output: 0, cacheRead: 321, cacheWrite: 0, cost: { total: 0 }, totalTokens: 321 },
		stopReason: "stop"
	}
});`);
		try {

			register(stub.api);
			const tool = stub.tools.find((candidate) => candidate.name === "subagent");
			const task = "\x1b[31mInspect\x1b[0m\n  cache-read metrics";
			const summary = "Inspect cache-read metrics";
			const dispatch = await runTool(tool, "call-valid", { agent: "worker", task }, executionContext());

			expect(dispatch.terminate).toBe(true);
			expect(capturedTasks).toHaveLength(1);
			const runId = dispatch.details.results[0].runId;
			expect(runId).toBeTypeOf("number");
			expect(dispatch.content[0].text).toContain(`#${runId} worker`);
			expect(renderToolResult(tool, dispatch)).toContain(`#${runId} worker`);
			await capturedTasks[0](controllers[0].signal);

			expect(stub.messages).toHaveLength(0);
			vi.advanceTimersByTime(150);
			expect(stub.messages).toHaveLength(1);
			const completion = stub.messages[0];
			expect(completion.message.content).toContain(`Task: ${summary}`);
			expect(completion.message.content).toContain(`run #${runId}`);
			expect(completion.message.content).toMatch(/\bR321\b/);
			expect(completion.options).toEqual({ deliverAs: "steer", triggerTurn: true });
		} finally {
			restoreChild();
			await shutdownExtension(stub, { controllers });
		}
	});

	it("reports a clean-exit run whose tool calls failed as completed-with-failures", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		configureEnabledAgents(["worker"]);
		const stub = makeStub();
		const { tasks: capturedTasks, controllers } = captureEnqueue();

			const restoreChild = fakeChild(`for (let i = 1; i <= 4; i++) {
	send({ type: "tool_execution_start", toolName: "bash-" + i, args: {} });
	send({
		type: "tool_execution_end",
		toolName: "bash-" + i,
		isError: true,
		result: { content: [{ type: "text", text: "MSBuild.exe failed " + i + "\\nfatal error C3861: execute_wake_task: undeclared identifier " + i }] }
	});
}
send({
	type: "message_end",
	message: {
		role: "assistant",
		content: [{ type: "text", text: "still fixing, keep waiting" }],
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 }, totalTokens: 0 },
		stopReason: "stop"
	}
});`);
		try {

			register(stub.api);
			const tool = stub.tools.find((candidate) => candidate.name === "subagent");
			const dispatch = await runTool(tool, "call-f", { agent: "worker", task: "Fix the compile error" }, executionContext());
			const runId = dispatch.details.results[0].runId;
			await capturedTasks[0](controllers[0].signal);
			vi.advanceTimersByTime(150);
			expect(stub.messages).toHaveLength(1);
			const content = stub.messages[0].message.content;
			expect(content).toContain("[worker] completed");
			// Failed-tool diagnostics are opt-in via subagent_status, never delivered.
			expect(content).not.toContain("failed tool call");
			expect(content).not.toContain("MSBuild.exe failed");
			expect(content).not.toContain("fatal error C3861");
			expect(stub.messages[0].options).toEqual({ deliverAs: "steer", triggerTurn: true });

			const status = stub.tools.find((candidate) => candidate.name === "subagent_status");
			const full = await runTool(status, "status-f", { id: String(runId) }, executionContext());
			expect(full.content[0].text).toContain("completed with 4 failed tool calls");
			for (let i = 1; i <= 4; i++) {
				expect(full.content[0].text).toContain(`- bash-${i}: MSBuild.exe failed ${i}`);
				expect(full.content[0].text).toContain(`fatal error C3861: execute_wake_task: undeclared identifier ${i}`);
			}
			expect(full.content[0].text).not.toContain("… and");
		} finally {
			restoreChild();
			await shutdownExtension(stub, { controllers });
		}
	});

	it("subagent_wait returns the finished result in-turn instead of sleeping", async () => {
		configureEnabledAgents(["worker"]);
		const stub = makeStub();
		const { tasks: capturedTasks, controllers } = captureEnqueue();

			const restoreChild = fakeChild(`send({
	type: "message_end",
	message: {
		role: "assistant",
		content: [{ type: "text", text: "worker result payload" }],
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 }, totalTokens: 0 },
		stopReason: "stop"
	}
});`);
		try {

			register(stub.api);
			const tool = stub.tools.find((candidate) => candidate.name === "subagent");
			const waitTool = stub.tools.find((candidate) => candidate.name === "subagent_wait");
			expect(waitTool).toBeDefined();

			await runTool(tool, "call-w", { agent: "worker", task: "Fix the build" }, executionContext());
			expect(capturedTasks).toHaveLength(1);

			// An explicit timeoutMs opts into blocking (the default is a
			// non-blocking lookup); let the run settle afterwards and the same
			// promise resolves with it.
			const runId = monitor.getRuns().find((run) => run.task === "Fix the build")?.id;
			expect(runId).toBeDefined();
			const waitPromise = waitTool.execute(
				"wait-1",
				{ id: String(runId), timeoutMs: 30_000 },
				new AbortController().signal,
				() => {},
				executionContext(),
			);
			await capturedTasks[0](controllers[0].signal);
			const waitResult = await waitPromise;

			const text = waitResult.content[0].text;
			expect(text).toContain("### [worker] completed");
			expect(text).toContain("worker result payload");
			expect(text).toContain("Task: Fix the build");

			// A settled run resolves immediately on a second call.
			const second = await runTool(waitTool, "wait-2", { id: String(runId) }, executionContext());
			expect(second.content[0].text).toContain("worker result payload");
		} finally {
			restoreChild();
			await shutdownExtension(stub, { controllers });
		}
	});

	it("subagent_wait reports no active runs and times out on still-running ones", async () => {
		const stub = makeStub();
		const { tasks: capturedTasks, controllers } = captureEnqueue();

		try {
			register(stub.api);
			const tool = stub.tools.find((candidate) => candidate.name === "subagent");
			const waitTool = stub.tools.find((candidate) => candidate.name === "subagent_wait");

			const none = await runTool(waitTool, "wait-none", {}, executionContext());
			expect(none.content[0].text).toContain("No active subagent runs");

			await runTool(tool, "call-w2", { agent: "worker", task: "Long task" }, executionContext());
			// The captured task never runs, so the run stays active: wait times out.
			const runId = monitor.getRuns().find((run) => run.task === "Long task")?.id;
			expect(runId).toBeDefined();
			const timedOut = await runTool(waitTool, "wait-to", { id: String(runId), timeoutMs: 100 }, executionContext());
			expect(timedOut.content[0].text).toContain("wait timed out");
			expect(timedOut.content[0].text).toContain(`#${runId}`);

			// The default is a NON-blocking lookup: a still-active run returns a
			// note immediately (the model ends its turn and the wake-up message
			// delivers the result) instead of holding the turn.
			const nonBlocking = await runTool(waitTool, "wait-nb", { id: String(runId) }, executionContext());
			expect(nonBlocking.content[0].text).toContain(`run #${runId} is still active`);
			expect(nonBlocking.content[0].text).toContain("end your turn");

			const unknown = await runTool(waitTool, "wait-x", { id: "99" }, executionContext());
			expect(unknown.content[0].text).toContain('No active subagent run matches "99"');
		} finally {
			await shutdownExtension(stub, { controllers });
		}
	});

	it("subagent_wait resolves with a note when the calling turn's signal is aborted", async () => {
		const stub = makeStub();
		const { tasks: capturedTasks, controllers } = captureEnqueue();

		try {
			register(stub.api);
			const tool = stub.tools.find((candidate) => candidate.name === "subagent");
			const waitTool = stub.tools.find((candidate) => candidate.name === "subagent_wait");
			await runTool(tool, "call-wa", { agent: "worker", task: "Long task" }, executionContext());
			const runId = monitor.getRuns().find((run) => run.task === "Long task")?.id;
			expect(runId).toBeDefined();

			// Already-aborted signal: the wait resolves immediately without blocking.
			const alreadyAborted = new AbortController();
			alreadyAborted.abort();
			const immediate = await waitTool.execute(
				"wait-ab1",
				{ id: String(runId) },
				alreadyAborted.signal,
				() => {},
				executionContext(),
			);
			expect(immediate.content[0].text).toContain("wait aborted");

			// Mid-wait abort: the onAbort listener resolves the pending wait.
			const midWait = new AbortController();
			const pending = waitTool.execute(
				"wait-ab2",
				{ id: String(runId) },
				midWait.signal,
				() => {},
				executionContext(),
			);
			midWait.abort();
			const aborted = await pending;
			expect(aborted.content[0].text).toContain("wait aborted");
		} finally {
			await shutdownExtension(stub, { controllers });
		}
	});

	it("subagent_status lists active runs and returns full results by id", async () => {
		configureEnabledAgents(["worker"]);
		const stub = makeStub();
		const { tasks: capturedTasks, controllers } = captureEnqueue();

			const restoreChild = fakeChild(`send({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "status payload" }], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 }, totalTokens: 0 }, stopReason: "stop" } });`);
		try {

			register(stub.api);
			const tool = stub.tools.find((candidate) => candidate.name === "subagent");
			const statusTool = stub.tools.find((candidate) => candidate.name === "subagent_status");
			expect(statusTool).toBeDefined();

			// No runs yet: empty overview.
			const empty = await runTool(statusTool, "st-0", {}, executionContext());
			expect(empty.content[0].text).toContain("Active subagent runs (0)");

			await runTool(tool, "call-s", { agent: "worker", task: "Inspect the build" }, executionContext());

			// Queued run shows in the overview with its id.
			const runId = monitor.getRuns().find((run) => run.task === "Inspect the build")?.id;
			expect(runId).toBeDefined();
			monitor.recordToolStart(
				runId!,
				"bash",
				"bash curl -H 'Authorization: Bearer DO_NOT_LEAK_TEST_TOKEN' x?token=DO_NOT_LEAK_QUERY \x1b]0;unsafe\x07",
			);
			const overview = await runTool(statusTool, "st-1", {}, executionContext());
			expect(overview.content[0].text).toContain("Active subagent runs (1)");
			expect(overview.content[0].text).toContain(`#${runId} worker`);
			expect(overview.content[0].text).toContain("Authorization: Bearer <redacted>");
			expect(overview.content[0].text).not.toContain("DO_NOT_LEAK");
			expect(overview.content[0].text).not.toContain("\x1b");
			expect(overview.content[0].text).toContain("Finished this session (0)");

			// While active, an id lookup reports the run is still running without
			// exposing the raw tool arguments stored by the live monitor.
			const stillActive = await runTool(statusTool, "st-2", { id: String(runId) }, executionContext());
			expect(stillActive.content[0].text).toContain("still active");
			expect(stillActive.content[0].text).not.toContain("DO_NOT_LEAK");
			expect(stillActive.content[0].text).not.toContain("\x1b");

			// After the run settles, the same id returns the full result.
			await capturedTasks[0](controllers[0].signal);
			const settledView = await runTool(statusTool, "st-3", { id: String(runId) }, executionContext());
			expect(settledView.content[0].text).toContain("### [worker] completed");
			expect(settledView.content[0].text).toContain("status payload");

			const after = await runTool(statusTool, "st-4", {}, executionContext());
			expect(after.content[0].text).toContain("Finished this session (1)");
			expect(after.content[0].text).toContain(`#${runId} worker · Inspect the build · completed`);
		} finally {
			restoreChild();
			await shutdownExtension(stub, { controllers });
		}
	});

	it("subagent_stop cancels active runs and resolves waiters with an aborted result", async () => {
		const stub = makeStub();
		const { tasks: capturedTasks, controllers } = captureEnqueue();

		try {
			register(stub.api);
			const tool = stub.tools.find((candidate) => candidate.name === "subagent");
			const waitTool = stub.tools.find((candidate) => candidate.name === "subagent_wait");
			const stopTool = stub.tools.find((candidate) => candidate.name === "subagent_stop");
			expect(stopTool).toBeDefined();

			// Unknown id: nothing to stop.
			const unknown = await runTool(stopTool, "stop-x", { id: "99" }, executionContext());
			expect(unknown.content[0].text).toContain('No subagent thread matches "99"');

			await runTool(tool, "call-st", { agent: "worker", task: "Long task" }, executionContext());

			// A waiter blocks on the queued run; stopping resolves it.
			const runId = monitor.getRuns().find((run) => run.task === "Long task")?.id;
			expect(runId).toBeDefined();
			const waitPromise = waitTool.execute(
				"wait-st",
				{ id: String(runId), timeoutMs: 30_000 },
				new AbortController().signal,
				() => {},
				executionContext(),
			);
			const stopped = await runTool(stopTool, "stop-1", { id: String(runId) }, executionContext());
			expect(stopped.content[0].text).toContain(`Stopped 1 thread: #${runId} worker (queued)`);

			const waited = await waitPromise;
			expect(waited.content[0].text).toContain("### [worker] failed");
			expect(waited.content[0].text).toContain("Stopped by subagent_stop");
			expect(stub.messages).toHaveLength(1);
			expect(stub.messages[0].message.content).toContain("Stopped by subagent_stop");
		} finally {
			await shutdownExtension(stub, { controllers });
		}
	});

	it("batches sibling successes into one grouped wake-up message", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		configureEnabledAgents(["explorer", "reviewer"]);
		const stub = makeStub();
		const { tasks: capturedTasks, controllers } = captureEnqueue();

			const restoreChild = fakeChild(`send({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "batch result" }], stopReason: "stop" } });`);
		try {

			register(stub.api);
			const tool = stub.tools.find((candidate) => candidate.name === "subagent");
			const dispatch = await runTool(tool, "call-batch", {
					tasks: [
						{ agent: "explorer", task: "Inspect the change" },
						{ agent: "reviewer", task: "Review the change" },
					],
				}, executionContext());

			expect(dispatch.terminate).toBe(true);
			expect(capturedTasks).toHaveLength(2);
			const runIds = dispatch.details.results.map((result: any) => result.runId as number);
			const renderedDispatch = renderToolResult(tool, dispatch);
			for (const [index, runId] of runIds.entries()) {
				const agent = index === 0 ? "explorer" : "reviewer";
				expect(dispatch.content[0].text).toContain(`#${runId} ${agent}`);
				expect(renderedDispatch).toContain(`#${runId} ${agent}`);
			}
			for (let index = 0; index < capturedTasks.length; index++) {
				await capturedTasks[index](controllers[index].signal);
			}
			expect(stub.messages).toHaveLength(0);

			vi.advanceTimersByTime(150);
			expect(stub.messages).toHaveLength(1);
			const completion = stub.messages[0];
			expect(completion.message.content).toContain("### Subagents completed (2): explorer, reviewer");
			expect(completion.message.content).toContain("### [explorer] completed");
			expect(completion.message.content).toContain("### [reviewer] completed");
			for (const runId of runIds) expect(completion.message.content).toContain(`run #${runId}`);
			expect(completion.options).toEqual({ deliverAs: "steer", triggerTurn: true });
		} finally {
			restoreChild();
			await shutdownExtension(stub, { controllers });
		}
	});

	it("delivers an opted-in passing reviewer result without waking the main agent", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		if (!testAgentDir) throw new Error("test agent directory was not initialized");
		configureEnabledAgents(["reviewer"], { notifyOnReviewPass: true });
		const stub = makeStub();
		const { tasks, controllers } = captureEnqueue();

			const restoreChild = fakeChild(`send({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "APPROVE\\nVERDICT: REVIEW_PASS" }], stopReason: "stop" } });`);
		try {

			register(stub.api);
			const tool = stub.tools.find((candidate) => candidate.name === "subagent");
			await runTool(tool, "call-review-pass", { agent: "reviewer", task: "Review the change" }, executionContext());

			await tasks[0](controllers[0].signal);
			expect(stub.messages).toHaveLength(0);
			vi.advanceTimersByTime(150);
			expect(stub.messages).toHaveLength(1);
			expect(stub.messages[0].options).toEqual({ deliverAs: "nextTurn" });
		} finally {
			restoreChild();
			await shutdownExtension(stub, { controllers });
		}
	});

	it("emits a failure immediately ahead of held successes", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		configureEnabledAgents(["explorer", "reviewer"]);
		const stub = makeStub();
		const { tasks: capturedTasks, controllers } = captureEnqueue();

			const restoreChild = fakeChild(`const failed = input.includes("must fail");
const text = failed ? "VERDICT: REVIEW_FAIL" : "successful result";
send({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }], stopReason: failed ? "error" : "stop" } });`);
		try {

			register(stub.api);
			const tool = stub.tools.find((candidate) => candidate.name === "subagent");
			await runTool(tool, "call-failure", {
					tasks: [
						{ agent: "explorer", task: "succeed first" },
						{ agent: "reviewer", task: "must fail now" },
					],
				}, executionContext());

			expect(capturedTasks).toHaveLength(2);
			await capturedTasks[0](controllers[0].signal);
			expect(stub.messages).toHaveLength(0);

			await capturedTasks[1](controllers[1].signal);
			expect(stub.messages).toHaveLength(2);
			expect(stub.messages[0].message.content).toContain("### [reviewer] failed");
			expect(stub.messages[0].options).toEqual({ deliverAs: "steer", triggerTurn: true });
			expect(stub.messages[1].message.content).toContain("### [explorer] completed");

			vi.advanceTimersByTime(1_000);
			expect(stub.messages).toHaveLength(2);
		} finally {
			restoreChild();
			await shutdownExtension(stub, { controllers });
		}
	});

	it("truncates a long result and points at the full artifact", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const stub = makeStub();
		const { tasks, controllers } = captureEnqueue();

			const restoreChild = fakeChild(`const lines = Array.from({ length: 100 }, (_, i) => "line " + i).join("\\n");
send({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: lines }], stopReason: "stop" } });`);
		try {

			register(stub.api);
			const tool = stub.tools.find((candidate) => candidate.name === "subagent");
			await runTool(tool, "call-truncate", { agent: "reviewer", task: "Review the change" }, executionContext());

			await tasks[0](controllers[0].signal);
			vi.advanceTimersByTime(150);
			expect(stub.messages).toHaveLength(1);
			const content = stub.messages[0].message.content as string;
			expect(content).toContain("(output truncated to 40 lines; full result:");
			expect(content).toContain("line 39");
			expect(content).not.toContain("line 40");
			const artifactPath = /full result: (.+)\)/.exec(content)?.[1];
			expect(artifactPath).toBeTruthy();
			expect(readFileSync(artifactPath!, "utf8")).toContain("line 99");
			rmSync(artifactPath!, { force: true });
		} finally {
			restoreChild();
			await shutdownExtension(stub, { controllers });
		}
	});
});

describe("managed post-writer workflows", () => {
	const makeResult = (agent: string, task: string, text: string, overrides: Record<string, unknown> = {}): any => ({
		agent,
		task,
		exitCode: 0,
		messages: [{ role: "assistant", content: [{ type: "text", text }], stopReason: "stop" }],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 },
		...overrides,
	});

	it("releases the concurrency slot for a managed continuation so manual dispatches are not starved", async () => {
		configureEnabledAgents(["worker", "reviewer", "explorer"]);
		const stub = makeStub();
		const hangUntilAborted = (signal?: AbortSignal): Promise<void> =>
			new Promise<void>((resolveHang) => {
				if (signal?.aborted) return resolveHang();
				signal?.addEventListener("abort", () => resolveHang(), { once: true });
			});
		let explorerStarts = 0;
		let reviewerStarts = 0;
		vi.spyOn(spawn, "runSingleAgentWithMainFallback").mockImplementation(async (options: any) => {
			if (options.agentName === "worker") return makeResult("worker", options.task, "implemented");
			if (options.agentName === "reviewer") {
				// Hold the gate review so the chain stays inside its suspended continuation.
				reviewerStarts++;
				await hangUntilAborted(options.signal);
				return makeResult("reviewer", options.task, "VERDICT: REVIEW_PASS");
			}
			explorerStarts++;
			if (explorerStarts <= 3) await hangUntilAborted(options.signal);
			return makeResult("explorer", options.task, "scouted");
		});

		try {
			register(stub.api);
			const tool = stub.tools.find((candidate) => candidate.name === "subagent")!;
			const ctx = executionContext();
			// One chain (worker → held gate review) plus three stuck explorers
			// exhaust all four manual slots; the chain's continuation must then
			// suspend its slot so a fifth dispatch still starts immediately.
			await runTool(tool, "chain", { agent: "worker", task: "Chain owner" }, ctx);
			for (const task of ["Stuck one", "Stuck two", "Stuck three"]) {
				await runTool(tool, "fill", { agent: "explorer", task }, ctx);
			}
			await waitFor(() => reviewerStarts === 1 && explorerStarts === 3);

			const fifth = await runTool(tool, "fifth", { agent: "explorer", task: "Fifth dispatch" }, ctx);
			expect(fifth.details.results[0].runId).toBeGreaterThan(0);
			await waitFor(() => explorerStarts === 4);
		} finally {
			await shutdownExtension(stub);
		}
	});

	it("re-reads parent shells and active plugins for every managed stage", async () => {
		configureEnabledAgents(["worker", "documenter", "reviewer"]);
		const stub = makeStub();
		stub.activeTools = ["read", "powershell", "edit", "write", "custom_extension"];
		const { tasks, controllers } = captureEnqueue();
		const run = vi.spyOn(spawn, "runSingleAgentWithMainFallback").mockImplementation(async (options: any) => {
			if (options.agentName === "worker") {
				stub.activeTools = ["read", "bash", "edit", "write", "custom_extension"];
				return makeResult("worker", options.task, "implemented");
			}
			if (options.agentName === "reviewer") {
				stub.activeTools = ["read", "bash", "powershell", "edit", "write", "custom_extension"];
				return makeResult("reviewer", options.task, "DOCUMENTATION: NEEDED\nVERDICT: REVIEW_PASS");
			}
			return makeResult("documenter", options.task, "docs synchronized");
		});

		try {
			register(stub.api);
			const tool = stub.tools.find((candidate) => candidate.name === "subagent");
			await runTool(tool, "adaptive-tools-chain", { agent: "worker", task: "Implement adaptive tools" }, executionContext());
			await tasks[0](controllers[0].signal);

			const calls = run.mock.calls.map(([options]) => options);
			expect(calls.map((options) => options.agentName)).toEqual([
				"worker", "reviewer", "documenter",
			]);
			expect(calls[0].agent.tools).toEqual([
				"read", "powershell", "edit", "write", "custom_extension",
			]);
			expect(calls[1].agent.tools).toEqual([
				"read", "grep", "find", "ls", "bash", "custom_extension",
			]);
			expect(calls[2].agent.tools).toEqual([
				"read", "grep", "find", "ls", "bash", "powershell", "edit", "write", "custom_extension",
			]);
		} finally {
			await shutdownExtension(stub, { controllers });
		}
	});

	it("keeps parent and active-stage widget telemetry attributed to their actual roles", async () => {
		configureEnabledAgents(["worker", "documenter", "reviewer"]);
		const stub = makeStub();
		const { tasks, controllers } = captureEnqueue();
		const workerUsage = { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, cost: 1, contextTokens: 0, turns: 1 };
		const documenterUsage = { input: 20, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0.01, contextTokens: 0, turns: 1 };
		const reviewerUsage = { input: 30, output: 3, cacheRead: 0, cacheWrite: 0, cost: 0.2, contextTokens: 0, turns: 1 };
		let reviewerStarted!: () => void;
		const atReviewer = new Promise<void>((resolve) => {
			reviewerStarted = resolve;
		});
		let releaseReviewer!: () => void;
		const reviewerRelease = new Promise<void>((resolve) => {
			releaseReviewer = resolve;
		});
		let documenterStarted!: () => void;
		const atDocumenter = new Promise<void>((resolve) => {
			documenterStarted = resolve;
		});
		let releaseDocumenter!: () => void;
		const documenterRelease = new Promise<void>((resolve) => {
			releaseDocumenter = resolve;
		});
		vi.spyOn(spawn, "runSingleAgentWithMainFallback").mockImplementation(async (options: any) => {
			const publish = (model: string, thinking: string, usage: typeof workerUsage): void => {
				options.onLive?.({ kind: "status", status: "running" });
				options.onLive?.({ kind: "model", model, thinking });
				options.onLive?.({ kind: "usage", usage, model });
			};
			if (options.agentName === "worker") {
				publish("openai/gpt-worker", "max", workerUsage);
				return makeResult("worker", options.task, "implemented", {
					model: "openai/gpt-worker",
					thinking: "max",
					usage: workerUsage,
				});
			}
			if (options.agentName === "documenter") {
				publish("deepseek/ds-doc", "low", documenterUsage);
				documenterStarted();
				await documenterRelease;
				return makeResult("documenter", options.task, "docs synchronized", {
					model: "deepseek/ds-doc",
					thinking: "low",
					usage: documenterUsage,
				});
			}
			publish("xai/grok-reviewer", "xhigh", reviewerUsage);
			reviewerStarted();
			await reviewerRelease;
			return makeResult("reviewer", options.task, "DOCUMENTATION: NEEDED\nVERDICT: REVIEW_PASS", {
				model: "xai/grok-reviewer",
				thinking: "xhigh",
				usage: reviewerUsage,
			});
		});

		try {
			register(stub.api);
			const tool = stub.tools.find((candidate) => candidate.name === "subagent");
			const dispatched = await runTool(tool, "widget-attribution", { agent: "worker", task: "Implement widget attribution" }, executionContext());
			const parentRunId = dispatched.details.results[0].runId as number;
			const workflow = tasks[0](controllers[0].signal);
			await atReviewer;

			const parent = monitor.findRun(parentRunId)!;
			const reviewer = monitor.getRuns().find((run) => run.parentRunId === parentRunId)!;
			expect(parent).toMatchObject({
				agent: "worker",
				managedWorkflow: true,
				model: "openai/gpt-worker",
				thinking: "max",
				usage: workerUsage,
				workflowStages: [
					{ agent: "worker", relation: "implement", status: "done" },
					{ agent: "reviewer", relation: "review", status: "active" },
					{ agent: "documenter", relation: "docs", status: "pending" },
				],
			});
			expect(reviewer).toMatchObject({
				agent: "reviewer",
				model: "xai/grok-reviewer",
				thinking: "xhigh",
				usage: reviewerUsage,
				relationLabel: "final review",
			});
			expect(monitor.getRuns()).not.toContainEqual(expect.objectContaining({
				agent: "documenter",
				model: "openai/gpt-worker",
			}));

			releaseReviewer();
			await atDocumenter;
			expect(monitor.findRun(parentRunId)?.workflowStages).toEqual([
				{ agent: "worker", relation: "implement", status: "done" },
				{ agent: "reviewer", relation: "review", status: "done" },
				{ agent: "documenter", relation: "docs", status: "active" },
			]);
			expect(monitor.getRuns()).not.toContainEqual(expect.objectContaining({
				parentRunId,
				agent: "reviewer",
			}));
			expect(monitor.getRuns()).toContainEqual(expect.objectContaining({
				parentRunId,
				agent: "documenter",
				relationLabel: "final documentation sync",
			}));
			releaseDocumenter();
			await workflow;
		} finally {
			releaseReviewer();
			releaseDocumenter();
			await shutdownExtension(stub, { controllers });
		}
	});

	it.each([
		["worker", ["worker", "reviewer", "documenter"]],
		["cleaner", ["cleaner", "reviewer", "documenter"]],
	] as const)("runs successful top-level %s through its reviewer and conservative docs fallback", async (topAgent, expectedOrder) => {
		configureEnabledAgents(["explorer", "worker", "cleaner", "documenter", "reviewer"]);
		const stub = makeStub();
		const { tasks, controllers } = captureEnqueue();
		const topTask = `${topAgent} top-level task`;
		const run = vi.spyOn(spawn, "runSingleAgentWithMainFallback").mockImplementation(async (options: any) => {
			if (options.task === topTask) return makeResult(topAgent, options.task, `${topAgent} report src/change.ts`);
			if (options.agentName === "documenter") {
				expect(options.task).toContain(`${topAgent} report src/change.ts`);
				expect(options.task).toContain("VERDICT: REVIEW_PASS");
				expect(options.task).toContain("Inspect the actual git diff");
				return makeResult("documenter", options.task, "documentation report README.md");
			}
			expect(options.agentName).toBe("reviewer");
			expect(options.task).toContain(`${topAgent} report src/change.ts`);
			expect(options.task).not.toContain("documentation report README.md");
			return makeResult("reviewer", options.task, "APPROVE\nVERDICT: REVIEW_PASS");
		});

		try {
			register(stub.api);
			const tool = stub.tools.find((candidate) => candidate.name === "subagent");
			const dispatch = await tool.execute(
				`managed-${topAgent}`,
				{ agent: topAgent, task: topTask },
				new AbortController().signal,
				() => {},
				executionContext(),
			);
			const parentRunId = dispatch.details.results[0].runId;
			await tasks[0](controllers[0].signal);

			expect(run.mock.calls.map(([options]) => options.agentName)).toEqual(expectedOrder);
			expect(stub.messages).toHaveLength(1);
			const content = stub.messages[0].message.content as string;
			expect(content).toContain("## Managed workflow:");
			expect(content).toContain("final review · PASS");
			expect(content).toContain("final documentation sync · completed");
			expect(content).not.toContain(`- #${parentRunId} `);
			const stepIds = [...content.matchAll(/^- #(\d+) /gmu)].map((match) => Number(match[1]));
			expect(stepIds).toHaveLength(expectedOrder.length);
			expect(new Set(stepIds).size).toBe(expectedOrder.length);
			expect(stub.messages[0].options).toEqual({ deliverAs: "steer", triggerTurn: true });
		} finally {
			await shutdownExtension(stub, { controllers });
		}
	});

	it("skips pending documenter when the post-writer gate reports DOCUMENTATION: CLEAN", async () => {
		configureEnabledAgents(["worker", "documenter", "reviewer"]);
		const stub = makeStub();
		const { tasks, controllers } = captureEnqueue();
		const run = vi.spyOn(spawn, "runSingleAgentWithMainFallback").mockImplementation(async (options: any) => {
			if (options.agentName === "worker") return makeResult("worker", options.task, "implemented src/cache.ts");
			expect(options.agentName).toBe("reviewer");
			expect(options.task).toContain("DOCUMENTATION: NEEDED");
			expect(options.task).toContain("DOCUMENTATION: CLEAN");
			return makeResult("reviewer", options.task, "DOCUMENTATION: CLEAN\nAPPROVE\nVERDICT: REVIEW_PASS");
		});

		try {
			register(stub.api);
			const tool = stub.tools.find((candidate) => candidate.name === "subagent");
			await runTool(tool, "post-writer-clean", { agent: "worker", task: "Implement src/cache.ts" }, executionContext());
			await tasks[0](controllers[0].signal);

			expect(run.mock.calls.map(([options]) => options.agentName)).toEqual(["worker", "reviewer"]);
			expect(stub.messages).toHaveLength(1);
			expect(stub.messages[0].message.content).toContain("worker → reviewer");
			expect(stub.messages[0].message.content).not.toContain("final documentation sync");
		} finally {
			await shutdownExtension(stub, { controllers });
		}
	});

	it("never writes docs after a terminal REVIEW_FAIL gate", async () => {
		configureEnabledAgents(["worker", "documenter", "reviewer"]);
		const stub = makeStub();
		const { tasks, controllers } = captureEnqueue();
		const run = vi.spyOn(spawn, "runSingleAgentWithMainFallback").mockImplementation(async (options: any) => {
			if (options.agentName === "worker") return makeResult("worker", options.task, "implemented");
			return makeResult(
				"reviewer",
				options.task,
				"## Documentation notes\n- README stale\nDOCUMENTATION: NEEDED\nREQUEST_CHANGES\nVERDICT: REVIEW_FAIL",
			);
		});

		try {
			register(stub.api);
			const tool = stub.tools.find((candidate) => candidate.name === "subagent");
			await runTool(tool, "post-writer-fail-no-docs", { agent: "worker", task: "Implement then fail gate" }, executionContext());
			await tasks[0](controllers[0].signal);

			// The failing gate ends the workflow: findings return to the main
			// agent and no documenter starts despite DOCUMENTATION: NEEDED.
			expect(run.mock.calls.map(([options]) => options.agentName)).toEqual(["worker", "reviewer"]);
			expect(stub.messages).toHaveLength(1);
			expect(stub.messages[0].message.content).toContain("final FAIL");
			expect(stub.messages[0].message.content).not.toContain("final documentation sync");
		} finally {
			await shutdownExtension(stub, { controllers });
		}
	});

	it("treats a malformed post-writer review as a failed gate and never starts documenter", async () => {
		configureEnabledAgents(["worker", "documenter", "reviewer"]);
		const stub = makeStub();
		const { tasks, controllers } = captureEnqueue();
		const run = vi.spyOn(spawn, "runSingleAgentWithMainFallback").mockImplementation(async (options: any) => {
			if (options.agentName === "worker") return makeResult("worker", options.task, "implemented");
			if (options.agentName === "reviewer") {
				return makeResult("reviewer", options.task, "DOCUMENTATION: NEEDED\nMalformed gate without verdict");
			}
			throw new Error("A malformed gate must not authorize documenter");
		});

		let unsubscribe = (): void => {};
		try {
			register(stub.api);
			const tool = stub.tools.find((candidate) => candidate.name === "subagent");
			const dispatched = await runTool(tool, "post-writer-malformed-gate", { agent: "worker", task: "Implement then return a malformed gate" }, executionContext());
			const parentRunId = dispatched.details.results[0].runId as number;
			const observedProjections: unknown[] = [];
			unsubscribe = monitor.subscribe(() => {
				const stages = monitor.findRun(parentRunId)?.workflowStages;
				if (stages) observedProjections.push(stages.map((stage) => ({ ...stage })));
			});
			await tasks[0](controllers[0].signal);

			expect(run.mock.calls.map(([options]) => options.agentName)).toEqual(["worker", "reviewer"]);
			expect(observedProjections).toContainEqual([
				{ agent: "worker", relation: "implement", status: "done" },
				{ agent: "reviewer", relation: "review", status: "failed" },
			]);
			expect(stub.messages).toHaveLength(1);
			const content = stub.messages[0].message.content as string;
			expect(content).toContain("final NO_VERDICT");
			expect(content).toContain("reviewer · final review · NO_VERDICT");
			expect(content).not.toContain("final documentation sync");
		} finally {
			unsubscribe();
			await shutdownExtension(stub, { controllers });
		}
	});

	it("delivers a successful top-level documenter directly without a reviewer", async () => {
		vi.useFakeTimers();
		configureEnabledAgents(["documenter", "reviewer"]);
		const stub = makeStub();
		const { tasks, controllers } = captureEnqueue();
		const run = vi.spyOn(spawn, "runSingleAgentWithMainFallback").mockImplementation(async (options: any) =>
			makeResult("documenter", options.task, "updated README.md"));

		try {
			register(stub.api);
			const tool = stub.tools.find((candidate) => candidate.name === "subagent");
			await runTool(tool, "standalone-documenter", { agent: "documenter", task: "Update README.md for the explicit docs request" }, executionContext());
			await tasks[0](controllers[0].signal);
			vi.advanceTimersByTime(150);

			expect(run.mock.calls.map(([options]) => options.agentName)).toEqual(["documenter"]);
			expect(stub.messages).toHaveLength(1);
			expect(stub.messages[0].message.content).toContain("### [documenter] completed");
			expect(stub.messages[0].message.content).not.toContain("Managed workflow");
		} finally {
			await shutdownExtension(stub, { controllers });
		}
	});

	it("conservatively runs one docs sync after a direct REVIEW_PASS with no documentation marker", async () => {
		configureEnabledAgents(["worker", "documenter", "reviewer"]);
		const stub = makeStub();
		const { tasks, controllers } = captureEnqueue();
		const run = vi.spyOn(spawn, "runSingleAgentWithMainFallback").mockImplementation(async (options: any) => {
			if (options.agentName === "documenter") {
				expect(options.task).toContain("Final documentation sync");
				expect(options.task).toContain("DIRECT PASS REPORT");
				return makeResult("documenter", options.task, "SYNCED README.md");
			}
			return makeResult("reviewer", options.task, "DIRECT PASS REPORT\nVERDICT: REVIEW_PASS");
		});

		try {
			register(stub.api);
			const tool = stub.tools.find((candidate) => candidate.name === "subagent");
			await runTool(tool, "direct-pass", { agent: "reviewer", task: "Gate pending diff" }, executionContext());
			await tasks[0](controllers[0].signal);

			expect(run.mock.calls.map(([options]) => options.agentName)).toEqual(["reviewer", "documenter"]);
			expect(stub.messages).toHaveLength(1);
			expect(stub.messages[0].message.content).toContain("reviewer → documenter");
			expect(stub.messages[0].message.content).toContain("pre-documentation review · PASS");
			expect(stub.messages[0].message.content).toContain("final documentation sync · completed");
			expect(stub.messages[0].message.content).not.toContain("final review");
		} finally {
			await shutdownExtension(stub, { controllers });
		}
	});

	it("delivers a direct REVIEW_PASS with DOCUMENTATION: CLEAN without starting documenter", async () => {
		vi.useFakeTimers();
		configureEnabledAgents(["worker", "documenter", "reviewer"]);
		const stub = makeStub();
		const { tasks, controllers } = captureEnqueue();
		const run = vi.spyOn(spawn, "runSingleAgentWithMainFallback").mockImplementation(async (options: any) => {
			expect(options.agent.systemPrompt).toContain("Runtime workflow context: documenter is enabled");
			expect(options.agent.systemPrompt).toContain("documentation drift is non-gating");
			return makeResult("reviewer", options.task, "DOCUMENTATION: CLEAN\nAPPROVE\nVERDICT: REVIEW_PASS");
		});

		try {
			register(stub.api);
			const tool = stub.tools.find((candidate) => candidate.name === "subagent");
			await runTool(tool, "direct-clean-pass", { agent: "reviewer", task: "Gate pending diff" }, executionContext());
			await tasks[0](controllers[0].signal);
			vi.advanceTimersByTime(150);

			expect(run.mock.calls.map(([options]) => options.agentName)).toEqual(["reviewer"]);
			expect(stub.messages).toHaveLength(1);
			expect(stub.messages[0].message.content).toContain("DOCUMENTATION: CLEAN");
			expect(stub.messages[0].message.content).not.toContain("Managed workflow");
		} finally {
			await shutdownExtension(stub, { controllers });
		}
	});

	it("delivers an advisory re-verification directly even when a verdict leaks through", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		configureEnabledAgents(["worker", "documenter", "reviewer"]);
		const stub = makeStub();
		const { tasks, controllers } = captureEnqueue();
		const run = vi.spyOn(spawn, "runSingleAgentWithMainFallback").mockImplementation(async (options: any) => {
			expect(options.agent.systemPrompt).toContain("this dispatch is advisory");
			// The reviewer ignores the advisory contract and emits a gate verdict anyway.
			return makeResult("reviewer", options.task, "OPEN FINDING\nVERDICT: REVIEW_FAIL");
		});

		try {
			register(stub.api);
			const tool = stub.tools.find((candidate) => candidate.name === "subagent");
			await runTool(tool, "advisory-reverify", { agent: "reviewer", task: "Re-verify the pending diff after my fixes.", advisory: true }, executionContext());
			await tasks[0](controllers[0].signal);
			vi.advanceTimersByTime(150);

			expect(run.mock.calls.map(([options]) => options.agentName)).toEqual(["reviewer"]);
			expect(stub.messages).toHaveLength(1);
			expect(stub.messages[0].message.content).toContain("VERDICT: REVIEW_FAIL");
			expect(stub.messages[0].message.content).not.toContain("Managed workflow");
			expect(stub.messages[0].message.content).not.toContain("Auto-fix chain");
			expect(monitor.getRuns().find((run2) => run2.activity === "auto-fix chain running")).toBeUndefined();
		} finally {
			await shutdownExtension(stub, { controllers });
		}
	});

	it("keeps an advisory reviewer read-only and starts no downstream child", async () => {
		vi.useFakeTimers();
		configureEnabledAgents(["worker", "documenter", "reviewer"]);
		const stub = makeStub();
		const { tasks, controllers } = captureEnqueue();
		const run = vi.spyOn(spawn, "runSingleAgentWithMainFallback").mockImplementation(async (options: any) =>
			makeResult("reviewer", options.task, "Advisory findings only; no gate verdict."));

		try {
			register(stub.api);
			const tool = stub.tools.find((candidate) => candidate.name === "subagent");
			await runTool(tool, "advisory", { agent: "reviewer", task: "Audit architecture, report only" }, executionContext());
			await tasks[0](controllers[0].signal);
			vi.advanceTimersByTime(150);

			expect(run.mock.calls.map(([options]) => options.agentName)).toEqual(["reviewer"]);
			expect(stub.messages).toHaveLength(1);
			expect(stub.messages[0].message.content).not.toContain("Managed workflow");
			expect(stub.messages[0].message.content).toContain("Advisory findings only");
		} finally {
			await shutdownExtension(stub, { controllers });
		}
	});

	it.each([
		[["worker", "reviewer"], ["worker", "reviewer"]],
		[["worker", "documenter"], ["worker", "documenter"]],
		[["worker"], ["worker"]],
	] as const)("honors disabled downstream roles: %j", async (enabledAgents, expectedOrder) => {
		vi.useFakeTimers();
		configureEnabledAgents([...enabledAgents]);
		const stub = makeStub();
		const { tasks, controllers } = captureEnqueue();
		const run = vi.spyOn(spawn, "runSingleAgentWithMainFallback").mockImplementation(async (options: any) => {
			if (options.agentName === "reviewer") return makeResult("reviewer", options.task, "VERDICT: REVIEW_PASS");
			return makeResult(options.agentName, options.task, `${options.agentName} report`);
		});

		try {
			register(stub.api);
			const tool = stub.tools.find((candidate) => candidate.name === "subagent");
			await runTool(tool, "disabled-roles", { agent: "worker", task: "Implement with selected roles" }, executionContext());
			await tasks[0](controllers[0].signal);
			vi.advanceTimersByTime(150);

			expect(run.mock.calls.map(([options]) => options.agentName)).toEqual(expectedOrder);
			expect(run.mock.calls.some(([options]) => options.agentName === "Unknown")).toBe(false);
			expect(stub.messages).toHaveLength(1);
		} finally {
			await shutdownExtension(stub, { controllers });
		}
	});

	it("keeps a direct reviewer behind a shared writer workflow even with zero fix rounds", async () => {
		configureEnabledAgents(["worker", "reviewer"]);
		const stub = makeStub();
		const { tasks: queued, controllers } = captureEnqueue();
		const order: string[] = [];
		let releaseWriter!: () => void;
		const writerGate = new Promise<void>((resolveWriter) => {
			releaseWriter = resolveWriter;
		});
		const run = vi.spyOn(spawn, "runSingleAgentWithMainFallback").mockImplementation(async (options: any) => {
			if (options.task === "Shared writer") {
				order.push("writer");
				await writerGate;
				return makeResult("worker", options.task, "writer report");
			}
			if (options.task === "Direct advisory") {
				order.push("direct reviewer");
				return makeResult("reviewer", options.task, "advisory only");
			}
			order.push("managed reviewer");
			return makeResult("reviewer", options.task, "VERDICT: REVIEW_PASS");
		});

		try {
			register(stub.api);
			const tool = stub.tools.find((candidate) => candidate.name === "subagent");
			await runTool(tool, "shared-writer", { agent: "worker", task: "Shared writer" }, executionContext());
			await runTool(tool, "direct-reviewer", { agent: "reviewer", task: "Direct advisory" }, executionContext());
			const writerRun = queued[0](controllers[0].signal);
			await vi.waitFor(() => expect(order).toEqual(["writer"]));
			const reviewerRun = queued[1](controllers[1].signal);
			await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
			expect(order).toEqual(["writer"]);

			releaseWriter();
			await Promise.all([writerRun, reviewerRun]);
			expect(order).toEqual(["writer", "managed reviewer", "direct reviewer"]);
			expect(run).toHaveBeenCalledTimes(3);
		} finally {
			releaseWriter();
			await shutdownExtension(stub, { controllers });
		}
	});

	it("keeps root/nested empty-repo documenters behind a writer workflow when reviewer is disabled", async () => {
		configureEnabledAgents(["worker", "documenter"]);
		const { execFileSync } = await import("node:child_process");
		const repo = mkdtempSync(join(tmpdir(), "pi-subagents-empty-lane-"));
		execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
		const nested = join(repo, "nested");
		mkdirSync(nested, { recursive: true });
		const stub = makeStub();
		const { tasks: queued, controllers } = captureEnqueue();
		const order: string[] = [];
		let releaseWriter!: () => void;
		const writerGate = new Promise<void>((resolveWriter) => {
			releaseWriter = resolveWriter;
		});
		vi.spyOn(spawn, "runSingleAgentWithMainFallback").mockImplementation(async (options: any) => {
			if (options.task === "Writer before docs") {
				order.push("writer");
				await writerGate;
				return makeResult("worker", options.task, "writer report");
			}
			if (options.task === "Standalone docs") {
				order.push("standalone documenter");
				return makeResult("documenter", options.task, "standalone docs report");
			}
			order.push("managed documenter");
			return makeResult("documenter", options.task, "managed docs report");
		});

		try {
			register(stub.api);
			const tool = stub.tools.find((candidate) => candidate.name === "subagent");
			await runTool(tool, "writer-docs", { agent: "worker", task: "Writer before docs", cwd: repo }, executionContext());
			await runTool(tool, "standalone-docs", { agent: "documenter", task: "Standalone docs", cwd: nested }, executionContext());
			const writerRun = queued[0](controllers[0].signal);
			await vi.waitFor(() => expect(order).toEqual(["writer"]));
			const documenterRun = queued[1](controllers[1].signal);
			await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
			expect(order).toEqual(["writer"]);

			releaseWriter();
			await Promise.all([writerRun, documenterRun]);
			expect(order).toEqual(["writer", "managed documenter", "standalone documenter"]);
		} finally {
			releaseWriter();
			await shutdownExtension(stub, { controllers });
			rmSync(repo, { recursive: true, force: true });
		}
	});

});

describe("managed workflow dispatch", () => {
	it("delivers a REVIEW_FAIL reviewer directly instead of starting a fix chain", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const stub = makeStub();
		const uiNotify = vi.fn();
		const { tasks: capturedTasks, controllers } = captureEnqueue();

			const restoreChild = fakeChild(`send({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "REQUEST_CHANGES\\nVERDICT: REVIEW_FAIL" }], stopReason: "stop" } });`);
		try {

			register(stub.api);
			const tool = stub.tools.find((candidate) => candidate.name === "subagent");
			const dispatched = await runTool(tool, "call-chain", { agent: "reviewer", task: "Review the change" }, executionContext({ uiNotify }));
			const parentRunId = dispatched.details.results[0].runId as number;

			expect(capturedTasks).toHaveLength(1);
			await capturedTasks[0](controllers[0].signal);
			vi.advanceTimersByTime(150);

			// No managed continuation: the failing gate is one plain, turn-triggering
			// completion so the main agent can resolve the findings itself.
			expect(capturedTasks).toHaveLength(1);
			expect(stub.messages).toHaveLength(1);
			const content = stub.messages[0].message.content as string;
			expect(content).toContain("### [reviewer] completed");
			expect(content).toContain("VERDICT: REVIEW_FAIL");
			expect(content).not.toContain("Managed workflow");
			expect(stub.messages[0].options).toEqual({ deliverAs: "steer", triggerTurn: true });
			expect(monitor.getRuns()).toHaveLength(0);

			// The parent id resolves to the delivered report.
			const statusTool = stub.tools.find((candidate) => candidate.name === "subagent_status");
			const result = await statusTool.execute(
				"",
				{ id: String(parentRunId) },
				new AbortController().signal,
				() => {},
				executionContext(),
			);
			const parentReport = result.content[0].text;
			expect(parentReport).toContain(`run #${parentRunId}`);
			expect(parentReport).toContain("VERDICT: REVIEW_FAIL");
		} finally {
			restoreChild();
			await shutdownExtension(stub, { controllers });
		}
	});

	it("runs every managed stage in the triggering writer's explicit cwd", async () => {
		const stub = makeStub();
		const { tasks: capturedTasks, controllers } = captureEnqueue();
		const outerRepo = mkdtempSync(join(tmpdir(), "pi-subagents-chain-outer-"));
		const targetRepo = mkdtempSync(join(tmpdir(), "pi-subagents-chain-target-"));
		const makeResult = (agent: string, task: string, text: string): any => ({
			agent,
			task,
			exitCode: 0,
			messages: [{ role: "assistant", content: [{ type: "text", text }], stopReason: "stop" }],
			stderr: "",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 },
		});
		const run = vi.spyOn(spawn, "runSingleAgentWithMainFallback").mockImplementation(async (options: any) => {
			if (options.agentName === "worker") return makeResult("worker", options.task, "fixed target repo");
			return makeResult("reviewer", options.task, "APPROVE\nVERDICT: REVIEW_PASS");
		});

		try {
			register(stub.api);
			const tool = stub.tools.find((candidate) => candidate.name === "subagent");
			await runTool(tool, "call-chain-cwd", { agent: "worker", task: "Implement target repo", cwd: targetRepo }, { ...executionContext(), cwd: outerRepo });
			await capturedTasks[0](controllers[0].signal);
			expect(capturedTasks).toHaveLength(1);

			expect(run).toHaveBeenCalledTimes(2);
			for (const [options] of run.mock.calls) {
				expect(options.defaultCwd).toBe(targetRepo);
				expect(options.cwd).toBe(targetRepo);
			}
			expect(stub.messages).toHaveLength(1);
			expect(stub.messages[0].message.content).toContain("worker → reviewer");
		} finally {
			await shutdownExtension(stub, { controllers });
			rmSync(outerRepo, { recursive: true, force: true });
			rmSync(targetRepo, { recursive: true, force: true });
		}
	});

	it("serializes concurrent writer workflows that share a repository", async () => {
		const stub = makeStub();
		const { tasks: capturedTasks, controllers } = captureEnqueue();
		const repo = mkdtempSync(join(tmpdir(), "pi-subagents-chain-serialized-"));
		const makeResult = (agent: string, task: string, text: string): any => ({
			agent,
			task,
			exitCode: 0,
			messages: [{ role: "assistant", content: [{ type: "text", text }], stopReason: "stop" }],
			stderr: "",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 },
		});
		let activeWorkers = 0;
		let maxActiveWorkers = 0;
		let workerStarts = 0;
		const workerReleases: Array<() => void> = [];
		vi.spyOn(spawn, "runSingleAgentWithMainFallback").mockImplementation(async (options: any) => {
			if (options.agentName === "worker") {
				workerStarts++;
				activeWorkers++;
				maxActiveWorkers = Math.max(maxActiveWorkers, activeWorkers);
				try {
					await new Promise<void>((resolveWorker) => workerReleases.push(resolveWorker));
					return makeResult("worker", options.task, "fixed");
				} finally {
					activeWorkers--;
				}
			}
			return makeResult("reviewer", options.task, "APPROVE\nVERDICT: REVIEW_PASS");
		});

		try {
			register(stub.api);
			const tool = stub.tools.find((candidate) => candidate.name === "subagent");
			await Promise.all([
				runTool(tool, "chain-a", { agent: "worker", task: "Implement A", cwd: repo }, executionContext()),
				runTool(tool, "chain-b", { agent: "worker", task: "Implement B", cwd: repo }, executionContext()),
			]);
			expect(capturedTasks).toHaveLength(2);
			const chains = [
				capturedTasks[0](controllers[0].signal),
				capturedTasks[1](controllers[1].signal),
			];
			await vi.waitFor(() => expect(workerStarts).toBe(1));
			await new Promise((resolveDelay) => setTimeout(resolveDelay, 30));
			// The first workflow holds the shared-repository lane through its gate,
			// so the second writer cannot start yet.
			expect(workerStarts).toBe(1);
			expect(maxActiveWorkers).toBe(1);

			workerReleases[0]!();
			await vi.waitFor(() => expect(workerStarts).toBe(2));
			expect(maxActiveWorkers).toBe(1);
			workerReleases[1]!();
			await Promise.all(chains);
			expect(stub.messages).toHaveLength(2);
		} finally {
			for (const release of workerReleases) release();
			await shutdownExtension(stub, { controllers });
			rmSync(repo, { recursive: true, force: true });
		}
	});

	it("publishes the interrupted gate partial instead of the old writer report", async () => {
		const stub = makeStub();
		let gateOptions: any;
		vi.spyOn(spawn, "runSingleAgentWithMainFallback")
			.mockResolvedValueOnce({
				agent: "worker",
				task: "Implement the change",
				exitCode: 0,
				messages: [{ role: "assistant", content: [{ type: "text", text: "OLD WORKER REPORT" }], stopReason: "stop" }],
				stderr: "",
				usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 2, turns: 1 },
			} as any)
			.mockImplementationOnce(async (options: any) => {
				gateOptions = options;
				return new Promise((resolve) => {
					const finish = () => resolve({
						agent: "reviewer",
						task: options.task,
						exitCode: 1,
						messages: [{ role: "assistant", content: [{ type: "text", text: "CURRENT GATE PARTIAL" }], stopReason: "aborted" }],
						stderr: "",
						usage: { input: 2, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 4, turns: 1 },
						stopReason: "aborted",
						errorMessage: "Subagent was aborted",
					} as any);
					if (options.signal.aborted) finish();
					else options.signal.addEventListener("abort", finish, { once: true });
				});
			});

		register(stub.api);
		const tool = stub.tools.find((candidate) => candidate.name === "subagent");
		const stopTool = stub.tools.find((candidate) => candidate.name === "subagent_stop");
		const dispatched = await runTool(tool, "call-chain-stop", { agent: "worker", task: "Implement the change" }, executionContext());
		const runId = dispatched.details.results[0].runId;
		await vi.waitFor(() => expect(gateOptions).toBeDefined());

		await runTool(stopTool, "stop-chain", { id: String(runId) }, executionContext());
		expect(stub.messages).toHaveLength(1);
		expect(stub.messages[0].message.content).toContain("CURRENT GATE PARTIAL");
		expect(stub.messages[0].message.content).not.toContain("OLD WORKER REPORT");
		await shutdownExtension(stub);
	});

	it("delivers a REVIEW_FAIL review directly when worker is disabled", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		if (!testAgentDir) throw new Error("test agent directory was not initialized");
		writeFileSync(join(testAgentDir, "pi-subagents.json"), JSON.stringify({
			enabledAgents: ["reviewer"],
			announcedFeatures: ["cleanerDefaulted", "documenterDefaulted"],
		}), "utf8");
		const stub = makeStub();
		const { tasks: capturedTasks, controllers } = captureEnqueue();
		vi.spyOn(spawn, "runSingleAgentWithMainFallback").mockResolvedValue({
			agent: "reviewer",
			task: "Gate without worker",
			exitCode: 0,
			messages: [{ role: "assistant", content: [{ type: "text", text: "REQUEST_CHANGES\nVERDICT: REVIEW_FAIL" }], stopReason: "stop" }],
			stderr: "",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 },
		} as any);

		try {
			register(stub.api);
			const tool = stub.tools.find((candidate) => candidate.name === "subagent");
			await runTool(tool, "call-no-worker", { agent: "reviewer", task: "Gate without worker" }, executionContext());
			await capturedTasks[0](controllers[0].signal);
			expect(capturedTasks).toHaveLength(1);
			vi.advanceTimersByTime(150);
			expect(stub.messages).toHaveLength(1);
			expect(stub.messages[0].message.content).toContain("VERDICT: REVIEW_FAIL");
			expect(monitor.getRuns().find((run) => run.activity === "managed workflow running")).toBeUndefined();
		} finally {
			await shutdownExtension(stub, { controllers });
		}
	});


	it("delivers a dispatch-crashed reviewer as a failure, never as a phantom fix chain", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const stub = makeStub();
		const uiNotify = vi.fn();
		const { tasks: capturedTasks, controllers } = captureEnqueue();

		// Point argv[1] at a fake child anyway: if the rejection below fails to
		// intercept, the test fails on assertions instead of spawning real pi.
		const restoreChild = fakeChild(`send({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "REQUEST_CHANGES\\nVERDICT: REVIEW_FAIL" }], stopReason: "stop" } });`);

		try {
			register(stub.api);
			const tool = stub.tools.find((candidate) => candidate.name === "subagent");
			await runTool(tool, "call-crash", { agent: "reviewer", task: "Review the change" }, executionContext({ uiNotify }));
			expect(capturedTasks).toHaveLength(1);

			// The dispatch layer throws (spawn infra, fs, ...): the crash result must
			// be delivered as a failure and never fed into the auto-fix gate — a
			// crashed reviewer's output is not a review verdict, so no chain may
			// start and no "auto-fix chain running" activity may appear.
			const spy = vi.spyOn(spawn, "runSingleAgentWithMainFallback").mockRejectedValueOnce(new Error("spawn infra exploded"));
			await capturedTasks[0](controllers[0].signal);
			spy.mockRestore();

			expect(capturedTasks).toHaveLength(1);
			vi.advanceTimersByTime(150);
			expect(stub.messages).toHaveLength(1);
			const content = stub.messages[0].message.content as string;
			expect(content).toContain("### [reviewer] failed");
			expect(content).toContain("spawn infra exploded");
			expect(stub.messages[0].options).toEqual({ deliverAs: "steer", triggerTurn: true });
			expect(uiNotify).toHaveBeenCalledWith("✗ reviewer dispatch failed: spawn infra exploded", "error");
			expect(monitor.getRuns().find((run) => run.activity === "managed workflow running")).toBeUndefined();
		} finally {
			restoreChild();
			await shutdownExtension(stub, { controllers });
		}
	});

	it("delivers a crashed reviewer with a trailing REVIEW_FAIL partial as a failure, without a fix chain", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const stub = makeStub();
		const uiNotify = vi.fn();
		const { tasks: capturedTasks, controllers } = captureEnqueue();

			const restoreChild = fakeChild(`send({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "I found issues.\\nVERDICT: REVIEW_FAIL" }], stopReason: "error" } });`);
		try {

			register(stub.api);
			const tool = stub.tools.find((candidate) => candidate.name === "subagent");
			await runTool(tool, "call-crash2", { agent: "reviewer", task: "Review the change" }, executionContext({ uiNotify }));
			expect(capturedTasks).toHaveLength(1);

			// The child crashed (non-zero exit, error stop reason) after emitting a
			// partial report that ends in VERDICT: REVIEW_FAIL. A crash is not a
			// review verdict: the failure is delivered and no chain may start.
			await capturedTasks[0](controllers[0].signal);

			expect(capturedTasks).toHaveLength(1);
			expect(stub.messages).toHaveLength(1);
			const content = stub.messages[0].message.content as string;
			expect(content).toContain("### [reviewer] failed");
			expect(content).toContain("VERDICT: REVIEW_FAIL");
			expect(stub.messages[0].options).toEqual({ deliverAs: "steer", triggerTurn: true });
			expect(uiNotify).toHaveBeenCalledTimes(1);
			expect(monitor.getRuns().find((run) => run.activity === "managed workflow running")).toBeUndefined();
		} finally {
			restoreChild();
			await shutdownExtension(stub, { controllers });
		}
	});
});

describe("before_agent_start injection", () => {
	it("appends a delegation directive built from the shipped agents", async () => {
		const stub = makeStub();
		register(stub.api);
		const hook = stub.hooks["before_agent_start"];
		const result = await hook({ systemPrompt: "BASE PROMPT" }, { cwd: process.cwd() });
		expect(result).toBeDefined();
		expect(result.systemPrompt.startsWith("BASE PROMPT")).toBe(true);
		expect(result.systemPrompt).toContain("Sub-agent delegation");
		// Fresh-install default enabled set: explorer, worker, cleaner, reviewer.
		expect(result.systemPrompt).toContain("- explorer:");
		expect(result.systemPrompt).toContain("- worker:");
		expect(result.systemPrompt).toContain("- cleaner:");
		expect(result.systemPrompt).not.toContain("- documenter:");
		expect(result.systemPrompt).toContain("- reviewer:");
		expect(result.systemPrompt).not.toContain("- plan:");
	});

	it("excludes untrusted project agent overrides from injection and dispatch", async () => {
		if (!testAgentDir) throw new Error("test agent directory was not initialized");
		writeFileSync(join(testAgentDir, "pi-subagents.json"), JSON.stringify({
			agentScope: "both",
			enabledAgents: ["worker"],
			announcedFeatures: ["cleanerDefaulted", "documenterDefaulted"],
		}), "utf8");
		const project = mkdtempSync(join(tmpdir(), "pi-subagents-untrusted-project-"));
		const projectAgents = join(project, ".pi", "agents");
		mkdirSync(projectAgents, { recursive: true });
		writeFileSync(join(projectAgents, "worker.md"), [
			"---",
			"name: worker",
			"description: MALICIOUS PROJECT OVERRIDE",
			"---",
			"MALICIOUS PROJECT SYSTEM PROMPT",
		].join("\n"), "utf8");
		const stub = makeStub();
		const { tasks, controllers } = captureEnqueue();
		const run = vi.spyOn(spawn, "runSingleAgentWithMainFallback").mockResolvedValue({
			agent: "worker",
			task: "safe task",
			exitCode: 0,
			messages: [],
			stderr: "",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		} as any);
		const untrustedCtx = {
			...executionContext(),
			cwd: project,
			isProjectTrusted: () => false,
		};

		try {
			register(stub.api);
			const injection = await stub.hooks["before_agent_start"](
				{ systemPrompt: "BASE PROMPT" },
				untrustedCtx,
			);
			expect(injection.systemPrompt).toContain("- worker:");
			expect(injection.systemPrompt).not.toContain("MALICIOUS PROJECT");

			const tool = stub.tools.find((candidate) => candidate.name === "subagent");
			await runTool(tool, "untrusted-dispatch", { agent: "worker", task: "safe task" }, untrustedCtx);
			await tasks[0](controllers[0].signal);
			expect(run).toHaveBeenCalledTimes(1);
			const options = run.mock.calls[0]![0]!;
			expect(options.agent!.source).toBe("builtin");
			expect(options.agent!.systemPrompt).not.toContain("MALICIOUS PROJECT");
		} finally {
			await shutdownExtension(stub, { controllers });
			rmSync(project, { recursive: true, force: true });
		}
	});
});

describe("selected agent model dispatch", () => {
	const AVAILABLE = [
		{ provider: "openai", id: "current", reasoning: false, input: ["text"] },
		{ provider: "anthropic", id: "sonnet", reasoning: true, input: ["text"], thinkingLevelMap: { max: "max" } },
	];

	/** Register, run one dispatch with the given config, and return the captured
	 * enqueue task and the spawn spy for model assertions. */
	async function dispatchWithConfig(
		config: Record<string, unknown>,
		uiNotify: ReturnType<typeof vi.fn>,
	): Promise<{ controller: AbortController; runSpy: ReturnType<typeof vi.spyOn> }> {
		if (!testAgentDir) throw new Error("test agent directory was not initialized");
		writeFileSync(join(testAgentDir, "pi-subagents.json"), JSON.stringify(config), "utf8");
		const stub = makeStub();
		const captured: BackgroundTask[] = [];
		const controller = new AbortController();
		vi.spyOn(BackgroundTaskQueue.prototype, "enqueue").mockImplementation((task) => {
			captured.push(task);
			return controller;
		});
		const runSpy = vi
			.spyOn(spawn, "runSingleAgentWithMainFallback")
			.mockResolvedValue({
				agent: "reviewer",
				task: "Review the change",
				exitCode: 0,
				messages: [],
				stderr: "",
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
			} as any);
		register(stub.api);
		const tool = stub.tools.find((candidate) => candidate.name === "subagent");
		await runTool(tool, "call-model", { agent: "reviewer", task: "Review the change" }, { ...executionContext({ uiNotify }), model: AVAILABLE[0], modelRegistry: { getAvailable: () => AVAILABLE } });
		expect(captured).toHaveLength(1);
		await captured[0](controller.signal);
		expect(runSpy).toHaveBeenCalledTimes(1);
		return { controller, runSpy };
	}

	it("skips a stale selected agent model and preserves only the selection", async () => {
		const uiNotify = vi.fn();
		const { controller, runSpy } = await dispatchWithConfig(
			{
				agentModels: { reviewer: "removed/primary" },
				agentBackupModels: { reviewer: "legacy/backup" },
			},
			uiNotify,
		);
		expect(runSpy.mock.calls[0][0].agent.model).toBe("openai/current");
		expect(runSpy.mock.calls[0][1]).toBeUndefined();
		const saved = JSON.parse(readFileSync(join(testAgentDir!, "pi-subagents.json"), "utf8"));
		expect(saved.agentModels.reviewer).toBe("removed/primary");
		expect(saved).not.toHaveProperty("agentBackupModels");
		controller.abort();
	});

	it("routes a configured agent model with capability-clamped thinking", async () => {
		const uiNotify = vi.fn();
		const { controller, runSpy } = await dispatchWithConfig(
			{ agentModels: { reviewer: "anthropic/sonnet" } },
			uiNotify,
		);
		const options = runSpy.mock.calls[0][0];
		expect(options.agent.model).toBe("anthropic/sonnet");
		expect(options.thinkingLevelForModel("openai/current")).toBe("off");
		expect(runSpy.mock.calls[0][1]).toBe("openai/current");
		controller.abort();
	});
});

