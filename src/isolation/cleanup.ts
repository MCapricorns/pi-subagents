/**
 * Explicit storage cleanup for the per-project durable root.
 *
 * Long workflows leave three kinds of bytes behind: retained child sessions,
 * detached worktrees, and Markdown result excerpts. Startup hygiene already
 * removes artifacts whose owning process died, but a project that keeps running
 * builds up settled sessions and result files that nothing ages out until the
 * whole project goes idle. This module answers "how much is this costing" and
 * reclaims what no manifest claims, without touching parked recovery work.
 */

import { type Dirent, lstatSync, readdirSync, rmdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { getSubagentsRoot, sweepProjectResultArtifacts } from "../execution/spawn.ts";
import { pruneStaleProjectRoots, readReferencedDurablePaths, readThreadRecords } from "../lifecycle/durable.ts";
import type { SubagentRuntime } from "../lifecycle/runtime.ts";
import { isProcessAlive, readTempOwnerMarker, sweepProjectDurableDirs, sweepProjectTempDirs } from "./temp-hygiene.ts";
import { isPathInside } from "./worktree.ts";

/** Bytes a directory tree occupies, without following symlinks. */
function directoryBytes(path: string): number {
	let total = 0;
	const stack = [path];
	while (stack.length > 0) {
		const current = stack.pop()!;
		let entries: Dirent[];
		try {
			entries = readdirSync(current, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			if (entry.isSymbolicLink()) continue;
			const child = join(current, entry.name);
			if (entry.isDirectory()) {
				stack.push(child);
				continue;
			}
			try {
				total += statSync(child).size;
			} catch {
				/* a racing delete simply costs nothing */
			}
		}
	}
	return total;
}

interface CleanupUsage {
	/** Per-project usage, largest first. */
	projects: Array<{ path: string; bytes: number; sessions: number; worktrees: number }>;
	totalBytes: number;
}

function countDirectories(path: string, prefixes: readonly string[]): number {
	try {
		return readdirSync(path, { withFileTypes: true })
			.filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
			.filter((entry) => prefixes.some((prefix) => entry.name.startsWith(prefix))).length;
	} catch {
		return 0;
	}
}

/** Report what the durable root currently holds, so cleanup decisions are
 * evidence-based instead of a guess about which run left what. */
export function measureDurableUsage(root: string): CleanupUsage {
	let projects: Dirent[] = [];
	try {
		projects = readdirSync(root, { withFileTypes: true });
	} catch {
		return { projects: [], totalBytes: 0 };
	}
	const measured = projects
		.filter((entry) => entry.isDirectory() && !entry.isSymbolicLink() && !entry.name.endsWith(".lock"))
		.map((entry) => {
			const path = join(root, entry.name);
			return {
				path,
				bytes: directoryBytes(path),
				sessions: countDirectories(join(path, "sessions"), ["pi-subagent-session-"]),
				worktrees: countDirectories(join(path, "worktrees"), ["pi-subagent-worktree-"]),
			};
		})
		.sort((left, right) => right.bytes - left.bytes);
	return {
		projects: measured,
		totalBytes: measured.reduce((sum, project) => sum + project.bytes, 0),
	};
}

interface CleanupResult {
	before: CleanupUsage;
	after: CleanupUsage;
	/** Bytes actually reclaimed, measured rather than estimated. */
	freedBytes: number;
	/** Project roots removed because nothing was using them. */
	removedProjects: string[];
	/** True when parked recovery records still claim artifacts that were kept. */
	parkedRecords: number;
}

/** Reclaim unclaimed artifacts. Parked recovery work, live owners' directories
 * and every path a manifest still references always survive. */
export async function runStorageCleanup(configPath: string, options: { now?: number; root?: string } = {}): Promise<CleanupResult> {
	const root = options.root ?? getSubagentsRoot(configPath);
	const before = measureDurableUsage(root);
	const records = await readThreadRecords(configPath);
	const claimed = await readReferencedDurablePaths(configPath, records);
	const protectedPaths = [...claimed];
	const keep = (path: string) => protectedPaths.some((claim) => isPathInside(path, claim) || isPathInside(claim, path));

	sweepProjectTempDirs(root);
	sweepProjectDurableDirs(root, { keep, isAlive: isProcessAlive });
	sweepProjectResultArtifacts(root, { now: options.now });
	const removedProjects = await pruneStaleProjectRoots(configPath, { referenced: claimed, now: options.now }).catch(() => [] as string[]);

	// Remove empty roots only if no new artifacts appeared during cleanup.
	for (const project of before.projects) {
		try {
			rmdirSync(project.path);
		} catch {
			/* best-effort */
		}
	}

	const after = measureDurableUsage(root);
	return {
		before,
		after,
		freedBytes: Math.max(0, before.totalBytes - after.totalBytes),
		removedProjects,
		parkedRecords: records.filter((record) => record.state === "parked").length,
	};
}

export function formatBytes(bytes: number): string {
	if (bytes < 1024) return bytes + " B";
	const units = ["KB", "MB", "GB", "TB"];
	let value = bytes / 1024;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit++;
	}
	return value.toFixed(value >= 10 ? 0 : 1) + " " + units[unit];
}

/** Sessions of settled runs are kept only so a follow-up can resume them. After
 * this window they are pure disk cost: `subagent_message` with
 * `context: "summary"` still works, and rework usually starts long before it. */
const SETTLED_SESSION_MAX_AGE_MS = 30 * 60 * 1_000;

/** Recent sessions are never reclaimed regardless of budget: a follow-up can
 * legitimately arrive seconds after settlement. */
const RECENT_SESSION_FLOOR_MS = 5 * 60 * 1_000;

/** Automatic passes are paced by settlement, so a burst of finished runs costs
 * one sweep instead of one per run. */
const AUTO_CLEANUP_INTERVAL_MS = 5 * 60 * 1_000;

/** Upper bound for one project's artifacts; the oldest settled sessions go
 * first until the project fits. */
const PROJECT_BUDGET_BYTES = 1.5 * 1024 * 1024 * 1024;

let lastAutomaticCleanupAt = 0;

interface AutomaticCleanupOptions {
	now?: number;
	/** Retained-session age before automatic reclamation. */
	maxSessionAgeMs?: number;
	/** Per-project artifact budget. */
	budgetBytes?: number;
	/** Ignore the pacing clock (tests, or an explicit pass). */
	force?: boolean;
}

/** Another Pi process may still be preparing its checkpoint. Its owner marker
 * protects the session even when this runtime has no thread or manifest for it. */
function hasForeignLiveOwner(path: string): boolean {
	const owner = readTempOwnerMarker(path);
	return owner !== undefined && owner.pid !== process.pid && isProcessAlive(owner.pid);
}

interface SettledSession {
	path: string;
	mtimeMs: number;
}

function settledSessions(projectRoot: string): SettledSession[] {
	const dir = join(projectRoot, "sessions");
	let entries: Dirent[];
	try {
		if (!lstatSync(dir).isDirectory()) return [];
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return [];
	}
	return entries
		.filter((entry) => entry.isDirectory() && !entry.isSymbolicLink() && entry.name.startsWith("pi-subagent-session-"))
		.flatMap((entry) => {
			const path = join(dir, entry.name);
			if (hasForeignLiveOwner(path)) return [];
			try {
				// Pi appends the transcript in place, leaving the parent mtime
				// unchanged. Settlement also refreshes the directory timestamp.
				let mtimeMs = statSync(path).mtimeMs;
				for (const file of readdirSync(path, { withFileTypes: true })) {
					if (file.isFile()) mtimeMs = Math.max(mtimeMs, statSync(join(path, file.name)).mtimeMs);
				}
				return [{ path, mtimeMs }];
			} catch {
				return [];
			}
		});
}

/** Reclaim expired sessions, then the oldest eligible sessions under budget
 * pressure. A single inventory serves both retention rules. */
function reclaimSettledSessions(
	project: CleanupUsage["projects"][number],
	keep: (path: string) => boolean,
	now: number,
	maxAgeMs: number,
	budgetBytes: number,
): number {
	const ageLimit = Math.max(maxAgeMs, RECENT_SESSION_FLOOR_MS);
	let freed = 0;
	for (const session of settledSessions(project.path).sort((left, right) => left.mtimeMs - right.mtimeMs)) {
		const age = now - session.mtimeMs;
		if (age < RECENT_SESSION_FLOOR_MS || (age < ageLimit && project.bytes - freed <= budgetBytes)) break;
		if (keep(session.path)) continue;
		try {
			const bytes = directoryBytes(session.path);
			rmSync(session.path, { recursive: true, force: true });
			freed += bytes;
		} catch {
			/* a locked directory waits for the next pass */
		}
	}
	return freed;
}

function protectedSessionPaths(runtime: Pick<SubagentRuntime, "threads">, claimed: ReadonlySet<string>): string[] {
	const protectedPaths = [...claimed];
	for (const thread of runtime.threads.values()) {
		// A parked or unfinished thread keeps its session for recovery; a live
		// thread may be resumed by a follow-up that is already running.
		if (thread.state === "queued" || thread.state === "running" || thread.state === "interrupting" || thread.state === "parked") {
			if (thread.sessionDir) protectedPaths.push(thread.sessionDir);
			continue;
		}
		if (thread.lifecycleOperation !== undefined && thread.sessionDir) protectedPaths.push(thread.sessionDir);
	}
	return protectedPaths;
}

/** Reclaim what nothing references, then keep each project inside its budget.
 * Safe to call at any time: live runs, parked recovery work and recently
 * settled sessions are all protected. */
export async function runAutomaticCleanup(
	runtime: Pick<SubagentRuntime, "configPath" | "threads">,
	options: AutomaticCleanupOptions = {},
): Promise<{ freedBytes: number; skipped: boolean }> {
	const now = options.now ?? Date.now();
	if (!options.force && now - lastAutomaticCleanupAt < AUTO_CLEANUP_INTERVAL_MS) return { freedBytes: 0, skipped: true };
	lastAutomaticCleanupAt = now;
	const root = getSubagentsRoot(runtime.configPath);
	let claimed: Set<string>;
	try {
		claimed = await readReferencedDurablePaths(runtime.configPath);
	} catch {
		// Unknown references cannot authorize deleting any recovery artifacts.
		return { freedBytes: 0, skipped: true };
	}
	const protectedPaths = protectedSessionPaths(runtime, claimed);
	const keep = (path: string) => protectedPaths.some((kept) => isPathInside(path, kept) || isPathInside(kept, path));
	const before = measureDurableUsage(root).totalBytes;

	sweepProjectTempDirs(root);
	sweepProjectDurableDirs(root, { keep, isAlive: isProcessAlive });
	sweepProjectResultArtifacts(root, { now });
	const afterSweep = measureDurableUsage(root);
	let freedBytes = before - afterSweep.totalBytes;
	for (const project of afterSweep.projects) {
		freedBytes += reclaimSettledSessions(project, keep, now,
			options.maxSessionAgeMs ?? SETTLED_SESSION_MAX_AGE_MS, options.budgetBytes ?? PROJECT_BUDGET_BYTES);
	}
	return { freedBytes: Math.max(0, freedBytes), skipped: false };
}

/** Reset the pacing clock so the next settlement performs a real pass. */
export function resetAutomaticCleanupClock(): void {
	lastAutomaticCleanupAt = 0;
}
