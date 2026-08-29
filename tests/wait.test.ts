/**
 * subagent_wait: the event-driven in-turn wait for runs that were already
 * dispatched. The contract under test is "returns the moment a run settles" —
 * there is no timer to expire, so a waiter that misses its settle event hangs
 * the test instead of passing late.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import register from "../src/index.ts";
import { monitor } from "../src/monitor.ts";
import {
	captureEnqueue,
	executionContext,
	fakeChild,
	makeStub,
	runTool,
	shutdownExtension,
	waitFor,
} from "./test-helpers.ts";

let savedDepth: string | undefined;
let savedAgentDir: string | undefined;
let testAgentDir: string | undefined;

beforeEach(() => {
	savedDepth = process.env.PI_SUBAGENT_DEPTH;
	savedAgentDir = process.env.PI_CODING_AGENT_DIR;
	delete process.env.PI_SUBAGENT_DEPTH;
	testAgentDir = mkdtempSync(join(tmpdir(), "pi-subagents-wait-"));
	process.env.PI_CODING_AGENT_DIR = testAgentDir;
	writeFileSync(join(testAgentDir, "pi-subagents.json"), JSON.stringify({
		enabledAgents: ["worker"],
		announcedFeatures: ["cleanerDefaulted", "documenterDefaulted"],
	}), "utf8");
});

afterEach(() => {
	vi.restoreAllMocks();
	for (const run of [...monitor.getRuns()]) monitor.removeRun(run.id);
	if (savedDepth === undefined) delete process.env.PI_SUBAGENT_DEPTH;
	else process.env.PI_SUBAGENT_DEPTH = savedDepth;
	if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
	if (testAgentDir) rmSync(testAgentDir, { recursive: true, force: true });
	testAgentDir = undefined;
});

const WORKER_PAYLOAD = `send({
	type: "message_end",
	message: {
		role: "assistant",
		content: [{ type: "text", text: "worker result payload" }],
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 }, totalTokens: 0 },
		stopReason: "stop"
	}
});`;

describe("subagent_wait", () => {
	it("resolves the moment a running run settles, not on a timer", async () => {
		const stub = makeStub();
		const { tasks: capturedTasks, controllers } = captureEnqueue();
		const restoreChild = fakeChild(WORKER_PAYLOAD);
		try {
			register(stub.api);
			const dispatch = stub.tools.find((t: any) => t.name === "subagent");
			const wait = stub.tools.find((t: any) => t.name === "subagent_wait");

			await runTool(dispatch, "call-d", { agent: "worker", task: "Fix the build" }, executionContext());
			await waitFor(() => capturedTasks.length === 1);
			const runId = monitor.getRuns()[0]!.id;

			// Block on the already-dispatched run, then let it settle.
			const pending = runTool(wait, "call-w", { id: String(runId) }, executionContext());
			await capturedTasks[0]!(controllers[0]!.signal, controllers[0]!);
			const waited = await pending;

			expect(waited.content[0].text).toContain("### [worker] completed");
			expect(waited.content[0].text).toContain("worker result payload");
		} finally {
			restoreChild();
			await shutdownExtension(stub, { controllers });
		}
	});

	it("returns an already-settled result immediately", async () => {
		const stub = makeStub();
		const { tasks: capturedTasks, controllers } = captureEnqueue();
		const restoreChild = fakeChild(WORKER_PAYLOAD);
		try {
			register(stub.api);
			const dispatch = stub.tools.find((t: any) => t.name === "subagent");
			const wait = stub.tools.find((t: any) => t.name === "subagent_wait");

			await runTool(dispatch, "call-d", { agent: "worker", task: "Fix the build" }, executionContext());
			await waitFor(() => capturedTasks.length === 1);
			const runId = monitor.getRuns()[0]!.id;
			await capturedTasks[0]!(controllers[0]!.signal, controllers[0]!);

			const waited = await runTool(wait, "call-w", { id: String(runId) }, executionContext());
			expect(waited.content[0].text).toContain("### [worker] completed");
			expect(waited.content[0].text).toContain("worker result payload");
		} finally {
			restoreChild();
			await shutdownExtension(stub, { controllers });
		}
	});

	it("answers a parked run immediately with its resume handle", async () => {
		const stub = makeStub();
		const { controllers } = captureEnqueue();
		try {
			register(stub.api);
			const dispatch = stub.tools.find((t: any) => t.name === "subagent");
			const wait = stub.tools.find((t: any) => t.name === "subagent_wait");

			await runTool(dispatch, "call-d", { agent: "worker", task: "Long task" }, executionContext());
			const runId = monitor.getRuns()[0]!.id;
			monitor.setStatus(runId, "parked");

			const waited = await runTool(wait, "call-w", { id: String(runId) }, executionContext());
			expect(waited.content[0].text).toContain(`run #${runId} is parked`);
			expect(waited.content[0].text).toContain("subagent_control resume");
		} finally {
			await shutdownExtension(stub, { controllers });
		}
	});

	it("reports when nothing matches instead of blocking", async () => {
		const stub = makeStub();
		const { controllers } = captureEnqueue();
		try {
			register(stub.api);
			const dispatch = stub.tools.find((t: any) => t.name === "subagent");
			const wait = stub.tools.find((t: any) => t.name === "subagent_wait");

			const idle = await runTool(wait, "call-w0", {}, executionContext());
			expect(idle.content[0].text).toContain("No active subagent runs to wait for.");

			await runTool(dispatch, "call-d", { agent: "worker", task: "Long task" }, executionContext());
			const runId = monitor.getRuns()[0]!.id;
			const missed = await runTool(wait, "call-w1", { id: "9999" }, executionContext());
			expect(missed.content[0].text).toContain('No subagent run matches "9999"');
			expect(missed.content[0].text).toContain(`#${runId}`);
		} finally {
			await shutdownExtension(stub, { controllers });
		}
	});

	it("resolves with a note when the calling turn aborts", async () => {
		const stub = makeStub();
		const { tasks: capturedTasks, controllers } = captureEnqueue();
		try {
			register(stub.api);
			const dispatch = stub.tools.find((t: any) => t.name === "subagent");
			const wait = stub.tools.find((t: any) => t.name === "subagent_wait");

			await runTool(dispatch, "call-d", { agent: "worker", task: "Long task" }, executionContext());
			await waitFor(() => capturedTasks.length === 1);
			const runId = monitor.getRuns()[0]!.id;

			const midWait = new AbortController();
			const pending = wait.execute("call-w", { id: String(runId) }, midWait.signal, () => {}, executionContext());
			midWait.abort();
			const aborted = await pending;
			expect(aborted.content[0].text).toContain("wait aborted");
		} finally {
			await shutdownExtension(stub, { controllers });
		}
	});
});
