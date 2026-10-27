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

import { existsSync, type Dirent, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { getSubagentsRoot, sweepProjectResultArtifacts } from "../execution/spawn.ts";
import { pruneStaleProjectRoots, readReferencedDurablePaths, readThreadRecords } from "../lifecycle/durable.ts";
import { isProcessAlive, sweepProjectDurableDirs, sweepProjectTempDirs } from "./temp-hygiene.ts";

/** Bytes a directory tree occupies, without following symlinks. */
export function directoryBytes(path: string): number {
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

export interface CleanupUsage {
	/** Absolute path of the extension's durable root. */
	root: string;
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
		return { root, projects: [], totalBytes: 0 };
	}
	const measured = projects
		.filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
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
		root,
		projects: measured,
		totalBytes: measured.reduce((sum, project) => sum + project.bytes, 0),
	};
}

function removeEmptySessionCopies(path: string, claimed: readonly string[]): void {
	let entries: Dirent[];
	try {
		entries = readdirSync(join(path, "sessions"), { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
		if (!entry.name.startsWith("pi-subagent-session-")) continue;
		const dir = join(path, "sessions", entry.name);
		if (claimed.some((claim) => claim.startsWith(dir))) continue;
		// A follow-up copies a session and the child resumes it; once that copy
		// holds nothing, it is pure overhead. Owner liveness already guards the
		// live case, so an empty unclaimed directory is safe to drop.
		let files = 0;
		try {
			files = readdirSync(dir).filter((name) => name !== "owner.json").length;
		} catch {
			continue;
		}
		if (files === 0) rmSync(dir, { recursive: true, force: true });
	}
}

export interface CleanupResult {
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
	const records = await readThreadRecords(configPath).catch(() => []);
	const claimed = await readReferencedDurablePaths(configPath).catch(() => new Set<string>());
	const keep = (path: string) => [...claimed].some((claim) => path.startsWith(claim) || claim.startsWith(path));

	sweepProjectTempDirs(root);
	sweepProjectDurableDirs(root, { keep, isAlive: isProcessAlive });
	sweepProjectResultArtifacts(root, { now: options.now });
	for (const project of before.projects) removeEmptySessionCopies(project.path, [...claimed]);
	const removedProjects = await pruneStaleProjectRoots(configPath, { referenced: claimed, now: options.now }).catch(() => [] as string[]);

	// A project directory that just lost its last artifact should disappear too.
	for (const project of before.projects) {
		if (!existsSync(project.path)) continue;
		try {
			if (readdirSync(project.path).length === 0) rmSync(project.path, { recursive: true, force: true });
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
