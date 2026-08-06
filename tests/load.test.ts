import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BackgroundTaskQueue, type BackgroundTask } from "../src/background.ts";
import register from "../src/index.ts";
import { monitor } from "../src/monitor.ts";

interface StubPi {
	tools: any[];
	commands: string[];
	hooks: Record<string, (event: any, ctx: any) => any>;
	messages: Array<{ message: any; options: any }>;
	setWidget: ReturnType<typeof vi.fn>;
	api: any;
}

function makeStub(): StubPi {
	const stub: StubPi = {
		tools: [],
		commands: [],
		hooks: {},
		messages: [],
		setWidget: vi.fn(),
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

let savedDepth: string | undefined;
let savedAgentDir: string | undefined;
let testAgentDir: string | undefined;

beforeEach(() => {
	savedDepth = process.env.PI_SUBAGENT_DEPTH;
	savedAgentDir = process.env.PI_CODING_AGENT_DIR;
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
		expect(stub.commands).toContain("subagents-setup");
		expect(typeof stub.hooks["before_agent_start"]).toBe("function");

		const tool = stub.tools.find((t) => t.name === "subagent");
		expect(tool.promptGuidelines.length).toBeGreaterThan(0);
		expect(tool.description).toContain("explore");
		expect(tool.parameters.properties.task).toMatchObject({ minLength: 1, pattern: "\\S" });
		expect(tool.parameters.properties.tasks.items.properties.task).toMatchObject({ minLength: 1, pattern: "\\S" });
	});

	it("does not register the tool inside any child sub-agent process", () => {
		process.env.PI_SUBAGENT_DEPTH = "1";
		const stub = makeStub();
		register(stub.api);
		expect(stub.tools.map((t) => t.name)).not.toContain("subagent");
		expect(stub.commands).toContain("subagents-setup");
	});

	it("also blocks a deeper inherited depth", () => {
		process.env.PI_SUBAGENT_DEPTH = "2";
		const stub = makeStub();
		register(stub.api);
		expect(stub.tools.map((t) => t.name)).not.toContain("subagent");
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
					{ agent: "explore", task: "Inspect the relevant files" },
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

describe("registered tool background dispatch", () => {
	it("shows the task in the widget and reports its summary with cache reads on completion", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const stub = makeStub();
		const capturedTasks: BackgroundTask[] = [];
		const backgroundController = new AbortController();
		vi.spyOn(BackgroundTaskQueue.prototype, "enqueue").mockImplementation((task) => {
			capturedTasks.push(task);
			return backgroundController;
		});

		let component: { render: (width: number) => string[]; dispose: () => void } | undefined;
		let childDir: string | undefined;
		const previousScript = process.argv[1];
		try {
			childDir = mkdtempSync(join(tmpdir(), "pi-subagents-load-child-"));
			const childScript = join(childDir, "fake-pi-child.mjs");
			writeFileSync(
				childScript,
				`process.stdin.resume();
process.stdin.on("end", () => {
	process.stdout.write(JSON.stringify({ type: "agent_start" }) + "\\n");
	process.stdout.write(JSON.stringify({
		type: "message_end",
		message: {
			role: "assistant",
			content: [{ type: "text", text: "fake child completed" }],
			usage: { input: 0, output: 0, cacheRead: 321, cacheWrite: 0, cost: { total: 0 }, totalTokens: 321 },
			stopReason: "stop"
		}
	}) + "\\n");
});
`,
				"utf8",
			);
			process.argv[1] = childScript;

			register(stub.api);
			await stub.hooks["session_start"]({}, { mode: "tui", ui: { setWidget: stub.setWidget } });
			expect(stub.setWidget).toHaveBeenCalledOnce();
			const widgetRegistration = stub.setWidget.mock.calls[0];
			expect(widgetRegistration[0]).toBe("pi-subagents");
			expect(widgetRegistration[2]).toEqual({ placement: "aboveEditor" });
			const widgetComponent = widgetRegistration[1](
				{ requestRender: vi.fn() },
				{ fg: (_color: string, text: string) => text, bold: (text: string) => text },
			) as { render: (width: number) => string[]; dispose: () => void };
			component = widgetComponent;

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
			// The task title is inlined after the agent name (› marker) so parallel
			// runs of the same agent are distinguishable at a glance.
			expect(widgetComponent.render(160).join("\n")).toContain(`worker › ${summary}`);

			await capturedTasks[0](backgroundController.signal);

			expect(stub.messages).toHaveLength(0);
			vi.advanceTimersByTime(150);
			expect(stub.messages).toHaveLength(1);
			const completion = stub.messages[0];
			expect(completion.message.content).toContain(`Task: ${summary}`);
			expect(completion.message.content).toMatch(/\bR321\b/);
			expect(completion.options).toEqual({ deliverAs: "followUp", triggerTurn: true });
		} finally {
			component?.dispose();
			backgroundController.abort();
			await stub.hooks["session_shutdown"]?.({}, {});
			for (const run of [...monitor.getRuns()]) monitor.removeRun(run.id);
			process.argv[1] = previousScript;
			if (childDir) rmSync(childDir, { recursive: true, force: true });
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
				`process.stdin.resume();
process.stdin.on("end", () => {
	process.stdout.write(JSON.stringify({
		type: "message_end",
		message: { role: "assistant", content: [{ type: "text", text: "batch result" }], stopReason: "stop" }
	}) + "\\n");
});
`,
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
			expect(completion.options).toEqual({ deliverAs: "followUp", triggerTurn: true });
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
				`process.stdin.resume();
process.stdin.on("end", () => {
	process.stdout.write(JSON.stringify({
		type: "message_end",
		message: {
			role: "assistant",
			content: [{ type: "text", text: "APPROVE\\nVERDICT: REVIEW_PASS" }],
			stopReason: "stop"
		}
	}) + "\\n");
});
`,
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
				`let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => input += chunk);
process.stdin.on("end", () => {
	const failed = input.includes("must fail");
	const text = failed ? "VERDICT: REVIEW_FAIL" : "successful result";
	process.stdout.write(JSON.stringify({
		type: "message_end",
		message: { role: "assistant", content: [{ type: "text", text }], stopReason: "stop" }
	}) + "\\n");
	process.exitCode = failed ? 1 : 0;
});
`,
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
			expect(stub.messages[0].options).toEqual({ deliverAs: "followUp", triggerTurn: true });
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
				`process.stdin.resume();
process.stdin.on("end", () => {
	const lines = Array.from({ length: 100 }, (_, i) => "line " + i).join("\\n");
	process.stdout.write(JSON.stringify({
		type: "message_end",
		message: { role: "assistant", content: [{ type: "text", text: lines }], stopReason: "stop" }
	}) + "\\n");
});
`,
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
				`let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => input += chunk);
process.stdin.on("end", () => {
	let text = "REQUEST_CHANGES\\nVERDICT: REVIEW_FAIL";
	if (input.includes("Auto-fix round")) text = "all blockers fixed";
	else if (input.includes("Re-review after auto-fix round")) text = "APPROVE\\nVERDICT: REVIEW_PASS";
	process.stdout.write(JSON.stringify({
		type: "message_end",
		message: { role: "assistant", content: [{ type: "text", text }], stopReason: "stop" }
	}) + "\\n");
});
`,
				"utf8",
			);
			process.argv[1] = childScript;

			register(stub.api);
			const tool = stub.tools.find((candidate) => candidate.name === "subagent");
			await tool.execute(
				"call-chain",
				{ agent: "reviewer", task: "Review the change" },
				new AbortController().signal,
				() => {},
				executionContext({ uiNotify }),
			);

			expect(capturedTasks).toHaveLength(1);
			await capturedTasks[0](controllers[0].signal);

			// The chain task was enqueued by the initial review's completion; the
			// review itself is NOT delivered or notified yet.
			expect(capturedTasks).toHaveLength(2);
			expect(stub.messages).toHaveLength(0);
			expect(uiNotify).not.toHaveBeenCalled();
			const parent = monitor.getRuns().find((run) => run.annotation === "auto-fix chain running");
			expect(parent).toBeDefined();
			expect(parent?.agent).toBe("reviewer");

			await capturedTasks[1](controllers[1].signal);

			expect(stub.messages).toHaveLength(1);
			const content = stub.messages[0].message.content as string;
			expect(content).toContain("### [reviewer] completed");
			expect(content).toContain("### [worker] completed");
			expect(content).toContain("Task: Review the change");
			expect(content).toContain("Task: Auto-fix round 1 of 2");
			expect(content).toContain("Task: Re-review after auto-fix round 1");
			expect(stub.messages[0].options).toEqual({ deliverAs: "followUp", triggerTurn: true });
			// Chain-internal runs notify individually; the parent row is dropped.
			expect(uiNotify).toHaveBeenCalledTimes(2);
			expect(monitor.getRuns().find((run) => run.annotation)).toBeUndefined();
		} finally {
			for (const controller of controllers) controller.abort();
			await stub.hooks["session_shutdown"]?.({}, {});
			for (const run of [...monitor.getRuns()]) monitor.removeRun(run.id);
			process.argv[1] = previousScript;
			if (childDir) rmSync(childDir, { recursive: true, force: true });
		}
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
				`let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => input += chunk);
process.stdin.on("end", () => {
	if (input.includes("Auto-fix round")) {
		process.stdout.write(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "fixed" }], stopReason: "stop" } }) + "\\n");
	} else if (input.includes("Re-review after auto-fix round")) {
		process.stdout.write(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "crashed mid-review" }], stopReason: "error" } }) + "\\n");
		process.exitCode = 1;
	} else {
		process.stdout.write(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "REQUEST_CHANGES\\nVERDICT: REVIEW_FAIL" }], stopReason: "stop" } }) + "\\n");
	}
});
`,
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
			expect(content).toContain("### [reviewer] failed");
			expect(content).toContain("Task: Auto-fix round 1 of 2");
			// No second fix round: the crashed re-review ends the chain.
			expect(content).not.toContain("Auto-fix round 2");
			expect(monitor.getRuns().find((run) => run.annotation)).toBeUndefined();
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
				`process.stdin.resume();
process.stdin.on("end", () => {
	process.stdout.write(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "REQUEST_CHANGES\\nVERDICT: REVIEW_FAIL" }], stopReason: "stop" } }) + "\\n");
});
`,
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
			expect(monitor.getRuns().find((run) => run.annotation)).toBeUndefined();
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
		// Default enabled set: explore, worker, reviewer.
		expect(result.systemPrompt).toContain("- explore:");
		expect(result.systemPrompt).toContain("- worker:");
		expect(result.systemPrompt).toContain("- reviewer:");
		expect(result.systemPrompt).not.toContain("- plan:");
	});
});
