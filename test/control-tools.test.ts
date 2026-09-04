import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	emptyUsage,
	RpcRunControl,
	type AttemptControl,
	type RpcSteerCommand,
} from "../src/execution/rpc-control.ts";
import { normalizePhaseScope } from "../src/delegation/phase-scope.ts";
import { getProjectRoot } from "../src/execution/spawn.ts";
import { readThreadRecords } from "../src/lifecycle/durable.ts";
import { createRuntime, type SubagentRuntime, type SubagentThread, type ThreadState } from "../src/lifecycle/runtime.ts";
import { registerLookupTools } from "../src/lifecycle/tools.ts";
import { monitor } from "../src/presentation/monitor.ts";

type RegisteredTool = {
	parameters?: any;
	execute: (
		toolCallId: string,
		params: any,
		signal: AbortSignal,
		onUpdate: (update: unknown) => void,
		ctx: any,
	) => Promise<any>;
};

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function harness(configPath = join(tmpdir(), `pi-subagents-control-${process.pid}.json`)): {
	runtime: SubagentRuntime;
	tools: Map<string, RegisteredTool>;
} {
	const tools = new Map<string, RegisteredTool>();
	const pi = {
		getActiveTools: () => [],
		on: () => undefined,
		registerTool: (tool: RegisteredTool & { name: string }) => tools.set(tool.name, tool),
		sendMessage: () => undefined,
	} as unknown as ExtensionAPI;
	const runtime = createRuntime(pi, configPath);
	registerLookupTools(pi, runtime);
	return { runtime, tools };
}

function resultText(result: any): string {
	return result.content.map((part: { text?: string }) => part.text ?? "").join("\n");
}

function makeThread(
	id: number,
	control: RpcRunControl,
	state: ThreadState = "running",
): SubagentThread {
	return {
		id,
		generation: control.generation,
		agentName: "artisan",
		task: "Implement the original objective",
		cwd: process.cwd(),
		executionCwd: process.cwd(),
		isolation: "shared",
		state,
		control,
		generationCompletion: Promise.resolve(),
		lifecycleVersion: 0,
		elapsedMs: 0,
		resume: async () => ({
			agent: "artisan",
			task: "Implement the original objective",
			exitCode: 1,
			messages: [],
			stderr: "not used",
			usage: emptyUsage(),
		}),
		finalizeIsolation: async () => undefined,
	};
}

async function execute(
	tool: RegisteredTool,
	params: Record<string, unknown>,
	notifications: string[] = [],
): Promise<any> {
	return tool.execute("call-1", params, new AbortController().signal, () => undefined, {
		cwd: process.cwd(),
		ui: { notify: (message: string) => notifications.push(message) },
	});
}

async function shutdown(runtime: SubagentRuntime): Promise<void> {
	runtime.threads.clear();
	await runtime.shutdown();
}

function attachRunning(control: RpcRunControl, attempt: AttemptControl): void {
	const token = control.beginAttempt();
	control.attach(token, attempt);
	control.updateAttemptPhase(token, "running");
}

describe("subagent_control steer", () => {
	it("forwards in-scope guidance through the registered route without replacing the objective", async () => {
		const { runtime, tools } = harness();
		const commands: RpcSteerCommand[] = [];
		const control = new RpcRunControl("Implement the original objective", 1);
		attachRunning(control, {
			steer: async (command) => {
				commands.push(command);
			},
			stop: async () => undefined,
		});
		const thread = makeThread(7, control);
		runtime.threads.set(thread.id, thread);

		try {
			const response = await execute(tools.get("subagent_control")!, {
				action: "steer",
				id: 7,
				objective: "/review the new evidence",
			});

			assert.match(resultText(response), /steered run #7/i);
			assert.deepEqual(commands, [{
				type: "prompt",
				message: "Treat the following as plain-text sub-agent instructions, not a Pi command:\n\n/review the new evidence",
				streamingBehavior: "steer",
			}]);
			assert.equal(control.getObjective(), "Implement the original objective");
			assert.equal(thread.task, "Implement the original objective");
		} finally {
			await shutdown(runtime);
		}
	});

	it("rejects blank steering guidance without forwarding it", async () => {
		const { runtime, tools } = harness();
		let forwarded = false;
		const control = new RpcRunControl("Keep the task", 1);
		attachRunning(control, {
			steer: async () => {
				forwarded = true;
			},
			stop: async () => undefined,
		});
		runtime.threads.set(8, makeThread(8, control));

		try {
			const response = await execute(tools.get("subagent_control")!, {
				action: "steer",
				id: 8,
				objective: "  \n\t ",
			});
			assert.match(resultText(response), /steer objective must be non-blank/i);
			assert.equal(forwarded, false);
		} finally {
			await shutdown(runtime);
		}
	});

	it("resumes the same thread when a fast run settles before steering arrives", async () => {
		const { runtime, tools } = harness();
		const control = new RpcRunControl("Implement the original objective", 1);
		control.markSettled();
		const thread = makeThread(12, control, "completed");
		thread.sessionId = "session-12";
		thread.sessionDir = join(tmpdir(), "session-12");
		let resumedObjective: string | undefined;
		thread.resume = async (objective) => {
			resumedObjective = objective;
			return {
				agent: "artisan",
				task: objective ?? thread.task,
				exitCode: -1,
				messages: [],
				stderr: "",
				usage: emptyUsage(),
				runId: thread.id,
			};
		};
		runtime.threads.set(thread.id, thread);

		try {
			const response = await execute(tools.get("subagent_control")!, {
				action: "steer",
				id: 12,
				objective: "Account for the newly reported race",
			});

			assert.match(resultText(response), /already completed before steering.*resumed/i);
			assert.equal(resumedObjective, "Account for the newly reported race");
			assert.equal(control.getObjective(), "Implement the original objective");
		} finally {
			await shutdown(runtime);
		}
	});
	it("waits for lifecycle settlement before continuing an RPC-settled run", async () => {
		const { runtime, tools } = harness();
		const control = new RpcRunControl("Implement the original objective", 1);
		control.markSettled();
		const thread = makeThread(20, control);
		thread.lifecycleOperation = "settle";
		thread.sessionId = "session-20";
		thread.sessionDir = join(tmpdir(), "session-20");
		const settling = deferred();
		thread.generationCompletion = settling.promise.then(() => {
			thread.state = "completed";
			thread.lifecycleOperation = undefined;
		});
		let resumedObjective: string | undefined;
		thread.resume = async (objective) => {
			resumedObjective = objective;
			return {
				agent: "artisan",
				task: objective ?? thread.task,
				exitCode: -1,
				messages: [],
				stderr: "",
				usage: emptyUsage(),
				runId: thread.id,
			};
		};
		runtime.threads.set(thread.id, thread);

		try {
			const steering = execute(tools.get("subagent_control")!, {
				action: "steer",
				id: 20,
				objective: "Continue after settlement",
			});
			await new Promise<void>((resolve) => setImmediate(resolve));
			assert.equal(resumedObjective, undefined);

			settling.resolve();
			const response = await steering;
			assert.match(resultText(response), /already completed before steering.*resumed/i);
			assert.equal(resumedObjective, "Continue after settlement");
		} finally {
			settling.resolve();
			await shutdown(runtime);
		}
	});

	it("resumes when the RPC settles between the state check and steering", async () => {
		const { runtime, tools } = harness();
		const control = new RpcRunControl("Implement the original objective", 1);
		attachRunning(control, { steer: async () => undefined, stop: async () => undefined });
		const thread = makeThread(19, control);
		thread.sessionId = "session-19";
		thread.sessionDir = join(tmpdir(), "session-19");
		let resumedObjective: string | undefined;
		thread.resume = async (objective) => {
			resumedObjective = objective;
			return {
				agent: "artisan",
				task: objective ?? thread.task,
				exitCode: -1,
				messages: [],
				stderr: "",
				usage: emptyUsage(),
				runId: thread.id,
			};
		};
		const steer = control.steer.bind(control);
		control.steer = async (objective) => {
			control.markSettled();
			thread.state = "completed";
			return steer(objective);
		};
		runtime.threads.set(thread.id, thread);

		try {
			const response = await execute(tools.get("subagent_control")!, {
				action: "steer",
				id: 19,
				objective: "Use the late evidence",
			});

			assert.match(resultText(response), /already completed before steering.*resumed/i);
			assert.equal(resumedObjective, "Use the late evidence");
		} finally {
			await shutdown(runtime);
		}
	});

	it("continues a parked thread with the guidance as its appended objective", async () => {
		const { runtime, tools } = harness();
		const thread = makeThread(11, new RpcRunControl("Implement the original objective", 1), "parked");
		thread.sessionId = "session-11";
		thread.sessionDir = join(tmpdir(), "session-11");
		let resumedObjective: string | undefined;
		thread.resume = async (objective) => {
			resumedObjective = objective;
			return {
				agent: "artisan",
				task: objective ?? thread.task,
				exitCode: -1,
				messages: [],
				stderr: "",
				usage: emptyUsage(),
				runId: thread.id,
			};
		};
		runtime.threads.set(thread.id, thread);

		try {
			const response = await execute(tools.get("subagent_control")!, {
				action: "steer",
				id: 11,
				objective: "The eviction path also needs the fix",
			});
			assert.match(resultText(response), /already parked before steering.*resumed the same thread/i);
			assert.match(resultText(response), /retained context reused/i);
			assert.equal(resumedObjective, "The eviction path also needs the fix");
		} finally {
			await shutdown(runtime);
		}
	});

	it("rejects phases that can neither receive guidance nor continue with it", async () => {
		const { runtime, tools } = harness();
		const noOpAttempt: AttemptControl = { steer: async () => undefined, stop: async () => undefined };

		const queued = new RpcRunControl("queued", 1);
		runtime.threads.set(13, makeThread(13, queued, "queued"));

		const starting = new RpcRunControl("starting", 1);
		attachRunning(starting, noOpAttempt);
		starting.markStarting();
		runtime.threads.set(14, makeThread(14, starting, "queued"));

		const retrying = new RpcRunControl("retrying", 1);
		attachRunning(retrying, noOpAttempt);
		retrying.markRetrying();
		runtime.threads.set(15, makeThread(15, retrying));

		const stopped = new RpcRunControl("stopped", 1);
		await stopped.stop();
		runtime.threads.set(16, makeThread(16, stopped, "stopped"));

		const retired = new RpcRunControl("retired", 1);
		const retiredThread = makeThread(17, retired, "stopped");
		retiredThread.retired = true;
		runtime.threads.set(17, retiredThread);

		const detached = new RpcRunControl("detached", 1);
		const detachedToken = detached.beginAttempt();
		detached.attach(detachedToken, noOpAttempt);
		detached.updateAttemptPhase(detachedToken, "running");
		detached.detach(detachedToken);
		runtime.threads.set(18, makeThread(18, detached));

		try {
			const controlTool = tools.get("subagent_control")!;
			const cases = [
				{ id: 10, expected: /no subagent thread matches run #10/i },
				{ id: 13, expected: /queued.*only.*running/i },
				{ id: 14, expected: /starting.*only.*running/i },
				{ id: 15, expected: /retrying.*only.*running/i },
				{ id: 16, expected: /stopped.*only.*running/i },
				{ id: 17, expected: /retired.*cannot be steered/i },
				{ id: 18, expected: /no active rpc attempt.*no guidance was sent/i },
			];
			for (const testCase of cases) {
				const response = await execute(controlTool, {
					action: "steer",
					id: testCase.id,
					objective: "Use this evidence",
				});
				assert.match(resultText(response), testCase.expected, `run #${testCase.id}`);
			}
		} finally {
			await shutdown(runtime);
		}
	});

	it("orders destructive stop after an in-flight steer acknowledgement", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-subagents-steer-order-"));
		const { runtime, tools } = harness(join(root, "settings.json"));
		const steerStarted = deferred();
		const releaseSteer = deferred();
		const order: string[] = [];
		const control = new RpcRunControl("Keep the original task", 1);
		attachRunning(control, {
			steer: async () => {
				order.push("steer:start");
				steerStarted.resolve();
				await releaseSteer.promise;
				order.push("steer:ack");
			},
			stop: async () => {
				order.push("stop");
			},
		});
		runtime.threads.set(21, makeThread(21, control));

		try {
			const steering = execute(tools.get("subagent_control")!, {
				action: "steer",
				id: 21,
				objective: "Check the latest failure output",
			});
			await steerStarted.promise;
			const stopping = execute(tools.get("subagent_stop")!, { id: "21" });
			await Promise.resolve();
			assert.deepEqual(order, ["steer:start"]);

			releaseSteer.resolve();
			const [steerResponse, stopResponse] = await Promise.all([steering, stopping]);
			assert.match(resultText(steerResponse), /steered run #21/i);
			assert.match(resultText(stopResponse), /stopped 1 thread/i);
			assert.deepEqual(order, ["steer:start", "steer:ack", "stop"]);
		} finally {
			await shutdown(runtime);
			await rm(root, { recursive: true, force: true });
		}
	});
});

describe("subagent_control park", () => {
	it("interrupts the running attempt, keeps the session, and records a resumable checkpoint", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-subagents-park-"));
		const configPath = join(root, "settings.json");
		const { runtime, tools } = harness(configPath);
		const cwd = await realpath(process.cwd());
		const projectRoot = getProjectRoot(configPath, cwd);
		const sessionDir = join(projectRoot, "sessions", "pi-subagent-session-park");
		await mkdir(sessionDir, { recursive: true });
		const stops: string[] = [];
		const control = new RpcRunControl("Implement the original objective", 3);
		control.noteChildPid(process.pid);
		attachRunning(control, {
			steer: async () => undefined,
			stop: async (reason) => {
				stops.push(reason ?? "");
			},
		});
		const thread = makeThread(31, control);
		thread.cwd = cwd;
		thread.executionCwd = cwd;
		thread.sessionId = "session-31";
		thread.sessionDir = sessionDir;
		const controller = new AbortController();
		thread.queueController = controller;
		runtime.runControllers.set(thread.id, controller);
		runtime.threads.set(thread.id, thread);
		monitor.restoreRun({ id: 31, agent: "artisan", task: thread.task, status: "running" });
		const notifications: string[] = [];

		try {
			const response = await execute(tools.get("subagent_control")!, { action: "park", id: 31 }, notifications);

			assert.match(resultText(response), /parked run #31 \(artisan\) at a stable checkpoint/i);
			assert.match(resultText(response), /subagent_control resume/i);
			assert.deepEqual(stops, ["Parked by subagent_control at a stable checkpoint."]);
			assert.equal(thread.state, "parked");
			assert.equal(thread.lifecycleOperation, undefined);
			assert.equal(thread.queueController, undefined);
			assert.equal(runtime.runControllers.has(31), false);
			assert.equal(thread.sessionId, "session-31");
			assert.equal(monitor.findRun(31)?.status, "parked");
			assert.equal(notifications.length, 1);
			assert.match(notifications[0]!, /#31 .*parked/u);
			const record = (await readThreadRecords(configPath)).find((candidate) => candidate.runId === 31);
			assert.equal(record?.state, "parked");
			assert.equal(record?.generation, 3);
			assert.equal(record?.sessionDir, sessionDir);
			assert.deepEqual(record?.childPids, [], "a closed child's pid must not be persisted for a later kill");
		} finally {
			monitor.clear();
			await shutdown(runtime);
			await rm(root, { recursive: true, force: true });
		}
	});

	it("continues a parked thread with immutable phase identity and additive scope metadata", async () => {
		const { runtime, tools } = harness();
		const thread = makeThread(32, new RpcRunControl("Implement the original objective", 1), "parked");
		thread.sessionId = "session-32";
		thread.sessionDir = join(tmpdir(), "session-32");
		thread.phaseId = "original-phase";
		thread.scope = normalizePhaseScope({ paths: ["src"] }, thread.cwd);
		let resumed = 0;
		const metadata: Array<{ scope?: unknown } | undefined> = [];
		thread.resume = async (objective, _ctx, nextMetadata) => {
			resumed++;
			metadata.push(nextMetadata);
			return {
				agent: "artisan",
				task: objective ?? thread.task,
				exitCode: -1,
				messages: [],
				stderr: "",
				usage: emptyUsage(),
				runId: thread.id,
			};
		};
		runtime.threads.set(thread.id, thread);
		try {
			const control = tools.get("subagent_control")!;
			assert.equal(control.parameters?.properties?.phaseId, undefined);
			const inherited = await execute(control, { action: "resume", id: 32 });
			assert.match(resultText(inherited), /resumed run #32: continuing current objective/i);
			assert.deepEqual(metadata[0], { scope: undefined });
			const additionalScope = { symbols: [{ path: "src/parser.ts", name: "parse" }] };
			await execute(control, {
				action: "resume",
				id: 32,
				scope: additionalScope,
			});
			assert.deepEqual(metadata[1], { scope: additionalScope });
			assert.equal(thread.phaseId, "original-phase");
			assert.equal(resumed, 2);
		} finally {
			await shutdown(runtime);
		}
	});

	it("rejects threads without an active attempt or a retained session", async () => {
		const { runtime, tools } = harness();
		const noOpAttempt: AttemptControl = { steer: async () => undefined, stop: async () => undefined };
		let stopped = 0;
		const countingAttempt: AttemptControl = {
			steer: async () => undefined,
			stop: async () => {
				stopped++;
			},
		};

		runtime.threads.set(41, makeThread(41, new RpcRunControl("queued", 1), "queued"));

		const completed = new RpcRunControl("completed", 1);
		completed.markSettled();
		runtime.threads.set(42, makeThread(42, completed, "completed"));

		const parked = new RpcRunControl("parked", 1);
		runtime.threads.set(43, makeThread(43, parked, "parked"));

		const retired = new RpcRunControl("retired", 1);
		const retiredThread = makeThread(44, retired, "stopped");
		retiredThread.retired = true;
		runtime.threads.set(44, retiredThread);

		const sessionless = new RpcRunControl("sessionless", 1);
		attachRunning(sessionless, countingAttempt);
		runtime.threads.set(45, makeThread(45, sessionless));

		const resuming = new RpcRunControl("resuming", 1);
		attachRunning(resuming, noOpAttempt);
		const resumingThread = makeThread(46, resuming, "resuming");
		resumingThread.lifecycleOperation = "resume";
		runtime.threads.set(46, resumingThread);

		try {
			const controlTool = tools.get("subagent_control")!;
			const cases = [
				{ id: 40, expected: /no subagent thread matches run #40/i },
				{ id: 41, expected: /queued.*only an active running rpc attempt can be parked/i },
				{ id: 42, expected: /settled \(completed\).*can be parked/i },
				{ id: 43, expected: /parked.*can be parked/i },
				{ id: 44, expected: /retired.*cannot be parked/i },
				{ id: 45, expected: /no retained session yet/i },
				{ id: 46, expected: /resuming.*can be parked/i },
			];
			for (const testCase of cases) {
				const response = await execute(controlTool, { action: "park", id: testCase.id });
				assert.match(resultText(response), testCase.expected, `run #${testCase.id}`);
			}
			assert.equal(stopped, 0, "a rejected park never interrupts the child");
			for (const id of [41, 42, 43, 45, 46]) {
				assert.equal(runtime.threads.get(id)?.lifecycleOperation, id === 46 ? "resume" : undefined, `run #${id}`);
			}
		} finally {
			await shutdown(runtime);
		}
	});

	it("yields to a destructive stop that claims the thread while it is parking", async () => {
		const { runtime, tools } = harness();
		const releaseStop = deferred();
		const control = new RpcRunControl("Implement the original objective", 1);
		attachRunning(control, {
			steer: async () => undefined,
			stop: async () => {
				await releaseStop.promise;
			},
		});
		const thread = makeThread(51, control);
		thread.sessionId = "session-51";
		thread.sessionDir = join(tmpdir(), "session-51");
		runtime.threads.set(thread.id, thread);

		try {
			const parking = execute(tools.get("subagent_control")!, { action: "park", id: 51 });
			await new Promise<void>((resolve) => setImmediate(resolve));
			assert.equal(thread.lifecycleOperation, "park");
			// A concurrent destructive stop supersedes the park claim.
			thread.lifecycleVersion++;
			thread.lifecycleOperation = "stop";
			thread.retired = true;
			thread.state = "stopped";
			releaseStop.resolve();

			const response = await parking;
			assert.match(resultText(response), /changed while it was being parked/i);
			assert.equal(thread.state, "stopped");
			assert.equal(thread.lifecycleOperation, "stop");
		} finally {
			await shutdown(runtime);
		}
	});
});
