import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	isProcessAlive,
	killProcessTree,
	sweepOrphanTempDirs,
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
	it("removes only dead-owner and old-unmarked directories", () => {
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
		const oldUnmarked = makeDir(root, "pi-subagent-session-legacy");
		aged(oldUnmarked);
		const freshUnmarked = makeDir(root, "pi-subagent-session-fresh");
		const results = makeDir(root, "pi-subagents-results");
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
		expect(existsSync(results)).toBe(true);
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
});

