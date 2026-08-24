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

interface StubPi {
	tools: any[];
	commands: string[];
	hooks: Record<string, (event: any, ctx: any) => any>;
	messages: Array<{ message: any; options: any }>;
	api: any;
}

function makeStub(): StubPi {
	const stub: StubPi = {
		tools: [],
		commands: [],
		hooks: {},
		messages: [],
		api: null,
	};
	stub.api = {
		registerTool: (tool: any) => stub.tools.push(tool),
		registerMessageRenderer: (_type: string, _renderer: any) => {},
		registerCommand: (name: string) => stub.commands.push(name),
		registerShortcut: (_key: string, _opts: any) => {},
		sendMessage: (message: any, options: any) => stub.messages.push({ message, options }),
		on: (event: string, handler: any) => {
			stub.hooks[event] = handler;
		},
	};
	return stub;
}

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
		expect(tool.description).toContain("explorer for broad read-only reconnaissance");
		expect(tool.description).toContain("cleaner only for explicitly authorized cleanup/removal/simplification edits");
		expect(tool.description).toContain("reviewer for generic read-only assessments and pre-commit gates");
		expect(tool.description).toContain("do not poll");
		expect(tool.description).toContain("continues the retained session on the current main model");
		expect(tool.promptSnippet).toContain("results resume automatically");
		expect(`${tool.description}\n${tool.promptSnippet}`).not.toMatch(/[\u4e00-\u9fff]/u);
		expect(tool.parameters.properties.task).toMatchObject({ minLength: 1, pattern: "\\S" });
		expect(tool.parameters.properties.tasks.items.properties.task).toMatchObject({ minLength: 1, pattern: "\\S" });
		expect(tool.parameters.properties.isolation).toBeDefined();
		expect(tool.parameters.properties.tasks.items.properties.isolation).toBeDefined();
		const control = stub.tools.find((t) => t.name === "subagent_control");
		expect(control.description).toContain("fork copies");
		expect(JSON.stringify(control.parameters.properties.action)).toContain("fork");
	});

	it("wires recovery and one-time feature notices through session_start", async () => {
		if (!testAgentDir) throw new Error("test agent directory was not initialized");
		const configPath = join(testAgentDir, "pi-subagents.json");
		const patchPath = join(testAgentDir, "retained.patch");
		writeFileSync(configPath, JSON.stringify({
			enabledAgents: ["explorer", "worker", "reviewer"],
			announcedFeatures: [],
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
		// No reviewer model/thinking overrides were configured, so the upgrade
		// injected cleaner without inheriting anything and the notice says so.
		expect(notify).toHaveBeenCalledWith(
			"pi-subagents: the built-in cleaner agent was enabled by default. Run /subagents-setup to adjust or disable it.",
			"info",
		);
		const savedConfig = JSON.parse(readFileSync(configPath, "utf8"));
		// The load-time upgrade defaulted cleaner into the old explicit list and
		// stamped the config so the migration and the notice never repeat.
		expect(savedConfig.enabledAgents).toEqual(["explorer", "worker", "cleaner", "reviewer"]);
		expect(savedConfig.announcedFeatures).toEqual(expect.arrayContaining([
			"cleanerDefaulted",
			"cleanerAutoEnabled",
			"cleanerAutoEnabledNotice",
		]));

		// Recovery remains visible while its artifact exists, but the feature markers
		// prevent repeated informational notices on later session starts.
		notify.mockClear();
		await stub.hooks["session_start"]({}, context);
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("recovery for run #41"), "error");
		expect(notify.mock.calls.some((call) => call[1] === "info")).toBe(false);
	});

	it("runs recovery but skips feature notices outside TUI mode", async () => {
		if (!testAgentDir) throw new Error("test agent directory was not initialized");
		const configPath = join(testAgentDir, "pi-subagents.json");
		const patchPath = join(testAgentDir, "non-tui-retained.patch");
		writeFileSync(configPath, JSON.stringify({ announcedFeatures: [] }), "utf8");
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
		expect(JSON.parse(readFileSync(configPath, "utf8")).announcedFeatures).toEqual([]);
	});

	it("states reviewer inheritance in the cleaner notice only when settings were copied", async () => {
		if (!testAgentDir) throw new Error("test agent directory was not initialized");
		const configPath = join(testAgentDir, "pi-subagents.json");
		// A pre-cleaner config whose reviewer carries model and thinking overrides.
		writeFileSync(configPath, JSON.stringify({
			enabledAgents: ["explorer", "worker", "reviewer"],
			agentModels: { reviewer: "anthropic/claude-sonnet-4-5" },
			agentThinkingLevels: { reviewer: "low" },
			announcedFeatures: [],
		}), "utf8");

		const stub = makeStub();
		register(stub.api);
		const notify = vi.fn();
		const setWidget = vi.fn();
		await stub.hooks["session_start"]({}, { mode: "tui", hasUI: true, ui: { notify, setWidget } });

		expect(notify).toHaveBeenCalledWith(
			"pi-subagents: the built-in cleaner agent was enabled by default and inherited your reviewer model/thinking settings. Run /subagents-setup to adjust or disable it.",
			"info",
		);
		const savedConfig = JSON.parse(readFileSync(configPath, "utf8"));
		expect(savedConfig.announcedFeatures).toEqual(expect.arrayContaining([
			"cleanerDefaulted",
			"cleanerAutoEnabled",
			"cleanerInheritedReviewer",
			"cleanerAutoEnabledNotice",
		]));
	});

	it("skips the cleaner notice when cleaner was disabled before it could fire", async () => {
		if (!testAgentDir) throw new Error("test agent directory was not initialized");
		const configPath = join(testAgentDir, "pi-subagents.json");
		// The upgrade ran and stamped the injection, but the user then disabled
		// cleaner (e.g. via full setup) before the async announcement save landed.
		writeFileSync(configPath, JSON.stringify({
			enabledAgents: ["explorer", "worker", "reviewer"],
			announcedFeatures: ["cleanerDefaulted", "cleanerAutoEnabled"],
		}), "utf8");

		const stub = makeStub();
		register(stub.api);
		const notify = vi.fn();
		const setWidget = vi.fn();
		await stub.hooks["session_start"]({}, { mode: "tui", hasUI: true, ui: { notify, setWidget } });

		expect(notify.mock.calls.some((call) => call[1] === "info")).toBe(false);
		const savedConfig = JSON.parse(readFileSync(configPath, "utf8"));
		expect(savedConfig.enabledAgents).toEqual(["explorer", "worker", "reviewer"]);
		expect(savedConfig.announcedFeatures).not.toContain("cleanerAutoEnabledNotice");
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

		const result = await tool.execute(
			"call-1",
			{ agent: "worker", task: " \n\t " },
			new AbortController().signal,
			() => {},
			executionContext(),
		);

		expect(enqueue).not.toHaveBeenCalled();
		expect(result.content[0].text).toContain("Invalid parameters. task must contain at least one non-whitespace character.");
		expect(result.details).toEqual({ mode: "single", results: [], background: false });
	});

	it("rejects an entire parallel batch when one task is whitespace-only", async () => {
		const enqueue = vi.spyOn(BackgroundTaskQueue.prototype, "enqueue").mockImplementation(() => new AbortController());
		const stub = makeStub();
		register(stub.api);
		const tool = stub.tools.find((candidate) => candidate.name === "subagent");

		const result = await tool.execute(
			"call-2",
			{
				tasks: [
					{ agent: "explorer", task: "Inspect the relevant files" },
					{ agent: "worker", task: "\n\t" },
				],
			},
			new AbortController().signal,
			() => {},
			executionContext(),
		);

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

		const result = await control.execute(
			"call-control",
			{ action: "resume", id: 999 },
			new AbortController().signal,
			() => {},
			executionContext(),
		);

		expect(enqueue).not.toHaveBeenCalled();
		expect(result.content[0].text).toContain("No subagent thread matches run #999");
	});
});

describe("registered tool background dispatch", () => {
	it("reports its summary with cache reads on completion", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const stub = makeStub();
		const capturedTasks: BackgroundTask[] = [];
		const backgroundController = new AbortController();
		vi.spyOn(BackgroundTaskQueue.prototype, "enqueue").mockImplementation((task) => {
			capturedTasks.push(task);
			return backgroundController;
		});

		let childDir: string | undefined;
		const previousScript = process.argv[1];
		try {
			childDir = mkdtempSync(join(tmpdir(), "pi-subagents-load-child-"));
			const childScript = join(childDir, "fake-pi-child.mjs");
			writeFileSync(
				childScript,
				fakeRpcScript({
					onPrompt: `send({
	type: "message_end",
	message: {
		role: "assistant",
		content: [{ type: "text", text: "fake child completed" }],
		usage: { input: 0, output: 0, cacheRead: 321, cacheWrite: 0, cost: { total: 0 }, totalTokens: 321 },
		stopReason: "stop"
	}
});`,
				}),
				"utf8",
			);
			process.argv[1] = childScript;

			register(stub.api);
			const tool = stub.tools.find((candidate) => candidate.name === "subagent");
			const task = "\x1b[31mInspect\x1b[0m\n  cache-read metrics";
			const summary = "Inspect cache-read metrics";
			const dispatch = await tool.execute(
				"call-valid",
				{ agent: "worker", task },
				new AbortController().signal,
				() => {},
				executionContext(),
			);

			expect(dispatch.terminate).toBe(true);
			expect(capturedTasks).toHaveLength(1);
			const runId = dispatch.details.results[0].runId;
			expect(runId).toBeTypeOf("number");
			expect(dispatch.content[0].text).toContain(`#${runId} worker`);
			expect(renderToolResult(tool, dispatch)).toContain(`#${runId} worker`);
			await capturedTasks[0](backgroundController.signal);

			expect(stub.messages).toHaveLength(0);
			vi.advanceTimersByTime(150);
			expect(stub.messages).toHaveLength(1);
			const completion = stub.messages[0];
			expect(completion.message.content).toContain(`Task: ${summary}`);
			expect(completion.message.content).toContain(`run #${runId}`);
			expect(completion.message.content).toMatch(/\bR321\b/);
			expect(completion.options).toEqual({ deliverAs: "steer", triggerTurn: true });
		} finally {
			backgroundController.abort();
			await stub.hooks["session_shutdown"]?.({}, {});
			for (const run of [...monitor.getRuns()]) monitor.removeRun(run.id);
			process.argv[1] = previousScript;
			if (childDir) rmSync(childDir, { recursive: true, force: true });
		}
	});

	it("reports a clean-exit run whose tool calls failed as completed-with-failures", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const stub = makeStub();
		const capturedTasks: BackgroundTask[] = [];
		const backgroundController = new AbortController();
		vi.spyOn(BackgroundTaskQueue.prototype, "enqueue").mockImplementation((task) => {
			capturedTasks.push(task);
			return backgroundController;
		});

		let childDir: string | undefined;
		const previousScript = process.argv[1];
		try {
			childDir = mkdtempSync(join(tmpdir(), "pi-subagents-failchild-"));
			const childScript = join(childDir, "fake-pi-child.mjs");
			// The child exits cleanly (exit code 0) even though its bash tool failed —
			// exactly the shape that used to produce a misleading "completed" message.
			writeFileSync(
				childScript,
				fakeRpcScript({
					onPrompt: `for (let i = 1; i <= 4; i++) {
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
});`,
				}),
				"utf8",
			);
			process.argv[1] = childScript;

			register(stub.api);
			const tool = stub.tools.find((candidate) => candidate.name === "subagent");
			const dispatch = await tool.execute(
				"call-f",
				{ agent: "worker", task: "Fix the compile error" },
				new AbortController().signal,
				() => {},
				executionContext(),
			);
			const runId = dispatch.details.results[0].runId;
			await capturedTasks[0](backgroundController.signal);
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
			const full = await status.execute(
				"status-f",
				{ id: String(runId) },
				new AbortController().signal,
				() => {},
				executionContext(),
			);
			expect(full.content[0].text).toContain("completed with 4 failed tool calls");
			for (let i = 1; i <= 4; i++) {
				expect(full.content[0].text).toContain(`- bash-${i}: MSBuild.exe failed ${i}`);
				expect(full.content[0].text).toContain(`fatal error C3861: execute_wake_task: undeclared identifier ${i}`);
			}
			expect(full.content[0].text).not.toContain("… and");
		} finally {
			backgroundController.abort();
			await stub.hooks["session_shutdown"]?.({}, {});
			for (const run of [...monitor.getRuns()]) monitor.removeRun(run.id);
			process.argv[1] = previousScript;
			if (childDir) rmSync(childDir, { recursive: true, force: true });
		}
	});

	it("subagent_wait returns the finished result in-turn instead of sleeping", async () => {
		const stub = makeStub();
		const capturedTasks: BackgroundTask[] = [];
		const backgroundController = new AbortController();
		vi.spyOn(BackgroundTaskQueue.prototype, "enqueue").mockImplementation((task) => {
			capturedTasks.push(task);
			return backgroundController;
		});

		let childDir: string | undefined;
		const previousScript = process.argv[1];
		try {
			childDir = mkdtempSync(join(tmpdir(), "pi-subagents-wait-child-"));
			const childScript = join(childDir, "fake-pi-child.mjs");
			writeFileSync(
				childScript,
				fakeRpcScript({
					onPrompt: `send({
	type: "message_end",
	message: {
		role: "assistant",
		content: [{ type: "text", text: "worker result payload" }],
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 }, totalTokens: 0 },
		stopReason: "stop"
	}
});`,
				}),
				"utf8",
			);
			process.argv[1] = childScript;

			register(stub.api);
			const tool = stub.tools.find((candidate) => candidate.name === "subagent");
			const waitTool = stub.tools.find((candidate) => candidate.name === "subagent_wait");
			expect(waitTool).toBeDefined();

			await tool.execute(
				"call-w",
				{ agent: "worker", task: "Fix the build" },
				new AbortController().signal,
				() => {},
				executionContext(),
			);
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
			await capturedTasks[0](backgroundController.signal);
			const waitResult = await waitPromise;

			const text = waitResult.content[0].text;
			expect(text).toContain("### [worker] completed");
			expect(text).toContain("worker result payload");
			expect(text).toContain("Task: Fix the build");

			// A settled run resolves immediately on a second call.
			const second = await waitTool.execute(
				"wait-2",
				{ id: String(runId) },
				new AbortController().signal,
				() => {},
				executionContext(),
			);
			expect(second.content[0].text).toContain("worker result payload");
		} finally {
			backgroundController.abort();
			await stub.hooks["session_shutdown"]?.({}, {});
			for (const run of [...monitor.getRuns()]) monitor.removeRun(run.id);
			process.argv[1] = previousScript;
			if (childDir) rmSync(childDir, { recursive: true, force: true });
		}
	});

	it("subagent_wait reports no active runs and times out on still-running ones", async () => {
		const stub = makeStub();
		const capturedTasks: BackgroundTask[] = [];
		const backgroundController = new AbortController();
		vi.spyOn(BackgroundTaskQueue.prototype, "enqueue").mockImplementation((task) => {
			capturedTasks.push(task);
			return backgroundController;
		});

		try {
			register(stub.api);
			const tool = stub.tools.find((candidate) => candidate.name === "subagent");
			const waitTool = stub.tools.find((candidate) => candidate.name === "subagent_wait");

			const none = await waitTool.execute("wait-none", {}, new AbortController().signal, () => {}, executionContext());
			expect(none.content[0].text).toContain("No active subagent runs");

			await tool.execute(
				"call-w2",
				{ agent: "worker", task: "Long task" },
				new AbortController().signal,
				() => {},
				executionContext(),
			);
			// The captured task never runs, so the run stays active: wait times out.
			const runId = monitor.getRuns().find((run) => run.task === "Long task")?.id;
			expect(runId).toBeDefined();
			const timedOut = await waitTool.execute(
				"wait-to",
				{ id: String(runId), timeoutMs: 100 },
				new AbortController().signal,
				() => {},
				executionContext(),
			);
			expect(timedOut.content[0].text).toContain("wait timed out");
			expect(timedOut.content[0].text).toContain(`#${runId}`);

			// The default is a NON-blocking lookup: a still-active run returns a
			// note immediately (the model ends its turn and the wake-up message
			// delivers the result) instead of holding the turn.
			const nonBlocking = await waitTool.execute(
				"wait-nb",
				{ id: String(runId) },
				new AbortController().signal,
				() => {},
				executionContext(),
			);
			expect(nonBlocking.content[0].text).toContain(`run #${runId} is still active`);
			expect(nonBlocking.content[0].text).toContain("end your turn");

			const unknown = await waitTool.execute(
				"wait-x",
				{ id: "99" },
				new AbortController().signal,
				() => {},
				executionContext(),
			);
			expect(unknown.content[0].text).toContain('No active subagent run matches "99"');
		} finally {
			backgroundController.abort();
			await stub.hooks["session_shutdown"]?.({}, {});
			for (const run of [...monitor.getRuns()]) monitor.removeRun(run.id);
		}
	});

	it("subagent_wait resolves with a note when the calling turn's signal is aborted", async () => {
		const stub = makeStub();
		const capturedTasks: BackgroundTask[] = [];
		const backgroundController = new AbortController();
		vi.spyOn(BackgroundTaskQueue.prototype, "enqueue").mockImplementation((task) => {
			capturedTasks.push(task);
			return backgroundController;
		});

		try {
			register(stub.api);
			const tool = stub.tools.find((candidate) => candidate.name === "subagent");
			const waitTool = stub.tools.find((candidate) => candidate.name === "subagent_wait");
			await tool.execute(
				"call-wa",
				{ agent: "worker", task: "Long task" },
				new AbortController().signal,
				() => {},
				executionContext(),
			);
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
			backgroundController.abort();
			await stub.hooks["session_shutdown"]?.({}, {});
			for (const run of [...monitor.getRuns()]) monitor.removeRun(run.id);
		}
	});

	it("subagent_status lists active runs and returns full results by id", async () => {
		const stub = makeStub();
		const capturedTasks: BackgroundTask[] = [];
		const backgroundController = new AbortController();
		vi.spyOn(BackgroundTaskQueue.prototype, "enqueue").mockImplementation((task) => {
			capturedTasks.push(task);
			return backgroundController;
		});

		let childDir: string | undefined;
		const previousScript = process.argv[1];
		try {
			childDir = mkdtempSync(join(tmpdir(), "pi-subagents-status-child-"));
			const childScript = join(childDir, "fake-pi-child.mjs");
			writeFileSync(
				childScript,
				fakeRpcScript({
					onPrompt: `send({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "status payload" }], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 }, totalTokens: 0 }, stopReason: "stop" } });`,
				}),
				"utf8",
			);
			process.argv[1] = childScript;

			register(stub.api);
			const tool = stub.tools.find((candidate) => candidate.name === "subagent");
			const statusTool = stub.tools.find((candidate) => candidate.name === "subagent_status");
			expect(statusTool).toBeDefined();

			// No runs yet: empty overview.
			const empty = await statusTool.execute("st-0", {}, new AbortController().signal, () => {}, executionContext());
			expect(empty.content[0].text).toContain("Active subagent runs (0)");

			await tool.execute(
				"call-s",
				{ agent: "worker", task: "Inspect the build" },
				new AbortController().signal,
				() => {},
				executionContext(),
			);

			// Queued run shows in the overview with its id.
			const runId = monitor.getRuns().find((run) => run.task === "Inspect the build")?.id;
			expect(runId).toBeDefined();
			monitor.recordToolStart(
				runId!,
				"bash",
				"bash curl -H 'Authorization: Bearer DO_NOT_LEAK_TEST_TOKEN' x?token=DO_NOT_LEAK_QUERY \x1b]0;unsafe\x07",
			);
			const overview = await statusTool.execute("st-1", {}, new AbortController().signal, () => {}, executionContext());
			expect(overview.content[0].text).toContain("Active subagent runs (1)");
			expect(overview.content[0].text).toContain(`#${runId} worker`);
			expect(overview.content[0].text).toContain("Authorization: Bearer <redacted>");
			expect(overview.content[0].text).not.toContain("DO_NOT_LEAK");
			expect(overview.content[0].text).not.toContain("\x1b");
			expect(overview.content[0].text).toContain("Finished this session (0)");

			// While active, an id lookup reports the run is still running without
			// exposing the raw tool arguments stored by the live monitor.
			const stillActive = await statusTool.execute("st-2", { id: String(runId) }, new AbortController().signal, () => {}, executionContext());
			expect(stillActive.content[0].text).toContain("still active");
			expect(stillActive.content[0].text).not.toContain("DO_NOT_LEAK");
			expect(stillActive.content[0].text).not.toContain("\x1b");

			// After the run settles, the same id returns the full result.
			await capturedTasks[0](backgroundController.signal);
			const settledView = await statusTool.execute("st-3", { id: String(runId) }, new AbortController().signal, () => {}, executionContext());
			expect(settledView.content[0].text).toContain("### [worker] completed");
			expect(settledView.content[0].text).toContain("status payload");

			const after = await statusTool.execute("st-4", {}, new AbortController().signal, () => {}, executionContext());
			expect(after.content[0].text).toContain("Finished this session (1)");
			expect(after.content[0].text).toContain(`#${runId} worker · Inspect the build · completed`);
		} finally {
			backgroundController.abort();
			await stub.hooks["session_shutdown"]?.({}, {});
			for (const run of [...monitor.getRuns()]) monitor.removeRun(run.id);
			process.argv[1] = previousScript;
			if (childDir) rmSync(childDir, { recursive: true, force: true });
		}
	});

	it("subagent_stop cancels active runs and resolves waiters with an aborted result", async () => {
		const stub = makeStub();
		const capturedTasks: BackgroundTask[] = [];
		const backgroundController = new AbortController();
		vi.spyOn(BackgroundTaskQueue.prototype, "enqueue").mockImplementation((task) => {
			capturedTasks.push(task);
			return backgroundController;
		});

		try {
			register(stub.api);
			const tool = stub.tools.find((candidate) => candidate.name === "subagent");
			const waitTool = stub.tools.find((candidate) => candidate.name === "subagent_wait");
			const stopTool = stub.tools.find((candidate) => candidate.name === "subagent_stop");
			expect(stopTool).toBeDefined();

			// Unknown id: nothing to stop.
			const unknown = await stopTool.execute("stop-x", { id: "99" }, new AbortController().signal, () => {}, executionContext());
			expect(unknown.content[0].text).toContain('No subagent thread matches "99"');

			await tool.execute(
				"call-st",
				{ agent: "worker", task: "Long task" },
				new AbortController().signal,
				() => {},
				executionContext(),
			);

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
			const stopped = await stopTool.execute("stop-1", { id: String(runId) }, new AbortController().signal, () => {}, executionContext());
			expect(stopped.content[0].text).toContain(`Stopped 1 thread: #${runId} worker (queued)`);

			const waited = await waitPromise;
			expect(waited.content[0].text).toContain("### [worker] failed");
			expect(waited.content[0].text).toContain("Stopped by subagent_stop");
			expect(stub.messages).toHaveLength(1);
			expect(stub.messages[0].message.content).toContain("Stopped by subagent_stop");
		} finally {
			backgroundController.abort();
			await stub.hooks["session_shutdown"]?.({}, {});
			for (const run of [...monitor.getRuns()]) monitor.removeRun(run.id);
		}
	});

	it("batches sibling successes into one grouped wake-up message", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const stub = makeStub();
		const capturedTasks: BackgroundTask[] = [];
		const controllers: AbortController[] = [];
		vi.spyOn(BackgroundTaskQueue.prototype, "enqueue").mockImplementation((task) => {
			capturedTasks.push(task);
			const controller = new AbortController();
			controllers.push(controller);
			return controller;
		});

		let childDir: string | undefined;
		const previousScript = process.argv[1];
		try {
			childDir = mkdtempSync(join(tmpdir(), "pi-subagents-batch-child-"));
			const childScript = join(childDir, "fake-pi-child.mjs");
			writeFileSync(
				childScript,
				fakeRpcScript({
					onPrompt: `send({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "batch result" }], stopReason: "stop" } });`,
				}),
				"utf8",
			);
			process.argv[1] = childScript;

			register(stub.api);
			const tool = stub.tools.find((candidate) => candidate.name === "subagent");
			const dispatch = await tool.execute(
				"call-batch",
				{
					tasks: [
						{ agent: "worker", task: "Implement the change" },
						{ agent: "reviewer", task: "Review the change" },
					],
				},
				new AbortController().signal,
				() => {},
				executionContext(),
			);

			expect(dispatch.terminate).toBe(true);
			expect(capturedTasks).toHaveLength(2);
			const runIds = dispatch.details.results.map((result: any) => result.runId as number);
			const renderedDispatch = renderToolResult(tool, dispatch);
			for (const [index, runId] of runIds.entries()) {
				const agent = index === 0 ? "worker" : "reviewer";
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
			expect(completion.message.content).toContain("### Subagents completed (2): worker, reviewer");
			expect(completion.message.content).toContain("### [worker] completed");
			expect(completion.message.content).toContain("### [reviewer] completed");
			for (const runId of runIds) expect(completion.message.content).toContain(`run #${runId}`);
			expect(completion.options).toEqual({ deliverAs: "steer", triggerTurn: true });
		} finally {
			for (const controller of controllers) controller.abort();
			await stub.hooks["session_shutdown"]?.({}, {});
			for (const run of [...monitor.getRuns()]) monitor.removeRun(run.id);
			process.argv[1] = previousScript;
			if (childDir) rmSync(childDir, { recursive: true, force: true });
		}
	});

	it("delivers an opted-in passing reviewer result without waking the main agent", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		if (!testAgentDir) throw new Error("test agent directory was not initialized");
		writeFileSync(
			join(testAgentDir, "pi-subagents.json"),
			JSON.stringify({ notifyOnReviewPass: true }),
			"utf8",
		);
		const stub = makeStub();
		let capturedTask: BackgroundTask | undefined;
		const controller = new AbortController();
		vi.spyOn(BackgroundTaskQueue.prototype, "enqueue").mockImplementation((task) => {
			capturedTask = task;
			return controller;
		});

		let childDir: string | undefined;
		const previousScript = process.argv[1];
		try {
			childDir = mkdtempSync(join(tmpdir(), "pi-subagents-review-pass-child-"));
			const childScript = join(childDir, "fake-pi-child.mjs");
			writeFileSync(
				childScript,
				fakeRpcScript({
					onPrompt: `send({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "APPROVE\\nVERDICT: REVIEW_PASS" }], stopReason: "stop" } });`,
				}),
				"utf8",
			);
			process.argv[1] = childScript;

			register(stub.api);
			const tool = stub.tools.find((candidate) => candidate.name === "subagent");
			await tool.execute(
				"call-review-pass",
				{ agent: "reviewer", task: "Review the change" },
				new AbortController().signal,
				() => {},
				executionContext(),
			);

			expect(capturedTask).toBeDefined();
			await capturedTask?.(controller.signal);
			expect(stub.messages).toHaveLength(0);
			vi.advanceTimersByTime(150);
			expect(stub.messages).toHaveLength(1);
			expect(stub.messages[0].options).toEqual({ deliverAs: "nextTurn" });
		} finally {
			controller.abort();
			await stub.hooks["session_shutdown"]?.({}, {});
			for (const run of [...monitor.getRuns()]) monitor.removeRun(run.id);
			process.argv[1] = previousScript;
			if (childDir) rmSync(childDir, { recursive: true, force: true });
		}
	});

	it("emits a failure immediately ahead of held successes", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const stub = makeStub();
		const capturedTasks: BackgroundTask[] = [];
		const controllers: AbortController[] = [];
		vi.spyOn(BackgroundTaskQueue.prototype, "enqueue").mockImplementation((task) => {
			capturedTasks.push(task);
			const controller = new AbortController();
			controllers.push(controller);
			return controller;
		});

		let childDir: string | undefined;
		const previousScript = process.argv[1];
		try {
			childDir = mkdtempSync(join(tmpdir(), "pi-subagents-failure-child-"));
			const childScript = join(childDir, "fake-pi-child.mjs");
			writeFileSync(
				childScript,
				fakeRpcScript({
					onPrompt: `const failed = input.includes("must fail");
const text = failed ? "VERDICT: REVIEW_FAIL" : "successful result";
send({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }], stopReason: failed ? "error" : "stop" } });`,
				}),
				"utf8",
			);
			process.argv[1] = childScript;

			register(stub.api);
			const tool = stub.tools.find((candidate) => candidate.name === "subagent");
			await tool.execute(
				"call-failure",
				{
					tasks: [
						{ agent: "worker", task: "succeed first" },
						{ agent: "reviewer", task: "must fail now" },
					],
				},
				new AbortController().signal,
				() => {},
				executionContext(),
			);

			expect(capturedTasks).toHaveLength(2);
			await capturedTasks[0](controllers[0].signal);
			expect(stub.messages).toHaveLength(0);

			await capturedTasks[1](controllers[1].signal);
			expect(stub.messages).toHaveLength(2);
			expect(stub.messages[0].message.content).toContain("### [reviewer] failed");
			expect(stub.messages[0].options).toEqual({ deliverAs: "steer", triggerTurn: true });
			expect(stub.messages[1].message.content).toContain("### [worker] completed");

			vi.advanceTimersByTime(1_000);
			expect(stub.messages).toHaveLength(2);
		} finally {
			for (const controller of controllers) controller.abort();
			await stub.hooks["session_shutdown"]?.({}, {});
			for (const run of [...monitor.getRuns()]) monitor.removeRun(run.id);
			process.argv[1] = previousScript;
			if (childDir) rmSync(childDir, { recursive: true, force: true });
		}
	});

	it("truncates a long result and points at the full artifact", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const stub = makeStub();
		let capturedTask: BackgroundTask | undefined;
		const controller = new AbortController();
		vi.spyOn(BackgroundTaskQueue.prototype, "enqueue").mockImplementation((task) => {
			capturedTask = task;
			return controller;
		});

		let childDir: string | undefined;
		const previousScript = process.argv[1];
		try {
			childDir = mkdtempSync(join(tmpdir(), "pi-subagents-truncate-child-"));
			const childScript = join(childDir, "fake-pi-child.mjs");
			writeFileSync(
				childScript,
				fakeRpcScript({
					onPrompt: `const lines = Array.from({ length: 100 }, (_, i) => "line " + i).join("\\n");
send({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: lines }], stopReason: "stop" } });`,
				}),
				"utf8",
			);
			process.argv[1] = childScript;

			register(stub.api);
			const tool = stub.tools.find((candidate) => candidate.name === "subagent");
			await tool.execute(
				"call-truncate",
				{ agent: "reviewer", task: "Review the change" },
				new AbortController().signal,
				() => {},
				executionContext(),
			);

			await capturedTask?.(controller.signal);
			vi.advanceTimersByTime(150);
			expect(stub.messages).toHaveLength(1);
			const content = stub.messages[0].message.content as string;
			expect(content).toContain("(output truncated to 80 lines; full result:");
			expect(content).toContain("line 79");
			expect(content).not.toContain("line 80");
			const artifactPath = /full result: (.+)\)/.exec(content)?.[1];
			expect(artifactPath).toBeTruthy();
			expect(readFileSync(artifactPath!, "utf8")).toContain("line 99");
			rmSync(artifactPath!, { force: true });
		} finally {
			controller.abort();
			await stub.hooks["session_shutdown"]?.({}, {});
			for (const run of [...monitor.getRuns()]) monitor.removeRun(run.id);
			process.argv[1] = previousScript;
			if (childDir) rmSync(childDir, { recursive: true, force: true });
		}
	});
});

describe("auto-fix loop dispatch", () => {
	it("intercepts a REVIEW_FAIL reviewer, runs the worker→re-review chain, and delivers it as one group", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const stub = makeStub();
		const uiNotify = vi.fn();
		const capturedTasks: BackgroundTask[] = [];
		const controllers: AbortController[] = [];
		vi.spyOn(BackgroundTaskQueue.prototype, "enqueue").mockImplementation((task) => {
			capturedTasks.push(task);
			const controller = new AbortController();
			controllers.push(controller);
			return controller;
		});

		let childDir: string | undefined;
		const previousScript = process.argv[1];
		try {
			childDir = mkdtempSync(join(tmpdir(), "pi-subagents-chain-child-"));
			const childScript = join(childDir, "fake-pi-child.mjs");
			writeFileSync(
				childScript,
				fakeRpcScript({
					onPrompt: `let text = "REQUEST_CHANGES\\nVERDICT: REVIEW_FAIL";
if (input.includes("Auto-fix round")) text = "all blockers fixed";
else if (input.includes("Re-review after auto-fix round")) text = "APPROVE\\nVERDICT: REVIEW_PASS";
send({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }], stopReason: "stop" } });`,
				}),
				"utf8",
			);
			process.argv[1] = childScript;

			register(stub.api);
			const tool = stub.tools.find((candidate) => candidate.name === "subagent");
			const dispatched = await tool.execute(
				"call-chain",
				{ agent: "reviewer", task: "Review the change" },
				new AbortController().signal,
				() => {},
				executionContext({ uiNotify }),
			);
			const parentRunId = dispatched.details.results[0].runId as number;

			expect(capturedTasks).toHaveLength(1);
			await capturedTasks[0](controllers[0].signal);

			// The chain task was enqueued by the initial review's completion; the
			// review itself is NOT delivered or notified yet.
			expect(capturedTasks).toHaveLength(2);
			expect(stub.messages).toHaveLength(0);
			expect(uiNotify).not.toHaveBeenCalled();
			const parent = monitor.getRuns().find((run) => run.activity === "auto-fix chain running");
			expect(parent).toBeDefined();
			expect(parent?.agent).toBe("reviewer");
			expect(parent?.status).toBe("running");
			expect(parent?.endedAt).toBeUndefined();

			await capturedTasks[1](controllers[1].signal);

			expect(stub.messages).toHaveLength(1);
			const content = stub.messages[0].message.content as string;
			// Condensed delivery: one summary block instead of every round's raw output.
			expect(content).toContain("## Auto-fix chain: 1 round — final PASS");
			expect(content).toContain("reviewer · initial review · FAIL");
			expect(content).toContain("worker · fix round 1 · completed");
			expect(content).toContain("reviewer · re-review round 1 · PASS");
			expect(content).toContain("Totals:");
			expect(content).toContain("subagent_status");
			// A passing final re-review appends no full block; earlier rounds' full
			// reports stay one subagent_status call away.
			expect(content).not.toContain("### [worker]");
			expect(content).not.toContain("Task: Review the change");
			// The initial review is not delivered or notified yet (still held by the chain).
			expect(stub.messages[0].options).toEqual({ deliverAs: "steer", triggerTurn: true });
			// Internal rounds stay silent; the parent is the chain's only live row.
			expect(uiNotify).not.toHaveBeenCalled();
			expect(monitor.getRuns()).toHaveLength(0);

			// Every step id in the summary resolves to that exact report. The stable
			// parent id is separate and resolves to a copy of the final logical result
			// whose embedded run id is still the parent, not the internal re-review.
			const stepIds = [...content.matchAll(/^- #(\d+) /gmu)].map((match) => Number(match[1]));
			expect(stepIds).toHaveLength(3);
			expect(new Set(stepIds).size).toBe(3);
			expect(stepIds).not.toContain(parentRunId);
			const statusTool = stub.tools.find((candidate) => candidate.name === "subagent_status");
			const lookup = async (id: number): Promise<string> => {
				const result = await statusTool.execute(
					`status-${id}`,
					{ id: String(id) },
					new AbortController().signal,
					() => {},
					executionContext(),
				);
				return result.content[0].text;
			};
			const initialReport = await lookup(stepIds[0]);
			const workerReport = await lookup(stepIds[1]);
			const reReviewReport = await lookup(stepIds[2]);
			const parentReport = await lookup(parentRunId);
			expect(initialReport).toContain(`run #${stepIds[0]}`);
			expect(initialReport).toContain("REQUEST_CHANGES");
			expect(workerReport).toContain(`run #${stepIds[1]}`);
			expect(workerReport).toContain("all blockers fixed");
			expect(reReviewReport).toContain(`run #${stepIds[2]}`);
			expect(reReviewReport).toContain("VERDICT: REVIEW_PASS");
			expect(parentReport).toContain(`run #${parentRunId}`);
			expect(parentReport).toContain("VERDICT: REVIEW_PASS");
		} finally {
			for (const controller of controllers) controller.abort();
			await stub.hooks["session_shutdown"]?.({}, {});
			for (const run of [...monitor.getRuns()]) monitor.removeRun(run.id);
			process.argv[1] = previousScript;
			if (childDir) rmSync(childDir, { recursive: true, force: true });
		}
	});

	it("runs every auto-fix round in the triggering reviewer's explicit cwd", async () => {
		const stub = makeStub();
		const capturedTasks: BackgroundTask[] = [];
		const controllers: AbortController[] = [];
		vi.spyOn(BackgroundTaskQueue.prototype, "enqueue").mockImplementation((task) => {
			capturedTasks.push(task);
			const controller = new AbortController();
			controllers.push(controller);
			return controller;
		});
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
			if (options.task === "Review target repo") {
				return makeResult("reviewer", options.task, "REQUEST_CHANGES\nVERDICT: REVIEW_FAIL");
			}
			if (options.agentName === "worker") return makeResult("worker", options.task, "fixed target repo");
			return makeResult("reviewer", options.task, "APPROVE\nVERDICT: REVIEW_PASS");
		});

		try {
			register(stub.api);
			const tool = stub.tools.find((candidate) => candidate.name === "subagent");
			await tool.execute(
				"call-chain-cwd",
				{ agent: "reviewer", task: "Review target repo", cwd: targetRepo },
				new AbortController().signal,
				() => {},
				{ ...executionContext(), cwd: outerRepo },
			);
			await capturedTasks[0](controllers[0].signal);
			await capturedTasks[1](controllers[1].signal);

			expect(run).toHaveBeenCalledTimes(3);
			for (const [options] of run.mock.calls) {
				expect(options.defaultCwd).toBe(targetRepo);
				expect(options.cwd).toBe(targetRepo);
			}
			expect(stub.messages).toHaveLength(1);
			expect(stub.messages[0].message.content).toContain("final PASS");
		} finally {
			for (const controller of controllers) controller.abort();
			await stub.hooks["session_shutdown"]?.({}, {});
			rmSync(outerRepo, { recursive: true, force: true });
			rmSync(targetRepo, { recursive: true, force: true });
		}
	});

	it("serializes concurrent auto-fix chains that share a repository", async () => {
		const stub = makeStub();
		const capturedTasks: BackgroundTask[] = [];
		const controllers: AbortController[] = [];
		vi.spyOn(BackgroundTaskQueue.prototype, "enqueue").mockImplementation((task) => {
			capturedTasks.push(task);
			const controller = new AbortController();
			controllers.push(controller);
			return controller;
		});
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
			if (options.task === "Review A" || options.task === "Review B") {
				return makeResult("reviewer", options.task, "REQUEST_CHANGES\nVERDICT: REVIEW_FAIL");
			}
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
				tool.execute("chain-a", { agent: "reviewer", task: "Review A", cwd: repo }, new AbortController().signal, () => {}, executionContext()),
				tool.execute("chain-b", { agent: "reviewer", task: "Review B", cwd: repo }, new AbortController().signal, () => {}, executionContext()),
			]);
			await Promise.all([
				capturedTasks[0](controllers[0].signal),
				capturedTasks[1](controllers[1].signal),
			]);
			expect(capturedTasks).toHaveLength(4);
			const chains = [
				capturedTasks[2](controllers[2].signal),
				capturedTasks[3](controllers[3].signal),
			];
			await vi.waitFor(() => expect(workerStarts).toBe(1));
			await new Promise((resolveDelay) => setTimeout(resolveDelay, 30));
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
			for (const controller of controllers) controller.abort();
			await stub.hooks["session_shutdown"]?.({}, {});
			rmSync(repo, { recursive: true, force: true });
		}
	});

	it("publishes the interrupted auto-fix sub-step partial instead of the old review", async () => {
		const stub = makeStub();
		let activeWorkerOptions: any;
		vi.spyOn(spawn, "runSingleAgentWithMainFallback")
			.mockResolvedValueOnce({
				agent: "reviewer",
				task: "Review the change",
				exitCode: 0,
				messages: [{ role: "assistant", content: [{ type: "text", text: "OLD INITIAL REVIEW\nVERDICT: REVIEW_FAIL" }], stopReason: "stop" }],
				stderr: "",
				usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 2, turns: 1 },
			} as any)
			.mockImplementationOnce(async (options: any) => {
				activeWorkerOptions = options;
				return new Promise((resolve) => {
					const finish = () => resolve({
						agent: "worker",
						task: options.task,
						exitCode: 1,
						messages: [{ role: "assistant", content: [{ type: "text", text: "CURRENT FIX PARTIAL" }], stopReason: "aborted" }],
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
		const dispatched = await tool.execute(
			"call-chain-stop",
			{ agent: "reviewer", task: "Review the change" },
			new AbortController().signal,
			() => {},
			executionContext(),
		);
		const runId = dispatched.details.results[0].runId;
		await vi.waitFor(() => expect(activeWorkerOptions).toBeDefined());

		await stopTool.execute(
			"stop-chain",
			{ id: String(runId) },
			new AbortController().signal,
			() => {},
			executionContext(),
		);
		expect(stub.messages).toHaveLength(1);
		expect(stub.messages[0].message.content).toContain("CURRENT FIX PARTIAL");
		expect(stub.messages[0].message.content).not.toContain("OLD INITIAL REVIEW");
		await stub.hooks["session_shutdown"]?.({}, {});
	});

	it("stops the chain when a re-review fails, without starting another fix round", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const stub = makeStub();
		const capturedTasks: BackgroundTask[] = [];
		const controllers: AbortController[] = [];
		vi.spyOn(BackgroundTaskQueue.prototype, "enqueue").mockImplementation((task) => {
			capturedTasks.push(task);
			const controller = new AbortController();
			controllers.push(controller);
			return controller;
		});

		let childDir: string | undefined;
		const previousScript = process.argv[1];
		try {
			childDir = mkdtempSync(join(tmpdir(), "pi-subagents-chain-fail-child-"));
			const childScript = join(childDir, "fake-pi-child.mjs");
			writeFileSync(
				childScript,
				fakeRpcScript({
					onPrompt: `if (input.includes("Auto-fix round")) {
	send({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "fixed" }], stopReason: "stop" } });
} else if (input.includes("Re-review after auto-fix round")) {
	send({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "crashed mid-review" }], stopReason: "error" } });
} else {
	send({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "REQUEST_CHANGES\\nVERDICT: REVIEW_FAIL" }], stopReason: "stop" } });
}`,
				}),
				"utf8",
			);
			process.argv[1] = childScript;

			register(stub.api);
			const tool = stub.tools.find((candidate) => candidate.name === "subagent");
			await tool.execute(
				"call-chain-fail",
				{ agent: "reviewer", task: "Review the change" },
				new AbortController().signal,
				() => {},
				executionContext(),
			);

			await capturedTasks[0](controllers[0].signal);
			expect(capturedTasks).toHaveLength(2);
			await capturedTasks[1](controllers[1].signal);

			expect(stub.messages).toHaveLength(1);
			const content = stub.messages[0].message.content as string;
			expect(content).toContain("## Auto-fix chain: 1 round — final failed");
			expect(content).toContain("reviewer · re-review round 1 · failed");
			// The crashed final re-review's full report is appended so the main agent
			// sees why the chain stopped.
			expect(content).toContain("### [reviewer] failed");
			// No second fix round: the crashed re-review ends the chain.
			expect(content).not.toContain("Auto-fix round 2");
			expect(monitor.getRuns()).toHaveLength(0);
		} finally {
			for (const controller of controllers) controller.abort();
			await stub.hooks["session_shutdown"]?.({}, {});
			for (const run of [...monitor.getRuns()]) monitor.removeRun(run.id);
			process.argv[1] = previousScript;
			if (childDir) rmSync(childDir, { recursive: true, force: true });
		}
	});

	it("delivers a REVIEW_FAIL review directly when maxFixRounds is 0", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		if (!testAgentDir) throw new Error("test agent directory was not initialized");
		writeFileSync(join(testAgentDir, "pi-subagents.json"), JSON.stringify({ maxFixRounds: 0 }), "utf8");
		const stub = makeStub();
		const capturedTasks: BackgroundTask[] = [];
		const controllers: AbortController[] = [];
		vi.spyOn(BackgroundTaskQueue.prototype, "enqueue").mockImplementation((task) => {
			capturedTasks.push(task);
			const controller = new AbortController();
			controllers.push(controller);
			return controller;
		});

		let childDir: string | undefined;
		const previousScript = process.argv[1];
		try {
			childDir = mkdtempSync(join(tmpdir(), "pi-subagents-no-loop-child-"));
			const childScript = join(childDir, "fake-pi-child.mjs");
			writeFileSync(
				childScript,
				fakeRpcScript({
					onPrompt: `send({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "REQUEST_CHANGES\\nVERDICT: REVIEW_FAIL" }], stopReason: "stop" } });`,
				}),
				"utf8",
			);
			process.argv[1] = childScript;

			register(stub.api);
			const tool = stub.tools.find((candidate) => candidate.name === "subagent");
			await tool.execute(
				"call-no-loop",
				{ agent: "reviewer", task: "Review the change" },
				new AbortController().signal,
				() => {},
				executionContext(),
			);

			await capturedTasks[0](controllers[0].signal);
			// Only the review task was enqueued — no chain task.
			expect(capturedTasks).toHaveLength(1);
			vi.advanceTimersByTime(150);
			expect(stub.messages).toHaveLength(1);
			expect(stub.messages[0].message.content).toContain("### [reviewer] completed");
			expect(monitor.getRuns().find((run) => run.activity === "auto-fix chain running")).toBeUndefined();
		} finally {
			for (const controller of controllers) controller.abort();
			await stub.hooks["session_shutdown"]?.({}, {});
			for (const run of [...monitor.getRuns()]) monitor.removeRun(run.id);
			process.argv[1] = previousScript;
			if (childDir) rmSync(childDir, { recursive: true, force: true });
		}
	});

	it("delivers a dispatch-crashed reviewer as a failure, never as a phantom fix chain", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const stub = makeStub();
		const uiNotify = vi.fn();
		const capturedTasks: BackgroundTask[] = [];
		const controllers: AbortController[] = [];
		vi.spyOn(BackgroundTaskQueue.prototype, "enqueue").mockImplementation((task) => {
			capturedTasks.push(task);
			const controller = new AbortController();
			controllers.push(controller);
			return controller;
		});

		let childDir: string | undefined;
		const previousScript = process.argv[1];
		try {
			// Point argv[1] at a fake child anyway: if the rejection below fails to
			// intercept, the test fails on assertions instead of spawning real pi.
			childDir = mkdtempSync(join(tmpdir(), "pi-subagents-crash-child-"));
			const childScript = join(childDir, "fake-pi-child.mjs");
			writeFileSync(
				childScript,
				fakeRpcScript({
					onPrompt: `send({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "REQUEST_CHANGES\\nVERDICT: REVIEW_FAIL" }], stopReason: "stop" } });`,
				}),
				"utf8",
			);
			process.argv[1] = childScript;

			register(stub.api);
			const tool = stub.tools.find((candidate) => candidate.name === "subagent");
			await tool.execute(
				"call-crash",
				{ agent: "reviewer", task: "Review the change" },
				new AbortController().signal,
				() => {},
				executionContext({ uiNotify }),
			);
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
			expect(monitor.getRuns().find((run) => run.activity === "auto-fix chain running")).toBeUndefined();
		} finally {
			for (const controller of controllers) controller.abort();
			await stub.hooks["session_shutdown"]?.({}, {});
			for (const run of [...monitor.getRuns()]) monitor.removeRun(run.id);
			process.argv[1] = previousScript;
			if (childDir) rmSync(childDir, { recursive: true, force: true });
		}
	});

	it("delivers a crashed reviewer with a trailing REVIEW_FAIL partial as a failure, without a fix chain", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const stub = makeStub();
		const uiNotify = vi.fn();
		const capturedTasks: BackgroundTask[] = [];
		const controllers: AbortController[] = [];
		vi.spyOn(BackgroundTaskQueue.prototype, "enqueue").mockImplementation((task) => {
			capturedTasks.push(task);
			const controller = new AbortController();
			controllers.push(controller);
			return controller;
		});

		let childDir: string | undefined;
		const previousScript = process.argv[1];
		try {
			childDir = mkdtempSync(join(tmpdir(), "pi-subagents-partial-child-"));
			const childScript = join(childDir, "fake-pi-child.mjs");
			writeFileSync(
				childScript,
				fakeRpcScript({
					onPrompt: `send({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "I found issues.\\nVERDICT: REVIEW_FAIL" }], stopReason: "error" } });`,
				}),
				"utf8",
			);
			process.argv[1] = childScript;

			register(stub.api);
			const tool = stub.tools.find((candidate) => candidate.name === "subagent");
			await tool.execute(
				"call-crash2",
				{ agent: "reviewer", task: "Review the change" },
				new AbortController().signal,
				() => {},
				executionContext({ uiNotify }),
			);
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
			expect(monitor.getRuns().find((run) => run.activity === "auto-fix chain running")).toBeUndefined();
		} finally {
			for (const controller of controllers) controller.abort();
			await stub.hooks["session_shutdown"]?.({}, {});
			for (const run of [...monitor.getRuns()]) monitor.removeRun(run.id);
			process.argv[1] = previousScript;
			if (childDir) rmSync(childDir, { recursive: true, force: true });
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
		expect(result.systemPrompt).toContain("- reviewer:");
		expect(result.systemPrompt).not.toContain("- plan:");
	});

	it("excludes untrusted project agent overrides from injection and dispatch", async () => {
		if (!testAgentDir) throw new Error("test agent directory was not initialized");
		writeFileSync(join(testAgentDir, "pi-subagents.json"), JSON.stringify({
			agentScope: "both",
			enabledAgents: ["worker"],
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
		let queued!: BackgroundTask;
		const controller = new AbortController();
		vi.spyOn(BackgroundTaskQueue.prototype, "enqueue").mockImplementation((task) => {
			queued = task;
			return controller;
		});
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
			await tool.execute(
				"untrusted-dispatch",
				{ agent: "worker", task: "safe task" },
				new AbortController().signal,
				() => {},
				untrustedCtx,
			);
			await queued(controller.signal);
			expect(run).toHaveBeenCalledTimes(1);
			const options = run.mock.calls[0]![0]!;
			expect(options.agent!.source).toBe("builtin");
			expect(options.agent!.systemPrompt).not.toContain("MALICIOUS PROJECT");
		} finally {
			controller.abort();
			await stub.hooks["session_shutdown"]?.({}, {});
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
		await tool.execute(
			"call-model",
			{ agent: "reviewer", task: "Review the change" },
			new AbortController().signal,
			() => {},
			{ ...executionContext({ uiNotify }), model: AVAILABLE[0], modelRegistry: { getAvailable: () => AVAILABLE } },
		);
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

