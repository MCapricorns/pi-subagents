import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BackgroundTaskQueue, type BackgroundTask } from "../src/background.ts";
import register from "../src/index.ts";
import { monitor } from "../src/monitor.ts";
import * as spawn from "../src/spawn.ts";
import { fakeRpcScript } from "./fake-rpc.ts";
import { makeStub, readJsonLines, waitFor, type StubPi } from "./test-helpers.ts";

function executionContext(): any {
	return {
		cwd: process.cwd(),
		model: undefined,
		scopedModels: [],
		modelRegistry: { getAvailable: () => [] },
		ui: { notify: vi.fn() },
	};
}

function commandLog(path: string): Array<{ type: string; message?: string; argv: string[] }> {
	return readJsonLines(path);
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
	writeFileSync(join(testDir, "pi-subagents.json"), JSON.stringify({
		enabledAgents: ["worker"],
		announcedFeatures: ["cleanerDefaulted", "documenterDefaulted"],
	}), "utf8");
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
		expect(monitor.findRun(runId!)).toMatchObject({
			status: "parked",
			continuationKind: "retarget",
		});
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
		const elapsedBeforeResume = monitor.findRun(runId!)?.elapsedMs ?? 0;
		const first = commandLog(log)[0];
		const sessionDir = first.argv[first.argv.indexOf("--session-dir") + 1];
		expect(existsSync(sessionDir)).toBe(true);

		const resumed = await execute(control, {
			action: "resume",
			id: runId,
			objective: "Finish from checkpoint",
		});
		expect(resumed.content[0].text).toContain(`Resumed run #${runId}`);
		expect(resumed.content[0].text).toContain("appended objective: Finish from checkpoint");
		expect(resumed.content[0].text).toContain("cumulative active time");
		expect(monitor.findRun(runId!)?.id).toBe(runId);
		expect(monitor.findRun(runId!)?.continuationKind).toBe("resume-appended");
		expect(monitor.findRun(runId!)?.elapsedMs ?? 0).toBeGreaterThanOrEqual(elapsedBeforeResume);
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

	it("does not launch downstream work when park wins after top-level RPC settlement", async () => {
		writeFileSync(join(testDir, "pi-subagents.json"), JSON.stringify({
			enabledAgents: ["worker", "documenter", "reviewer"],
			announcedFeatures: ["cleanerDefaulted", "documenterDefaulted"],
		}), "utf8");
		const script = join(testDir, "unused-post-settle-park.mjs");
		writeFileSync(script, "", "utf8");
		let releaseTopLevel!: () => void;
		const topLevelGate = new Promise<void>((resolveTopLevel) => {
			releaseTopLevel = resolveTopLevel;
		});
		let topLevelSettled = false;
		let topSignalAborted = false;
		const calls: string[] = [];
		vi.spyOn(spawn, "runSingleAgentWithMainFallback").mockImplementation(async (options: any) => {
			calls.push(options.agentName);
			if (options.agentName !== "worker") throw new Error("downstream child must not start after park");
			const token = options.control.beginAttempt();
			options.control.attach(token, {
				steer: async () => {},
				retarget: async () => {},
				park: async () => {},
				stop: async () => {},
			});
			options.control.updateAttemptPhase(token, "running");
			options.control.markSettled();
			topLevelSettled = true;
			const aborted = new Promise<void>((resolveAborted) => {
				options.signal.addEventListener("abort", () => {
					topSignalAborted = true;
					resolveAborted();
				}, { once: true });
			});
			await Promise.race([topLevelGate, aborted]);
			return {
				agent: "worker",
				task: options.task,
				exitCode: 0,
				messages: [{ role: "assistant", content: [{ type: "text", text: "STABLE WRITER RESULT" }], stopReason: "stop" }],
				stderr: "",
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 },
			} as any;
		});

		const { stub, subagent, control, stop, status } = registerWithScript(script);
		const dispatched = await execute(subagent, { agent: "worker", task: "Park after settlement" });
		const runId = dispatched.details.results[0].runId;
		await waitFor(() => topLevelSettled);
		const parking = execute(control, { action: "park", id: runId });
		await waitFor(() => topSignalAborted);
		releaseTopLevel();
		const parked = await parking;

		expect(parked.content[0].text).toContain("stable checkpoint");
		expect(calls).toEqual(["worker"]);
		expect(stub.messages).toHaveLength(0);
		const parkedStatus = await execute(status, { id: String(runId) });
		expect(parkedStatus.content[0].text).toContain("worker");
		await execute(stop, { id: String(runId) });
		expect(stub.messages).toHaveLength(1);
		expect(stub.messages[0].message.content).toContain("STABLE WRITER RESULT");
		expect(stub.messages[0].message.content).not.toContain("documenter");
	});

	it("parks during documenter, retains its newest session, and resumes to a fresh reviewer", async () => {
		writeFileSync(join(testDir, "pi-subagents.json"), JSON.stringify({
			enabledAgents: ["worker", "documenter", "reviewer"],
			maxFixRounds: 1,
			announcedFeatures: ["cleanerDefaulted", "documenterDefaulted"],
		}), "utf8");
		const sessionDir = mkdtempSync(join(testDir, "doc-session-"));
		writeFileSync(join(sessionDir, "now_doc-session.jsonl"), "", "utf8");
		const script = join(testDir, "unused-doc-park.mjs");
		writeFileSync(script, "", "utf8");
		const result = (agent: string, task: string, text: string, extra: Record<string, unknown> = {}): any => ({
			agent,
			task,
			exitCode: 0,
			messages: [{ role: "assistant", content: [{ type: "text", text }], stopReason: "stop" }],
			stderr: "",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 },
			...extra,
		});
		let documenterAttempts = 0;
		let documenterStarted = false;
		const run = vi.spyOn(spawn, "runSingleAgentWithMainFallback").mockImplementation(async (options: any) => {
			options.onLive?.({ kind: "status", status: "running" });
			if (options.agentName === "worker") {
				options.control?.markSettled();
				return result("worker", options.task, "OLD WRITER REPORT");
			}
			if (options.agentName === "documenter") {
				documenterAttempts++;
				if (documenterAttempts === 1) {
					documenterStarted = true;
					await new Promise<void>((resolveAborted) => {
						if (options.signal.aborted) resolveAborted();
						else options.signal.addEventListener("abort", () => resolveAborted(), { once: true });
					});
					return result("documenter", options.task, "NEWEST DOC PARTIAL", {
						exitCode: 1,
						stopReason: "aborted",
						errorMessage: "parked",
						sessionId: "doc-session",
						sessionDir,
					});
				}
				expect(options.sessionId).toBe("doc-session");
				expect(options.sessionDir).toBe(sessionDir);
				options.control?.markSettled();
				return result("documenter", options.task, "DOCS FINISHED README.md", {
					sessionId: "doc-session",
					sessionDir,
				});
			}
			return result("reviewer", options.task, "APPROVE\nVERDICT: REVIEW_PASS");
		});

		const { stub, subagent, control, status } = registerWithScript(script);
		const dispatched = await execute(subagent, { agent: "worker", task: "Implement then document" });
		const runId = dispatched.details.results[0].runId;
		await waitFor(() => documenterStarted);
		const activeStatus = await execute(status, { id: String(runId) });
		expect(activeStatus.content[0].text).toContain("managed downstream stage");
		expect(activeStatus.content[0].text).toContain("Steer/retarget are unavailable");

		const parked = await execute(control, { action: "park", id: runId });
		expect(parked.content[0].text).toContain("stable checkpoint");
		expect(stub.messages).toHaveLength(0);
		const parkedStatus = await execute(status, { id: String(runId) });
		expect(parkedStatus.content[0].text).toContain("documenter");
		expect(monitor.findRun(runId)?.task).toContain("Documentation sync after successful top-level worker.");

		const resumed = await execute(control, { action: "resume", id: runId, objective: "Finish documentation" });
		expect(resumed.content[0].text).toContain(`Resumed run #${runId}`);
		await waitFor(() => stub.messages.length === 1);
		expect(run.mock.calls.map(([options]) => options.agentName)).toEqual([
			"worker", "documenter", "documenter", "reviewer",
		]);
		const completion = stub.messages[0].message.content as string;
		expect(completion).toContain("documenter · documentation pass · completed");
		expect(completion).not.toContain("OLD WRITER REPORT");
		const documenterStepId = /- #(\d+) documenter/.exec(completion)?.[1];
		expect(documenterStepId).toBeTruthy();
		const documenterReport = await execute(status, { id: documenterStepId });
		expect(documenterReport.content[0].text).toContain("DOCS FINISHED README.md");
	});

	it("stops during documenter and publishes its partial instead of the old writer", async () => {
		writeFileSync(join(testDir, "pi-subagents.json"), JSON.stringify({
			enabledAgents: ["worker", "documenter", "reviewer"],
			announcedFeatures: ["cleanerDefaulted", "documenterDefaulted"],
		}), "utf8");
		const script = join(testDir, "unused-doc-stop.mjs");
		writeFileSync(script, "", "utf8");
		const result = (agent: string, task: string, text: string, extra: Record<string, unknown> = {}): any => ({
			agent,
			task,
			exitCode: 0,
			messages: [{ role: "assistant", content: [{ type: "text", text }], stopReason: "stop" }],
			stderr: "",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 },
			...extra,
		});
		let documenterStarted = false;
		vi.spyOn(spawn, "runSingleAgentWithMainFallback").mockImplementation(async (options: any) => {
			options.onLive?.({ kind: "status", status: "running" });
			if (options.agentName === "worker") {
				options.control?.markSettled();
				return result("worker", options.task, "OLD WRITER OUTPUT");
			}
			documenterStarted = true;
			await new Promise<void>((resolveAborted) => {
				if (options.signal.aborted) resolveAborted();
				else options.signal.addEventListener("abort", () => resolveAborted(), { once: true });
			});
			return result("documenter", options.task, "CURRENT DOCUMENTER PARTIAL", {
				exitCode: 1,
				stopReason: "aborted",
				errorMessage: "stopped",
			});
		});

		const { stub, subagent, stop } = registerWithScript(script);
		const dispatched = await execute(subagent, { agent: "worker", task: "Stop in documentation" });
		const runId = dispatched.details.results[0].runId;
		await waitFor(() => documenterStarted);
		await execute(stop, { id: String(runId) });

		expect(stub.messages).toHaveLength(1);
		expect(stub.messages[0].message.content).toContain("CURRENT DOCUMENTER PARTIAL");
		expect(stub.messages[0].message.content).not.toContain("OLD WRITER OUTPUT");
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

		const resumed = await execute(control, { action: "resume", id: runId });
		expect(resumed.content[0].text).toContain("no prior child session existed");
		expect(resumed.content[0].text).not.toContain("same retained session");
		expect(monitor.findRun(runId!)).toMatchObject({
			status: "queued",
			continuationKind: "resume-retained",
		});
		expect(captured).toHaveLength(2);
	});

	it("stops a queued resumed generation without publishing the completed generation's result", async () => {
		writeFileSync(join(testDir, "pi-subagents.json"), JSON.stringify({
			maxConcurrency: 1,
			enabledAgents: ["worker"],
			announcedFeatures: ["cleanerDefaulted", "documenterDefaulted"],
		}), "utf8");
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
		expect(resumed.content[0].text).toContain("continuing current objective: retrying");
		expect(monitor.findRun(runId)?.continuationKind).toBe("resume-retained");
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
