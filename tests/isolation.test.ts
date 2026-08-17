import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@earendil-works/pi-agent-core";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BackgroundTaskQueue, type BackgroundTask } from "../src/background.ts";
import { isWorktreeCapableAgent } from "../src/dispatch.ts";
import register from "../src/index.ts";
import { monitor } from "../src/monitor.ts";
import { readRecoveryRecords } from "../src/recovery.ts";
import * as spawnModule from "../src/spawn.ts";
import { inspectorStore } from "../src/trajectory.ts";
import * as worktreeModule from "../src/worktree.ts";
import type { WorktreeFinalization, WorktreeIsolation } from "../src/worktree.ts";

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
		model: undefined,
		scopedModels: [],
		modelRegistry: { getAvailable: () => [] },
		ui: { notify: vi.fn() },
	};
}

function execute(tool: any, params: any, cwd: string): Promise<any> {
	return tool.execute("call", params, new AbortController().signal, () => {}, ctx(cwd));
}

function emptyResult(task: string, extra: Record<string, unknown> = {}): any {
	return {
		agent: "worker",
		agentSource: "builtin",
		task,
		exitCode: 0,
		messages: [{ role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop" }],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 },
		...extra,
	};
}

function createRetainedSession(cwd: string): { id: string; dir: string } {
	const dir = mkdtempSync(join(tmpdir(), "pi-subagents-isolation-retained-"));
	const manager = SessionManager.create(cwd, dir);
	manager.appendMessage({ role: "user", content: "initial objective", timestamp: Date.now() });
	manager.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: "retained context" }],
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
	});
	return { id: manager.getSessionId(), dir };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function fakeWorktree(root: string, final: WorktreeFinalization = {
	status: "no_changes",
	integrated: false,
	hadChanges: false,
}, label = "isolated"): WorktreeIsolation & {
	finalizeMock: ReturnType<typeof vi.fn>;
	discardMock: ReturnType<typeof vi.fn>;
} {
	let state: WorktreeIsolation["state"] = "active";
	let promise: Promise<WorktreeFinalization> | undefined;
	const finalizeMock = vi.fn(() => {
		promise ??= Promise.resolve(final).then((value) => {
			state = value.status;
			return value;
		});
		return promise;
	});
	const discardMock = vi.fn(async () => {
		state = "no_changes";
	});
	return {
		originalCwd: root,
		originalRoot: root,
		cwd: join(root, label),
		worktreePath: join(root, label),
		tempDir: join(root, `${label}-temp`),
		patchPath: join(root, `${label}-temp`, "changes.patch"),
		head: "deadbeef",
		get state() {
			return state;
		},
		async snapshotCheckpoint() {
			return { baseHead: "deadbeef", commit: "deadbeef", patch: Buffer.alloc(0) };
		},
		finalize: finalizeMock,
		finalizeMock,
		discard: discardMock,
		discardMock,
	};
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error("Timed out waiting for test condition");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

let savedDepth: string | undefined;
let savedAgentDir: string | undefined;
let agentDir: string;
let activeStubs: StubPi[];

beforeEach(() => {
	savedDepth = process.env.PI_SUBAGENT_DEPTH;
	savedAgentDir = process.env.PI_CODING_AGENT_DIR;
	delete process.env.PI_SUBAGENT_DEPTH;
	agentDir = mkdtempSync(join(tmpdir(), "pi-subagents-isolation-agent-"));
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

describe("dispatch isolation selection", () => {
	it("defaults single to shared and parallel worker items to worktree with explicit overrides", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-subagents-isolation-root-"));
		const handles: WorktreeIsolation[] = [];
		const create = vi.spyOn(worktreeModule, "createWorktreeIsolation").mockImplementation(async () => {
			const handle = fakeWorktree(root);
			handles.push(handle);
			return handle;
		});
		const tasks: BackgroundTask[] = [];
		vi.spyOn(BackgroundTaskQueue.prototype, "enqueue").mockImplementation((task) => {
			tasks.push(task);
			return new AbortController();
		});
		const { subagent } = registered();

		const single = await execute(subagent, { agent: "worker", task: "single" }, root);
		expect(single.details.results[0]).toMatchObject({ isolation: "shared" });
		expect(create).not.toHaveBeenCalled();

		const parallel = await execute(subagent, {
			tasks: [
				{ agent: "worker", task: "default isolated" },
				{ agent: "worker", task: "explicit shared", isolation: "shared" },
				{ agent: "explore", task: "read only" },
			],
		}, root);
		expect(parallel.details.results.map((result: any) => result.isolation)).toEqual([
			"worktree",
			"shared",
			"shared",
		]);
		expect(create).toHaveBeenCalledTimes(1);
		expect(tasks).toHaveLength(4);

		const explicit = await execute(subagent, {
			agent: "worker",
			task: "single isolated",
			isolation: "worktree",
		}, root);
		expect(explicit.details.results[0]).toMatchObject({
			isolation: "worktree",
			isolationCwd: handles[1].cwd,
			integrationStatus: "pending",
		});
		expect(create).toHaveBeenCalledTimes(2);
		rmSync(root, { recursive: true, force: true });
	});

	it("reports every partial parallel startup failure and throws when none start", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-subagents-isolation-partial-root-"));
		const nonGit = mkdtempSync(join(tmpdir(), "pi-subagents-isolation-partial-nongit-"));
		vi.spyOn(worktreeModule, "createWorktreeIsolation").mockImplementation(async (cwd) => {
			if (cwd === nonGit) throw new Error(`not a Git repository: ${cwd}`);
			return fakeWorktree(root);
		});
		const tasks: BackgroundTask[] = [];
		vi.spyOn(BackgroundTaskQueue.prototype, "enqueue").mockImplementation((task) => {
			tasks.push(task);
			return new AbortController();
		});
		const { subagent } = registered();
		const partial = await execute(subagent, {
			tasks: [
				{ agent: "worker", task: "starts", cwd: root },
				{ agent: "worker", task: "fails", cwd: nonGit },
			],
		}, root);
		expect(partial.content[0].text).toContain("Started 1 background subagent");
		expect(partial.content[0].text).toContain("tasks[1] (worker) failed to start");
		expect(partial.content[0].text).toContain(nonGit);
		expect(partial.details.results).toHaveLength(2);
		expect(tasks).toHaveLength(1);

		await expect(execute(subagent, {
			tasks: [{ agent: "worker", task: "all fail", cwd: nonGit }],
		}, root)).rejects.toThrow(/No background subagents were started[\s\S]*tasks\[0\].*not a Git repository/i);
		rmSync(root, { recursive: true, force: true });
		rmSync(nonGit, { recursive: true, force: true });
	});

	it("surfaces an all-failed parallel dispatch as a Pi Agent tool error", async () => {
		const nonGit = mkdtempSync(join(tmpdir(), "pi-subagents-isolation-agent-wrapper-"));
		vi.spyOn(worktreeModule, "createWorktreeIsolation").mockRejectedValue(new Error("not a Git repository"));
		const { subagent } = registered();
		const tool = {
			...subagent,
			execute: (id: string, params: unknown, signal?: AbortSignal, onUpdate?: (result: unknown) => void) =>
				subagent.execute(id, params, signal, onUpdate, ctx(nonGit)),
		};
		const usage = {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		const responses = [
			{
				role: "assistant",
				content: [{
					type: "toolCall",
					id: "dispatch-all-fail",
					name: "subagent",
					arguments: { tasks: [{ agent: "worker", task: "must isolate", cwd: nonGit }] },
				}],
				api: "test",
				provider: "test",
				model: "test-model",
				usage,
				stopReason: "toolUse",
				timestamp: Date.now(),
			},
			{
				role: "assistant",
				content: [{ type: "text", text: "observed tool failure" }],
				api: "test",
				provider: "test",
				model: "test-model",
				usage,
				stopReason: "stop",
				timestamp: Date.now(),
			},
		] as any[];
		const streamFn = vi.fn(async () => {
			const message = responses.shift();
			if (!message) throw new Error("unexpected extra model turn");
			return {
				async *[Symbol.asyncIterator]() {
					yield { type: "done" };
				},
				result: async () => message,
			};
		});
		const agent = new Agent({
			initialState: {
				systemPrompt: "test",
				model: {
					id: "test-model",
					name: "Test",
					api: "test",
					provider: "test",
					baseUrl: "",
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 1_000,
					maxTokens: 100,
				} as any,
				thinkingLevel: "off",
				tools: [tool],
			},
			streamFn: streamFn as any,
		});
		const toolEnds: any[] = [];
		agent.subscribe((event) => {
			if (event.type === "tool_execution_end") toolEnds.push(event);
		});
		await agent.prompt("dispatch it");
		expect(toolEnds).toHaveLength(1);
		expect(toolEnds[0].isError).toBe(true);
		expect(toolEnds[0].result.content[0].text).toMatch(/No background subagents were started[\s\S]*tasks\[0\]/i);
		rmSync(nonGit, { recursive: true, force: true });
	});

	it("recognizes custom write-capable agents but not explicit read-only agents", () => {
		const base = {
			description: "test",
			systemPrompt: "test",
			source: "project" as const,
			filePath: "agent.md",
		};
		expect(isWorktreeCapableAgent({ ...base, name: "custom-writer", tools: ["read", "edit"] })).toBe(true);
		expect(isWorktreeCapableAgent({ ...base, name: "custom-full" })).toBe(true);
		expect(isWorktreeCapableAgent({ ...base, name: "custom-reader", tools: ["read", "grep"] })).toBe(false);
		expect(isWorktreeCapableAgent({ ...base, name: "reviewer" })).toBe(false);
	});

	it("surfaces Git setup failure and never silently enqueues shared work", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-subagents-isolation-not-git-"));
		const enqueue = vi.spyOn(BackgroundTaskQueue.prototype, "enqueue");
		const { subagent } = registered();
		await expect(execute(subagent, {
			agent: "worker",
			task: "must isolate",
			isolation: "worktree",
		}, root)).rejects.toThrow(/requires cwd to be inside a Git worktree\/repository/i);
		expect(enqueue).not.toHaveBeenCalled();
		rmSync(root, { recursive: true, force: true });
	});

	it("rejects worktree isolation for explore/reviewer before enqueue", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-subagents-isolation-reject-"));
		const create = vi.spyOn(worktreeModule, "createWorktreeIsolation");
		const enqueue = vi.spyOn(BackgroundTaskQueue.prototype, "enqueue");
		const { subagent } = registered();
		for (const agent of ["explore", "reviewer"]) {
			await expect(execute(subagent, { agent, task: "read", isolation: "worktree" }, root))
				.rejects.toThrow(/read-only.*worktree isolation/i);
		}
		expect(create).not.toHaveBeenCalled();
		expect(enqueue).not.toHaveBeenCalled();
		rmSync(root, { recursive: true, force: true });
	});
});

describe("logical worktree reuse and guarded finalization", () => {
	it("reuses one worktree across park/resume and preserves the execution cwd", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-subagents-isolation-park-"));
		const handle = fakeWorktree(root);
		const create = vi.spyOn(worktreeModule, "createWorktreeIsolation").mockResolvedValue(handle);
		const queued: Array<{ task: BackgroundTask; controller: AbortController }> = [];
		vi.spyOn(BackgroundTaskQueue.prototype, "enqueue").mockImplementation((task) => {
			const controller = new AbortController();
			queued.push({ task, controller });
			return controller;
		});
		const sessionDir = mkdtempSync(join(tmpdir(), "pi-subagents-isolation-session-"));
		const run = vi.spyOn(spawnModule, "runSingleAgentWithModelFallback")
			.mockResolvedValueOnce(emptyResult("park me", {
				parked: true,
				sessionId: "session-1",
				sessionDir,
			}))
			.mockResolvedValueOnce(emptyResult("continue"));
		const { subagent, control } = registered();
		const dispatched = await execute(subagent, { agent: "worker", task: "park me", isolation: "worktree" }, root);
		const runId = dispatched.details.results[0].runId;
		await queued[0].task(queued[0].controller.signal);
		expect(monitor.findRun(runId)?.status).toBe("parked");
		expect(handle.finalizeMock!).not.toHaveBeenCalled();

		const resumed = await execute(control, { action: "resume", id: runId, objective: "continue" }, root);
		expect(resumed.content[0]!.text).toContain(`Resumed run #${runId}`);
		expect(create).toHaveBeenCalledTimes(1);
		await queued[1].task(queued[1].controller.signal);
		expect(handle.finalizeMock).toHaveBeenCalledTimes(1);
		expect(run.mock.calls[0][0].cwd).toBe(handle.cwd);
		expect(run.mock.calls[1][0].cwd).toBe(handle.cwd);
		rmSync(root, { recursive: true, force: true });
	});

	it("resumes a settled isolated thread in a fresh worktree with a rewritten session cwd", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-subagents-isolation-settled-resume-"));
		const firstHandle = fakeWorktree(root, undefined, "generation-one");
		const secondHandle = fakeWorktree(root, undefined, "generation-two");
		const create = vi.spyOn(worktreeModule, "createWorktreeIsolation")
			.mockResolvedValueOnce(firstHandle)
			.mockResolvedValueOnce(secondHandle);
		const queued: Array<{ task: BackgroundTask; controller: AbortController }> = [];
		vi.spyOn(BackgroundTaskQueue.prototype, "enqueue").mockImplementation((task) => {
			const controller = new AbortController();
			queued.push({ task, controller });
			return controller;
		});
		const retained = createRetainedSession(firstHandle.cwd);
		let resumedOptions: any;
		vi.spyOn(spawnModule, "runSingleAgentWithModelFallback")
			.mockResolvedValueOnce(emptyResult("generation one", {
				sessionId: retained.id,
				sessionDir: retained.dir,
			}))
			.mockImplementationOnce(async (options: any) => {
				resumedOptions = options;
				return emptyResult("generation two", {
					sessionId: options.sessionId,
					sessionDir: options.sessionDir,
				});
			});
		const { subagent, control } = registered();
		const dispatched = await execute(subagent, {
			agent: "worker",
			task: "generation one",
			isolation: "worktree",
		}, root);
		const runId = dispatched.details.results[0].runId;
		await queued[0].task(queued[0].controller.signal);
		expect(firstHandle.state).toBe("no_changes");

		const resumed = await execute(control, {
			action: "resume",
			id: runId,
			objective: "generation two",
		}, root);
		expect(resumed.content[0]!.text).toContain(`Resumed run #${runId}`);
		expect(resumed.details ?? {}).toBeDefined();
		expect(create).toHaveBeenCalledTimes(2);
		expect(monitor.findRun(runId)?.integrationStatus).toBe("pending");
		await queued[1].task(queued[1].controller.signal);
		expect(resumedOptions.cwd).toBe(secondHandle.cwd);
		expect(resumedOptions.agent.systemPrompt).toContain("temporary detached Git worktree");
		const sessions = await SessionManager.listAll(resumedOptions.sessionDir);
		expect(sessions).toHaveLength(1);
		expect(SessionManager.open(sessions[0]!.path).getCwd()).toBe(secondHandle.cwd);
		rmSync(root, { recursive: true, force: true });
	});

	it("marks a no-op continuation seed as integrated for the next resume", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-subagents-isolation-noop-seed-"));
		const firstHandle = fakeWorktree(root, {
			status: "integrated",
			integrated: true,
			hadChanges: true,
		}, "generation-one");
		const secondHandle = fakeWorktree(root, {
			status: "no_changes",
			integrated: false,
			hadChanges: false,
		}, "generation-two");
		const thirdHandle = fakeWorktree(root, undefined, "generation-three");
		const create = vi.spyOn(worktreeModule, "createWorktreeIsolation")
			.mockResolvedValueOnce(firstHandle)
			.mockResolvedValueOnce(secondHandle)
			.mockResolvedValueOnce(thirdHandle);
		const queued: Array<{ task: BackgroundTask; controller: AbortController }> = [];
		vi.spyOn(BackgroundTaskQueue.prototype, "enqueue").mockImplementation((task) => {
			const controller = new AbortController();
			queued.push({ task, controller });
			return controller;
		});
		const retained = createRetainedSession(firstHandle.cwd);
		vi.spyOn(spawnModule, "runSingleAgentWithModelFallback")
			.mockResolvedValueOnce(emptyResult("generation one", {
				sessionId: retained.id,
				sessionDir: retained.dir,
			}))
			.mockImplementation(async (options: any) => emptyResult(options.task, {
				sessionId: options.sessionId,
				sessionDir: options.sessionDir,
			}));
		const { subagent, control } = registered();
		const dispatched = await execute(subagent, {
			agent: "worker",
			task: "generation one",
			isolation: "worktree",
		}, root);
		const runId = dispatched.details.results[0].runId;
		await queued[0].task(queued[0].controller.signal);

		await execute(control, { action: "resume", id: runId, objective: "generation two" }, root);
		await queued[1].task(queued[1].controller.signal);
		expect(secondHandle.state).toBe("no_changes");
		await execute(control, { action: "resume", id: runId, objective: "generation three" }, root);

		expect(create).toHaveBeenCalledTimes(3);
		expect(create.mock.calls[2]![1]).toMatchObject({ seedIsIntegrated: true });
		await queued[2].task(queued[2].controller.signal);
		rmSync(root, { recursive: true, force: true });
	});

	it("retargets without creating or finalizing another worktree", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-subagents-isolation-retarget-"));
		const handle = fakeWorktree(root);
		const create = vi.spyOn(worktreeModule, "createWorktreeIsolation").mockResolvedValue(handle);
		const queued: BackgroundTask[] = [];
		vi.spyOn(BackgroundTaskQueue.prototype, "enqueue").mockImplementation((task) => {
			queued.push(task);
			return new AbortController();
		});
		const run = vi.spyOn(spawnModule, "runSingleAgentWithModelFallback").mockResolvedValue(emptyResult("replacement"));
		const { subagent, control } = registered();
		const dispatched = await execute(subagent, { agent: "worker", task: "old", isolation: "worktree" }, root);
		const runId = dispatched.details.results[0].runId;
		const retargeted = await execute(control, { action: "retarget", id: runId, objective: "replacement" }, root);
		expect(retargeted.content[0].text).toContain("no child was spawned");
		await queued[0](new AbortController().signal);
		expect(create).toHaveBeenCalledTimes(1);
		expect(run.mock.calls[0]![0].control!.getObjective()).toBe("replacement");
		expect(run.mock.calls[0]![0].cwd).toBe(handle.cwd);
		expect(run.mock.calls[0]![0].agent!.systemPrompt!).toContain("temporary detached Git worktree");
		expect(handle.finalizeMock!).toHaveBeenCalledTimes(1);
		rmSync(root, { recursive: true, force: true });
	});

	it("passes one worktree through the full model candidate pool", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-subagents-isolation-model-"));
		const handle = fakeWorktree(root);
		const create = vi.spyOn(worktreeModule, "createWorktreeIsolation").mockResolvedValue(handle);
		let queued!: BackgroundTask;
		vi.spyOn(BackgroundTaskQueue.prototype, "enqueue").mockImplementation((task) => {
			queued = task;
			return new AbortController();
		});
		const run = vi.spyOn(spawnModule, "runSingleAgentWithModelFallback").mockResolvedValue(emptyResult("pool"));
		const { subagent } = registered();
		await execute(subagent, { agent: "worker", task: "pool", isolation: "worktree" }, root);
		await queued(new AbortController().signal);
		expect(create).toHaveBeenCalledTimes(1);
		expect(run).toHaveBeenCalledTimes(1);
		expect(run.mock.calls[0][0].cwd).toBe(handle.cwd);
		expect(Array.isArray(run.mock.calls[0][1])).toBe(true);
		expect(handle.finalizeMock).toHaveBeenCalledTimes(1);
		rmSync(root, { recursive: true, force: true });
	});

	it("ignores a stale generation and finalizes the shared handle exactly once", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-subagents-isolation-stale-"));
		const handle = fakeWorktree(root);
		vi.spyOn(worktreeModule, "createWorktreeIsolation").mockResolvedValue(handle);
		const queued: Array<{ task: BackgroundTask; controller: AbortController }> = [];
		vi.spyOn(BackgroundTaskQueue.prototype, "enqueue").mockImplementation((task) => {
			const controller = new AbortController();
			queued.push({ task, controller });
			return controller;
		});
		const first = deferred<any>();
		vi.spyOn(spawnModule, "runSingleAgentWithModelFallback")
			.mockImplementationOnce(async (options: any) => {
				options.onLive?.({ kind: "status", status: "running" });
				return first.promise;
			})
			.mockResolvedValueOnce(emptyResult("generation two"));
		const { subagent, control } = registered();
		const dispatched = await execute(subagent, { agent: "worker", task: "generation one", isolation: "worktree" }, root);
		const runId = dispatched.details.results[0].runId;
		const staleTask = queued[0].task(queued[0].controller.signal);
		await waitFor(() => monitor.findRun(runId)?.status === "running");
		await execute(control, { action: "park", id: runId }, root);
		await execute(control, { action: "resume", id: runId, objective: "generation two" }, root);
		first.resolve(emptyResult("generation one", { parked: true }));
		await staleTask;
		expect(handle.finalizeMock).not.toHaveBeenCalled();
		await queued[1].task(queued[1].controller.signal);
		expect(handle.finalizeMock).toHaveBeenCalledTimes(1);
		rmSync(root, { recursive: true, force: true });
	});

	it("rejects park after terminal settlement has claimed a slow worktree finalization", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-subagents-isolation-settle-park-"));
		const finalization = deferred<WorktreeFinalization>();
		const handle = fakeWorktree(root);
		handle.finalizeMock.mockImplementation(() => finalization.promise);
		vi.spyOn(worktreeModule, "createWorktreeIsolation").mockResolvedValue(handle);
		vi.spyOn(spawnModule, "runSingleAgentWithModelFallback").mockImplementation(async (options: any) => {
			options.onLive?.({ kind: "status", status: "running" });
			return emptyResult("settling");
		});
		const { stub, subagent, control } = registered();
		const dispatched = await execute(subagent, {
			agent: "worker",
			task: "settling",
			isolation: "worktree",
		}, root);
		const runId = dispatched.details.results[0].runId;
		await waitFor(() => handle.finalizeMock.mock.calls.length === 1);
		expect(monitor.findRun(runId)?.status).toBe("running");

		await expect(execute(control, { action: "park", id: runId }, root))
			.rejects.toThrow(/handling settle/i);
		expect(stub.messages).toHaveLength(0);
		finalization.resolve({ status: "no_changes", integrated: false, hadChanges: false });
		await waitFor(() => stub.messages.length === 1);
		expect(stub.messages[0].message.content).toContain("settling");
		expect(monitor.findRun(runId)).toBeUndefined();
		rmSync(root, { recursive: true, force: true });
	});

	it("lets destructive stop supersede slow settlement without publishing success", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-subagents-isolation-settle-stop-"));
		const finalization = deferred<WorktreeFinalization>();
		const handle = fakeWorktree(root);
		handle.finalizeMock.mockImplementation(() => finalization.promise);
		vi.spyOn(worktreeModule, "createWorktreeIsolation").mockResolvedValue(handle);
		vi.spyOn(spawnModule, "runSingleAgentWithModelFallback").mockResolvedValue(emptyResult("stop while settling"));
		const { stub, subagent, stop, status } = registered();
		const dispatched = await execute(subagent, {
			agent: "worker",
			task: "stop while settling",
			isolation: "worktree",
		}, root);
		const runId = dispatched.details.results[0].runId;
		await waitFor(() => handle.finalizeMock.mock.calls.length === 1);

		let stopResolved = false;
		const stopping = execute(stop, { all: true }, root).then((value) => {
			stopResolved = true;
			return value;
		});
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(stopResolved).toBe(false);
		finalization.resolve({ status: "no_changes", integrated: false, hadChanges: false });
		const stopped = await stopping;
		expect(stopped.content[0].text).toContain(`#${runId}`);
		expect(stub.messages).toHaveLength(1);
		expect(stub.messages[0].message.content).toContain("Stopped by subagent_stop");
		expect(stub.messages[0].message.content).toContain("--- Partial output ---");
		expect(stub.messages[0].message.content).toContain("done");
		const full = await execute(status, { id: String(runId) }, root);
		expect(full.content[0].text).toContain("Stopped by subagent_stop");
		expect(full.content[0].text).not.toContain("done\n");
		rmSync(root, { recursive: true, force: true });
	});

	it("surfaces retained recovery paths in result, status, completion, and trajectory", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-subagents-isolation-conflict-"));
		const retainedResult: WorktreeFinalization = {
			status: "retained",
			integrated: false,
			hadChanges: true,
			worktreePath: join(root, "isolated"),
			patchPath: join(root, "changes.patch"),
			error: "patch does not apply",
		};
		const handle = fakeWorktree(root, retainedResult);
		vi.spyOn(worktreeModule, "createWorktreeIsolation").mockResolvedValue(handle);
		let queued!: BackgroundTask;
		vi.spyOn(BackgroundTaskQueue.prototype, "enqueue").mockImplementation((task) => {
			queued = task;
			return new AbortController();
		});
		vi.spyOn(spawnModule, "runSingleAgentWithModelFallback").mockResolvedValue(emptyResult("conflict"));
		const { stub, subagent, status } = registered();
		const dispatched = await execute(subagent, { agent: "worker", task: "conflict", isolation: "worktree" }, root);
		const runId = dispatched.details.results[0].runId;
		await queued(new AbortController().signal);
		const full = await execute(status, { id: String(runId) }, root);
		const text = full.content[0].text;
		expect(text).toContain("worktree · integration failed");
		expect(text).toContain(`Retained worktree: ${retainedResult.worktreePath}`);
		expect(text).toContain(`Retained patch: ${retainedResult.patchPath}`);
		expect(text).toContain("Integration error: patch does not apply");
		expect(text).not.toContain("diff --git");
		expect(stub.messages[0].message.content).toContain("recovery artifacts retained");
		const worktreeEvent = inspectorStore.get(runId).trajectory.getEvents().find((event) => event.kind === "worktree" && event.status === "retained");
		expect(worktreeEvent).toMatchObject({ patchPath: retainedResult.patchPath, error: retainedResult.error });
		rmSync(root, { recursive: true, force: true });
	});
});

describe("shutdown and destructive-stop integration", () => {
	it("keeps a queued isolated stop active until worktree cleanup and result publication finish", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-subagents-isolation-queued-stop-"));
		writeFileSync(join(agentDir, "pi-subagents.json"), JSON.stringify({ maxConcurrency: 1 }), "utf8");
		const finalization = deferred<WorktreeFinalization>();
		const handle = fakeWorktree(root);
		handle.finalizeMock.mockImplementation(() => finalization.promise);
		vi.spyOn(worktreeModule, "createWorktreeIsolation").mockResolvedValue(handle);
		vi.spyOn(spawnModule, "runSingleAgentWithModelFallback").mockImplementation(async (options: any) => {
			options.onLive?.({ kind: "status", status: "running" });
			await new Promise<void>((resolve) => {
				if (options.signal.aborted) resolve();
				else options.signal.addEventListener("abort", () => resolve(), { once: true });
			});
			return emptyResult(options.task, {
				exitCode: 1,
				stopReason: "aborted",
				errorMessage: "stopped",
			});
		});
		const { stub, subagent, stop, status } = registered();
		await execute(subagent, { agent: "worker", task: "occupy slot" }, root);
		await waitFor(() => monitor.getRuns().some((run) => run.task === "occupy slot" && run.status === "running"));
		const queued = await execute(subagent, {
			agent: "worker",
			task: "queued isolated",
			isolation: "worktree",
		}, root);
		const runId = queued.details.results[0].runId;
		expect(monitor.findRun(runId)?.status).toBe("queued");

		let stopResolved = false;
		const stopping = execute(stop, { id: String(runId) }, root).then((value) => {
			stopResolved = true;
			return value;
		});
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(stopResolved).toBe(false);
		expect(monitor.findRun(runId)?.status).toBe("queued");
		const duringCleanup = await execute(status, { id: String(runId) }, root);
		expect(duringCleanup.content[0].text).toContain("still active");
		expect(stub.messages).toHaveLength(0);

		finalization.resolve({ status: "no_changes", integrated: false, hadChanges: false });
		await stopping;
		expect(monitor.findRun(runId)).toBeUndefined();
		expect(stub.messages).toHaveLength(1);
		expect(stub.messages[0].message.content).toContain("Stopped by subagent_stop before the run started");
		rmSync(root, { recursive: true, force: true });
	});

	it.each(["resume", "fork"] as const)(
		"invalidates and rolls back an isolated %s preflight before clearing the runtime",
		async (action) => {
			const root = mkdtempSync(join(tmpdir(), `pi-subagents-isolation-shutdown-${action}-`));
			const firstHandle = fakeWorktree(root, undefined, "source");
			const childHandle = fakeWorktree(root, undefined, "continuation");
			const childCreation = deferred<WorktreeIsolation>();
			const create = vi.spyOn(worktreeModule, "createWorktreeIsolation")
				.mockResolvedValueOnce(firstHandle)
				.mockImplementationOnce(async () => childCreation.promise);
			const queued: Array<{ task: BackgroundTask; controller: AbortController }> = [];
			vi.spyOn(BackgroundTaskQueue.prototype, "enqueue").mockImplementation((task) => {
				const controller = new AbortController();
				queued.push({ task, controller });
				return controller;
			});
			const retained = createRetainedSession(firstHandle.cwd);
			vi.spyOn(spawnModule, "runSingleAgentWithModelFallback").mockResolvedValue(
				emptyResult("source", { sessionId: retained.id, sessionDir: retained.dir }),
			);
			const { stub, subagent, control } = registered();
			const dispatched = await execute(subagent, {
				agent: "worker",
				task: "source",
				isolation: "worktree",
			}, root);
			const runId = dispatched.details.results[0].runId;
			await queued[0].task(queued[0].controller.signal);

			const controlling = execute(control, { action, id: runId }, root);
			await waitFor(() => create.mock.calls.length === 2);
			const shuttingDown = stub.hooks["session_shutdown"]?.({}, {});
			childCreation.resolve(childHandle);
			const result = await controlling;
			await shuttingDown;

			expect(result.content[0].text).toMatch(/changed|shut down/i);
			expect(childHandle.discardMock).toHaveBeenCalledTimes(1);
			expect(queued).toHaveLength(1);
			expect(existsSync(retained.dir)).toBe(false);
			rmSync(root, { recursive: true, force: true });
		},
	);

	it("persists recovery metadata when shutdown cannot discard a preflight continuation", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-subagents-isolation-shutdown-discard-"));
		const firstHandle = fakeWorktree(root, undefined, "source");
		const childHandle = fakeWorktree(root, undefined, "continuation");
		mkdirSync(childHandle.worktreePath, { recursive: true });
		childHandle.discardMock.mockRejectedValue(new Error("worktree prune failed"));
		const childCreation = deferred<WorktreeIsolation>();
		const create = vi.spyOn(worktreeModule, "createWorktreeIsolation")
			.mockResolvedValueOnce(firstHandle)
			.mockImplementationOnce(async () => childCreation.promise);
		const queued: Array<{ task: BackgroundTask; controller: AbortController }> = [];
		vi.spyOn(BackgroundTaskQueue.prototype, "enqueue").mockImplementation((task) => {
			const controller = new AbortController();
			queued.push({ task, controller });
			return controller;
		});
		const retained = createRetainedSession(firstHandle.cwd);
		vi.spyOn(spawnModule, "runSingleAgentWithModelFallback").mockResolvedValue(
			emptyResult("source", { sessionId: retained.id, sessionDir: retained.dir }),
		);
		const { stub, subagent, control } = registered();
		const dispatched = await execute(subagent, {
			agent: "worker",
			task: "source",
			isolation: "worktree",
		}, root);
		const runId = dispatched.details.results[0].runId;
		await queued[0].task(queued[0].controller.signal);

		const resuming = execute(control, { action: "resume", id: runId }, root);
		await waitFor(() => create.mock.calls.length === 2);
		const shuttingDown = stub.hooks["session_shutdown"]?.({}, {});
		childCreation.resolve(childHandle);
		await resuming;
		await shuttingDown;

		const records = await readRecoveryRecords(join(agentDir, "pi-subagents.json"));
		expect(records).toContainEqual(expect.objectContaining({
			runId,
			worktreePath: childHandle.worktreePath,
			error: expect.stringContaining("worktree prune failed"),
		}));
		rmSync(root, { recursive: true, force: true });
	});

	it("best-effort integrates a parked worktree during parent session shutdown", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-subagents-isolation-shutdown-parent-"));
		const { execFileSync } = await import("node:child_process");
		const git = (args: string[]) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
		git(["init"]);
		git(["config", "user.email", "pi-subagents-tests@example.invalid"]);
		git(["config", "user.name", "pi-subagents tests"]);
		git(["config", "core.autocrlf", "false"]);
		writeFileSync(join(root, "parked.txt"), "base\n", "utf8");
		git(["add", "."]);
		git(["commit", "-m", "base"]);
		vi.spyOn(spawnModule, "runSingleAgentWithModelFallback").mockImplementation(async (options: any) => {
			writeFileSync(join(options.cwd, "parked.txt"), "parked worker edit\n", "utf8");
			return emptyResult("parked", { parked: true });
		});
		const { stub, subagent } = registered();
		await execute(subagent, { agent: "worker", task: "parked", isolation: "worktree" }, root);
		await waitFor(() => monitor.getRuns().some((run) => run.status === "parked"));
		await stub.hooks["session_shutdown"]?.({}, {});
		expect(readFileSync(join(root, "parked.txt"), "utf8")).toBe("parked worker edit\n");
		rmSync(root, { recursive: true, force: true });
	});

	it("integrates partial worktree edits before the stopped result settles", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-subagents-isolation-stop-parent-"));
		// Use a tiny real repository for the stop-path integration boundary.
		const { execFileSync } = await import("node:child_process");
		const git = (args: string[]) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
		git(["init"]);
		git(["config", "user.email", "pi-subagents-tests@example.invalid"]);
		git(["config", "user.name", "pi-subagents tests"]);
		git(["config", "core.autocrlf", "false"]);
		writeFileSync(join(root, "partial.txt"), "base\n", "utf8");
		git(["add", "."]);
		git(["commit", "-m", "base"]);

		vi.spyOn(spawnModule, "runSingleAgentWithModelFallback").mockImplementation(async (options: any) => {
			writeFileSync(join(options.cwd, "partial.txt"), "partial worker edit\n", "utf8");
			options.onLive?.({ kind: "status", status: "running" });
			await new Promise<void>((resolve) => {
				if (options.signal.aborted) resolve();
				else options.signal.addEventListener("abort", () => resolve(), { once: true });
			});
			return emptyResult("partial", {
				exitCode: 1,
				stopReason: "aborted",
				errorMessage: "Stopped by subagent_stop.",
				messages: [{ role: "assistant", content: [{ type: "text", text: "partial output" }], stopReason: "aborted" }],
			});
		});
		const { stub, subagent, stop, status } = registered();
		const dispatched = await execute(subagent, { agent: "worker", task: "partial", isolation: "worktree" }, root);
		const runId = dispatched.details.results[0].runId;
		await waitFor(() => monitor.findRun(runId)?.status === "running");
		await execute(stop, { id: String(runId) }, root);
		await waitFor(() => readFileSync(join(root, "partial.txt"), "utf8") === "partial worker edit\n");
		const full = await execute(status, { id: String(runId) }, root);
		expect(full.content[0].text).toContain("worktree · changes integrated");
		expect(full.content[0].text).toContain("partial output");
		expect(stub.messages).toHaveLength(1);
		expect(stub.messages[0].message.content).toContain("partial output");
		rmSync(root, { recursive: true, force: true });
	});
});
