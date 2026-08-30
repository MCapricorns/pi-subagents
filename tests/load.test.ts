import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BackgroundTaskQueue, type BackgroundTask } from "../src/background.ts";
import { BUILTIN_AGENT_NAMES } from "../src/config.ts";
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
		// Steady-state bookkeeping: every shipped built-in has been surfaced, so
		// loadConfig must not re-enable roles this suite disabled on purpose.
		knownAgents: [...BUILTIN_AGENT_NAMES],
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
		// No status/poll tool and no wait tool: results deliver themselves as
		// completion wake-ups. The only in-turn block is `wait: true` on the
		// dispatch that starts the runs, for one-shot pi -p parents.
		expect(stub.tools.map((t) => t.name)).toEqual(["subagent", "subagent_control", "subagent_stop"]);
		expect(stub.commands).toContain("subagents-setup");
		expect(stub.commands).not.toContain("subagents-inspect");
		expect(typeof stub.hooks["before_agent_start"]).toBe("function");

		const tool = stub.tools.find((t) => t.name === "subagent");
		expect(tool.promptGuidelines).toBeUndefined();
		expect(tool.description).toContain("Dispatching never blocks your turn");
		expect(tool.description).toContain("Put every genuinely independent unit in one `tasks` array");
		expect(tool.description).toContain("there is no per-call cap");
		expect(tool.description).toContain("Parallel write-capable agents default to a detached Git worktree");
		expect(tool.description).toContain("never silently falls back to shared");
		expect(tool.description).toContain("never poll or restate delivered results");
		expect(tool.description).toContain("continues the retained session on the current main model");
		expect(tool.description).not.toContain("DOCUMENTATION:");
		expect(tool.promptSnippet).toContain("never blocks your turn");
		expect(`${tool.description}\n${tool.promptSnippet}`).not.toMatch(/[\u4e00-\u9fff]/u);
		expect(tool.parameters.properties.task).toMatchObject({ minLength: 1, pattern: "\\S" });
		expect(tool.parameters.properties.tasks.items.properties.task).toMatchObject({ minLength: 1, pattern: "\\S" });
		expect(tool.parameters.properties.isolation).toBeDefined();
		expect(tool.parameters.properties.tasks.items.properties.isolation).toBeDefined();
		const control = stub.tools.find((t) => t.name === "subagent_control");
		expect(control.promptSnippet).toContain("Resume a parked or settled subagent thread");
	});

	it("keeps the parent-paid tool prompt surface within budget", () => {
		const stub = makeStub();
		register(stub.api);
		// Policy lives once in the always-injected directive, so tool text carries
		// call-time mechanics only.
		const parentPaid = stub.tools.reduce((total: number, tool: any) =>
			total + [tool.description, tool.promptSnippet, ...(tool.promptGuidelines ?? [])].join(" ").length, 0);
		expect(parentPaid).toBeLessThan(2_500);
	});

	it("points a first run without a config file at /subagents-setup", async () => {
		if (!testAgentDir) throw new Error("test agent directory was not initialized");
		const stub = makeStub();
		register(stub.api);
		const notify = vi.fn();
		const setWidget = vi.fn();
		expect(typeof stub.hooks["session_start"]).toBe("function");

		await stub.hooks["session_start"]({}, { mode: "tui", hasUI: true, ui: { notify, setWidget } });
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("run /subagents-setup"), "info");

		// Once the file exists the hint stays silent.
		writeFileSync(join(testAgentDir, "pi-subagents.json"), JSON.stringify({}), "utf8");
		notify.mockClear();
		await stub.hooks["session_start"]({}, { mode: "tui", hasUI: true, ui: { notify, setWidget } });
		expect(notify).not.toHaveBeenCalledWith(expect.stringContaining("/subagents-setup"), "info");
	});

	it("wires recovery, widget install, and config migration through session_start", async () => {
		if (!testAgentDir) throw new Error("test agent directory was not initialized");
		const configPath = join(testAgentDir, "pi-subagents.json");
		const patchPath = join(testAgentDir, "retained.patch");
		writeFileSync(configPath, JSON.stringify({
			enabledAgents: ["explorer", "executor"],
			knownAgents: [...BUILTIN_AGENT_NAMES],
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
		expect(savedConfig.enabledAgents).toEqual(["explorer", "executor"]);

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
			enabledAgents: ["explorer", "executor"],
			agentModels: {
				executor: "gone/old-model",
				explorer: "live/current-model",
			},
			agentThinkingLevels: { explorer: "low" },
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
			"pi-subagents: removed stale agent model overrides that are no longer available (executor: gone/old-model). Those agents now follow the current main model; run /subagents-setup to re-pick.",
			"warning",
		);
		const savedConfig = JSON.parse(readFileSync(configPath, "utf8"));
		expect(savedConfig.agentModels).toEqual({ explorer: "live/current-model" });
		expect(savedConfig.agentThinkingLevels).toEqual({ explorer: "low" });

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

	it("surfaces compaction failures through session_compact_failed", async () => {
		const stub = makeStub();
		register(stub.api);
		const notify = vi.fn();
		expect(typeof stub.hooks["session_compact_failed"]).toBe("function");

		await stub.hooks["session_compact_failed"](
			{ reason: "threshold", errorMessage: "provider 502", aborted: false, willRetry: false },
			{ ui: { notify } },
		);
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("provider 502"), "error");

		notify.mockClear();
		await stub.hooks["session_compact_failed"](
			{ reason: "overflow", errorMessage: "transient", aborted: true, willRetry: true },
			{ ui: { notify } },
		);
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("retrying automatically"), "warning");

		// A user-cancelled compaction stays silent.
		notify.mockClear();
		await stub.hooks["session_compact_failed"](
			{ reason: "manual", aborted: true, willRetry: false },
			{ ui: { notify } },
		);
		expect(notify).not.toHaveBeenCalled();
	});
});

describe("run id matching", () => {
	it("prefers an exact id over prefix matches", () => {
		// "1" must resolve to run 1 only, never fan out to 10/11 (single-digit
		// lookups would otherwise return several full result blocks).
		expect(matchRunIds([1, 10, 11], "1")).toEqual([1]);
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

		const result = await runTool(tool, "call-1", { agent: "executor", task: " \n\t " }, executionContext());

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
					{ agent: "executor", task: "\n\t" },
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
		configureEnabledAgents(["executor"]);
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
			const dispatch = await runTool(tool, "call-valid", { agent: "executor", task }, executionContext());

			expect(dispatch.terminate).toBeUndefined();
			expect(capturedTasks).toHaveLength(1);
			const runId = dispatch.details.results[0].runId;
			expect(runId).toBeTypeOf("number");
			expect(dispatch.content[0].text).toContain(`#${runId} executor`);
			expect(renderToolResult(tool, dispatch)).toContain(`#${runId} executor`);
			await capturedTasks[0](controllers[0].signal, controllers[0]);

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

	it("keeps transient failed tool calls out of a completed run's delivery", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		configureEnabledAgents(["executor"]);
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
			await runTool(tool, "call-f", { agent: "executor", task: "Fix the compile error" }, executionContext());
			await capturedTasks[0](controllers[0].signal, controllers[0]);
			vi.advanceTimersByTime(150);
			expect(stub.messages).toHaveLength(1);
			const content = stub.messages[0].message.content;
			expect(content).toContain("[executor] completed");
			// The agent already worked around them; diagnostics ride along only
			// when the run itself fails.
			expect(content).not.toContain("failed tool call");
			expect(content).not.toContain("MSBuild.exe failed");
			expect(content).not.toContain("fatal error C3861");
			expect(stub.messages[0].options).toEqual({ deliverAs: "steer", triggerTurn: true });
		} finally {
			restoreChild();
			await shutdownExtension(stub, { controllers });
		}
	});

	it("dispatch with wait: true blocks for the result in-turn instead of sleeping", async () => {
		configureEnabledAgents(["executor"]);
		const stub = makeStub();
		const { tasks: capturedTasks, controllers } = captureEnqueue();

			const restoreChild = fakeChild(`send({
	type: "message_end",
	message: {
		role: "assistant",
		content: [{ type: "text", text: "executor result payload" }],
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 }, totalTokens: 0 },
		stopReason: "stop"
	}
});`);
		try {

			register(stub.api);
			const tool = stub.tools.find((candidate) => candidate.name === "subagent");

			// wait: true holds the dispatch call open until the run settles, then
			// hands back the result in-turn (a one-shot pi -p parent has no
			// wake-up message to end its turn into).
			const waitPromise = tool.execute(
				"call-w",
				{ agent: "executor", task: "Fix the build", wait: true },
				new AbortController().signal,
				() => {},
				executionContext(),
			);
			await waitFor(() => capturedTasks.length === 1);
			await capturedTasks[0](controllers[0].signal, controllers[0]);
			const waitResult = await waitPromise;

			const text = waitResult.content[0].text;
			expect(text).toContain("waited in-turn");
			expect(text).toContain("### [executor] completed");
			expect(text).toContain("executor result payload");
			expect(text).toContain("Task: Fix the build");
		} finally {
			restoreChild();
			await shutdownExtension(stub, { controllers });
		}
	});

	it("dispatch with wait: true resolves when the calling turn's signal is aborted", async () => {
		const stub = makeStub();
		const { tasks: capturedTasks, controllers } = captureEnqueue();

		try {
			register(stub.api);
			const tool = stub.tools.find((candidate) => candidate.name === "subagent");

			// The captured task never runs, so the run stays active; aborting the
			// turn resolves the pending wait with a note instead of hanging.
			const midWait = new AbortController();
			const pending = tool.execute(
				"call-wa",
				{ agent: "executor", task: "Long task", wait: true },
				midWait.signal,
				() => {},
				executionContext(),
			);
			await waitFor(() => capturedTasks.length === 1);
			midWait.abort();
			const aborted = await pending;
			expect(aborted.content[0].text).toContain("waited in-turn");
			expect(aborted.content[0].text).toContain("wait aborted");
		} finally {
			await shutdownExtension(stub, { controllers });
		}
	});

	it("subagent_stop cancels active runs and resolves waiters with an aborted result", async () => {
		const stub = makeStub();
		const { tasks: capturedTasks, controllers } = captureEnqueue();

		try {
			register(stub.api);
			const tool = stub.tools.find((candidate) => candidate.name === "subagent");
			const stopTool = stub.tools.find((candidate) => candidate.name === "subagent_stop");
			expect(stopTool).toBeDefined();

			// Unknown id: nothing to stop.
			const unknown = await runTool(stopTool, "stop-x", { id: "99" }, executionContext());
			expect(unknown.content[0].text).toContain('No subagent thread matches "99"');

			// A dispatch waiting in-turn blocks on the queued run; stopping resolves
			// it with the aborted result.
			const waitPromise = tool.execute(
				"call-st",
				{ agent: "executor", task: "Long task", wait: true },
				new AbortController().signal,
				() => {},
				executionContext(),
			);
			await waitFor(() => monitor.getRuns().some((run) => run.task === "Long task"));
			const runId = monitor.getRuns().find((run) => run.task === "Long task")?.id;
			expect(runId).toBeDefined();
			const stopped = await runTool(stopTool, "stop-1", { id: String(runId) }, executionContext());
			expect(stopped.content[0].text).toContain(`Stopped 1 thread: #${runId} executor (queued)`);

			const waited = await waitPromise;
			expect(waited.content[0].text).toContain("### [executor] failed");
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
		configureEnabledAgents(["explorer", "executor"]);
		const stub = makeStub();
		const { tasks: capturedTasks, controllers } = captureEnqueue();

			const restoreChild = fakeChild(`send({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "batch result" }], stopReason: "stop" } });`);
		try {

			register(stub.api);
			const tool = stub.tools.find((candidate) => candidate.name === "subagent");
			const dispatch = await runTool(tool, "call-batch", {
					tasks: [
						{ agent: "explorer", task: "Inspect the change" },
						{ agent: "executor", task: "Review the change" },
					],
				}, executionContext());

			expect(dispatch.terminate).toBeUndefined();
			expect(capturedTasks).toHaveLength(2);
			const runIds = dispatch.details.results.map((result: any) => result.runId as number);
			const renderedDispatch = renderToolResult(tool, dispatch);
			for (const [index, runId] of runIds.entries()) {
				const agent = index === 0 ? "explorer" : "executor";
				expect(dispatch.content[0].text).toContain(`#${runId} ${agent}`);
				expect(renderedDispatch).toContain(`#${runId} ${agent}`);
			}
			for (let index = 0; index < capturedTasks.length; index++) {
				await capturedTasks[index](controllers[index].signal, controllers[index]);
			}
			expect(stub.messages).toHaveLength(0);

			vi.advanceTimersByTime(150);
			expect(stub.messages).toHaveLength(1);
			const completion = stub.messages[0];
			expect(completion.message.content).toContain("### Subagents completed (2): explorer, executor");
			expect(completion.message.content).toContain("### [explorer] completed");
			expect(completion.message.content).toContain("### [executor] completed");
			for (const runId of runIds) expect(completion.message.content).toContain(`run #${runId}`);
			expect(completion.options).toEqual({ deliverAs: "steer", triggerTurn: true });
		} finally {
			restoreChild();
			await shutdownExtension(stub, { controllers });
		}
	});

	it("emits a failure immediately ahead of held successes", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		configureEnabledAgents(["explorer", "executor"]);
		const stub = makeStub();
		const { tasks: capturedTasks, controllers } = captureEnqueue();

			const restoreChild = fakeChild(`const failed = input.includes("must fail");
const text = failed ? "synthetic failure" : "successful result";
send({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }], stopReason: failed ? "error" : "stop" } });`);
		try {

			register(stub.api);
			const tool = stub.tools.find((candidate) => candidate.name === "subagent");
			await runTool(tool, "call-failure", {
					tasks: [
						{ agent: "explorer", task: "succeed first" },
						{ agent: "executor", task: "must fail now" },
					],
				}, executionContext());

			expect(capturedTasks).toHaveLength(2);
			await capturedTasks[0](controllers[0].signal, controllers[0]);
			expect(stub.messages).toHaveLength(0);

			await capturedTasks[1](controllers[1].signal, controllers[1]);
			expect(stub.messages).toHaveLength(2);
			expect(stub.messages[0].message.content).toContain("### [executor] failed");
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
			await runTool(tool, "call-truncate", { agent: "executor", task: "Review the change" }, executionContext());

			await tasks[0](controllers[0].signal, controllers[0]);
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

const makeResult = (agent: string, task: string, text: string, overrides: Record<string, unknown> = {}): any => ({
	agent,
	task,
	exitCode: 0,
	messages: [{ role: "assistant", content: [{ type: "text", text }], stopReason: "stop" }],
	stderr: "",
	usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 },
	...overrides,
});

describe("shared-repository lane", () => {
	it("reports a lane-serialized shared writer truthfully instead of as slot queueing", async () => {
		configureEnabledAgents(["executor"]);
		const stub = makeStub();
		const { tasks: queued, controllers } = captureEnqueue();
		let releaseWriter!: () => void;
		const writerGate = new Promise<void>((resolveWriter) => {
			releaseWriter = resolveWriter;
		});
		vi.spyOn(spawn, "runSingleAgentWithMainFallback").mockImplementation(async (options: any) => {
			if (options.task === "First shared writer") {
				await writerGate;
				return makeResult("executor", options.task, "writer report");
			}
			return makeResult("executor", options.task, "second writer report");
		});

		try {
			register(stub.api);
			const tool = stub.tools.find((candidate) => candidate.name === "subagent");
			const first = await runTool(tool, "lane-first", { agent: "executor", task: "First shared writer" }, executionContext());
			const second = await runTool(tool, "lane-second", { agent: "executor", task: "Second shared writer" }, executionContext());
			const firstId = first.details.results[0].runId as number;
			const secondId = second.details.results[0].runId as number;
			const firstRun = queued[0](controllers[0].signal, controllers[0]);
			await waitFor(() => monitor.findRun(firstId)?.waitReason === "starting");
			const secondRun = queued[1](controllers[1].signal, controllers[1]);
			await waitFor(() => monitor.findRun(secondId)?.waitReason === "repository-lane");
			expect(monitor.findRun(secondId)?.status).toBe("queued");

			// A third dispatch's confirmation separates slot pacing from lane
			// serialization so the model never reads the pool as exhausted.
			const probe = await runTool(tool, "lane-probe", { agent: "executor", task: "Probe pacing" }, executionContext());
			const confirmation = probe.content[0].text as string;
			expect(confirmation).toContain("1 waiting for a free process slot");
			expect(confirmation).toContain("waiting for the repository write lane — write serialization, not slot capacity");
			expect(confirmation).toContain("Keep dispatching independent units");

			releaseWriter();
			await Promise.all([firstRun, secondRun]);
		} finally {
			releaseWriter();
			await shutdownExtension(stub, { controllers });
		}
	});

	it("keeps a shared-checkout writer behind a running writer across nested paths", async () => {
		configureEnabledAgents(["executor"]);
		const { execFileSync } = await import("node:child_process");
		const repo = mkdtempSync(join(tmpdir(), "pi-subagents-empty-lane-"));
		execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
		const nested = join(repo, "nested");
		mkdirSync(nested, { recursive: true });
		const stub = makeStub();
		const { tasks: queued, controllers } = captureEnqueue();
		const order: string[] = [];
		let releaseFirst!: () => void;
		const firstGate = new Promise<void>((resolveFirst) => {
			releaseFirst = resolveFirst;
		});
		vi.spyOn(spawn, "runSingleAgentWithMainFallback").mockImplementation(async (options: any) => {
			if (options.task === "First writer") {
				order.push("first writer");
				await firstGate;
				return makeResult("executor", options.task, "first report");
			}
			order.push("nested writer");
			return makeResult("executor", options.task, "nested report");
		});

		try {
			register(stub.api);
			const tool = stub.tools.find((candidate) => candidate.name === "subagent");
			await runTool(tool, "writer-first", { agent: "executor", task: "First writer", cwd: repo }, executionContext());
			await runTool(tool, "nested-writer", { agent: "executor", task: "Nested writer", cwd: nested }, executionContext());
			const firstRun = queued[0](controllers[0].signal, controllers[0]);
			await vi.waitFor(() => expect(order).toEqual(["first writer"]));
			const nestedRun = queued[1](controllers[1].signal, controllers[1]);
			await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
			expect(order).toEqual(["first writer"]);

			releaseFirst();
			await Promise.all([firstRun, nestedRun]);
			expect(order).toEqual(["first writer", "nested writer"]);
		} finally {
			releaseFirst();
			await shutdownExtension(stub, { controllers });
			rmSync(repo, { recursive: true, force: true });
		}
	});

	it("lets a read-only dispatch start while a shared writer holds the lane", async () => {
		configureEnabledAgents(["executor", "explorer"]);
		const stub = makeStub();
		const { tasks: queued, controllers } = captureEnqueue();
		const order: string[] = [];
		let releaseWriter!: () => void;
		const writerGate = new Promise<void>((resolveWriter) => {
			releaseWriter = resolveWriter;
		});
		vi.spyOn(spawn, "runSingleAgentWithMainFallback").mockImplementation(async (options: any) => {
			if (options.task === "Shared writer") {
				order.push("writer");
				await writerGate;
				return makeResult("executor", options.task, "writer report");
			}
			order.push("direct explorer");
			return makeResult("explorer", options.task, "recon report");
		});

		try {
			register(stub.api);
			const tool = stub.tools.find((candidate) => candidate.name === "subagent");
			await runTool(tool, "shared-writer", { agent: "executor", task: "Shared writer" }, executionContext());
			await runTool(tool, "direct-explorer", { agent: "explorer", task: "Direct recon" }, executionContext());
			const writerRun = queued[0](controllers[0].signal, controllers[0]);
			await vi.waitFor(() => expect(order).toEqual(["writer"]));
			const explorerRun = queued[1](controllers[1].signal, controllers[1]);
			await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
			// Read-only dispatches never reserve the lane, so the explorer starts
			// while the writer still holds it.
			expect(order).toEqual(["writer", "direct explorer"]);

			releaseWriter();
			await Promise.all([writerRun, explorerRun]);
		} finally {
			releaseWriter();
			await shutdownExtension(stub, { controllers });
		}
	});

	it("serializes concurrent shared writers that edit the same repository", async () => {
		const stub = makeStub();
		const { tasks: capturedTasks, controllers } = captureEnqueue();
		const repo = mkdtempSync(join(tmpdir(), "pi-subagents-lane-serialized-"));
		let activeWriters = 0;
		let maxActiveWriters = 0;
		let writerStarts = 0;
		const writerReleases: Array<() => void> = [];
		vi.spyOn(spawn, "runSingleAgentWithMainFallback").mockImplementation(async (options: any) => {
			writerStarts++;
			activeWriters++;
			maxActiveWriters = Math.max(maxActiveWriters, activeWriters);
			try {
				await new Promise<void>((resolveWriter) => writerReleases.push(resolveWriter));
				return makeResult("executor", options.task, "fixed");
			} finally {
				activeWriters--;
			}
		});

		try {
			register(stub.api);
			const tool = stub.tools.find((candidate) => candidate.name === "subagent");
			await Promise.all([
				runTool(tool, "writer-a", { agent: "executor", task: "Implement A", cwd: repo }, executionContext()),
				runTool(tool, "writer-b", { agent: "executor", task: "Implement B", cwd: repo }, executionContext()),
			]);
			expect(capturedTasks).toHaveLength(2);
			const runs = [
				capturedTasks[0](controllers[0].signal, controllers[0]),
				capturedTasks[1](controllers[1].signal, controllers[1]),
			];
			await vi.waitFor(() => expect(writerStarts).toBe(1));
			await new Promise((resolveDelay) => setTimeout(resolveDelay, 30));
			// The first writer holds the shared-repository lane, so the second
			// writer cannot start in the same checkout yet.
			expect(writerStarts).toBe(1);
			expect(maxActiveWriters).toBe(1);

			writerReleases[0]!();
			await vi.waitFor(() => expect(writerStarts).toBe(2));
			expect(maxActiveWriters).toBe(1);
			writerReleases[1]!();
			await Promise.all(runs);
		} finally {
			for (const release of writerReleases) release();
			await shutdownExtension(stub, { controllers });
			rmSync(repo, { recursive: true, force: true });
		}
	});

	it("runs the dispatch in the caller's explicit cwd", async () => {
		configureEnabledAgents(["executor"]);
		const stub = makeStub();
		const { tasks: capturedTasks, controllers } = captureEnqueue();
		const outerRepo = mkdtempSync(join(tmpdir(), "pi-subagents-cwd-outer-"));
		const targetRepo = mkdtempSync(join(tmpdir(), "pi-subagents-cwd-target-"));
		const run = vi.spyOn(spawn, "runSingleAgentWithMainFallback").mockImplementation(async (options: any) =>
			makeResult("executor", options.task, "fixed target repo"));

		try {
			register(stub.api);
			const tool = stub.tools.find((candidate) => candidate.name === "subagent");
			await runTool(tool, "call-cwd", { agent: "executor", task: "Implement target repo", cwd: targetRepo }, { ...executionContext(), cwd: outerRepo });
			await capturedTasks[0](controllers[0].signal, controllers[0]);
			expect(capturedTasks).toHaveLength(1);

			expect(run).toHaveBeenCalledTimes(1);
			const options = run.mock.calls[0]![0]!;
			expect(options.defaultCwd).toBe(targetRepo);
			expect(options.cwd).toBe(targetRepo);
			// Successful runs deliver through the completion batcher debounce.
			await waitFor(() => stub.messages.length > 0);
			expect(stub.messages).toHaveLength(1);
		} finally {
			await shutdownExtension(stub, { controllers });
			rmSync(outerRepo, { recursive: true, force: true });
			rmSync(targetRepo, { recursive: true, force: true });
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
		// Fresh-install default enabled set: every shipped agent.
		expect(result.systemPrompt).toContain("- explorer:");
		expect(result.systemPrompt).toContain("- executor:");
		expect(result.systemPrompt).not.toContain("- plan:");
	});

	it("excludes untrusted project agent overrides from injection and dispatch", async () => {
		if (!testAgentDir) throw new Error("test agent directory was not initialized");
		writeFileSync(join(testAgentDir, "pi-subagents.json"), JSON.stringify({
			agentScope: "both",
			enabledAgents: ["executor"],
			knownAgents: [...BUILTIN_AGENT_NAMES],
			announcedFeatures: ["cleanerDefaulted", "documenterDefaulted"],
		}), "utf8");
		const project = mkdtempSync(join(tmpdir(), "pi-subagents-untrusted-project-"));
		const projectAgents = join(project, ".pi", "agents");
		mkdirSync(projectAgents, { recursive: true });
		writeFileSync(join(projectAgents, "executor.md"), [
			"---",
			"name: executor",
			"description: MALICIOUS PROJECT OVERRIDE",
			"---",
			"MALICIOUS PROJECT SYSTEM PROMPT",
		].join("\n"), "utf8");
		const stub = makeStub();
		const { tasks, controllers } = captureEnqueue();
		const run = vi.spyOn(spawn, "runSingleAgentWithMainFallback").mockResolvedValue({
			agent: "executor",
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
			expect(injection.systemPrompt).toContain("- executor:");
			expect(injection.systemPrompt).not.toContain("MALICIOUS PROJECT");

			const tool = stub.tools.find((candidate) => candidate.name === "subagent");
			await runTool(tool, "untrusted-dispatch", { agent: "executor", task: "safe task" }, untrustedCtx);
			await tasks[0](controllers[0].signal, controllers[0]);
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
				agent: "executor",
				task: "Review the change",
				exitCode: 0,
				messages: [],
				stderr: "",
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
			} as any);
		register(stub.api);
		const tool = stub.tools.find((candidate) => candidate.name === "subagent");
		await runTool(tool, "call-model", { agent: "executor", task: "Review the change" }, { ...executionContext({ uiNotify }), model: AVAILABLE[0], modelRegistry: { getAvailable: () => AVAILABLE } });
		expect(captured).toHaveLength(1);
		await captured[0](controller.signal, controller);
		expect(runSpy).toHaveBeenCalledTimes(1);
		return { controller, runSpy };
	}

	it("skips a stale selected agent model and preserves only the selection", async () => {
		const uiNotify = vi.fn();
		const { controller, runSpy } = await dispatchWithConfig(
			{
				agentModels: { executor: "removed/primary" },
				agentBackupModels: { executor: "legacy/backup" },
			},
			uiNotify,
		);
		expect(runSpy.mock.calls[0][0].agent.model).toBe("openai/current");
		expect(runSpy.mock.calls[0][1]).toBeUndefined();
		const saved = JSON.parse(readFileSync(join(testAgentDir!, "pi-subagents.json"), "utf8"));
		expect(saved.agentModels.executor).toBe("removed/primary");
		expect(saved).not.toHaveProperty("agentBackupModels");
		controller.abort();
	});

	it("routes a configured agent model with capability-clamped thinking", async () => {
		const uiNotify = vi.fn();
		const { controller, runSpy } = await dispatchWithConfig(
			{ agentModels: { executor: "anthropic/sonnet" } },
			uiNotify,
		);
		const options = runSpy.mock.calls[0][0];
		expect(options.agent.model).toBe("anthropic/sonnet");
		expect(options.thinkingLevelForModel("openai/current")).toBe("off");
		expect(runSpy.mock.calls[0][1]).toBe("openai/current");
		controller.abort();
	});
});

