/** Cross-process serialization for shared durable manifests. */

import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { mkdir, readdir, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import { uptime } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { isProcessAlive } from "./temp-hygiene.ts";

const LOCK_TIMEOUT_MS = 15_000;
const EMPTY_LOCK_MAX_AGE_MS = 60_000;
const BOOT_TOLERANCE_MS = 60_000;

function bootId(): number {
	return Math.round(Date.now() - uptime() * 1_000);
}

async function releaseLock(lockDir: string, owner: string): Promise<void> {
	// Only the contender which removed this unique owner file may remove its
	// directory. A second stale-lock reaper cannot unlink a successor's lock.
	await unlink(join(lockDir, owner));
	await rmdir(lockDir).catch(() => undefined);
}

async function reapAbandonedLock(lockDir: string): Promise<void> {
	try {
		const owners = await readdir(lockDir);
		if (owners.length === 0) {
			// A process can die between mkdir and writing its owner marker. Fresh
			// empty locks belong to contenders still acquiring them.
			if (Date.now() - (await stat(lockDir)).mtimeMs >= EMPTY_LOCK_MAX_AGE_MS) await rmdir(lockDir);
			return;
		}
		if (owners.length !== 1) return;
		const owner = owners[0]!;
		const match = /^(\d+)-(\d+)-[0-9a-f-]+$/.exec(owner);
		if (!match) return;
		if (Math.abs(Number(match[2]) - bootId()) <= BOOT_TOLERANCE_MS && isProcessAlive(Number(match[1]))) return;
		await releaseLock(lockDir, owner);
	} catch {
		/* Another contender may already have released this abandoned lock. */
	}
}

/** Keep the host's in-process queue and lock the entire read/modify/write across
 * Pi windows too. Dead owners are reclaimable without a heartbeat or an age
 * cutoff that could steal a live writer's lock. */
export function withManifestMutation<T>(path: string, mutate: () => Promise<T>): Promise<T> {
	return withFileMutationQueue(path, async () => {
		await mkdir(dirname(path), { recursive: true });
		const lockDir = `${path}.lock`;
		const owner = `${process.pid}-${bootId()}-${randomUUID()}`;
		const deadline = Date.now() + LOCK_TIMEOUT_MS;
		while (true) {
			try {
				await mkdir(lockDir);
				break;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
				await reapAbandonedLock(lockDir);
				if (Date.now() >= deadline) throw new Error(`Timed out waiting for manifest lock: ${path}`);
				await delay(25);
			}
		}
		try {
			await writeFile(join(lockDir, owner), "", "utf8");
			return await mutate();
		} finally {
			await releaseLock(lockDir, owner).catch(() => undefined);
		}
	});
}
