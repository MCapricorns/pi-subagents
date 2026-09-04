import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_CONFIG, type SubagentsConfig } from "../src/configuration/config.ts";
import { discoverAgents, loadBuiltinAgents, type AgentConfig } from "../src/delegation/agents.ts";
import { normalizePhaseScope } from "../src/delegation/phase-scope.ts";
import { defaultIsolationMode, isWorktreeCapableAgent } from "../src/delegation/dispatch.ts";
import { createRuntime, type SubagentThread } from "../src/lifecycle/runtime.ts";
import { findDuplicateDispatch, type PhaseLeaseSource } from "../src/delegation/prompt.ts";
import { buildAppendedObjectivePrompt, buildResumePrompt } from "../src/execution/spawn.ts";
import { createBackgroundDispatcher } from "../src/lifecycle/thread-lifecycle.ts";
import { monitor } from "../src/presentation/monitor.ts";

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolvePromise!: () => void;
	const promise = new Promise<void>((resolve) => {
		resolvePromise = resolve;
	});
	return { promise, resolve: resolvePromise };
}

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

describe("fresh write capability", () => {
	it("does not let a false writeCapable hint skip writer scope admission", async () => {
		const { runtime, start } = dispatcher([]);
		runtime.threads.set(41, {
			...source({ id: 41, agentName: "artisan", task: "Existing src writer", phaseId: "existing-src" }),
			scope: normalizePhaseScope({ paths: ["src"] }, process.cwd()),
			writeCapable: true,
		} as unknown as SubagentThread);
		const result = await start("artisan", "Another writer", process.cwd(), "shared", {
			writeCapable: false,
			phaseId: "other-phase",
			scope: { paths: ["src/file.ts"] },
		});
		assert.equal(result.exitCode, 1);
		assert.match(result.errorMessage ?? result.stderr, /scope.*run #41/i);
		assert.equal(runtime.threads.size, 1);
		assert.equal(runtime.runControllers.size, 0);
	});

	it("rejects explicit sentinel worktree isolation before allocation", async () => {
		const sentinel = loadBuiltinAgents().find((agent) => agent.name === "sentinel");
		assert.ok(sentinel);
		const pi = {
			on: () => undefined,
			getActiveTools: () => ["read", "grep", "bash"],
			sendMessage: () => undefined,
		} as unknown as ExtensionAPI;
		const runtime = createRuntime(pi, `${process.cwd()}/.pi-test/config.json`);
		const start = createBackgroundDispatcher({
			runtime,
			getEnvironment: () => ({
				ctx: { cwd: process.cwd() } as ExtensionContext,
				config: {} as SubagentsConfig,
				agents: [sentinel],
			}),
			finishRun: () => undefined,
			makeLiveHandler: () => () => undefined,
			makeDetails: (mode, background = false) => (results) => ({ mode, background, results }),
		});
		try {
			const result = await start("sentinel", "Review the completed diff", process.cwd(), "worktree");
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

	it("uses phaseId for rewritten tasks while preserving the exact-task fallback", () => {
		const active = [source({ phaseId: "dispatch-admission" })];
		assert.equal(
			findDuplicateDispatch(active, "Rewrite the dispatch admission checks", process.cwd(), "dispatch-admission")?.source.id,
			41,
		);
		assert.equal(
			findDuplicateDispatch(active, "Trace dispatch ownership", process.cwd(), "different-phase")?.source.id,
			41,
			"the legacy exact task+cwd fallback still rejects equal text across phase ids",
		);
		assert.equal(
			findDuplicateDispatch(active, "Rewrite the dispatch admission checks", process.cwd()),
			undefined,
			"calls without phaseId keep exact-match compatibility rather than fuzzy matching",
		);
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

	it("rejects a rewritten task with the same stable phase id before allocation", async () => {
		const { runtime, start } = dispatcher([source({ phaseId: "dispatch-admission" })]);
		const result = await start(
			"artisan",
			"Rewrite the dispatch admission checks",
			process.cwd(),
			"shared",
			{ phaseId: "dispatch-admission" },
		);
		assert.equal(result.exitCode, 1);
		assert.match(result.errorMessage ?? "", /matches run #41 \(scout\)/u);
		assert.equal(runtime.threads.size, 1);
		assert.equal(runtime.runControllers.size, 0);
	});

	it("rejects re-running a finished brief and points at the retained thread", async () => {
		const { runtime, start } = dispatcher([settledSource()]);
		const result = await start("artisan", "Trace dispatch ownership", process.cwd());
		assert.equal(result.exitCode, 1);
		assert.match(result.errorMessage ?? "", /Run #41 \(scout\) already completed this logical phase/u);
		assert.match(result.errorMessage ?? "", /Resume #41 with an appended objective/u);
		assert.match(result.errorMessage ?? "", /restate the brief with what changed/u);
		assert.equal(runtime.threads.size, 1);
		assert.equal(runtime.runControllers.size, 0);
	});
});

describe("resume admission metadata", () => {
	it("keeps phase/scope/capability monotonic across role changes", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-subagents-resume-admission-"));
		const configPath = join(root, "settings.json");
		const agentDir = join(root, ".pi", "agents");
		const agentPath = join(agentDir, "mutable.md");
		const writeAgent = (tools: string): Promise<void> =>
			writeFile(
				agentPath,
				`---\nname: mutable\ndescription: Mutable role\ntools: ${tools}\n---\nMutable role.\n`,
				"utf8",
			);
		const config = {
			...DEFAULT_CONFIG,
			enabledAgents: ["mutable"],
			knownAgents: ["mutable"],
			agentScope: "project" as const,
		};
		const release = deferred();
		await mkdir(agentDir, { recursive: true });
		await writeAgent("read");
		await writeFile(configPath, `${JSON.stringify(config)}\n`, "utf8");
		const pi = {
			on: () => undefined,
			getActiveTools: () => ["read", "write"],
			sendMessage: () => undefined,
		} as unknown as ExtensionAPI;
		const runtime = createRuntime(pi, configPath);
		const ctx = {
			cwd: root,
			isProjectTrusted: () => true,
			modelRegistry: { getAvailable: () => [] },
			ui: { notify: () => undefined },
		} as unknown as ExtensionContext;
		const currentAgents = () => discoverAgents(root, {
			scope: "project",
			enabledNames: ["mutable"],
			projectTrusted: true,
		}).agents;
		const start = createBackgroundDispatcher({
			runtime,
			getEnvironment: () => ({ ctx, config, agents: currentAgents() }),
			finishRun: () => undefined,
			makeLiveHandler: () => () => undefined,
			makeDetails: (mode, background = false) => (results) => ({ mode, background, results }),
		});
		for (let index = 0; index < runtime.backgroundQueue.capacity; index++) {
			runtime.backgroundQueue.enqueue(async () => release.promise);
		}
		await new Promise<void>((resolve) => setImmediate(resolve));
		try {
			const fresh = await start("mutable", "Initial retained edits", root, "shared", {
				phaseId: "stable-phase", scope: { paths: ["src"] },
			});
			assert.equal(fresh.exitCode, -1);
			const thread = runtime.threads.get(fresh.runId!);
			assert.ok(thread);
			assert.equal(thread.writeCapable, false);
			thread.state = "parked";
			thread.sessionId = "session-mutable";
			thread.sessionDir = join(root, "session-mutable");
			await writeAgent("read, write");
			const upgraded = await thread.resume("Continue with docs", ctx, {
				phaseId: "forged-replacement",
				scope: { paths: ["docs"] },
			} as any);
			assert.equal(upgraded.exitCode, -1);
			assert.equal(thread.phaseId, "stable-phase");
			assert.equal(thread.writeCapable, true, "a newly writable role upgrades the lease");
			const expectedScopePaths = [join(root, "src"), join(root, "docs")].map((path) =>
				process.platform === "win32" ? path.toLowerCase() : path,
			);
			assert.deepEqual(thread.scope?.paths, expectedScopePaths);
			thread.state = "parked";
			await writeAgent("read");
			const downgraded = await thread.resume(undefined, ctx);
			assert.equal(downgraded.exitCode, -1);
			assert.equal(thread.writeCapable, true, "a formerly writable lease never downgrades");
			thread.state = "parked";
			const retainedGeneration = thread.generation;
			const retainedScope = structuredClone(thread.scope);
			runtime.threads.set(99, {
				...source({ id: 99, agentName: "artisan", task: "Active src writer", phaseId: "active-src" }),
				scope: normalizePhaseScope({ paths: ["src/file.ts"] }, root),
				writeCapable: true,
			} as unknown as SubagentThread);
			const retainedConflict = await thread.resume(undefined, ctx);
			assert.notEqual(retainedConflict.exitCode, -1);
			assert.match(retainedConflict.errorMessage ?? retainedConflict.stderr, /scope.*run #99/i);
			assert.equal(thread.generation, retainedGeneration);
			assert.equal(thread.state, "parked");
			assert.deepEqual(thread.scope, retainedScope);
			runtime.threads.delete(99);
			runtime.threads.set(100, {
				...source({ id: 100, agentName: "artisan", task: "Active config writer", phaseId: "active-config" }),
				scope: normalizePhaseScope({ paths: ["config"] }, root),
				writeCapable: true,
			} as unknown as SubagentThread);
			const expansionConflict = await thread.resume(
				undefined,
				ctx,
				{ scope: { paths: ["config"] } },
			);
			assert.notEqual(expansionConflict.exitCode, -1);
			assert.match(expansionConflict.errorMessage ?? expansionConflict.stderr, /scope.*run #100/i);
			assert.equal(thread.generation, retainedGeneration);
			assert.equal(thread.state, "parked");
			assert.deepEqual(thread.scope, retainedScope);
		} finally {
			runtime.threads.clear();
			release.resolve();
			await runtime.shutdown();
			monitor.clear();
			await rm(root, { recursive: true, force: true });
		}
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
