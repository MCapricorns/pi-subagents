import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadBuiltinAgents, type AgentConfig } from "../src/delegation/agents.ts";
import type { SubagentsConfig } from "../src/configuration/config.ts";
import { defaultIsolationMode, isWorktreeCapableAgent } from "../src/delegation/dispatch.ts";
import { createRuntime, type SubagentThread } from "../src/lifecycle/runtime.ts";
import { findDuplicateDispatch, type PhaseLeaseSource } from "../src/delegation/prompt.ts";
import { buildAppendedObjectivePrompt, buildResumePrompt } from "../src/execution/spawn.ts";
import { createBackgroundDispatcher } from "../src/lifecycle/thread-lifecycle.ts";

function source(partial: Partial<PhaseLeaseSource> = {}): PhaseLeaseSource {
	return {
		id: 41,
		agentName: "scout",
		task: "Trace dispatch ownership",
		cwd: process.cwd(),
		state: "running",
		...partial,
	};
}

function settledSource(partial: Partial<PhaseLeaseSource> = {}): PhaseLeaseSource {
	return source({ state: "completed", sessionId: "session-41", sessionDir: "/sessions/41", ...partial });
}

function dispatcher(threads: PhaseLeaseSource[]) {
	const pi = {
		on: () => undefined,
		getActiveTools: () => ["read", "write"],
		sendMessage: () => undefined,
	} as unknown as ExtensionAPI;
	const runtime = createRuntime(pi, `${process.cwd()}/.pi-test/config.json`);
	for (const thread of threads) runtime.threads.set(thread.id, thread as unknown as SubagentThread);
	const artisan: AgentConfig = {
		name: "artisan",
		description: "implementation",
		systemPrompt: "body",
		source: "builtin",
		filePath: "/agents/artisan.md",
	};
	const start = createBackgroundDispatcher({
		runtime,
		getEnvironment: () => ({
			ctx: { cwd: process.cwd() } as ExtensionContext,
			config: {} as SubagentsConfig,
			agents: [artisan],
		}),
		finishRun: () => undefined,
		makeLiveHandler: () => () => undefined,
		makeDetails: (mode, background = false) => (results) => ({ mode, background, results }),
	});
	return { runtime, start };
}

describe("isolation policy", () => {
	it("keeps sentinel on the shared checkout whose uncommitted diff it reviews", () => {
		const sentinel = loadBuiltinAgents().find((agent) => agent.name === "sentinel");
		assert.ok(sentinel);
		assert.equal(isWorktreeCapableAgent(sentinel), false);
		assert.equal(
			defaultIsolationMode("parallel", sentinel.name, undefined, isWorktreeCapableAgent(sentinel), sentinel.isolation),
			"shared",
		);
	});
});

describe("duplicate dispatch", () => {
	it("matches normalized task and resolved cwd across agents without fuzzy matching", () => {
		const active = [source()];
		assert.equal(
			findDuplicateDispatch(active, "  Trace   dispatch\nownership  ", `${process.cwd()}/child/..`)?.source.id,
			41,
		);
		assert.equal(findDuplicateDispatch(active, "Trace dispatch phase ownership", process.cwd()), undefined);
	});

	it("treats every live, parked, and settling state as an active lease", () => {
		for (const state of ["queued", "resuming", "running", "interrupting", "parked"] as const) {
			const duplicate = findDuplicateDispatch([source({ state })], "Trace dispatch ownership", process.cwd());
			assert.equal(duplicate?.kind, "active", state);
			assert.equal(duplicate?.source.id, 41, state);
		}
		assert.equal(
			findDuplicateDispatch(
				[source({ state: "completed", lifecycleOperation: "settle" })],
				"Trace dispatch ownership",
				process.cwd(),
			)?.kind,
			"active",
		);
	});

	it("reports a finished thread with retained context as a settled duplicate", () => {
		for (const state of ["completed", "failed"] as const) {
			const duplicate = findDuplicateDispatch([settledSource({ state })], "Trace dispatch ownership", process.cwd());
			assert.equal(duplicate?.kind, "settled", state);
		}
		assert.equal(
			findDuplicateDispatch([settledSource({ retired: true })], "Trace dispatch ownership", process.cwd()),
			undefined,
		);
		assert.equal(
			findDuplicateDispatch([source({ state: "completed" })], "Trace dispatch ownership", process.cwd()),
			undefined,
			"a settled thread without a retained session is not worth resuming",
		);
		assert.equal(
			findDuplicateDispatch([settledSource({ state: "stopped" })], "Trace dispatch ownership", process.cwd()),
			undefined,
		);
	});

	it("prefers the active lease when both an active and a settled match exist", () => {
		const duplicate = findDuplicateDispatch(
			[settledSource({ id: 40 }), source({ id: 42 })],
			"Trace dispatch ownership",
			process.cwd(),
		);
		assert.equal(duplicate?.kind, "active");
		assert.equal(duplicate?.source.id, 42);
	});

	it("rejects the fresh duplicate of an active run before allocating another", async () => {
		const { runtime, start } = dispatcher([source()]);
		const result = await start("artisan", " Trace   dispatch ownership ", `${process.cwd()}/child/..`);
		assert.equal(result.exitCode, 1);
		assert.match(result.errorMessage ?? "", /matches run #41 \(scout\)/u);
		assert.equal(runtime.threads.size, 1);
		assert.equal(runtime.runControllers.size, 0);
	});

	it("rejects re-running a finished brief and points at the retained thread", async () => {
		const { runtime, start } = dispatcher([settledSource()]);
		const result = await start("artisan", "Trace dispatch ownership", process.cwd());
		assert.equal(result.exitCode, 1);
		assert.match(result.errorMessage ?? "", /Run #41 \(scout\) already completed this exact brief/u);
		assert.match(result.errorMessage ?? "", /Resume #41 with an appended objective/u);
		assert.match(result.errorMessage ?? "", /restate the brief with what changed/u);
		assert.equal(runtime.threads.size, 1);
		assert.equal(runtime.runControllers.size, 0);
	});
});

describe("resume prompts", () => {
	it("keeps retained work while guarding against a changed workspace", () => {
		const prompt = buildResumePrompt("Fix the cache race", "the retained thread was resumed");
		assert.match(prompt, /resuming an earlier sub-agent session after the retained thread was resumed/u);
		assert.match(prompt, /Do not redo searches, reads, or edits that already succeeded/u);
		assert.match(prompt, /workspace may have changed.*re-read it unless you read it during this continuation/u);
		assert.match(prompt, /Current objective: Fix the cache race/u);
		assert.match(prompt, /result-only handoff/u);
	});

	it("frames an appended objective as a continuation of the same thread", () => {
		const prompt = buildAppendedObjectivePrompt("Fix the cache race", "Also cover the eviction path");
		assert.match(prompt, /Previous objective: Fix the cache race/u);
		assert.match(prompt, /Appended objective: Also cover the eviction path/u);
		assert.match(prompt, /without restarting from scratch/u);
		assert.match(prompt, /re-read it unless you read it during this continuation/u);
	});
});
