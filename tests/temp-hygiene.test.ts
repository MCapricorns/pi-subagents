import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	isProcessAlive,
	killProcessTree,
	sweepOrphanTempDirs,
	sweepProjectDurableDirs,
	sweepProjectTempDirs,
	TEMP_OWNER_FILE_NAME,
	UNMARKED_TEMP_MAX_AGE_MS,
	writeTempOwnerMarker,
} from "../src/temp-hygiene.ts";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeDir(root: string, name: string): string {
	const dir = join(root, name);
	mkdirSync(dir, { recursive: true });
	return dir;
}

describe("process liveness and tree kill", () => {
	it("reports the current process alive and rejects nonsense pids", () => {
		expect(isProcessAlive(process.pid)).toBe(true);
		expect(isProcessAlive(-1)).toBe(false);
		expect(isProcessAlive(Number.NaN)).toBe(false);
		expect(isProcessAlive(0)).toBe(false);
	});

	it("never throws for a pid that is already gone", () => {
		expect(() => killProcessTree(0x7fffffff)).not.toThrow();
	});
});

describe("temp owner markers and orphan sweep", () => {
	it("removes only dead-owner and old-unmarked transient directories", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-subagents-hygiene-"));
		roots.push(root);
		const now = Date.now();
		const aged = (dir: string): void => {
			utimesSync(dir, new Date(now - UNMARKED_TEMP_MAX_AGE_MS - 1_000), new Date(now - UNMARKED_TEMP_MAX_AGE_MS - 1_000));
		};

		const liveOwner = makeDir(root, "pi-subagents-policy-live");
		writeTempOwnerMarker(liveOwner, 0);
		const deadOwner = makeDir(root, "pi-subagents-policy-dead");
		// writeTempOwnerMarker always stamps the current pid, so simulate a dead
		// owner by writing its marker directly with a pid the probe reports dead.
		writeFileSync(
			join(deadOwner, TEMP_OWNER_FILE_NAME),
			`${JSON.stringify({ pid: 999_999, createdAt: 0 })}\n`,
			"utf8",
		);
		writeFileSync(join(deadOwner, "payload.txt"), "x", "utf8");
		const oldUnmarked = makeDir(root, "pi-subagents-unmarked-old");
		aged(oldUnmarked);
		const freshUnmarked = makeDir(root, "pi-subagents-unmarked-fresh");
		// Durable session/worktree directories use the singular pi-subagent-
		// prefix and live in their own roots; the transient sweep never touches
		// them even when they age past the cap.
		const durableSession = makeDir(root, "pi-subagent-session-durable");
		aged(durableSession);
		const unrelated = makeDir(root, "someone-elses-dir");

		const removed = sweepOrphanTempDirs(root, {
			now,
			isAlive: (pid) => pid === process.pid,
		});

		expect(removed).toBe(2);
		expect(existsSync(liveOwner)).toBe(true);
		expect(existsSync(deadOwner)).toBe(false);
		expect(existsSync(oldUnmarked)).toBe(false);
		expect(existsSync(freshUnmarked)).toBe(true);
		expect(existsSync(durableSession)).toBe(true);
		expect(existsSync(unrelated)).toBe(true);
	});

	it("treats an unmarked directory as young until the age cap passes", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-subagents-hygiene-age-"));
		roots.push(root);
		const dir = makeDir(root, "pi-subagents-123");
		const boundary = Date.now();
		utimesSync(dir, new Date(boundary), new Date(boundary));
		// Evaluated one millisecond before the cap: still young.
		const justInside = sweepOrphanTempDirs(root, {
			now: boundary + UNMARKED_TEMP_MAX_AGE_MS - 1,
			isAlive: () => true,
		});
		expect(justInside).toBe(0);
		expect(existsSync(dir)).toBe(true);
	});

	it("sweeps every project's tmp directory under the durable root", () => {
		const durableRoot = mkdtempSync(join(tmpdir(), "pi-subagents-hygiene-root-"));
		roots.push(durableRoot);
		const deadOwner = (project: string, name: string): string => {
			const dir = makeDir(join(durableRoot, project), join("tmp", name));
			writeFileSync(
				join(dir, TEMP_OWNER_FILE_NAME),
				`${JSON.stringify({ pid: 999_999, createdAt: 0 })}\n`,
				"utf8",
			);
			return dir;
		};
		const goneA = deadOwner("proj-a", "pi-subagents-dead-a");
		const goneB = deadOwner("proj-b", "pi-subagents-dead-b");
		const liveDir = makeDir(join(durableRoot, "proj-a"), join("tmp", "pi-subagents-live"));
		writeTempOwnerMarker(liveDir, 0);
		// A project whose tmp directory was never created must be skipped silently.
		mkdirSync(join(durableRoot, "proj-c", "sessions"), { recursive: true });
		// Loose files under the durable root are not project directories.
		writeFileSync(join(durableRoot, "stray.txt"), "x", "utf8");

		const removed = sweepProjectTempDirs(durableRoot, { isAlive: (pid) => pid === process.pid });

		expect(removed).toBe(2);
		expect(existsSync(goneA)).toBe(false);
		expect(existsSync(goneB)).toBe(false);
		expect(existsSync(liveDir)).toBe(true);
		expect(existsSync(join(durableRoot, "proj-c", "sessions"))).toBe(true);
	});
});

describe("durable session and worktree sweep", () => {
	function deadOwnerDir(project: string, relative: string): string {
		const dir = makeDir(project, relative);
		writeFileSync(
			join(dir, TEMP_OWNER_FILE_NAME),
			`${JSON.stringify({ pid: 999_999, createdAt: 0 })}\n`,
			"utf8",
		);
		return dir;
	}

	it("removes state whose owner is gone, keeps live owners and claimed paths", () => {
		const durableRoot = mkdtempSync(join(tmpdir(), "pi-subagents-durable-sweep-"));
		roots.push(durableRoot);
		const project = join(durableRoot, "proj-a");
		const orphanSession = deadOwnerDir(project, join("sessions", "pi-subagent-session-orphan"));
		const orphanWorktree = deadOwnerDir(project, join("worktrees", "pi-subagent-worktree-orphan"));
		const parkedWorktree = deadOwnerDir(project, join("worktrees", "pi-subagent-worktree-parked"));
		const liveSession = makeDir(project, join("sessions", "pi-subagent-session-live"));
		writeTempOwnerMarker(liveSession, 0);
		const transient = deadOwnerDir(project, join("tmp", "pi-subagents-policy-dead"));

		const removed = sweepProjectDurableDirs(durableRoot, {
			isAlive: (pid) => pid === process.pid,
			keep: (path) => path === parkedWorktree,
		});

		expect(removed).toBe(2);
		// A crash leaves a full worktree checkout and its session behind; nothing
		// else reaches them while the checkout is still being worked in.
		expect(existsSync(orphanSession)).toBe(false);
		expect(existsSync(orphanWorktree)).toBe(false);
		// Parked work outlives the process that made it, so a path the manifest
		// still claims stays even though its owner is gone.
		expect(existsSync(parkedWorktree)).toBe(true);
		// A settled session that no record claims is still resumable in the
		// session that produced it; its live owner is what protects it.
		expect(existsSync(liveSession)).toBe(true);
		// tmp/ belongs to the transient sweep, which has its own prefixes.
		expect(existsSync(transient)).toBe(true);
	});

	it("gives unmarked durable leftovers the age cap rather than deleting on sight", () => {
		const durableRoot = mkdtempSync(join(tmpdir(), "pi-subagents-durable-sweep-age-"));
		roots.push(durableRoot);
		const project = join(durableRoot, "proj-a");
		const fresh = makeDir(project, join("sessions", "pi-subagent-session-fresh"));
		const stale = makeDir(project, join("sessions", "pi-subagent-session-stale"));
		const now = Date.now();
		const aged = new Date(now - UNMARKED_TEMP_MAX_AGE_MS - 1_000);
		utimesSync(stale, aged, aged);

		const removed = sweepProjectDurableDirs(durableRoot, { now, isAlive: () => true });

		expect(removed).toBe(1);
		expect(existsSync(fresh)).toBe(true);
		expect(existsSync(stale)).toBe(false);
	});
});

