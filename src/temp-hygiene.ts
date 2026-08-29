/**
 * Temp hygiene: ownership markers and startup sweeps for the transient
 * directories this extension creates.
 *
 * Transient per-run files (child prompt copies, the no-retry policy extension)
 * live under the project's durable tmp directory, never the OS temp dir. Each
 * mkdtemp directory gets an owner marker with the creating pid. At extension
 * load, directories whose owner is dead are removed; unmarked leftovers fall
 * back to an age cap.
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
 * (`pi-subagents-policy-*`). Durable sessions and worktrees use the singular
 * `pi-subagent-` prefixes and live in their own roots, never swept here. */
const TEMP_DIR_PREFIXES = ["pi-subagents-"] as const;

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

/** Remove dead-owner and old-unmarked transient directories under `rootDir`.
 * Returns how many directories were removed. */
export function sweepOrphanTempDirs(
	rootDir: string,
	options: SweepOptions = {},
): number {
	const now = options.now ?? Date.now();
	const isAlive = options.isAlive ?? isProcessAlive;
	const unmarkedMaxAgeMs = options.unmarkedMaxAgeMs ?? UNMARKED_TEMP_MAX_AGE_MS;
	let entries: Dirent[];
	try {
		entries = readdirSync(rootDir, { withFileTypes: true });
	} catch {
		return 0;
	}
	let removed = 0;
	for (const entry of entries) {
		if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
		if (!TEMP_DIR_PREFIXES.some((prefix) => entry.name.startsWith(prefix))) continue;
		const path = join(rootDir, entry.name);
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

