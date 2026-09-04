import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerSubagentTool } from "../src/delegation/dispatch.ts";
import {
	findPhaseScopeOverlap,
	findWriterLeaseScopeOverlap,
	mergePhaseScopes,
	normalizePhaseId,
	normalizePhaseScope,
	PHASE_ID_MAX_LENGTH,
	PHASE_ID_PATTERN_SOURCE,
} from "../src/delegation/phase-scope.ts";
import { emptyUsage, RpcRunControl } from "../src/execution/rpc-control.ts";
import {
	getThreadsManifestPath,
	readThreadRecords,
	threadRecordFromThread,
	upsertThreadRecord,
	type ThreadRecord,
} from "../src/lifecycle/durable.ts";
import { createRuntime, type SubagentRuntime, type SubagentThread } from "../src/lifecycle/runtime.ts";
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
	let resolvePromise!: () => void;
	const promise = new Promise<void>((resolve) => {
		resolvePromise = resolve;
	});
	return { promise, resolve: resolvePromise };
}

function canonical(path: string): string {
	const absolute = resolve(path);
	return process.platform === "win32" ? absolute.toLowerCase() : absolute;
}

function dispatchHarness(configPath: string): {
	runtime: SubagentRuntime;
	tool: RegisteredTool;
} {
	const tools = new Map<string, RegisteredTool>();
	const pi = {
		getActiveTools: () => ["read", "write"],
		on: () => undefined,
		registerTool: (tool: RegisteredTool & { name: string }) => tools.set(tool.name, tool),
		sendMessage: () => undefined,
	} as unknown as ExtensionAPI;
	const runtime = createRuntime(pi, configPath);
	registerSubagentTool(pi, runtime);
	return { runtime, tool: tools.get("subagent")! };
}

async function execute(tool: RegisteredTool, params: Record<string, unknown>, cwd: string): Promise<any> {
	return tool.execute("call-1", params, new AbortController().signal, () => undefined, {
		cwd,
		modelRegistry: { getAvailable: () => [] },
		isProjectTrusted: () => false,
		ui: { notify: () => undefined },
	});
}

function activeWriter(id: number, cwd: string, path: string): SubagentThread {
	return {
		id,
		generation: 1,
		agentName: "artisan",
		task: "Existing writer",
		phaseId: "existing-writer",
		scope: normalizePhaseScope({ paths: [path] }, cwd),
		writeCapable: true,
		cwd,
		executionCwd: cwd,
		isolation: "shared",
		state: "parked",
		control: new RpcRunControl("Existing writer", 1),
		generationCompletion: Promise.resolve(),
		lifecycleVersion: 0,
		elapsedMs: 0,
		resume: async () => ({
			agent: "artisan",
			task: "Existing writer",
			exitCode: 1,
			messages: [],
			stderr: "not used",
			usage: emptyUsage(),
		}),
		finalizeIsolation: async () => undefined,
	};
}

describe("phase and scope normalization", () => {
	it("accepts bounded stable phase ids and rejects unsafe display input", () => {
		assert.equal(normalizePhaseId("parser-fix:v2.1"), "parser-fix:v2.1");
		assert.throws(() => normalizePhaseId("parser fix"), /phaseId.*identifier/i);
		assert.throws(() => normalizePhaseId("parser\nfix"), /phaseId.*identifier/i);
		assert.throws(() => normalizePhaseId("x".repeat(PHASE_ID_MAX_LENGTH + 1)), /phaseId.*80/i);
	});

	it("resolves exact claims from caller cwd and rejects empty or wildcard scopes", () => {
		const cwd = resolve("scope-fixture");
		assert.deepEqual(normalizePhaseScope({
			paths: ["src", "src", "app/[id]/page.tsx"],
			symbols: [{ path: "test/parser.test.ts", name: "parses input" }],
		}, cwd), {
			paths: [canonical(join(cwd, "src")), canonical(join(cwd, "app/[id]/page.tsx"))],
			symbols: [{ path: canonical(join(cwd, "test/parser.test.ts")), name: "parses input" }],
		});
		assert.throws(() => normalizePhaseScope({}, cwd), /at least one valid claim/i);
		assert.throws(() => normalizePhaseScope({ paths: [] }, cwd), /at least one valid claim/i);
		assert.throws(() => normalizePhaseScope({ paths: ["src/*.ts"] }, cwd), /wildcard|pattern/i);
		assert.throws(() => normalizePhaseScope({ paths: ["src/file?.ts"] }, cwd), /wildcard|pattern/i);
		assert.throws(() => normalizePhaseScope({ symbols: [{ path: "src/a.ts", name: " " }] }, cwd), /symbol.*name/i);
	});

	it("detects deterministic write overlaps while allowing different symbols in one file", () => {
		const cwd = resolve("scope-fixture");
		const directory = normalizePhaseScope({ paths: ["src"] }, cwd)!;
		const file = normalizePhaseScope({ paths: ["src/a.ts"] }, cwd)!;
		const symbolA = normalizePhaseScope({ symbols: [{ path: "src/a.ts", name: "parse" }] }, cwd)!;
		const sameSymbol = normalizePhaseScope({ symbols: [{ path: "src/a.ts", name: "parse" }] }, cwd)!;
		const symbolB = normalizePhaseScope({ symbols: [{ path: "src/a.ts", name: "format" }] }, cwd)!;

		assert.ok(findPhaseScopeOverlap(directory, file), "directory ancestor overlaps a file claim");
		assert.ok(findPhaseScopeOverlap(file, normalizePhaseScope({ paths: ["src/a.ts"] }, cwd)!), "the same path overlaps");
		assert.ok(findPhaseScopeOverlap(file, symbolA), "file claim overlaps a symbol in that file");
		assert.ok(findPhaseScopeOverlap(symbolA, sameSymbol), "the same symbol overlaps");
		assert.equal(findPhaseScopeOverlap(symbolA, symbolB), undefined, "different symbols in one file may run concurrently");
		if (process.platform === "win32") {
			const upper = normalizePhaseScope({ paths: ["SRC/A.TS"] }, cwd)!;
			assert.ok(findPhaseScopeOverlap(file, upper), "Windows path overlap is case-insensitive");
		}
	});

	it("extends continuation scope without dropping retained claims", () => {
		const cwd = resolve("scope-fixture");
		const previous = normalizePhaseScope({ paths: ["src"] }, cwd);
		const additional = normalizePhaseScope({ paths: ["docs"], symbols: [{ path: "test/a.ts", name: "case A" }] }, cwd);
		assert.deepEqual(mergePhaseScopes(previous, additional), {
			paths: [canonical(join(cwd, "src")), canonical(join(cwd, "docs"))],
			symbols: [{ path: canonical(join(cwd, "test/a.ts")), name: "case A" }],
		});
		assert.deepEqual(mergePhaseScopes(previous, undefined), previous);
	});

	it("publishes the same bounded phase id contract in single and parallel schemas", async () => {
		const { runtime, tool } = dispatchHarness(join(tmpdir(), `pi-subagents-phase-schema-${process.pid}.json`));
		try {
			const single = tool.parameters?.properties?.phaseId;
			const parallel = tool.parameters?.properties?.tasks?.items?.properties?.phaseId;
			for (const schema of [single, parallel]) {
				assert.equal(schema?.maxLength, PHASE_ID_MAX_LENGTH);
				assert.equal(schema?.pattern, PHASE_ID_PATTERN_SOURCE);
			}
		} finally {
			await runtime.shutdown();
		}
	});
});

describe("parallel scope admission", () => {
	it("rejects duplicate batch identities before attempting any start", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-subagents-phase-duplicate-"));
		const cases = [
			[
				{ agent: "missing-a", task: "First wording", phaseId: "shared-phase", scope: { paths: ["src/a.ts"] } },
				{ agent: "missing-b", task: "Rewritten wording", phaseId: "shared-phase", scope: { paths: ["src/b.ts"] } },
			],
			[
				{ agent: "missing-a", task: "Exact duplicate", phaseId: "phase-a" },
				{ agent: "missing-b", task: "  Exact   duplicate  ", phaseId: "phase-b" },
			],
		];
		try {
			for (const tasks of cases) {
				const { runtime, tool } = dispatchHarness(join(root, `${tasks[0]!.phaseId}.json`));
				try {
					await assert.rejects(execute(tool, { tasks }, root), /parallel admission.*duplicate.*tasks\[0\].*tasks\[1\]/i);
					assert.equal(runtime.threads.size, 0);
					assert.equal(monitor.getRuns().length, 0);
				} finally {
					await runtime.shutdown();
					monitor.clear();
				}
			}
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("rejects an overlapping writer batch before allocating any run", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-subagents-admission-"));
		const { runtime, tool } = dispatchHarness(join(root, "config.json"));
		try {
			await assert.rejects(
				execute(tool, {
					tasks: [
						{ agent: "artisan", task: "Edit parser", phaseId: "parser", scope: { paths: ["src/parser.ts"] } },
						{ agent: "steward", task: "Clean parser", phaseId: "parser-cleanup", scope: { symbols: [{ path: "src/parser.ts", name: "parse" }] } },
					],
				}, root),
				/error.*scope|scope.*overlap/i,
			);
			assert.equal(runtime.threads.size, 0);
			assert.equal(monitor.getRuns().length, 0);
		} finally {
			await runtime.shutdown();
			monitor.clear();
			await rm(root, { recursive: true, force: true });
		}
	});

	it("preflights existing duplicates and preserves active-over-settled priority", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-subagents-existing-duplicate-"));
		const { runtime, tool } = dispatchHarness(join(root, "config.json"));
		const settled = activeWriter(72, root, "docs");
		settled.state = "completed";
		settled.sessionId = "session-72";
		settled.sessionDir = join(root, "session-72");
		const active = activeWriter(73, root, "src");
		runtime.threads.set(settled.id, settled);
		runtime.threads.set(active.id, active);
		try {
			await assert.rejects(execute(tool, {
				tasks: [{ agent: "missing-agent", task: "Reworded duplicate", phaseId: "existing-writer" }],
			}, root), /parallel admission.*duplicates active.*run #73/i);
			assert.equal(runtime.threads.size, 2);
			assert.equal(monitor.getRuns().length, 0);
		} finally {
			runtime.threads.clear();
			await runtime.shutdown();
			monitor.clear();
			await rm(root, { recursive: true, force: true });
		}
	});

	it("rejects overlap with a parked writer lease before allocating any run", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-subagents-active-admission-"));
		const { runtime, tool } = dispatchHarness(join(root, "config.json"));
		runtime.threads.set(73, activeWriter(73, root, "src"));
		try {
			await assert.rejects(
				execute(tool, {
					tasks: [{
						agent: "artisan",
						task: "Edit parser",
						phaseId: "parser",
						scope: { paths: ["src/parser.ts"] },
					}],
				}, root),
				/overlaps run #73/i,
			);
			assert.equal(runtime.threads.size, 1);
			assert.equal(monitor.getRuns().length, 0);
		} finally {
			runtime.threads.clear();
			await runtime.shutdown();
			monitor.clear();
			await rm(root, { recursive: true, force: true });
		}
	});

	it("compares absolute scopes across root and nested caller cwd", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-subagents-nested-admission-"));
		const nested = join(root, "packages", "app");
		const { runtime, tool } = dispatchHarness(join(root, "config.json"));
		runtime.threads.set(74, activeWriter(74, root, "src"));
		try {
			await assert.rejects(execute(tool, {
				tasks: [{
					agent: "missing-agent",
					task: "Edit nested parser",
					phaseId: "nested-parser",
					cwd: nested,
					scope: { paths: ["../../src/parser.ts"] },
				}],
			}, root), /scope.*overlaps run #74/i);
			assert.equal(runtime.threads.size, 1);
			assert.equal(monitor.getRuns().length, 0);
		} finally {
			runtime.threads.clear();
			await runtime.shutdown();
			monitor.clear();
			await rm(root, { recursive: true, force: true });
		}
	});

	it("does not reject a later phase solely for sharing settled scope", () => {
		const cwd = resolve("scope-fixture");
		const settled = activeWriter(75, cwd, "src");
		settled.state = "completed";
		assert.equal(
			findWriterLeaseScopeOverlap(normalizePhaseScope({ paths: ["src/a.ts"] }, cwd)!, [settled]),
			undefined,
		);
	});

	it("exposes additive scope during the resuming preflight window", () => {
		const cwd = resolve("scope-fixture");
		const resuming = activeWriter(77, cwd, "src");
		resuming.state = "resuming";
		resuming.writeCapable = false;
		resuming.admissionScope = mergePhaseScopes(
			resuming.scope,
			normalizePhaseScope({ paths: ["docs"] }, cwd),
		);
		const conflict = findWriterLeaseScopeOverlap(
			normalizePhaseScope({ paths: ["docs/guide.md"] }, cwd)!,
			[resuming],
		);
		assert.equal(conflict?.lease.id, 77);
	});
});

describe("single scope admission", () => {
	it("rejects active writer overlap before allocating a fresh run", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-subagents-single-admission-"));
		const { runtime, tool } = dispatchHarness(join(root, "config.json"));
		const release = deferred();
		for (let index = 0; index < runtime.backgroundQueue.capacity; index++) {
			runtime.backgroundQueue.enqueue(async () => release.promise);
		}
		await new Promise<void>((resolve) => setImmediate(resolve));
		runtime.threads.set(76, activeWriter(76, root, "src"));
		try {
			await assert.rejects(execute(tool, {
				agent: "artisan",
				task: "Edit another parser wording",
				phaseId: "single-parser",
				scope: { paths: ["src/parser.ts"] },
			}, root), /scope.*overlaps active run #76/i);
			assert.equal(runtime.threads.size, 1);
			assert.equal(monitor.getRuns().length, 0);
		} finally {
			runtime.threads.clear();
			release.resolve();
			await runtime.shutdown();
			monitor.clear();
			await rm(root, { recursive: true, force: true });
		}
	});

	it("omits independence wording from single receipts with or without scope", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-subagents-single-receipt-"));
		const { runtime, tool } = dispatchHarness(join(root, "config.json"));
		const release = deferred();
		for (let index = 0; index < runtime.backgroundQueue.capacity; index++) {
			runtime.backgroundQueue.enqueue(async () => release.promise);
		}
		await new Promise<void>((resolve) => setImmediate(resolve));
		try {
			const withoutScope = await execute(tool, {
				agent: "artisan", task: "Single without scope", phaseId: "single-no-scope",
			}, root);
			const withScope = await execute(tool, {
				agent: "artisan", task: "Single with scope", phaseId: "single-with-scope", scope: { paths: ["docs"] },
			}, root);
			for (const result of [withoutScope, withScope]) {
				const text = result.content.map((part: { text?: string }) => part.text ?? "").join("\n");
				assert.doesNotMatch(text, /independence|scope admission/iu);
			}
		} finally {
			runtime.threads.clear();
			release.resolve();
			await runtime.shutdown();
			monitor.clear();
			await rm(root, { recursive: true, force: true });
		}
	});
});

describe("durable phase metadata", () => {
	it("round-trips phase identity and normalized scope without changing manifest v1", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-subagents-phase-record-"));
		const cwd = resolve(root);
		const configPath = join(root, "config.json");
		const thread = activeWriter(81, cwd, "src");
		const record = threadRecordFromThread(thread, "parked", undefined, 1000);
		try {
			await upsertThreadRecord(configPath, record);
			const [restored] = await readThreadRecords(configPath);
			assert.equal(restored?.phaseId, "existing-writer");
			assert.deepEqual(restored?.scope, thread.scope);
			assert.equal(restored?.writeCapable, true);
			const manifest = JSON.parse(await readFile(getThreadsManifestPath(configPath, cwd), "utf8"));
			assert.equal(manifest.version, 1);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("reads a legacy v1 record with no phase or scope fields", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-subagents-legacy-record-"));
		const cwd = resolve(root);
		const configPath = join(root, "config.json");
		const path = getThreadsManifestPath(configPath, cwd);
		const legacy: ThreadRecord = {
			runId: 82,
			createdAt: 1000,
			updatedAt: 1000,
			generation: 1,
			agentName: "artisan",
			task: "Legacy task",
			cwd,
			executionCwd: cwd,
			isolation: "shared",
			state: "parked",
			elapsedMs: 0,
			childPids: [],
		};
		try {
			await mkdir(dirname(path), { recursive: true });
			await writeFile(path, `${JSON.stringify({ version: 1, records: [legacy] })}\n`, "utf8");
			const [restored] = await readThreadRecords(configPath);
			assert.equal(restored?.runId, 82);
			assert.equal(restored?.phaseId, undefined);
			assert.equal(restored?.scope, undefined);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
