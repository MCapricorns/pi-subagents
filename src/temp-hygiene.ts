/**
 * Temp hygiene: ownership markers and startup sweeps for the directories this
 * extension creates under a project's durable root.
 *
 * Two classes live there and both are swept the same way. Transient per-run
 * files (child prompt copies, the no-retry policy extension) sit in `tmp/`;
 * retained child sessions and isolated worktrees sit in `sessions/` and
 * `worktrees/`, where they must outlive the process that made them so a reload
 * can resume from them. Every mkdtemp directory gets an owner marker with the
 * creating pid. At extension load, directories whose owner is dead are removed;
 * unmarked leftovers fall back to an age cap.
 *
 * Ownership is what makes this safe for the durable class. A retained session
 * that no manifest record claims — a settled thread still resumable in the
 * session that produced it — belongs to a live owner and survives; the same
 * directory left behind by a crash does not. Callers sweeping durable roots
 * additionally pass the paths their manifest still references, so parked work is
 * never removed even if its owner is long gone.
 *
 * A live sibling pi instance never loses its directories: `kill(pid, 0)` only
 * reports "no such process" when the pid genuinely does not exist, so a live
 * owner always survives the sweep. Pid reuse merely delays cleanup until the
 * reusing process exits or the age cap catches the directory.
 */

import { spawn } from "node:child_process";
import { type Dirent, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const TEMP_OWNER_FILE_NAME = "owner.json";

/** Transient directories created under `<project>/tmp`: the child prompt
 * copies (`pi-subagents-*`) and the no-retry policy extension
 * (`pi-subagents-policy-*`). The singular `pi-subagent-` prefixes below belong
 * to the durable roots and are swept separately, under a reference guard. */
const TEMP_DIR_PREFIXES = ["pi-subagents-"] as const;

/** Durable directories created under `<project>/sessions` and
 * `<project>/worktrees`: retained child sessions (including resume forks) and
 * isolated worktree groups. */
const DURABLE_DIR_PREFIXES = ["pi-subagent-session-", "pi-subagent-worktree-"] as const;

/** Durable subdirectories of a project root that hold owner-marked state. */
const DURABLE_SUBDIRS = ["sessions", "worktrees"] as const;

/** Unmarked directories (crash before the marker write) must outlive this age
 * before removal. */
export const UNMARKED_TEMP_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1_000;

interface TempOwner {
	pid: number;
	createdAt: number;
}

export function isProcessAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// EPERM means the process exists but belongs to another user.
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** Best-effort marker write; a missing marker only delays cleanup. */
export function writeTempOwnerMarker(dir: string, now = Date.now()): void {
	try {
		writeFileSync(
			join(dir, TEMP_OWNER_FILE_NAME),
			`${JSON.stringify({ pid: process.pid, createdAt: now } satisfies TempOwner)}\n`,
			"utf8",
		);
	} catch {
		/* marker failures must never break the creating operation */
	}
}

function readTempOwnerMarker(dir: string): TempOwner | undefined {
	try {
		const parsed = JSON.parse(readFileSync(join(dir, TEMP_OWNER_FILE_NAME), "utf8")) as Partial<TempOwner>;
		if (typeof parsed.pid !== "number" || !Number.isInteger(parsed.pid) || parsed.pid <= 0) return undefined;
		return { pid: parsed.pid, createdAt: typeof parsed.createdAt === "number" ? parsed.createdAt : 0 };
	} catch {
		return undefined;
	}
}

/** Terminate a whole process tree without waiting. Used on restore for child
 * processes orphaned by a reload or crash that still hold a retained session. */
export function killProcessTree(pid: number): void {
	if (!Number.isInteger(pid) || pid <= 0) return;
	if (process.platform === "win32") {
		try {
			spawn("taskkill", ["/pid", String(pid), "/t", "/f"], {
				stdio: "ignore",
				windowsHide: true,
			}).once("error", () => undefined);
		} catch {
			/* the process is gone */
		}
		return;
	}
	try {
		process.kill(pid, "SIGKILL");
	} catch {
		/* the process is gone */
	}
}

export interface SweepOptions {
	now?: number;
	/** Injectable pid liveness probe for tests. */
	isAlive?: (pid: number) => boolean;
	/** Override the unmarked-directory age cap for tests. */
	unmarkedMaxAgeMs?: number;
	/** Directory-name prefixes this sweep owns; defaults to the transient set. */
	prefixes?: readonly string[];
	/** Directories a durable record still claims. Kept whatever their owner. */
	keep?: (path: string) => boolean;
}

function removeDir(path: string): boolean {
	try {
		rmSync(path, { recursive: true, force: true });
		return true;
	} catch {
		// Windows locks (antivirus, indexer) leave the directory for a later sweep.
		return false;
	}
}

function directoryAgeMs(entry: Dirent, dir: string, now: number): number | undefined {
	try {
		return now - statSync(join(dir, entry.name)).mtimeMs;
	} catch {
		return undefined;
	}
}

/** Remove dead-owner and old-unmarked directories under `rootDir`.
 * Returns how many directories were removed. */
export function sweepOrphanTempDirs(
	rootDir: string,
	options: SweepOptions = {},
): number {
	const now = options.now ?? Date.now();
	const isAlive = options.isAlive ?? isProcessAlive;
	const unmarkedMaxAgeMs = options.unmarkedMaxAgeMs ?? UNMARKED_TEMP_MAX_AGE_MS;
	const prefixes = options.prefixes ?? TEMP_DIR_PREFIXES;
	let entries: Dirent[];
	try {
		entries = readdirSync(rootDir, { withFileTypes: true });
	} catch {
		return 0;
	}
	let removed = 0;
	for (const entry of entries) {
		if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
		if (!prefixes.some((prefix) => entry.name.startsWith(prefix))) continue;
		const path = join(rootDir, entry.name);
		if (options.keep?.(path)) continue;
		const owner = readTempOwnerMarker(path);
		if (owner) {
			// An unmarked fresh sibling race is impossible here: the marker is
			// written immediately after mkdtemp. A marked dir dies only with its
			// owning process.
			if (isAlive(owner.pid)) continue;
			if (removeDir(path)) removed++;
			continue;
		}
		const ageMs = directoryAgeMs(entry, rootDir, now);
		if (ageMs !== undefined && ageMs > unmarkedMaxAgeMs && removeDir(path)) removed++;
	}
	return removed;
}

/** Sweep every project's transient tmp directory under the durable extension
 * root, so crash leftovers from any checkout die on the next load. */
export function sweepProjectTempDirs(
	durableRoot: string,
	options: SweepOptions = {},
): number {
	let projects: Dirent[];
	try {
		projects = readdirSync(durableRoot, { withFileTypes: true });
	} catch {
		return 0;
	}
	let removed = 0;
	for (const project of projects) {
		if (!project.isDirectory() || project.isSymbolicLink()) continue;
		removed += sweepOrphanTempDirs(join(durableRoot, project.name, "tmp"), options);
	}
	return removed;
}

/** Sweep every project's retained sessions and isolated worktrees whose owning
 * process is gone and which no durable record claims. Without this, a crash
 * leaves a full worktree checkout and its session behind until the whole project
 * goes idle for days — which never happens in a checkout still being worked in.
 *
 * `keep` must report every path the threads manifest still references; parked
 * work outlives its owner by design. Removal is a plain recursive delete, the
 * same as the idle-project rule: an abandoned worktree may leave a prunable
 * registration in its origin repository, which `git worktree prune` and routine
 * gc clear on their own. */
export function sweepProjectDurableDirs(
	durableRoot: string,
	options: SweepOptions = {},
): number {
	let projects: Dirent[];
	try {
		projects = readdirSync(durableRoot, { withFileTypes: true });
	} catch {
		return 0;
	}
	let removed = 0;
	for (const project of projects) {
		if (!project.isDirectory() || project.isSymbolicLink()) continue;
		for (const subdir of DURABLE_SUBDIRS) {
			removed += sweepOrphanTempDirs(join(durableRoot, project.name, subdir), {
				...options,
				prefixes: options.prefixes ?? DURABLE_DIR_PREFIXES,
			});
		}
	}
	return removed;
}

