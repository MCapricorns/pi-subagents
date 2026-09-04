import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
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
import { createRuntime, type SubagentRuntime, type SubagentThread, type ThreadState } from "../src/lifecycle/runtime.ts";
import { registerLookupTools } from "../src/lifecycle/tools.ts";

type RegisteredTool = {
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
): Promise<any> {
	return tool.execute("call-1", params, new AbortController().signal, () => undefined, { cwd: process.cwd() });
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

	it("precisely rejects threads that are not an active running RPC attempt", async () => {
		const { runtime, tools } = harness();
		const noOpAttempt: AttemptControl = { steer: async () => undefined, stop: async () => undefined };

		const parked = new RpcRunControl("parked", 1);
		attachRunning(parked, noOpAttempt);
		runtime.threads.set(11, makeThread(11, parked, "parked"));

		const settled = new RpcRunControl("settled", 1);
		settled.markSettled();
		runtime.threads.set(12, makeThread(12, settled, "completed"));

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
				{ id: 11, expected: /parked.*only.*running/i },
				{ id: 12, expected: /settled.*completed.*only.*running/i },
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
