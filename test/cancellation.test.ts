import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { emptyUsage, RunControl } from "../src/execution/run-control.ts";
import { CANCELLATION_STATS_ENTRY, createRuntime, type SubagentThread } from "../src/lifecycle/runtime.ts";
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
	const events = new Map<string, (event: any, context?: ExtensionContext) => Promise<void> | void>();
	const sent: Array<{ message: any; options: any }> = [];
	const notices: string[] = [];
	const entries: Array<{ type: string; stats: string[] }> = [];
	const tui = { mode: "tui", ui: { notify: (text: string) => notices.push(text) } } as unknown as ExtensionContext;
	const pi = {
		on: (event: string, handler: (event: any, context?: ExtensionContext) => Promise<void> | void) => events.set(event, handler),
		getActiveTools: () => [], getAllTools: () => [], sendMessage: (message: unknown, options: unknown) => sent.push({ message, options }),
		registerEntryRenderer() {},
		appendEntry: (type: string, stats: string[]) => entries.push({ type, stats }),
	} as unknown as ExtensionAPI;
	const runtime = createRuntime(pi, join(root, "config.json"));
	registerCancellationHooks(pi, runtime);
	const cleanupEntered = deferred();
	const cleanupRelease = deferred();
	let finalized = false;
	const id = monitor.addRun("worker", "Apply change");
	const thread: SubagentThread = {
		id, generation: 1, agentName: "worker", task: "Apply change", cwd: root, executionCwd: root, isolation: "shared", state: "running",
		control: new RunControl("Apply change"), lifecycleVersion: 0, elapsedMs: 0, generationCompletion: Promise.resolve(),
		finalizeIsolation: async (_generation, result) => {
			cleanupEntered.resolve();
			await cleanupRelease.promise;
			finalized = true;
			if (result) result.integrationStatus = "integrated";
			return { status: "integrated", integrated: true, hadChanges: true };
		},
	};
	runtime.threads.set(id, thread);
	return { root, pi, runtime, thread, events, sent, notices, entries, tui, cleanupEntered, cleanupRelease, finalized: () => finalized };
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
				const stopping = h.events.get(event)!({ aborted: true }, event === "session_before_tree" ? h.tui : undefined);
				await h.cleanupEntered.promise;
				h.cleanupRelease.resolve();
				await stopping;
				h.runtime.completionBatcher.flush();
				assert.equal(h.thread.state, "stopped");
				assert.equal(h.finalized(), true);
				assert.equal(h.sent.length, event === "agent_settled" ? 1 : 0);
				assert.deepEqual(h.notices, [], "branch navigation leaves no cancellation notice");
				assert.deepEqual(h.entries, []);
				if (event === "agent_settled") {
					assert.equal(h.sent[0]!.message.customType, "subagent-cancelled");
					assert.equal(h.sent[0]!.message.display, true, "the non-TUI receipt stays visible");
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

	it("shows terminal cancellation progress and final stats without waiting for another prompt", async (t) => {
		const h = await harness();
		try {
			let now = Date.now();
			t.mock.method(Date, "now", () => now);
			monitor.setStatus(h.thread.id, "running");
			const usage = { ...emptyUsage(), turns: 1, input: 120, output: 25, cost: 0.004 };
			monitor.setUsage(h.thread.id, usage, "test/worker");
			const otherId = monitor.addRun("researcher", "Check current behavior");
			monitor.setStatus(otherId, "running");
			const other: SubagentThread = {
				...h.thread, id: otherId, agentName: "researcher", task: "Check current behavior",
				control: new RunControl("Check current behavior"), finalizeIsolation: async () => undefined,
			};
			h.runtime.threads.set(otherId, other);
			now += 4_000;
			const stopping = h.events.get("agent_settled")!({ aborted: true }, h.tui);
			await h.cleanupEntered.promise;
			assert.deepEqual(h.notices, [`Stopping 2 subagent runs · #${h.thread.id}, #${otherId}`]);
			assert.equal(h.entries.length, 0);
			assert.equal(h.sent.length, 0);
			now += 15_000;
			h.cleanupRelease.resolve();
			await stopping;
			assert.equal(h.entries[0]?.type, CANCELLATION_STATS_ENTRY);
			const summary = h.entries[0]!.stats.join("\n");
			assert.match(summary, /^Stopped 2 subagent runs\n#\d+ worker · 4s · test\/worker · 1 turn ↑120 ↓25 \$0\.0040/u);
			assert.match(summary, /#\d+ researcher · 4s$/u);
			assert.equal(h.thread.elapsedMs, 4_000);
			assert.equal(other.elapsedMs, 4_000, "a sibling's integration time is excluded from child elapsed time");
			assert.deepEqual(h.runtime.settledRuns.get(h.thread.id)?.usage, usage);
			assert.equal(h.sent.length, 1);
			assert.equal(h.sent[0]!.message.display, false, "the visible receipt was already rendered");
			assert.deepEqual(h.sent[0]!.options, { deliverAs: "nextTurn", triggerTurn: false });
			await h.events.get("agent_settled")!({ aborted: true }, h.tui);
			assert.equal(h.entries.length, 1, "repeated Escape must not duplicate terminal stats");
			assert.equal(h.sent.length, 1);
		} finally { h.cleanupRelease.resolve(); await h.runtime.shutdown(); await rm(h.root, { recursive: true, force: true }); }
	});

	it("records cancellation performed by an awaited tool before the settled hook", async () => {
		const h = await harness();
		try {
			h.cleanupRelease.resolve();
			await cancelActiveWork(h.runtime, "Parent run was cancelled.", { context: h.tui });
			assert.equal(h.sent.length, 1);
			assert.match(h.sent[0]!.message.content, /no further subagent_stop is needed/u);
			assert.equal(h.entries[0]?.stats[0], "Stopped 1 subagent run");
			await h.events.get("agent_settled")!({ aborted: true }, h.tui);
			assert.equal(h.sent.length, 1, "the settled hook must not lose or duplicate the receipt");
			assert.equal(h.entries.length, 1);
		} finally { h.cleanupRelease.resolve(); await h.runtime.shutdown(); await rm(h.root, { recursive: true, force: true }); }
	});

	it("stop-all interrupts active writers and finalizes isolation", { timeout: 5_000 }, async () => {
		const h = await harness();
		try {
			let stoppedWriter = false;
			const id = monitor.addRun("worker", "Unrelated shared writer");
			const control = new RunControl("Unrelated shared writer");
			const token = control.beginAttempt();
			control.attach(token, { stop: async () => { stoppedWriter = true; h.cleanupRelease.resolve(); } });
			h.runtime.threads.set(id, { id, generation: 1, agentName: "worker", task: "Unrelated shared writer", cwd: h.root, executionCwd: h.root, isolation: "shared", state: "running", control, lifecycleVersion: 0, elapsedMs: 0, generationCompletion: Promise.resolve(), finalizeIsolation: async () => undefined });
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

describe("run control stop", () => {
	it("stays stopped when the child spawns after a stop found no attempt", async () => {
		const phases: string[] = [];
		const control = new RunControl("Late spawn", (phase) => phases.push(phase));
		await control.stop("Stopped by subagent_stop.");
		// The cli-run sequence for a child spawned during its pre-spawn awaits.
		const token = control.beginAttempt();
		const attempt = { stop: async () => { control.updateAttemptPhase(token, "interrupting"); } };
		control.attach(token, attempt);
		control.markStarting();
		assert.equal(control.isStopRequested(), true);
		await attempt.stop();
		control.detach(token);
		control.markSettled();
		assert.equal(control.getPhase(), "stopped");
		assert.deepEqual(phases, ["stopped"]);
	});
});
