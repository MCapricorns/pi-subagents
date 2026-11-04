import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { RunControl } from "../src/execution/run-control.ts";
import { createRuntime, type SubagentThread } from "../src/lifecycle/runtime.ts";
import { registerLookupTools } from "../src/lifecycle/tools.ts";
import { cancelActiveWork, registerCancellationHooks } from "../src/lifecycle/cancellation.ts";
import { monitor } from "../src/presentation/monitor.ts";

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => { resolve = done; });
	return { promise, resolve };
}

async function harness() {
	const root = await mkdtemp(join(tmpdir(), "pi-subagents-cancel-"));
	const events = new Map<string, (event: any) => Promise<void> | void>();
	const sent: Array<{ message: any; options: any }> = [];
	const pi = {
		on: (event: string, handler: (event: any) => Promise<void> | void) => events.set(event, handler),
		getActiveTools: () => [], getAllTools: () => [], sendMessage: (message: unknown, options: unknown) => sent.push({ message, options }),
	} as unknown as ExtensionAPI;
	const runtime = createRuntime(pi, join(root, "config.json"));
	registerCancellationHooks(pi, runtime);
	const cleanupEntered = deferred();
	const cleanupRelease = deferred();
	let finalized = false;
	const id = monitor.addRun("artisan", "Apply change");
	const thread: SubagentThread = {
		id, generation: 1, agentName: "artisan", task: "Apply change", cwd: root, executionCwd: root, isolation: "shared", state: "running",
		control: new RunControl("Apply change", 1), lifecycleVersion: 0, elapsedMs: 0, generationCompletion: Promise.resolve(),
		finalizeIsolation: async (_generation, result) => {
			cleanupEntered.resolve();
			await cleanupRelease.promise;
			finalized = true;
			if (result) result.integrationStatus = "integrated";
			return { status: "integrated", integrated: true, hadChanges: true };
		},
	};
	runtime.threads.set(id, thread);
	return { root, pi, runtime, thread, events, sent, cleanupEntered, cleanupRelease, finalized: () => finalized };
}

describe("parent cancellation", () => {
	for (const event of ["agent_settled", "session_before_tree"]) {
		it("stops abandoned work without waking the parent on " + event, async () => {
			const h = await harness();
			try {
				if (event === "agent_settled") {
					await h.events.get(event)!({ aborted: false });
					assert.equal(h.thread.state, "running", "normal parent settlement leaves background work alive");
				}
				const stopping = h.events.get(event)!({ aborted: true });
				await h.cleanupEntered.promise;
				h.cleanupRelease.resolve();
				await stopping;
				h.runtime.completionBatcher.flush();
				assert.equal(h.thread.state, "stopped");
				assert.equal(h.finalized(), true);
				assert.equal(h.sent.length, event === "agent_settled" ? 1 : 0);
				if (event === "agent_settled") {
					assert.equal(h.sent[0]!.message.customType, "subagent-cancelled");
					assert.match(h.sent[0]!.message.content, /already cancelled; no further subagent_stop is needed/u);
					assert.deepEqual(h.sent[0]!.message.details.runIds, [h.thread.id]);
					assert.deepEqual(h.sent[0]!.options, { deliverAs: "nextTurn", triggerTurn: false });
					await h.events.get(event)!({ aborted: true });
					assert.equal(h.sent.length, 1, "repeated Escape must not duplicate the receipt");
				}
				assert.equal(h.runtime.suppressCompletions, false);
			} finally { h.cleanupRelease.resolve(); await h.runtime.shutdown(); await rm(h.root, { recursive: true, force: true }); }
		});
	}

	it("records cancellation performed by an awaited tool before the settled hook", async () => {
		const h = await harness();
		try {
			h.cleanupRelease.resolve();
			await cancelActiveWork(h.runtime, "Parent run was cancelled.");
			assert.equal(h.sent.length, 1);
			assert.match(h.sent[0]!.message.content, /no further subagent_stop is needed/u);
			await h.events.get("agent_settled")!({ aborted: true });
			assert.equal(h.sent.length, 1, "the settled hook must not lose or duplicate the receipt");
		} finally { h.cleanupRelease.resolve(); await h.runtime.shutdown(); await rm(h.root, { recursive: true, force: true }); }
	});

	it("stop-all interrupts active writers and finalizes isolation", { timeout: 5_000 }, async () => {
		const h = await harness();
		try {
			let stoppedWriter = false;
			const id = monitor.addRun("artisan", "Unrelated shared writer");
			const control = new RunControl("Unrelated shared writer", 1);
			const token = control.beginAttempt();
			control.attach(token, { stop: async () => { stoppedWriter = true; h.cleanupRelease.resolve(); } });
			h.runtime.threads.set(id, { id, generation: 1, agentName: "artisan", task: "Unrelated shared writer", cwd: h.root, executionCwd: h.root, isolation: "shared", state: "running", control, lifecycleVersion: 0, elapsedMs: 0, generationCompletion: Promise.resolve(), finalizeIsolation: async () => undefined });
			let stopTool: any;
			registerLookupTools({ ...h.pi, registerTool: (tool: any) => { if (tool.name === "subagent_stop") stopTool = tool; } } as ExtensionAPI, h.runtime);
			await stopTool.execute("stop-all", { all: true }, undefined, undefined, { cwd: h.root });
			assert.equal(stoppedWriter, true);
			assert.equal(h.finalized(), true);
		} finally { h.cleanupRelease.resolve(); await h.runtime.shutdown(); await rm(h.root, { recursive: true, force: true }); }
	});

	it("ends old-session work without delivery on new-session shutdown", async () => {
		const h = await harness();
		try {
			h.cleanupRelease.resolve();
			await h.runtime.shutdown();
			assert.equal(h.sent.length, 0);
			assert.equal(h.runtime.threads.size, 0);
		} finally { h.cleanupRelease.resolve(); await h.runtime.shutdown(); await rm(h.root, { recursive: true, force: true }); }
	});
});
