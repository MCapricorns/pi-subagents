import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BackgroundTaskQueue, type BackgroundTask } from "../src/background.ts";
import register from "../src/index.ts";
import { monitor } from "../src/monitor.ts";
import * as spawn from "../src/spawn.ts";
import { fakeRpcScript } from "./fake-rpc.ts";

interface StubPi {
	tools: any[];
	hooks: Record<string, (event: any, ctx: any) => any>;
	messages: Array<{ message: any; options: any }>;
	api: any;
}

function makeStub(): StubPi {
	const stub: StubPi = { tools: [], hooks: {}, messages: [], api: undefined };
	stub.api = {
		registerTool: (tool: any) => stub.tools.push(tool),
		registerMessageRenderer: () => {},
		registerCommand: () => {},
		registerShortcut: () => {},
		sendMessage: (message: any, options: any) => stub.messages.push({ message, options }),
		on: (event: string, handler: any) => {
			stub.hooks[event] = handler;
		},
	};
	return stub;
}

function executionContext(): any {
	return {
		cwd: process.cwd(),
		model: undefined,
		scopedModels: [],
		modelRegistry: { getAvailable: () => [] },
		ui: { notify: vi.fn() },
	};
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error("Timed out waiting for test condition");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

function commandLog(path: string): Array<{ type: string; message?: string; argv: string[] }> {
	return readFileSync(path, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));
}

let savedDepth: string | undefined;
let savedAgentDir: string | undefined;
let savedScript: string | undefined;
let testDir: string;
let activeStub: StubPi | undefined;

beforeEach(() => {
	savedDepth = process.env.PI_SUBAGENT_DEPTH;
	savedAgentDir = process.env.PI_CODING_AGENT_DIR;
	savedScript = process.argv[1];
	delete process.env.PI_SUBAGENT_DEPTH;
	testDir = mkdtempSync(join(tmpdir(), "pi-subagents-control-"));
	process.env.PI_CODING_AGENT_DIR = testDir;
});

afterEach(async () => {
	vi.restoreAllMocks();
	await activeStub?.hooks["session_shutdown"]?.({}, {});
	activeStub = undefined;
	monitor.clear();
	if (savedDepth === undefined) delete process.env.PI_SUBAGENT_DEPTH;
	else process.env.PI_SUBAGENT_DEPTH = savedDepth;
	if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
	process.argv[1] = savedScript ?? "";
	rmSync(testDir, { recursive: true, force: true });
});

function registerWithScript(script: string): {
	stub: StubPi;
	subagent: any;
	control: any;
	stop: any;
	status: any;
} {
	process.argv[1] = script;
	const stub = makeStub();
	activeStub = stub;
	register(stub.api);
	return {
		stub,
		subagent: stub.tools.find((tool) => tool.name === "subagent"),
		control: stub.tools.find((tool) => tool.name === "subagent_control"),
		stop: stub.tools.find((tool) => tool.name === "subagent_stop"),
		status: stub.tools.find((tool) => tool.name === "subagent_status"),
	};
}

function execute(tool: any, params: any, ctx: any = executionContext()): Promise<any> {
	return tool.execute("call", params, new AbortController().signal, () => {}, ctx);
}

describe("subagent_control persistent RPC threads", () => {
	it("steers a running RPC child after its current tool batch", async () => {
		const log = join(testDir, "commands.log");
		const script = join(testDir, "steer-child.mjs");
		writeFileSync(
			script,
			fakeRpcScript({
				setup: `const commandLog = ${JSON.stringify(log)};`,
				onPrompt: `fs.appendFileSync(commandLog, JSON.stringify({ type: "prompt", behavior: command.streamingBehavior, message: input, argv: process.argv }) + "\\n");
if (promptCount > 1) {
	send({ type: "turn_start" });
	send({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "steered: " + command.message }], stopReason: "stop" } });
	send({ type: "turn_end" });
	send({ type: "agent_settled" });
}`,
				autoSettle: false,
			}),
			"utf8",
		);
		const { stub, subagent, control } = registerWithScript(script);
		await execute(subagent, { agent: "worker", task: "Inspect old path" });
		const runId = monitor.getRuns()[0]?.id;
		expect(runId).toBeDefined();
		await waitFor(() => existsSync(log) && commandLog(log).some((entry) => entry.type === "prompt"));
		await new Promise((resolve) => setTimeout(resolve, 20));

		const controlled = await execute(control, {
			action: "steer",
			id: runId,
			instruction: "Use the new path instead",
		});
		expect(controlled.content[0].text).toContain("Queued steering instruction");
		await waitFor(() => stub.messages.length === 1);
		expect(stub.messages[0].message.content).toContain("steered: Use the new path instead");
		expect(commandLog(log).map((entry) => entry.type)).toEqual(["prompt", "prompt"]);
		expect(commandLog(log)[1]).toMatchObject({ behavior: "steer" });
	});

	it("retargets through abort -> agent_settled -> prompt without an aborted completion", async () => {
		const log = join(testDir, "commands.log");
		const script = join(testDir, "retarget-child.mjs");
		writeFileSync(
			script,
			fakeRpcScript({
				setup: `const commandLog = ${JSON.stringify(log)};`,
				onPrompt: `fs.appendFileSync(commandLog, JSON.stringify({ type: "prompt", message: input, argv: process.argv }) + "\\n");
if (promptCount > 1) {
	send({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "new objective complete" }], stopReason: "stop" } });
	send({ type: "agent_settled" });
} else {
	send({ type: "tool_execution_end", toolCallId: "old-failure", toolName: "bash", isError: true, result: { content: [{ type: "text", text: "old objective failed" }] } });
}`,
				onAbort: `fs.appendFileSync(commandLog, JSON.stringify({ type: "abort", argv: process.argv }) + "\\n");
send({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "abandoned partial" }], stopReason: "aborted" } });
send({ type: "agent_settled" });`,
				autoSettle: false,
			}),
			"utf8",
		);
		const { stub, subagent, control } = registerWithScript(script);
		await execute(subagent, { agent: "worker", task: "Old objective" });
		const runId = monitor.getRuns()[0]?.id;
		await waitFor(() => existsSync(log) && commandLog(log).some((entry) => entry.type === "prompt"));
		await new Promise((resolve) => setTimeout(resolve, 20));

		const controlled = await execute(control, {
			action: "retarget",
			id: runId,
			objective: "Replacement objective",
		});
		expect(controlled.content[0].text).toContain("aborted objective will not be delivered");
		await waitFor(() => stub.messages.length === 1);
		expect(stub.messages).toHaveLength(1);
		expect(stub.messages[0].message.content).toContain("new objective complete");
		expect(stub.messages[0].message.content).not.toContain("abandoned partial");
		expect(stub.messages[0].message.content).not.toContain("failed tool call");
		expect(stub.messages[0].message.content).not.toContain("old objective failed");
		const commands = commandLog(log);
		expect(commands.map((entry) => entry.type)).toEqual(["prompt", "abort", "prompt"]);
		expect(commands[2].message).toBe("Replacement objective");
	});

	it("serializes retarget and park so abort/settle/prompt transitions cannot double-deliver", async () => {
		const log = join(testDir, "commands.log");
		const script = join(testDir, "serialized-control-child.mjs");
		writeFileSync(
			script,
			fakeRpcScript({
				setup: `const commandLog = ${JSON.stringify(log)};`,
				onPrompt: `fs.appendFileSync(commandLog, JSON.stringify({ type: "prompt", message: input, argv: process.argv }) + "\\n");`,
				onAbort: `fs.appendFileSync(commandLog, JSON.stringify({ type: "abort", argv: process.argv }) + "\\n");
send({ type: "message_end", message: { role: "assistant", content: [], stopReason: "aborted" } });
send({ type: "agent_settled" });`,
				autoSettle: false,
			}),
			"utf8",
		);
		const { stub, subagent, control } = registerWithScript(script);
		await execute(subagent, { agent: "worker", task: "Old objective" });
		const runId = monitor.getRuns()[0]?.id;
		await waitFor(() => existsSync(log) && commandLog(log).length === 1);
		await new Promise((resolve) => setTimeout(resolve, 20));

		const retarget = execute(control, { action: "retarget", id: runId, objective: "Replacement" });
		const park = execute(control, { action: "park", id: runId });
		await Promise.all([retarget, park]);
		expect(monitor.findRun(runId!)?.status).toBe("parked");
		expect(stub.messages).toHaveLength(0);
		expect(commandLog(log).map((entry) => entry.type)).toEqual(["prompt", "abort", "prompt", "abort"]);
	});

	it("parks then resumes from the same retained session and logical run id", async () => {
		const log = join(testDir, "commands.log");
		const script = join(testDir, "park-child.mjs");
		writeFileSync(
			script,
			fakeRpcScript({
				setup: `const commandLog = ${JSON.stringify(log)}; const resumedProcess = process.argv.includes("--session");`,
				onPrompt: `fs.appendFileSync(commandLog, JSON.stringify({ type: "prompt", message: input, argv: process.argv }) + "\\n");
if (resumedProcess) {
	send({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "resumed completion" }], stopReason: "stop" } });
	send({ type: "agent_settled" });
}`,
				onAbort: `fs.appendFileSync(commandLog, JSON.stringify({ type: "abort", argv: process.argv }) + "\\n");
send({ type: "message_end", message: { role: "assistant", content: [], stopReason: "aborted" } });
send({ type: "agent_settled" });`,
				autoSettle: false,
			}),
			"utf8",
		);
		const { stub, subagent, control } = registerWithScript(script);
		await execute(subagent, { agent: "worker", task: "Long objective" });
		const runId = monitor.getRuns()[0]?.id;
		await waitFor(() => monitor.findRun(runId!)?.status === "running");

		const parked = await execute(control, { action: "park", id: runId });
		expect(parked.content[0].text).toContain("stable checkpoint");
		expect(monitor.findRun(runId!)?.status).toBe("parked");
		expect(stub.messages).toHaveLength(0);
		const first = commandLog(log)[0];
		const sessionDir = first.argv[first.argv.indexOf("--session-dir") + 1];
		expect(existsSync(sessionDir)).toBe(true);

		const resumed = await execute(control, {
			action: "resume",
			id: runId,
			objective: "Finish from checkpoint",
		});
		expect(resumed.content[0].text).toContain(`Resumed run #${runId}`);
		expect(monitor.findRun(runId!)?.id).toBe(runId);
		await waitFor(() => stub.messages.length === 1);
		expect(stub.messages[0].message.content).toContain("resumed completion");
		const prompts = commandLog(log).filter((entry) => entry.type === "prompt");
		expect(prompts).toHaveLength(2);
		expect(prompts[1].message).toBe("Finish from checkpoint");
		expect(prompts[1].argv).toContain("--session");
		expect(prompts[1].argv[prompts[1].argv.indexOf("--session-dir") + 1]).toBe(sessionDir);
	});

	it("resumes a completed thread with an optional new objective and the same id/session", async () => {
		const log = join(testDir, "commands.log");
		const script = join(testDir, "complete-resume-child.mjs");
		writeFileSync(
			script,
			fakeRpcScript({
				setup: `const commandLog = ${JSON.stringify(log)}; const resumedProcess = process.argv.includes("--session");`,
				onPrompt: `fs.appendFileSync(commandLog, JSON.stringify({ type: "prompt", message: input, argv: process.argv }) + "\\n");
send({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: resumedProcess ? "second completion" : "first completion" }], stopReason: "stop" } });`,
			}),
			"utf8",
		);
		const { stub, subagent, control, status } = registerWithScript(script);
		await execute(subagent, { agent: "worker", task: "Initial objective" });
		const runId = monitor.getRuns()[0]?.id;
		await waitFor(() => stub.messages.length === 1);
		expect(stub.messages[0].message.content).toContain("first completion");
		stub.messages.length = 0;

		const resumed = await execute(
			control,
			{
				action: "resume",
				id: runId,
				objective: "Follow-on objective",
			},
			{ ...executionContext(), model: { provider: "openai", id: "new-main" } },
		);
		expect(resumed.content[0].text).toContain(`Resumed run #${runId}`);
		expect(monitor.findRun(runId!)?.id).toBe(runId);
		await waitFor(() => stub.messages.length === 1);
		expect(stub.messages[0].message.content).toContain("second completion");
		const full = await execute(status, { id: String(runId) });
		expect(full.content[0].text).toContain("Task: Follow-on objective");
		const prompts = commandLog(log).filter((entry) => entry.type === "prompt");
		expect(prompts[1].message).toBe("Follow-on objective");
		expect(prompts[1].argv[prompts[1].argv.indexOf("--model") + 1]).toBe("openai/new-main");
		const retainedDir = prompts[0].argv[prompts[0].argv.indexOf("--session-dir") + 1];
		expect(retainedDir).toBe(prompts[1].argv[prompts[1].argv.indexOf("--session-dir") + 1]);
		expect(existsSync(retainedDir)).toBe(true);
		await stub.hooks["session_shutdown"]?.({}, {});
		activeStub = undefined;
		expect(existsSync(retainedDir)).toBe(false);
	});

	it("parks an auto-fix generation before resume so the old chain cannot publish", async () => {
		const log = join(testDir, "auto-fix-commands.log");
		const script = join(testDir, "auto-fix-park-child.mjs");
		writeFileSync(
			script,
			fakeRpcScript({
				setup: `const commandLog = ${JSON.stringify(log)}; const resumedProcess = process.argv.includes("--session");`,
				onPrompt: `fs.appendFileSync(commandLog, JSON.stringify({ type: "prompt", message: input, argv: process.argv }) + "\\n");
if (!input.includes("Auto-fix round")) {
	const text = resumedProcess ? "APPROVE\\nVERDICT: REVIEW_PASS" : "REQUEST_CHANGES\\nVERDICT: REVIEW_FAIL";
	send({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }], stopReason: "stop" } });
	send({ type: "agent_settled" });
}`,
				onAbort: `fs.appendFileSync(commandLog, JSON.stringify({ type: "abort" }) + "\\n");
send({ type: "message_end", message: { role: "assistant", content: [], stopReason: "aborted" } });
send({ type: "agent_settled" });`,
				autoSettle: false,
			}),
			"utf8",
		);
		const { stub, subagent, control } = registerWithScript(script);
		const dispatched = await execute(subagent, { agent: "reviewer", task: "Review the change" });
		const runId = dispatched.details.results[0].runId;
		await waitFor(() => monitor.findRun(runId)?.activity === "auto-fix chain running");
		await waitFor(() => commandLog(log).some((entry) => entry.message?.includes("Auto-fix round")));

		const parked = await execute(control, { action: "park", id: runId });
		expect(parked.content[0].text).toContain("stable checkpoint");
		expect(stub.messages).toHaveLength(0);
		const resumed = await execute(control, { action: "resume", id: runId, objective: "Re-review now" });
		expect(resumed.content[0].text).toContain(`Resumed run #${runId}`);
		await waitFor(() => stub.messages.length === 1);
		expect(stub.messages[0].message.content).toContain("VERDICT: REVIEW_PASS");
		expect(stub.messages[0].message.content).not.toContain("Auto-fix chain:");
		expect(commandLog(log).filter((entry) => entry.type === "prompt")).toHaveLength(3);
	});

	it("destructive stop retires a parked retained session", async () => {
		const log = join(testDir, "commands.log");
		const script = join(testDir, "stop-cleanup-child.mjs");
		writeFileSync(
			script,
			fakeRpcScript({
				setup: `const commandLog = ${JSON.stringify(log)};`,
				onPrompt: `fs.appendFileSync(commandLog, JSON.stringify({ type: "prompt", message: input, argv: process.argv }) + "\\n");`,
				autoSettle: false,
			}),
			"utf8",
		);
		const { subagent, control, stop } = registerWithScript(script);
		await execute(subagent, { agent: "worker", task: "Preserve then destroy" });
		const runId = monitor.getRuns()[0]?.id;
		await waitFor(() => monitor.findRun(runId!)?.status === "running");
		await execute(control, { action: "park", id: runId });
		const prompt = commandLog(log)[0];
		const sessionDir = prompt.argv[prompt.argv.indexOf("--session-dir") + 1];
		expect(existsSync(sessionDir)).toBe(true);

		// Start resume first so it claims the lifecycle and yields in preflight;
		// destructive stop must invalidate that claim before any child is enqueued.
		const resuming = execute(control, { action: "resume", id: runId });
		const stopping = execute(stop, { all: true });
		const [stopped, resume] = await Promise.all([stopping, resuming]);
		expect(stopped.content[0].text).toContain("Retained sessions were retired");
		expect(existsSync(sessionDir)).toBe(false);
		expect(resume.content[0].text).toContain("retired by subagent_stop");
		expect(commandLog(log).filter((entry) => entry.type === "prompt")).toHaveLength(1);
	});
});

describe("queued controls and stale generations", () => {
	it("updates a queued retarget and parks without spawning or creating a session", async () => {
		const captured: BackgroundTask[] = [];
		const controllers: AbortController[] = [];
		vi.spyOn(BackgroundTaskQueue.prototype, "enqueue").mockImplementation((task) => {
			captured.push(task);
			const controller = new AbortController();
			controllers.push(controller);
			return controller;
		});
		const script = join(testDir, "never-spawned.mjs");
		writeFileSync(script, "throw new Error('must not spawn');", "utf8");
		const { subagent, control } = registerWithScript(script);
		await execute(subagent, { agent: "worker", task: "Original queued objective" });
		const runId = monitor.getRuns()[0]?.id;
		expect(captured).toHaveLength(1);

		const retargeted = await execute(control, {
			action: "retarget",
			id: runId,
			objective: "Updated before spawn",
		});
		expect(retargeted.content[0].text).toContain("no child was spawned");
		expect(monitor.findRun(runId!)?.task).toBe("Updated before spawn");
		const parked = await execute(control, { action: "park", id: runId });
		expect(parked.content[0].text).toContain("never spawned a child or empty session");
		expect(controllers[0].signal.aborted).toBe(true);
		expect(monitor.findRun(runId!)?.status).toBe("parked");
	});

	it("stops a queued resumed generation without publishing the completed generation's result", async () => {
		writeFileSync(join(testDir, "pi-subagents.json"), JSON.stringify({ maxConcurrency: 1 }), "utf8");
		const oldSessionDir = mkdtempSync(join(testDir, "completed-session-"));
		writeFileSync(join(oldSessionDir, "retained.txt"), "old retained context", "utf8");
		vi.spyOn(spawn, "runSingleAgentWithMainFallback").mockImplementation(async (options: any) => {
			if (options.task === "Completed objective") {
				return {
					agent: "worker",
					task: options.task,
					exitCode: 0,
					messages: [{ role: "assistant", content: [{ type: "text", text: "OLD COMPLETED OUTPUT" }], stopReason: "stop" }],
					stderr: "",
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 },
					sessionId: "completed-session",
					sessionDir: oldSessionDir,
				} as any;
			}
			if (options.task === "Occupy the only slot") {
				options.onLive?.({ kind: "status", status: "running" });
				await new Promise<void>((resolveBlocked) => {
					if (options.signal.aborted) resolveBlocked();
					else options.signal.addEventListener("abort", () => resolveBlocked(), { once: true });
				});
				return {
					agent: "worker",
					task: options.task,
					exitCode: 1,
					messages: [],
					stderr: "stopped",
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
					stopReason: "aborted",
					errorMessage: "stopped",
				} as any;
			}
			throw new Error(`Queued resumed generation unexpectedly launched: ${options.task}`);
		});
		const script = join(testDir, "unused-queued-resume.mjs");
		writeFileSync(script, "", "utf8");
		const { stub, subagent, control, stop, status } = registerWithScript(script);
		const completed = await execute(subagent, { agent: "worker", task: "Completed objective" });
		const runId = completed.details.results[0].runId;
		await waitFor(() => stub.messages.length === 1);
		stub.messages.length = 0;

		const occupying = await execute(subagent, { agent: "worker", task: "Occupy the only slot" });
		const occupyingId = occupying.details.results[0].runId;
		await waitFor(() => monitor.findRun(occupyingId)?.status === "running");
		const resumed = await execute(control, {
			action: "resume",
			id: runId,
			objective: "Queued follow-on objective",
		});
		expect(resumed.content[0].text).toContain(`Resumed run #${runId}`);
		expect(monitor.findRun(runId)?.status).toBe("queued");

		await execute(stop, { id: String(runId) });
		expect(stub.messages).toHaveLength(1);
		const stoppedContent = stub.messages[0].message.content as string;
		expect(stoppedContent).toContain("Task: Queued follow-on objective");
		expect(stoppedContent).toContain("Stopped by subagent_stop before the run started");
		expect(stoppedContent).not.toContain("OLD COMPLETED OUTPUT");
		const full = await execute(status, { id: String(runId) });
		expect(full.content[0].text).toContain("Task: Queued follow-on objective");
		expect(full.content[0].text).not.toContain("OLD COMPLETED OUTPUT");
		expect(existsSync(oldSessionDir)).toBe(false);

		await execute(stop, { id: String(occupyingId) });
	});

	it("does not return from park until a retrying generation publishes its session and releases the slot", async () => {
		let releaseFirst!: (result: any) => void;
		const firstResult = new Promise<any>((resolve) => {
			releaseFirst = resolve;
		});
		const sessionDir = mkdtempSync(join(testDir, "retry-park-session-"));
		writeFileSync(join(sessionDir, "now_retry-park.jsonl"), "", "utf8");
		const runSpy = vi.spyOn(spawn, "runSingleAgentWithMainFallback")
			.mockImplementationOnce(async (options: any) => {
				options.control.markRetrying();
				return firstResult;
			})
			.mockResolvedValueOnce({
				agent: "worker",
				task: "retrying",
				exitCode: 0,
				messages: [{ role: "assistant", content: [{ type: "text", text: "resumed" }], stopReason: "stop" }],
				stderr: "",
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 },
				sessionId: "retry-park",
				sessionDir,
			} as any);
		const script = join(testDir, "unused-retry-park.mjs");
		writeFileSync(script, "", "utf8");
		const { subagent, control } = registerWithScript(script);
		const dispatched = await execute(subagent, { agent: "worker", task: "retrying" });
		const runId = dispatched.details.results[0].runId;
		await waitFor(() => monitor.findRun(runId)?.status === "running");

		let parkResolved = false;
		const parking = execute(control, { action: "park", id: runId }).then((value) => {
			parkResolved = true;
			return value;
		});
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(parkResolved).toBe(false);
		releaseFirst({
			agent: "worker",
			task: "retrying",
			exitCode: 0,
			messages: [],
			stderr: "",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
			sessionId: "retry-park",
			sessionDir,
			parked: true,
		});
		await parking;
		expect(parkResolved).toBe(true);

		const resumed = await execute(control, { action: "resume", id: runId });
		expect(resumed.content[0].text).toContain(`Resumed run #${runId}`);
		await waitFor(() => runSpy.mock.calls.length === 2);
		expect(runSpy.mock.calls[1]![0]).toMatchObject({
			sessionId: "retry-park",
			sessionDir,
		});
	});

	it("atomically admits only one concurrent resume for a settled thread", async () => {
		const captured: BackgroundTask[] = [];
		const controllers: AbortController[] = [];
		vi.spyOn(BackgroundTaskQueue.prototype, "enqueue").mockImplementation((task) => {
			captured.push(task);
			const controller = new AbortController();
			controllers.push(controller);
			return controller;
		});
		const sessionDir = mkdtempSync(join(testDir, "resume-race-session-"));
		writeFileSync(join(sessionDir, "now_resume-race.jsonl"), "", "utf8");
		const runSpy = vi.spyOn(spawn, "runSingleAgentWithMainFallback").mockResolvedValue({
			agent: "worker",
			task: "race",
			exitCode: 0,
			messages: [{ role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop" }],
			stderr: "",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 },
			sessionId: "resume-race",
			sessionDir,
		} as any);
		const script = join(testDir, "unused-race.mjs");
		writeFileSync(script, "", "utf8");
		const { subagent, control } = registerWithScript(script);
		const dispatched = await execute(subagent, { agent: "worker", task: "race" });
		const runId = dispatched.details.results[0].runId;
		await captured[0](controllers[0].signal);

		const [first, second] = await Promise.all([
			execute(control, { action: "resume", id: runId }),
			execute(control, { action: "resume", id: runId }),
		]);
		expect(first.content[0].text).toContain(`Resumed run #${runId}`);
		expect(second.content[0].text).toMatch(/resuming|must be parked or settled/i);
		expect(captured).toHaveLength(2);
		expect(runSpy).toHaveBeenCalledTimes(1);
		await captured[1](controllers[1].signal);
		expect(runSpy).toHaveBeenCalledTimes(2);
	});

	it("ignores stale live events and task continuations after a resumed generation", async () => {
		const captured: BackgroundTask[] = [];
		const controllers: AbortController[] = [];
		vi.spyOn(BackgroundTaskQueue.prototype, "enqueue").mockImplementation((task) => {
			captured.push(task);
			const controller = new AbortController();
			controllers.push(controller);
			return controller;
		});
		const sessionDir = mkdtempSync(join(testDir, "retained-session-"));
		writeFileSync(join(sessionDir, "now_id.jsonl"), "", "utf8");
		let staleLive: ((event: any) => void) | undefined;
		const runSpy = vi.spyOn(spawn, "runSingleAgentWithMainFallback")
			.mockImplementationOnce(async (options: any) => {
				staleLive = options.onLive;
				return {
					agent: "worker",
					task: "first",
					exitCode: 0,
					messages: [{ role: "assistant", content: [{ type: "text", text: "first" }], stopReason: "stop" }],
					stderr: "",
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
					sessionId: "id",
					sessionDir,
				} as any;
			})
			.mockResolvedValueOnce({
				agent: "worker",
				task: "second",
				exitCode: 0,
				messages: [{ role: "assistant", content: [{ type: "text", text: "second" }], stopReason: "stop" }],
				stderr: "",
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
				sessionId: "id",
				sessionDir,
			} as any);
		const script = join(testDir, "unused.mjs");
		writeFileSync(script, "", "utf8");
		const { subagent, control } = registerWithScript(script);
		await execute(subagent, { agent: "worker", task: "first" });
		const runId = monitor.getRuns()[0]?.id;
		await captured[0](controllers[0].signal);
		await execute(control, { action: "resume", id: runId, objective: "second" });
		expect(monitor.findRun(runId!)?.status).toBe("queued");

		staleLive?.({ kind: "status", status: "failed" });
		staleLive?.({
			kind: "usage",
			usage: { input: 999, output: 999, cacheRead: 0, cacheWrite: 0, cost: 99, contextTokens: 0, turns: 1 },
		});
		expect(monitor.findRun(runId!)?.status).toBe("queued");
		expect(monitor.findRun(runId!)?.usage.input).toBe(0);
		await captured[0](controllers[0].signal);
		expect(runSpy).toHaveBeenCalledTimes(1);
		await captured[1](controllers[1].signal);
		expect(runSpy).toHaveBeenCalledTimes(2);
	});
});
