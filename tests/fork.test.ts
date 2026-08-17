import { existsSync, readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BackgroundTaskQueue, type BackgroundTask } from "../src/background.ts";
import { FORK_CONTINUATION_PROMPT } from "../src/dispatch.ts";
import register from "../src/index.ts";
import { buildInspectorSnapshot } from "../src/inspector.ts";
import { monitor } from "../src/monitor.ts";
import { findRetainedSessionFile, forkRetainedSession } from "../src/session-fork.ts";
import * as spawnModule from "../src/spawn.ts";
import { inspectorStore } from "../src/trajectory.ts";
import * as worktreeModule from "../src/worktree.ts";
import type { WorktreeIsolation } from "../src/worktree.ts";

function assistant(text: string): any {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "test",
		provider: "test",
		model: "test-model",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function user(text: string): any {
	return { role: "user", content: text, timestamp: Date.now() };
}

function createSession(cwd: string, branched = false): {
	dir: string;
	id: string;
	file: string;
	manager: SessionManager;
} {
	const dir = mkdtempSync(join(tmpdir(), "pi-subagents-fork-source-"));
	const manager = SessionManager.create(cwd, dir);
	manager.appendMessage(user("root objective"));
	const rootAssistant = manager.appendMessage(assistant("root context"));
	if (branched) {
		manager.appendMessage(user("abandoned objective"));
		manager.appendMessage(assistant("abandoned context"));
		manager.branch(rootAssistant);
		manager.appendMessage(user("active branch objective"));
		manager.appendMessage(assistant("active branch context"));
	} else {
		manager.appendMessage(user("latest objective"));
		manager.appendMessage(assistant("latest context"));
	}
	const file = manager.getSessionFile();
	if (!file) throw new Error("test session was not persisted");
	return { dir, id: manager.getSessionId(), file, manager };
}

function contextTexts(manager: SessionManager): string[] {
	return manager.buildSessionContext().messages.flatMap((message: any) => {
		if (typeof message.content === "string") return [message.content];
		return (message.content ?? []).flatMap((part: any) =>
			part.type === "text" ? [part.text] : [],
		);
	});
}

const tempPaths: string[] = [];

afterEach(() => {
	for (const path of tempPaths.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("SessionManager-backed retained branch fork", () => {
	it("copies only the active branch into a new session and leaves the source byte-identical", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-subagents-fork-cwd-"));
		tempPaths.push(cwd);
		const source = createSession(cwd, true);
		tempPaths.push(source.dir);
		const before = readFileSync(source.file);

		expect(await findRetainedSessionFile(cwd, source.dir, source.id)).toBe(source.file);
		const forked = await forkRetainedSession({ cwd, sessionDir: source.dir, sessionId: source.id });
		tempPaths.push(forked.sessionDir);
		expect(forked.sessionId).not.toBe(source.id);
		expect(forked.sessionDir).not.toBe(source.dir);
		expect(readFileSync(source.file)).toEqual(before);

		const child = SessionManager.open(forked.sessionFile);
		const texts = contextTexts(child);
		expect(texts).toContain("root objective");
		expect(texts).toContain("root context");
		expect(texts).toContain("active branch objective");
		expect(texts).toContain("active branch context");
		expect(texts).not.toContain("abandoned objective");
		expect(texts).not.toContain("abandoned context");
		expect(child.getHeader()?.parentSession).toBe(source.file);
	});

	it("rewrites the cloned session cwd for a fresh isolated continuation", async () => {
		const sourceCwd = mkdtempSync(join(tmpdir(), "pi-subagents-fork-source-cwd-"));
		const targetCwd = mkdtempSync(join(tmpdir(), "pi-subagents-fork-target-cwd-"));
		tempPaths.push(sourceCwd, targetCwd);
		const source = createSession(sourceCwd);
		tempPaths.push(source.dir);
		const forked = await forkRetainedSession({
			cwd: sourceCwd,
			targetCwd,
			sessionDir: source.dir,
			sessionId: source.id,
		});
		tempPaths.push(forked.sessionDir);
		const child = SessionManager.open(forked.sessionFile);
		expect(child.getCwd()).toBe(targetCwd);
		expect(child.getHeader()?.cwd).toBe(targetCwd);
	});

	it("rejects an unknown retained session id clearly", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-subagents-fork-missing-cwd-"));
		const dir = mkdtempSync(join(tmpdir(), "pi-subagents-fork-missing-dir-"));
		tempPaths.push(cwd, dir);
		await expect(findRetainedSessionFile(cwd, dir, "missing-id")).rejects.toThrow(/was not found/i);
	});
});

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

function ctx(cwd: string): any {
	return {
		cwd,
		model: { provider: "test", id: "main" },
		scopedModels: [],
		modelRegistry: { getAvailable: () => [] },
		ui: { notify: vi.fn() },
	};
}

function execute(tool: any, params: any, cwd: string): Promise<any> {
	return tool.execute("call", params, new AbortController().signal, () => {}, ctx(cwd));
}

function result(task: string, session?: { id: string; dir: string }, extra: Record<string, unknown> = {}): any {
	return {
		agent: "worker",
		agentSource: "builtin",
		task,
		exitCode: 0,
		messages: [assistant(`result for ${task}`)],
		stderr: "",
		usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 2, turns: 1 },
		...(session ? { sessionId: session.id, sessionDir: session.dir } : {}),
		...extra,
	};
}

function fakeWorktree(cwd: string): WorktreeIsolation {
	let state: WorktreeIsolation["state"] = "active";
	return {
		originalCwd: cwd,
		originalRoot: cwd,
		cwd: join(cwd, "isolated"),
		worktreePath: join(cwd, "isolated"),
		tempDir: join(cwd, "temp"),
		patchPath: join(cwd, "temp", "changes.patch"),
		head: "deadbeef",
		get state() {
			return state;
		},
		async snapshotCheckpoint() {
			return { baseHead: "deadbeef", commit: "deadbeef", patch: Buffer.alloc(0) };
		},
		async finalize() {
			state = "no_changes";
			return { status: "no_changes", integrated: false, hadChanges: false };
		},
	};
}

let savedDepth: string | undefined;
let savedAgentDir: string | undefined;
let agentDir: string;
let activeStubs: StubPi[];

beforeEach(() => {
	savedDepth = process.env.PI_SUBAGENT_DEPTH;
	savedAgentDir = process.env.PI_CODING_AGENT_DIR;
	delete process.env.PI_SUBAGENT_DEPTH;
	agentDir = mkdtempSync(join(tmpdir(), "pi-subagents-fork-agent-"));
	process.env.PI_CODING_AGENT_DIR = agentDir;
	activeStubs = [];
});

afterEach(async () => {
	for (const stub of activeStubs) await stub.hooks["session_shutdown"]?.({}, {});
	vi.restoreAllMocks();
	monitor.clear();
	inspectorStore.clearAll();
	rmSync(agentDir, { recursive: true, force: true });
	if (savedDepth === undefined) delete process.env.PI_SUBAGENT_DEPTH;
	else process.env.PI_SUBAGENT_DEPTH = savedDepth;
	if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
});

function registered(): { stub: StubPi; subagent: any; control: any; stop: any; status: any } {
	const stub = makeStub();
	activeStubs.push(stub);
	register(stub.api);
	return {
		stub,
		subagent: stub.tools.find((tool) => tool.name === "subagent"),
		control: stub.tools.find((tool) => tool.name === "subagent_control"),
		stop: stub.tools.find((tool) => tool.name === "subagent_stop"),
		status: stub.tools.find((tool) => tool.name === "subagent_status"),
	};
}

function captureQueue(): Array<{ task: BackgroundTask; controller: AbortController }> {
	const queued: Array<{ task: BackgroundTask; controller: AbortController }> = [];
	vi.spyOn(BackgroundTaskQueue.prototype, "enqueue").mockImplementation((task) => {
		const controller = new AbortController();
		queued.push({ task, controller });
		return controller;
	});
	return queued;
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error("Timed out waiting for condition");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

describe("subagent_control fork", () => {
	it("forks a completed session into generation 1 with optional objective and linked trajectories", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-subagents-fork-control-cwd-"));
		tempPaths.push(cwd);
		const source = createSession(cwd, true);
		tempPaths.push(source.dir);
		const sourceBytes = readFileSync(source.file);
		const queued = captureQueue();
		let childOptions: any;
		const run = vi.spyOn(spawnModule, "runSingleAgentWithModelFallback")
			.mockResolvedValueOnce(result("source task", { id: source.id, dir: source.dir }))
			.mockImplementationOnce(async (options: any) => {
				childOptions = options;
				return result("independent objective", { id: options.sessionId, dir: options.sessionDir });
			});
		const { subagent, control, status } = registered();
		const dispatched = await execute(subagent, { agent: "worker", task: "source task" }, cwd);
		const sourceRunId = dispatched.details.results[0].runId;
		await queued[0].task(queued[0].controller.signal);
		expect(buildInspectorSnapshot({ runtime: { threads: new Map() }, selectedId: sourceRunId }).detail?.status).toBe("done");

		const forked = await execute(control, {
			action: "fork",
			id: sourceRunId,
			objective: "independent objective",
		}, cwd);
		const childRunId = forked.details.childRunId;
		expect(childRunId).not.toBe(sourceRunId);
		expect(forked.content[0].text).toContain(`new run #${childRunId}`);
		expect(forked.details.result).toMatchObject({
			runId: childRunId,
			forkedFromRunId: sourceRunId,
			isolation: "shared",
			resumed: true,
		});
		expect(readFileSync(source.file)).toEqual(sourceBytes);
		expect(queued).toHaveLength(2);
		expect(inspectorStore.get(childRunId).generation).toBe(1);
		expect(inspectorStore.get(sourceRunId).trajectory.getEvents()).toContainEqual(
			expect.objectContaining({ kind: "fork", sourceRunId, childRunId, objective: "independent objective" }),
		);
		expect(inspectorStore.get(childRunId).trajectory.getEvents()).toContainEqual(
			expect.objectContaining({ kind: "fork", sourceRunId, childRunId, objective: "independent objective" }),
		);

		await queued[1].task(queued[1].controller.signal);
		expect(childOptions.stdinText).toBe("independent objective");
		expect(childOptions.sessionId).not.toBe(source.id);
		expect(childOptions.sessionDir).not.toBe(source.dir);
		const childFile = await findRetainedSessionFile(cwd, childOptions.sessionDir, childOptions.sessionId);
		const childContext = contextTexts(SessionManager.open(childFile));
		expect(childContext).toContain("active branch context");
		expect(childContext).not.toContain("abandoned context");
		expect(run.mock.calls[1]![1]).toEqual(run.mock.calls[0]![1]);

		const sourceStatus = await execute(status, { id: String(sourceRunId) }, cwd);
		expect(sourceStatus.content[0].text).toContain(`fork children #${childRunId}`);
		const childStatus = await execute(status, { id: String(childRunId) }, cwd);
		expect(childStatus.content[0].text).toContain(`forked from #${sourceRunId}`);
	});

	it("forks a parked session with the concise continuation prompt and keeps the source parked", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-subagents-fork-parked-cwd-"));
		tempPaths.push(cwd);
		const source = createSession(cwd);
		tempPaths.push(source.dir);
		const queued = captureQueue();
		let childOptions: any;
		vi.spyOn(spawnModule, "runSingleAgentWithModelFallback")
			.mockResolvedValueOnce(result("parked task", { id: source.id, dir: source.dir }, { parked: true }))
			.mockImplementationOnce(async (options: any) => {
				childOptions = options;
				return result("parked task", { id: options.sessionId, dir: options.sessionDir });
			});
		const { subagent, control } = registered();
		const dispatched = await execute(subagent, { agent: "worker", task: "parked task" }, cwd);
		const sourceRunId = dispatched.details.results[0].runId;
		await queued[0].task(queued[0].controller.signal);
		expect(monitor.findRun(sourceRunId)?.status).toBe("parked");

		const forked = await execute(control, { action: "fork", id: sourceRunId }, cwd);
		const childRunId = forked.details.childRunId;
		expect(monitor.findRun(sourceRunId)?.status).toBe("parked");
		expect(monitor.findRun(childRunId)?.status).toBe("queued");
		await queued[1].task(queued[1].controller.signal);
		expect(childOptions.stdinText).toBe(FORK_CONTINUATION_PROMPT);
		expect(childOptions.task).toBe("parked task");
	});

	it("rejects forking a parked isolated seed before it has been integrated", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-subagents-fork-parked-isolated-cwd-"));
		tempPaths.push(cwd);
		const source = createSession(cwd);
		tempPaths.push(source.dir);
		const queued = captureQueue();
		const handle = fakeWorktree(cwd);
		vi.spyOn(worktreeModule, "createWorktreeIsolation").mockResolvedValue(handle);
		vi.spyOn(spawnModule, "runSingleAgentWithModelFallback").mockResolvedValue(
			result("parked isolated", { id: source.id, dir: source.dir }, { parked: true }),
		);
		const { subagent, control } = registered();
		const dispatched = await execute(subagent, {
			agent: "worker",
			task: "parked isolated",
			isolation: "worktree",
		}, cwd);
		const sourceRunId = dispatched.details.results[0].runId;
		await queued[0].task(queued[0].controller.signal);

		const forked = await execute(control, { action: "fork", id: sourceRunId }, cwd);
		expect(forked.content[0].text).toMatch(/has not been integrated.*applied exactly once/i);
		expect(queued).toHaveLength(1);
		expect(handle.state).toBe("active");
	});

	it("forks a failed retained session without changing the failed source state", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-subagents-fork-failed-cwd-"));
		tempPaths.push(cwd);
		const source = createSession(cwd);
		tempPaths.push(source.dir);
		const queued = captureQueue();
		vi.spyOn(spawnModule, "runSingleAgentWithModelFallback").mockResolvedValueOnce(
			result("failed task", { id: source.id, dir: source.dir }, {
				exitCode: 1,
				stopReason: "error",
				errorMessage: "task failed",
			}),
		);
		const { subagent, control } = registered();
		const dispatched = await execute(subagent, { agent: "worker", task: "failed task" }, cwd);
		const sourceRunId = dispatched.details.results[0].runId;
		await queued[0].task(queued[0].controller.signal);
		expect(buildInspectorSnapshot({ runtime: { threads: new Map() }, selectedId: sourceRunId }).detail?.status).toBe("failed");

		const forked = await execute(control, { action: "fork", id: sourceRunId }, cwd);
		expect(forked.isError).not.toBe(true);
		expect(forked.details.childRunId).not.toBe(sourceRunId);
		expect(buildInspectorSnapshot({ runtime: { threads: new Map() }, selectedId: sourceRunId }).detail?.status).toBe("failed");
	});

	it("rejects queued/active sources and blank objectives, but forks settled worktrees", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-subagents-fork-reject-cwd-"));
		tempPaths.push(cwd);
		const queued = captureQueue();
		const activeGate = new Promise<any>(() => {});
		vi.spyOn(spawnModule, "runSingleAgentWithModelFallback").mockImplementation(async (options: any) => {
			const token = options.control.beginAttempt();
			options.control.attach(token, {
				steer: async () => {},
				retarget: async () => {},
				park: async () => {},
				stop: async () => {},
			});
			options.control.updateAttemptPhase(token, "running");
			options.onLive?.({ kind: "status", status: "running" });
			return activeGate;
		});
		const { subagent, control } = registered();
		const first = await execute(subagent, { agent: "worker", task: "queued" }, cwd);
		const queuedId = first.details.results[0].runId;
		const queuedFork = await execute(control, { action: "fork", id: queuedId }, cwd);
		expect(queuedFork.content[0].text).toMatch(/queued and has no retained session/i);
		const blank = await execute(control, { action: "fork", id: queuedId, objective: "  " }, cwd);
		expect(blank.content[0].text).toContain("fork objective must be non-blank");

		const runningTask = queued[0].task(queued[0].controller.signal);
		await waitFor(() => monitor.findRun(queuedId)?.status === "running");
		const activeFork = await execute(control, { action: "fork", id: queuedId }, cwd);
		expect(activeFork.content[0].text).toMatch(/active; park it first/i);
		queued[0].controller.abort();
		void runningTask;

		vi.restoreAllMocks();
		const worktreeQueued = captureQueue();
		vi.spyOn(worktreeModule, "createWorktreeIsolation").mockImplementation(async () => fakeWorktree(cwd));
		const source = createSession(cwd);
		tempPaths.push(source.dir);
		vi.spyOn(spawnModule, "runSingleAgentWithModelFallback").mockResolvedValue(
			result("isolated", { id: source.id, dir: source.dir }),
		);
		const second = registered();
		const isolated = await execute(second.subagent, { agent: "worker", task: "isolated", isolation: "worktree" }, cwd);
		const isolatedId = isolated.details.results[0].runId;
		await worktreeQueued[0].task(worktreeQueued[0].controller.signal);
		const worktreeFork = await execute(second.control, { action: "fork", id: isolatedId }, cwd);
		expect(worktreeFork.isError).not.toBe(true);
		expect(worktreeFork.details.result).toMatchObject({
			forkedFromRunId: isolatedId,
			isolation: "worktree",
			integrationStatus: "pending",
		});
		expect(worktreeQueued).toHaveLength(2);
	});

	it("supports retarget, park, resume, and stop on the forked logical thread", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-subagents-fork-controls-cwd-"));
		tempPaths.push(cwd);
		const source = createSession(cwd);
		tempPaths.push(source.dir);
		const queued = captureQueue();
		vi.spyOn(spawnModule, "runSingleAgentWithModelFallback").mockResolvedValue(
			result("source", { id: source.id, dir: source.dir }),
		);
		const { subagent, control, stop } = registered();
		const dispatched = await execute(subagent, { agent: "worker", task: "source" }, cwd);
		const sourceRunId = dispatched.details.results[0].runId;
		await queued[0].task(queued[0].controller.signal);
		const forked = await execute(control, { action: "fork", id: sourceRunId }, cwd);
		const childRunId = forked.details.childRunId;
		const childSessionDir = forked.details.result.sessionDir;
		const childSessionId = forked.details.result.sessionId;

		const retargeted = await execute(control, {
			action: "retarget",
			id: childRunId,
			objective: "fork replacement",
		}, cwd);
		expect(retargeted.content[0].text).toContain("no child was spawned");
		const parked = await execute(control, { action: "park", id: childRunId }, cwd);
		expect(parked.content[0].text).toContain("never spawned a child");
		expect(existsSync(childSessionDir)).toBe(true);

		const resumed = await execute(control, {
			action: "resume",
			id: childRunId,
			objective: "fork resumed objective",
		}, cwd);
		expect(resumed.content[0].text).toContain(`Resumed run #${childRunId}`);
		expect(monitor.findRun(childRunId)?.id).toBe(childRunId);
		expect(inspectorStore.get(childRunId).generation).toBe(2);
		const retainedFile = await findRetainedSessionFile(cwd, childSessionDir, childSessionId);
		expect(existsSync(retainedFile)).toBe(true);

		await execute(stop, { id: String(childRunId) }, cwd);
		expect(existsSync(childSessionDir)).toBe(false);
		expect(existsSync(source.file)).toBe(true);
	});

	it("retires source and child session directories independently", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-subagents-fork-cleanup-cwd-"));
		tempPaths.push(cwd);
		const source = createSession(cwd);
		tempPaths.push(source.dir);
		const queued = captureQueue();
		vi.spyOn(spawnModule, "runSingleAgentWithModelFallback").mockResolvedValue(
			result("source", { id: source.id, dir: source.dir }),
		);
		const { subagent, control, stop } = registered();
		const dispatched = await execute(subagent, { agent: "worker", task: "source" }, cwd);
		const sourceRunId = dispatched.details.results[0].runId;
		await queued[0].task(queued[0].controller.signal);
		const childOne = await execute(control, { action: "fork", id: sourceRunId, objective: "child one" }, cwd);
		const childTwo = await execute(control, { action: "fork", id: sourceRunId, objective: "child two" }, cwd);
		const childOneDir = childOne.details.result.sessionDir;
		const childTwoDir = childTwo.details.result.sessionDir;
		expect(readFileSync(source.file).length).toBeGreaterThan(0);

		await execute(stop, { id: String(childOne.details.childRunId) }, cwd);
		expect(() => readFileSync(source.file)).not.toThrow();
		const childTwoFile = await findRetainedSessionFile(cwd, childTwoDir, childTwo.details.result.sessionId);
		expect(() => readFileSync(childTwoFile)).not.toThrow();
		expect(existsSync(childOneDir)).toBe(false);

		await execute(stop, { id: String(sourceRunId) }, cwd);
		expect(() => readFileSync(source.file)).toThrow();
		expect(() => readFileSync(childTwoFile)).not.toThrow();
	});
});
