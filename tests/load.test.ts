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
		expect(tool.description).toContain("Successful worker/cleaner runs get one automatic reviewer gate");
		expect(tool.description).toContain('review: "none"');
		expect(tool.description).toContain("A REVIEW_FAIL from a gate you dispatched directly returns its findings to you");
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

			expect(dispatch.terminate).toBeUndefined();
			expect(capturedTasks).toHaveLength(1);
			const runId = dispatch.details.results[0].runId;
			expect(runId).toBeTypeOf("number");
			expect(dispatch.content[0].text).toContain(`#${runId} worker`);
			expect(renderToolResult(tool, dispatch)).toContain(`#${runId} worker`);
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
			await runTool(tool, "call-f", { agent: "worker", task: "Fix the compile error" }, executionContext());
			await capturedTasks[0](controllers[0].signal, controllers[0]);
			vi.advanceTimersByTime(150);
			expect(stub.messages).toHaveLength(1);
			const content = stub.messages[0].message.content;
			expect(content).toContain("[worker] completed");
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

			// wait: true holds the dispatch call open until the run settles, then
			// hands back the result in-turn (a one-shot pi -p parent has no
			// wake-up message to end its turn into).
			const waitPromise = tool.execute(
				"call-w",
				{ agent: "worker", task: "Fix the build", wait: true },
				new AbortController().signal,
				() => {},
				executionContext(),
			);
			await waitFor(() => capturedTasks.length === 1);
			await capturedTasks[0](controllers[0].signal, controllers[0]);
			const waitResult = await waitPromise;

			const text = waitResult.content[0].text;
			expect(text).toContain("waited in-turn");
			expect(text).toContain("### [worker] completed");
			expect(text).toContain("worker result payload");
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
				{ agent: "worker", task: "Long task", wait: true },
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
				{ agent: "worker", task: "Long task", wait: true },
				new AbortController().signal,
				() => {},
				executionContext(),
			);
			await waitFor(() => monitor.getRuns().some((run) => run.task === "Long task"));
			const runId = monitor.getRuns().find((run) => run.task === "Long task")?.id;
			expect(runId).toBeDefined();
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

			expect(dispatch.terminate).toBeUndefined();
			expect(capturedTasks).toHaveLength(2);
			const runIds = dispatch.details.results.map((result: any) => result.runId as number);
			const renderedDispatch = renderToolResult(tool, dispatch);
			for (const [index, runId] of runIds.entries()) {
				const agent = index === 0 ? "explorer" : "reviewer";
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

			await tasks[0](controllers[0].signal, controllers[0]);
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
			await capturedTasks[0](controllers[0].signal, controllers[0]);
			expect(stub.messages).toHaveLength(0);

			await capturedTasks[1](controllers[1].signal, controllers[1]);
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
		configureEnabledAgents(["worker", "reviewer"]);
		const stub = makeStub();
		stub.activeTools = ["read", "powershell", "edit", "write", "custom_extension"];
		const { tasks, controllers } = captureEnqueue();
		const run = vi.spyOn(spawn, "runSingleAgentWithMainFallback").mockImplementation(async (options: any) => {
			if (options.agentName === "worker") {
				stub.activeTools = ["read", "bash", "edit", "write", "custom_extension"];
				return makeResult("worker", options.task, "implemented");
			}
			stub.activeTools = ["read", "bash", "powershell", "edit", "write", "custom_extension"];
			return makeResult("reviewer", options.task, "APPROVE\nVERDICT: REVIEW_PASS");
		});

		try {
			register(stub.api);
			const tool = stub.tools.find((candidate) => candidate.name === "subagent");
			await runTool(tool, "adaptive-tools-chain", { agent: "worker", task: "Implement adaptive tools" }, executionContext());
			await tasks[0](controllers[0].signal, controllers[0]);

			const calls = run.mock.calls.map(([options]) => options);
			expect(calls.map((options) => options.agentName)).toEqual([
				"worker", "reviewer",
			]);
			expect(calls[0].agent.tools).toEqual([
				"read", "powershell", "edit", "write", "custom_extension",
			]);
			expect(calls[1].agent.tools).toEqual([
				"read", "grep", "find", "ls", "bash", "custom_extension",
			]);
		} finally {
			await shutdownExtension(stub, { controllers });
		}
	});

	it("keeps parent and active-stage widget telemetry attributed to their actual roles", async () => {
		configureEnabledAgents(["worker", "reviewer"]);
		const stub = makeStub();
		const { tasks, controllers } = captureEnqueue();
		const workerUsage = { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, cost: 1, contextTokens: 0, turns: 1 };
		const reviewerUsage = { input: 30, output: 3, cacheRead: 0, cacheWrite: 0, cost: 0.2, contextTokens: 0, turns: 1 };
		let reviewerStarted!: () => void;
		const atReviewer = new Promise<void>((resolve) => {
			reviewerStarted = resolve;
		});
		let releaseReviewer!: () => void;
		const reviewerRelease = new Promise<void>((resolve) => {
			releaseReviewer = resolve;
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
			publish("xai/grok-reviewer", "xhigh", reviewerUsage);
			reviewerStarted();
			await reviewerRelease;
			return makeResult("reviewer", options.task, "APPROVE\nVERDICT: REVIEW_PASS", {
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
			const observedProjections: unknown[] = [];
			const unsubscribe = monitor.subscribe(() => {
				const stages = monitor.findRun(parentRunId)?.workflowStages;
				if (stages) observedProjections.push(stages.map((stage) => ({ ...stage })));
			});
			const workflow = tasks[0](controllers[0].signal, controllers[0]);
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
				],
			});
			expect(reviewer).toMatchObject({
				agent: "reviewer",
				model: "xai/grok-reviewer",
				thinking: "xhigh",
				usage: reviewerUsage,
				relationLabel: "final review",
			});

			releaseReviewer();
			await workflow;
			unsubscribe();
			// Settled stages keep their telemetry snapshot (model/usage frozen at
			// settlement) next to the status the flow cares about.
			expect(observedProjections).toContainEqual([
				expect.objectContaining({ agent: "worker", relation: "implement", status: "done", model: "openai/gpt-worker", usage: workerUsage }),
				expect.objectContaining({ agent: "reviewer", relation: "review", status: "done", model: "xai/grok-reviewer", usage: reviewerUsage }),
			]);
		} finally {
			releaseReviewer();
			await shutdownExtension(stub, { controllers });
		}
	});

	it.each([
		["worker", ["worker", "reviewer"]],
		["cleaner", ["cleaner", "reviewer"]],
	] as const)("runs a successful top-level %s through one reviewer gate and delivers", async (topAgent, expectedOrder) => {
		configureEnabledAgents(["explorer", "worker", "cleaner", "documenter", "reviewer"]);
		const stub = makeStub();
		const { tasks, controllers } = captureEnqueue();
		const topTask = `${topAgent} top-level task`;
		const run = vi.spyOn(spawn, "runSingleAgentWithMainFallback").mockImplementation(async (options: any) => {
			if (options.task === topTask) return makeResult(topAgent, options.task, `${topAgent} report src/change.ts`);
			expect(options.agentName).toBe("reviewer");
			expect(options.task).toContain(`${topAgent} report src/change.ts`);
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
			await tasks[0](controllers[0].signal, controllers[0]);

			expect(run.mock.calls.map(([options]) => options.agentName)).toEqual(expectedOrder);
			expect(stub.messages).toHaveLength(1);
			const content = stub.messages[0].message.content as string;
			expect(content).toContain("## Managed workflow:");
			expect(content).toContain("final review · PASS");
			expect(content).not.toContain("final documentation sync");
			expect(content).not.toContain(`- #${parentRunId} `);
			const stepIds = [...content.matchAll(/^- #(\d+) /gmu)].map((match) => Number(match[1]));
			expect(stepIds).toHaveLength(expectedOrder.length);
			expect(new Set(stepIds).size).toBe(expectedOrder.length);
			expect(stub.messages[0].options).toEqual({ deliverAs: "steer", triggerTurn: true });
		} finally {
			await shutdownExtension(stub, { controllers });
		}
	});

	it("keeps documentation drift an ordinary gate finding with no marker contract", async () => {
		configureEnabledAgents(["worker", "documenter", "reviewer"]);
		const stub = makeStub();
		const { tasks, controllers } = captureEnqueue();
		const run = vi.spyOn(spawn, "runSingleAgentWithMainFallback").mockImplementation(async (options: any) => {
			if (options.agentName === "worker") return makeResult("worker", options.task, "implemented src/cache.ts");
			expect(options.agentName).toBe("reviewer");
			expect(options.task).toContain("including documentation drift");
			expect(options.task).not.toContain("DOCUMENTATION:");
			return makeResult("reviewer", options.task, "APPROVE\nVERDICT: REVIEW_PASS");
		});

		try {
			register(stub.api);
			const tool = stub.tools.find((candidate) => candidate.name === "subagent");
			await runTool(tool, "post-writer-gate", { agent: "worker", task: "Implement src/cache.ts" }, executionContext());
			await tasks[0](controllers[0].signal, controllers[0]);

			expect(run.mock.calls.map(([options]) => options.agentName)).toEqual(["worker", "reviewer"]);
			expect(stub.messages).toHaveLength(1);
			expect(stub.messages[0].message.content).toContain("worker → reviewer");
			expect(stub.messages[0].message.content).not.toContain("final documentation sync");
		} finally {
			await shutdownExtension(stub, { controllers });
		}
	});

	it("delivers a review-none worker directly without starting a gate", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		configureEnabledAgents(["worker", "reviewer"]);
		const stub = makeStub();
		const { tasks, controllers } = captureEnqueue();
		const run = vi.spyOn(spawn, "runSingleAgentWithMainFallback").mockImplementation(async (options: any) => {
			if (options.agentName === "reviewer") {
				throw new Error("review: none must not start a reviewer gate");
			}
			return makeResult("worker", options.task, "fixed the typo in src/tiny.ts");
		});

		try {
			register(stub.api);
			const tool = stub.tools.find((candidate) => candidate.name === "subagent");
			await runTool(
				tool,
				"no-gate",
				{ agent: "worker", task: "Fix the typo in src/tiny.ts", review: "none" },
				executionContext(),
			);
			await tasks[0](controllers[0].signal, controllers[0]);
			vi.advanceTimersByTime(150);

			expect(run.mock.calls.map(([options]) => options.agentName)).toEqual(["worker"]);
			expect(stub.messages).toHaveLength(1);
			expect(stub.messages[0].message.content).toContain("### [worker] completed");
			expect(stub.messages[0].message.content).not.toContain("Managed workflow");
		} finally {
			await shutdownExtension(stub, { controllers });
		}
	});

	it("converges a failing gate through reviewer fix stages and fresh re-reviews", async () => {
		configureEnabledAgents(["worker", "documenter", "reviewer"]);
		const stub = makeStub();
		const { tasks, controllers } = captureEnqueue();
		const sessionDir = mkdtempSync(join(tmpdir(), "pi-subagents-gate-session-"));
		const calls: Array<{ agentName: string; stdinText?: string; sessionId?: string }> = [];
		const run = vi.spyOn(spawn, "runSingleAgentWithMainFallback").mockImplementation(async (options: any) => {
			calls.push({
				agentName: options.agentName,
				stdinText: options.stdinText,
				sessionId: options.sessionId,
			});
			if (options.agentName === "worker") return makeResult("worker", options.task, "implemented");
			if (options.stdinText === undefined) {
				// Fresh gate context: first scan fails, the re-review after the fix passes.
				const firstScan = calls.filter((call) => call.agentName === "reviewer" && call.stdinText === undefined).length === 1;
				if (!firstScan) return makeResult("reviewer", options.task, "APPROVE\nVERDICT: REVIEW_PASS");
				return makeResult(
					"reviewer",
					options.task,
					"- src/a.ts:10 — off-by-one breaks the loop — Fix: guard the empty range and re-run vitest\nVERDICT: REVIEW_FAIL",
					{ sessionId: "gate-session", sessionDir },
				);
			}
			// Reviewer fix stage: continues the failing gate's session with write access.
			expect(options.sessionId).toBe("gate-session");
			expect(options.stdinText).toContain("full write access in this same session");
			expect(options.agent.tools).toContain("edit");
			expect(options.agent.systemPrompt).toContain("FIX STAGE");
			return makeResult("reviewer", options.task, "## Fixed\n- src/a.ts — guarded the empty range\n## Verification\n- vitest 3 passed", {
				sessionId: "gate-session",
				sessionDir,
			});
		});

		try {
			register(stub.api);
			const tool = stub.tools.find((candidate) => candidate.name === "subagent");
			await runTool(tool, "gate-converge", { agent: "worker", task: "Implement then converge" }, executionContext());
			await tasks[0](controllers[0].signal, controllers[0]);

			expect(calls.map((call) => call.agentName)).toEqual(["worker", "reviewer", "reviewer", "reviewer"]);
			expect(calls[2]!.stdinText).toContain("Apply every one of your own fix instructions");
			expect(calls[3]!.stdinText).toBeUndefined();
			expect(run.mock.calls[3]![0].task).toContain("This gate CONVERGES");
			expect(stub.messages).toHaveLength(1);
			const content = stub.messages[0].message.content as string;
			expect(content).toContain("final review · FAIL");
			expect(content).toContain("review fix · completed");
			expect(content).toContain("re-review · PASS");
			expect(content).toContain("final PASS");
			// The delivery is the only view of the workflow: the writer's own
			// handoff rides along instead of a pointer to a lookup tool.
			expect(content).toContain("### [worker] completed");
			expect(content).not.toContain("Per-run details");
			expect(content).not.toContain("findings are yours to resolve now");
		} finally {
			await shutdownExtension(stub, { controllers });
			rmSync(sessionDir, { recursive: true, force: true });
		}
	});

	it("hands a still-failing gate back to the main agent after the fix-round cap", async () => {
		configureEnabledAgents(["worker", "documenter", "reviewer"]);
		const stub = makeStub();
		const { tasks, controllers } = captureEnqueue();
		const sessionDir = mkdtempSync(join(tmpdir(), "pi-subagents-gate-session-cap-"));
		const run = vi.spyOn(spawn, "runSingleAgentWithMainFallback").mockImplementation(async (options: any) => {
			if (options.agentName === "worker") return makeResult("worker", options.task, "implemented");
			if (options.stdinText === undefined) {
				return makeResult("reviewer", options.task, "NEW FINDING\nVERDICT: REVIEW_FAIL", {
					sessionId: "gate-session",
					sessionDir,
				});
			}
			return makeResult("reviewer", options.task, "## Fixed\n- patched", { sessionId: "gate-session", sessionDir });
		});

		try {
			register(stub.api);
			const tool = stub.tools.find((candidate) => candidate.name === "subagent");
			await runTool(tool, "gate-cap", { agent: "worker", task: "Never converges" }, executionContext());
			await tasks[0](controllers[0].signal, controllers[0]);

			// worker + gate + 2 × (fix + re-review); the capped failing re-review
			// returns to the main agent with the fix-now note.
			expect(run.mock.calls).toHaveLength(6);
			expect(stub.messages).toHaveLength(1);
			const content = stub.messages[0].message.content as string;
			expect(content).toContain("re-review 2 · FAIL");
			expect(content).toContain("final FAIL");
			expect(content).toContain("findings are yours to resolve now");
		} finally {
			await shutdownExtension(stub, { controllers });
			rmSync(sessionDir, { recursive: true, force: true });
		}
	});

	it("treats a malformed post-writer review as a failed gate and never starts another child", async () => {
		configureEnabledAgents(["worker", "documenter", "reviewer"]);
		const stub = makeStub();
		const { tasks, controllers } = captureEnqueue();
		const run = vi.spyOn(spawn, "runSingleAgentWithMainFallback").mockImplementation(async (options: any) => {
			if (options.agentName === "worker") return makeResult("worker", options.task, "implemented");
			if (options.agentName === "reviewer") {
				return makeResult("reviewer", options.task, "Malformed gate without verdict");
			}
			throw new Error("A malformed gate must not authorize any downstream child");
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
			await tasks[0](controllers[0].signal, controllers[0]);

			expect(run.mock.calls.map(([options]) => options.agentName)).toEqual(["worker", "reviewer"]);
			expect(observedProjections).toContainEqual([
				expect.objectContaining({ agent: "worker", relation: "implement", status: "done" }),
				expect.objectContaining({ agent: "reviewer", relation: "review", status: "failed" }),
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
			await tasks[0](controllers[0].signal, controllers[0]);
			vi.advanceTimersByTime(150);

			expect(run.mock.calls.map(([options]) => options.agentName)).toEqual(["documenter"]);
			expect(stub.messages).toHaveLength(1);
			expect(stub.messages[0].message.content).toContain("### [documenter] completed");
			expect(stub.messages[0].message.content).not.toContain("Managed workflow");
		} finally {
			await shutdownExtension(stub, { controllers });
		}
	});

	it("delivers a direct REVIEW_PASS without chaining any child or docs contract", async () => {
		vi.useFakeTimers();
		configureEnabledAgents(["worker", "documenter", "reviewer"]);
		const stub = makeStub();
		const { tasks, controllers } = captureEnqueue();
		const run = vi.spyOn(spawn, "runSingleAgentWithMainFallback").mockImplementation(async (options: any) => {
			expect(options.agent.systemPrompt).not.toContain("Runtime workflow context");
			return makeResult("reviewer", options.task, "DIRECT PASS REPORT\nAPPROVE\nVERDICT: REVIEW_PASS");
		});

		try {
			register(stub.api);
			const tool = stub.tools.find((candidate) => candidate.name === "subagent");
			await runTool(tool, "direct-pass", { agent: "reviewer", task: "Gate pending diff" }, executionContext());
			await tasks[0](controllers[0].signal, controllers[0]);
			vi.advanceTimersByTime(150);

			expect(run.mock.calls.map(([options]) => options.agentName)).toEqual(["reviewer"]);
			expect(stub.messages).toHaveLength(1);
			expect(stub.messages[0].message.content).toContain("VERDICT: REVIEW_PASS");
			expect(stub.messages[0].message.content).not.toContain("Managed workflow");
		} finally {
			await shutdownExtension(stub, { controllers });
		}
	});

	it("delivers a direct REVIEW_FAIL re-verification with the fix-now note and no chain", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		configureEnabledAgents(["worker", "documenter", "reviewer"]);
		const stub = makeStub();
		const { tasks, controllers } = captureEnqueue();
		const run = vi.spyOn(spawn, "runSingleAgentWithMainFallback").mockImplementation(async (options: any) =>
			// A re-verification gate over work the main agent already fixed itself.
			makeResult("reviewer", options.task, "OPEN FINDING\nVERDICT: REVIEW_FAIL"));

		try {
			register(stub.api);
			const tool = stub.tools.find((candidate) => candidate.name === "subagent");
			await runTool(tool, "reverify", { agent: "reviewer", task: "Re-verify the pending diff after my fixes." }, executionContext());
			await tasks[0](controllers[0].signal, controllers[0]);
			vi.advanceTimersByTime(150);

			expect(run.mock.calls.map(([options]) => options.agentName)).toEqual(["reviewer"]);
			expect(stub.messages).toHaveLength(1);
			expect(stub.messages[0].message.content).toContain("VERDICT: REVIEW_FAIL");
			expect(stub.messages[0].message.content).toContain("findings are yours to resolve now");
			expect(stub.messages[0].message.content).not.toContain("Managed workflow");
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
			await tasks[0](controllers[0].signal, controllers[0]);
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
		[["worker", "documenter"], ["worker"]],
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
			await tasks[0](controllers[0].signal, controllers[0]);
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
			const writerRun = queued[0](controllers[0].signal, controllers[0]);
			await vi.waitFor(() => expect(order).toEqual(["writer"]));
			const reviewerRun = queued[1](controllers[1].signal, controllers[1]);
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

	it("reports a lane-serialized shared writer truthfully instead of as slot queueing", async () => {
		configureEnabledAgents(["worker", "reviewer"]);
		const stub = makeStub();
		const { tasks: queued, controllers } = captureEnqueue();
		let releaseWriter!: () => void;
		const writerGate = new Promise<void>((resolveWriter) => {
			releaseWriter = resolveWriter;
		});
		vi.spyOn(spawn, "runSingleAgentWithMainFallback").mockImplementation(async (options: any) => {
			if (options.task === "First shared writer") {
				await writerGate;
				return makeResult("worker", options.task, "writer report");
			}
			if (options.agentName === "reviewer") return makeResult("reviewer", options.task, "APPROVE\nVERDICT: REVIEW_PASS");
			return makeResult("worker", options.task, "second writer report");
		});

		try {
			register(stub.api);
			const tool = stub.tools.find((candidate) => candidate.name === "subagent");
			const first = await runTool(tool, "lane-first", { agent: "worker", task: "First shared writer" }, executionContext());
			const second = await runTool(tool, "lane-second", { agent: "worker", task: "Second shared writer" }, executionContext());
			const firstId = first.details.results[0].runId as number;
			const secondId = second.details.results[0].runId as number;
			const firstRun = queued[0](controllers[0].signal, controllers[0]);
			await waitFor(() => monitor.findRun(firstId)?.waitReason === "starting");
			const secondRun = queued[1](controllers[1].signal, controllers[1]);
			await waitFor(() => monitor.findRun(secondId)?.waitReason === "repository-lane");
			expect(monitor.findRun(secondId)?.status).toBe("queued");

			// A third dispatch's confirmation separates slot pacing from lane
			// serialization so the model never reads the pool as exhausted.
			const probe = await runTool(tool, "lane-probe", { agent: "worker", task: "Probe pacing" }, executionContext());
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

	it("keeps a shared-checkout documenter behind a running writer across nested paths", async () => {
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
			if (options.task === "Writer first") {
				order.push("writer");
				await writerGate;
				return makeResult("worker", options.task, "writer report");
			}
			order.push("standalone documenter");
			return makeResult("documenter", options.task, "standalone docs report");
		});

		try {
			register(stub.api);
			const tool = stub.tools.find((candidate) => candidate.name === "subagent");
			await runTool(tool, "writer-first", { agent: "worker", task: "Writer first", cwd: repo }, executionContext());
			await runTool(tool, "standalone-docs", { agent: "documenter", task: "Standalone docs", cwd: nested }, executionContext());
			const writerRun = queued[0](controllers[0].signal, controllers[0]);
			await vi.waitFor(() => expect(order).toEqual(["writer"]));
			const documenterRun = queued[1](controllers[1].signal, controllers[1]);
			await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
			expect(order).toEqual(["writer"]);

			releaseWriter();
			await Promise.all([writerRun, documenterRun]);
			expect(order).toEqual(["writer", "standalone documenter"]);
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
			await capturedTasks[0](controllers[0].signal, controllers[0]);
			vi.advanceTimersByTime(150);

			// No managed continuation: the failing gate is one plain, turn-triggering
			// completion carrying the findings and the fix-now note, so the main
			// agent can resolve them itself.
			expect(capturedTasks).toHaveLength(1);
			expect(stub.messages).toHaveLength(1);
			const content = stub.messages[0].message.content as string;
			expect(content).toContain("### [reviewer] completed");
			expect(content).toContain("VERDICT: REVIEW_FAIL");
			expect(content).toContain("findings are yours to resolve now");
			expect(content).not.toContain("Managed workflow");
			expect(content).toContain(`run #${parentRunId}`);
			expect(stub.messages[0].options).toEqual({ deliverAs: "steer", triggerTurn: true });
			expect(monitor.getRuns()).toHaveLength(0);
		} finally {
			restoreChild();
			await shutdownExtension(stub, { controllers });
		}
	});

	it("runs every managed stage in the triggering writer's explicit cwd", async () => {
		// Pin the enabled set so the managed chain is exactly worker → reviewer
		// regardless of the fresh-install default agent catalog.
		configureEnabledAgents(["explorer", "worker", "reviewer"]);
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
			await capturedTasks[0](controllers[0].signal, controllers[0]);
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
				capturedTasks[0](controllers[0].signal, controllers[0]),
				capturedTasks[1](controllers[1].signal, controllers[1]),
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
			await capturedTasks[0](controllers[0].signal, controllers[0]);
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
			await capturedTasks[0](controllers[0].signal, controllers[0]);
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
			await capturedTasks[0](controllers[0].signal, controllers[0]);

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
		// Fresh-install default enabled set: every shipped agent.
		expect(result.systemPrompt).toContain("- explorer:");
		expect(result.systemPrompt).toContain("- worker:");
		expect(result.systemPrompt).toContain("- cleaner:");
		expect(result.systemPrompt).toContain("- documenter:");
		expect(result.systemPrompt).toContain("- reviewer:");
		expect(result.systemPrompt).not.toContain("- plan:");
	});

	it("injects regardless of a legacy proactiveInjection toggle in the config file", async () => {
		configureEnabledAgents(["worker"], { proactiveInjection: false });
		const stub = makeStub();
		register(stub.api);
		const result = await stub.hooks["before_agent_start"]({ systemPrompt: "BASE PROMPT" }, { cwd: process.cwd() });
		expect(result.systemPrompt).toContain("Sub-agent delegation");
		expect(result.systemPrompt).toContain("- worker:");
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
		await captured[0](controller.signal, controller);
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

