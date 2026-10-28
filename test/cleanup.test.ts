import assert from "node:assert/strict";
import { existsSync, utimesSync } from "node:fs";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { formatBytes, measureDurableUsage, resetAutomaticCleanupClock, runAutomaticCleanup, runStorageCleanup } from "../src/isolation/cleanup.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createRuntime, type SubagentThread } from "../src/lifecycle/runtime.ts";
import { persistThreadCheckpoint } from "../src/lifecycle/thread-shared.ts";
import { RunControl } from "../src/execution/run-control.ts";
import { getProjectRoot, getSubagentsRoot } from "../src/execution/spawn.ts";
import { getThreadsManifestPath } from "../src/lifecycle/durable.ts";
import { dirname } from "node:path";

async function fixture(run: (configPath: string, cwd: string) => Promise<void>): Promise<void> {
	const root = await mkdtemp(join(tmpdir(), "pi-subagents-cleanup-"));
	try {
		const cwd = join(root, "project");
		await mkdir(cwd, { recursive: true });
		await run(join(root, "agent", "pi-subagents.json"), cwd);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

describe("storage cleanup", () => {
	it("reports per-project usage and reclaims dead, unclaimed artifacts", async () => {
		await fixture(async (configPath, cwd) => {
			const projectRoot = getProjectRoot(configPath, cwd);
			const session = join(projectRoot, "sessions", "pi-subagent-session-dead");
			const worktree = join(projectRoot, "worktrees", "pi-subagent-worktree-dead");
			await mkdir(session, { recursive: true });
			await mkdir(worktree, { recursive: true });
			// A dead owner: nothing this process can be running.
			await writeFile(join(session, "owner.json"), JSON.stringify({ pid: 999_999, createdAt: 0 }));
			await writeFile(join(worktree, "owner.json"), JSON.stringify({ pid: 999_999, createdAt: 0 }));
			await writeFile(join(session, "transcript.jsonl"), "x".repeat(4_096));
			await writeFile(join(worktree, "changes.patch"), "y".repeat(2_048));
			await mkdir(join(projectRoot, "results"), { recursive: true });
			await writeFile(join(projectRoot, "results", "2100000000000-abcdef-old.md"), "z".repeat(1_024));

			const usage = measureDurableUsage(getSubagentsRoot(configPath));
			assert.equal(usage.projects.length, 1);
			assert.ok(usage.projects[0]!.bytes >= 6_000);
			assert.equal(usage.projects[0]!.sessions, 1);
			assert.equal(usage.projects[0]!.worktrees, 1);

			const result = await runStorageCleanup(configPath, { now: Date.now() + 30 * 24 * 60 * 60 * 1_000 });
			assert.equal(existsSync(session), false);
			assert.equal(existsSync(worktree), false);
			assert.ok(result.freedBytes > 0);
			assert.ok(formatBytes(result.freedBytes).length > 0);
		});
	});

	it("keeps parked recovery work and everything a manifest still claims", async () => {
		await fixture(async (configPath, cwd) => {
			const projectRoot = getProjectRoot(configPath, cwd);
			const session = join(projectRoot, "sessions", "pi-subagent-session-parked");
			await mkdir(session, { recursive: true });
			await writeFile(join(session, "owner.json"), JSON.stringify({ pid: 999_999, createdAt: 0 }));
			const sessionId = "parked-session";
			await writeFile(join(session, `2026-01-01T00-00-00.000Z_${sessionId}.jsonl`), "{}\n");
			const now = Date.now();
			const manifest = getThreadsManifestPath(configPath, cwd);
			await mkdir(dirname(manifest), { recursive: true });
			await writeFile(manifest, JSON.stringify({
				version: 1,
				records: [{
					runId: 11, createdAt: now, updatedAt: now, generation: 1, agentName: "artisan",
					task: "parked work", cwd, executionCwd: cwd, isolation: "shared", state: "parked",
					elapsedMs: 1, childPids: [], sessionId, sessionDir: session,
				}],
			}));

			const result = await runStorageCleanup(configPath);
			assert.equal(existsSync(join(session, `2026-01-01T00-00-00.000Z_${sessionId}.jsonl`)), true);
			assert.equal(result.parkedRecords, 1);
		});
	});
});
describe("automatic cleanup", () => {
	function thread(id: number, state: SubagentThread["state"], sessionDir: string): SubagentThread {
		return {
			id, generation: 1, agentName: "scout", task: "parked research",
			cwd: process.cwd(), executionCwd: process.cwd(), isolation: "shared",
			state, control: new RunControl("parked research", 1),
			generationCompletion: Promise.resolve(), lifecycleVersion: 0, elapsedMs: 0,
			sessionDir, sessionId: "session-" + id,
			finalizeIsolation: async () => undefined,
		};
	}

	it("reclaims old settled sessions but keeps live and parked work", async () => {
		await fixture(async (configPath, cwd) => {
			const root = join(getProjectRoot(configPath, cwd), "sessions");
			const old = new Date(Date.now() - 2 * 60 * 60 * 1_000);
			const settled = join(root, "pi-subagent-session-settled");
			const parked = join(root, "pi-subagent-session-parked");
			const live = join(root, "pi-subagent-session-live");
			for (const dir of [settled, parked, live]) {
				await mkdir(dir, { recursive: true });
				await writeFile(join(dir, "transcript.jsonl"), "x".repeat(2_048));
				utimesSync(join(dir, "transcript.jsonl"), old, old);
				utimesSync(dir, old, old);
			}
			const runtime = {
				configPath,
				threads: new Map<number, SubagentThread>([
					[1, thread(1, "parked", parked)],
					[2, thread(2, "running", live)],
				]),
			};
			resetAutomaticCleanupClock();
			const result = await runAutomaticCleanup(runtime, { force: true });
			assert.equal(result.skipped, false);
			assert.ok(result.freedBytes > 0, "the settled session is reclaimed");
			assert.equal(existsSync(settled), false);
			assert.equal(existsSync(parked), true);
			assert.equal(existsSync(live), true);
		});
	});

	it("keeps a long run's freshly appended transcript for the full follow-up window", async () => {
		await fixture(async (configPath, cwd) => {
			const session = join(getProjectRoot(configPath, cwd), "sessions", "pi-subagent-session-long-run");
			await mkdir(session, { recursive: true });
			await writeFile(join(session, "owner.json"), JSON.stringify({ pid: process.pid, createdAt: 1 }));
			const transcript = join(session, "transcript.jsonl");
			await writeFile(transcript, "initial\n");
			const old = new Date(Date.now() - 40 * 60_000);
			for (const path of [join(session, "owner.json"), transcript, session]) utimesSync(path, old, old);
			await appendFile(transcript, "finished\n");
			const now = Date.now();
			const runtime = { configPath, threads: new Map<number, SubagentThread>() };
			await runAutomaticCleanup(runtime, { force: true, now });
			assert.equal(existsSync(transcript), true);
			await runAutomaticCleanup(runtime, { force: true, now: now + 31 * 60_000 });
			assert.equal(existsSync(session), false);
		});
	});

	it("starts session retention at settlement even when the transcript is old", async () => {
		await fixture(async (configPath, cwd) => {
			const session = join(getProjectRoot(configPath, cwd), "sessions", "pi-subagent-session-slow-finalization");
			await mkdir(session, { recursive: true });
			await writeFile(join(session, "owner.json"), JSON.stringify({ pid: process.pid, createdAt: 1 }));
			await writeFile(join(session, "transcript.jsonl"), "finished before slow Git integration\n");
			const old = new Date(Date.now() - 40 * 60_000);
			for (const path of [join(session, "owner.json"), join(session, "transcript.jsonl"), session]) utimesSync(path, old, old);
			const runtime = createRuntime({ getActiveTools: () => [], getAllTools: () => [], on: () => undefined } as unknown as ExtensionAPI, configPath);
			const settled = thread(1, "completed", session);
			settled.cwd = settled.executionCwd = cwd;
			runtime.threads.set(1, settled);
			persistThreadCheckpoint(runtime, settled, "completed");
			const now = Date.now();
			await runAutomaticCleanup(runtime, { force: true, now: now + 60_000 });
			assert.equal(existsSync(session), true);
			await runAutomaticCleanup(runtime, { force: true, now: now + 31 * 60_000 });
			assert.equal(existsSync(session), false);
			await runtime.shutdown();
		});
	});

	it("uses recent transcript activity for the budget's minimum retention floor", async () => {
		await fixture(async (configPath, cwd) => {
			const session = join(getProjectRoot(configPath, cwd), "sessions", "pi-subagent-session-budget");
			await mkdir(session, { recursive: true });
			await writeFile(join(session, "owner.json"), JSON.stringify({ pid: process.pid, createdAt: 1 }));
			await writeFile(join(session, "transcript.jsonl"), "recent transcript\n");
			const old = new Date(Date.now() - 40 * 60_000);
			utimesSync(session, old, old);
			const runtime = { configPath, threads: new Map<number, SubagentThread>() };
			const now = Date.now();
			await runAutomaticCleanup(runtime, { force: true, budgetBytes: 0, now: now + 4 * 60_000 });
			assert.equal(existsSync(session), true);
			await runAutomaticCleanup(runtime, { force: true, budgetBytes: 0, now: now + 6 * 60_000 });
			assert.equal(existsSync(session), false);
		});
	});

	it("paces settlement-triggered passes instead of sweeping on every run", async () => {
		await fixture(async (configPath) => {
			const runtime = { configPath, threads: new Map<number, SubagentThread>() };
			resetAutomaticCleanupClock();
			assert.equal((await runAutomaticCleanup(runtime)).skipped, false);
			assert.equal((await runAutomaticCleanup(runtime)).skipped, true);
		});
	});
});
