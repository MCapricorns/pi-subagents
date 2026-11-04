import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SubagentsConfig } from "../src/configuration/config.ts";
import { isWriteCapableAgent, loadBuiltinAgents, type AgentConfig } from "../src/delegation/agents.ts";
import { defaultIsolationMode } from "../src/delegation/dispatch.ts";
import { createRuntime, type SubagentThread } from "../src/lifecycle/runtime.ts";
import { findDuplicateDispatch, type PhaseLeaseSource } from "../src/delegation/prompt.ts";
import { buildResumePrompt } from "../src/execution/spawn.ts";
import { createBackgroundDispatcher } from "../src/lifecycle/thread-lifecycle.ts";
import { monitor } from "../src/presentation/monitor.ts";

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
	return source({ state: "completed", ...partial });
}

function dispatcher(threads: PhaseLeaseSource[]) {
	const pi = {
		on: () => undefined,
		getActiveTools: () => ["read", "write"],
		getAllTools: () => [],
		sendMessage: () => undefined,
	} as unknown as ExtensionAPI;
	const runtime = createRuntime(pi, `${process.cwd()}/.pi-test/config.json`);
	for (const thread of threads) runtime.threads.set(thread.id, thread as unknown as SubagentThread);
	const artisan: AgentConfig = {
		name: "artisan",
		description: "implementation",
		systemPrompt: "body",
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
	});
	return { runtime, start };
}

describe("isolation policy", () => {
	it("keeps the lightweight reader on the shared checkout", () => {
		const scout = loadBuiltinAgents().find((agent) => agent.name === "scout");
		assert.ok(scout);
		assert.equal(isWriteCapableAgent(scout), false);
		assert.equal(defaultIsolationMode(scout.name), "shared");
	});
});

describe("fresh write capability", () => {
	it("rejects explicit scout worktree isolation before allocation", async () => {
		const scout = loadBuiltinAgents().find((agent) => agent.name === "scout");
		assert.ok(scout);
		const pi = {
			on: () => undefined,
			getActiveTools: () => ["read", "grep", "bash"],
			getAllTools: () => [],
			sendMessage: () => undefined,
		} as unknown as ExtensionAPI;
		const runtime = createRuntime(pi, `${process.cwd()}/.pi-test/config.json`);
		const start = createBackgroundDispatcher({
			runtime,
			getEnvironment: () => ({
				ctx: { cwd: process.cwd() } as ExtensionContext,
				config: {} as SubagentsConfig,
				agents: [scout],
			}),
			finishRun: () => undefined,
			makeLiveHandler: () => () => undefined,
		});
		try {
			const result = await start("scout", "Map the dispatch path", process.cwd(), "worktree");
			assert.equal(result.exitCode, 1);
			assert.match(result.errorMessage ?? result.stderr, /worktree isolation/i);
			assert.equal(runtime.threads.size, 0);
		} finally {
			await runtime.shutdown();
			monitor.clear();
		}
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
		for (const state of ["queued", "running", "interrupting", "parked"] as const) {
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

	it("keeps a finished phase owned without relying on a retained session", () => {
		for (const state of ["completed", "failed"] as const) {
			const duplicate = findDuplicateDispatch([settledSource({ state })], "Trace dispatch ownership", process.cwd());
			assert.equal(duplicate?.kind, "settled", state);
		}
		assert.equal(
			findDuplicateDispatch([settledSource({ retired: true })], "Trace dispatch ownership", process.cwd()),
			undefined,
		);
		assert.equal(
			findDuplicateDispatch([source({ state: "completed" })], "Trace dispatch ownership", process.cwd())?.kind,
			"settled",
			"a completed one-shot phase stays owned even without a retained session",
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
		assert.match(result.errorMessage ?? "", /Run #41 \(scout\).*phase \(running\)/u);
		assert.equal(runtime.threads.size, 1);
		assert.equal(runtime.runControllers.size, 0);
	});

	it("rejects re-running a finished brief and points at the retained thread", async () => {
		const { runtime, start } = dispatcher([settledSource()]);
		const result = await start("artisan", "Trace dispatch ownership", process.cwd());
		assert.equal(result.exitCode, 1);
		assert.match(result.errorMessage ?? "", /Run #41 \(scout\).*phase \(completed\)/u);
		assert.match(result.errorMessage ?? "", /subagent_status.*subagent_message/u);
		assert.doesNotMatch(result.errorMessage ?? "", /resume|steer|park/iu);
		assert.equal(runtime.threads.size, 1);
		assert.equal(runtime.runControllers.size, 0);
	});

	it("tells callers to wait for a stopping owner instead of stopping it again", async () => {
		const { start } = dispatcher([source({ state: "stopped", retired: true, lifecycleOperation: "stop" })]);
		const result = await start("artisan", "Trace dispatch ownership", process.cwd(), "shared");
		assert.equal(result.exitCode, 1);
		assert.match(result.errorMessage ?? "", /still stopping; dispatch the phase again after the stop finishes/u);
		assert.doesNotMatch(result.errorMessage ?? "", /subagent_stop/u);
	});

	it("gives interrupted owners a schema-valid retirement command", async () => {
		const { start } = dispatcher([source({ state: "parked" })]);
		const result = await start("artisan", "Trace dispatch ownership", process.cwd(), "shared");
		assert.equal(result.exitCode, 1);
		const remedy = result.errorMessage ?? "";
		assert.match(remedy, /subagent_stop\(\{ id: "41" \}\)/u);
	});

	it("rejects duplicate tasks inside a parallel batch before allocating any run", async () => {
		const { registerSubagentTool } = await import("../src/delegation/dispatch.ts");
		let tool: any;
		const pi = {
			on: () => undefined,
			getActiveTools: () => ["read", "write"],
			getAllTools: () => [],
			registerTool: (value: any) => { tool = value; },
			sendMessage: () => undefined,
		} as unknown as ExtensionAPI;
		const runtime = createRuntime(pi, `${process.cwd()}/.pi-test/config.json`);
		registerSubagentTool(pi, runtime);
		try {
			await assert.rejects(
				tool.execute("call-1", {
					tasks: [
						{ agent: "scout", task: "Exact duplicate" },
						{ agent: "artisan", task: "  Exact   duplicate  " },
					],
				}, new AbortController().signal, () => undefined, {
					cwd: process.cwd(),
					modelRegistry: { getAvailable: () => [] },
					ui: { notify: () => undefined },
				}),
				/parallel admission.*duplicate.*tasks\[0\].*tasks\[1\]/i,
			);
			assert.equal(runtime.threads.size, 0);
		} finally {
			await runtime.shutdown();
			monitor.clear();
		}
	});
});

describe("internal model handoff prompts", () => {
	it("keeps retained work while guarding against a changed workspace", () => {
		const prompt = buildResumePrompt("Fix the cache race", "the selected model failed");
		assert.match(prompt, /resuming an earlier sub-agent session after the selected model failed/u);
		assert.match(prompt, /Reuse relevant completed work and checks/u);
		assert.match(prompt, /current objective below takes precedence over earlier task requests/u);
		assert.match(prompt, /preserve earlier constraints unless it changes them/u);
		assert.match(prompt, /workspace may have changed.*re-read it unless you read it during this continuation/u);
		assert.match(prompt, /\n\nCurrent objective:\nFix the cache race\n\nComplete the remaining work for this objective/u);
		assert.match(prompt, /result-only handoff/u);
	});

	it("keeps a multi-line objective intact without doubling its final period", () => {
		const prompt = buildResumePrompt("Fix the cache race.\n- keep the API stable.\n", "a handoff");
		assert.match(prompt, /Current objective:\nFix the cache race\.\n- keep the API stable\.\n\nComplete the remaining work/u);
		assert.doesNotMatch(prompt, /\.\./u);
	});
});
