import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	createWorktreeIsolation,
	resolveWorktreeTarget,
	runCommand,
	type WorktreeIsolation,
} from "../src/worktree.ts";

function git(cwd: string, args: string[]): string {
	return execFileSync("git", args, {
		cwd,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	}).trim();
}

function createRepo(): string {
	const repo = mkdtempSync(join(tmpdir(), "pi-subagents-worktree-test-"));
	git(repo, ["init"]);
	// Identity is local to this disposable repository; never touch global config.
	git(repo, ["config", "user.email", "pi-subagents-tests@example.invalid"]);
	git(repo, ["config", "user.name", "pi-subagents tests"]);
	git(repo, ["config", "core.autocrlf", "false"]);
	writeFileSync(join(repo, "tracked.txt"), "base\n", "utf8");
	writeFileSync(join(repo, "delete-me.txt"), "delete me\n", "utf8");
	writeFileSync(join(repo, "parent-only.txt"), "parent base\n", "utf8");
	writeFileSync(join(repo, "conflict.txt"), "shared base\n", "utf8");
	rmSync(join(repo, "nested"), { recursive: true, force: true });
	mkdirSync(join(repo, "nested"), { recursive: true });
	writeFileSync(join(repo, "nested", "inside.txt"), "inside\n", "utf8");
	git(repo, ["add", "."]);
	git(repo, ["commit", "-m", "test base"]);
	return repo;
}

const repos: string[] = [];
const retained: Array<{ repo: string; handle: WorktreeIsolation }> = [];

afterEach(() => {
	for (const { repo, handle } of retained.splice(0)) {
		try {
			if (existsSync(handle.worktreePath)) git(repo, ["worktree", "remove", "--force", handle.worktreePath]);
			git(repo, ["worktree", "prune"]);
		} catch {
			/* best-effort test cleanup */
		}
		try {
			rmSync(handle.tempDir, { recursive: true, force: true });
		} catch {
			/* best-effort test cleanup */
		}
	}
	for (const repo of repos.splice(0)) rmSync(repo, { recursive: true, force: true });
});

describe("bounded Git command runner", () => {
	it("terminates commands that exceed their deadline", async () => {
		await expect(runCommand(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
			cwd: process.cwd(),
			timeoutMs: 30,
			maxOutputBytes: 1024,
		})).rejects.toThrow(/timed out after 30ms/i);
	});

	it("terminates commands before buffering oversized output", async () => {
		await expect(runCommand(process.execPath, ["-e", "process.stdout.write('x'.repeat(4096))"], {
			cwd: process.cwd(),
			timeoutMs: 5_000,
			maxOutputBytes: 128,
		})).rejects.toThrow(/output exceeded 128 bytes/i);
	});
});

describe("Git worktree isolation lifecycle", () => {
	it("rejects cwd outside a Git worktree without degrading to shared", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-subagents-not-git-"));
		repos.push(dir);
		await expect(resolveWorktreeTarget(dir)).rejects.toThrow(/inside a Git worktree\/repository/i);
		await expect(createWorktreeIsolation(dir)).rejects.toThrow(/inside a Git worktree\/repository/i);
	});

	it("creates a detached worktree and mirrors a requested subdirectory", async () => {
		const repo = createRepo();
		repos.push(repo);
		const requested = join(repo, "nested");
		const handle = await createWorktreeIsolation(requested);
		expect(existsSync(handle.worktreePath)).toBe(true);
		expect(existsSync(handle.cwd)).toBe(true);
		expect(relative(handle.worktreePath, handle.cwd)).toBe("nested");
		expect(readFileSync(join(handle.cwd, "inside.txt"), "utf8")).toBe("inside\n");
		expect(git(handle.worktreePath, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("HEAD");
		expect(resolve(handle.originalRoot)).toBe(resolve(repo));

		const result = await handle.finalize();
		expect(result).toMatchObject({ status: "no_changes", hadChanges: false, integrated: false });
		expect(existsSync(handle.tempDir)).toBe(false);
		expect(git(repo, ["worktree", "list", "--porcelain"])).not.toContain(handle.worktreePath);
	});

	it("integrates tracked edits, deletion, untracked text/binary without staging or clobbering parent edits", async () => {
		const repo = createRepo();
		repos.push(repo);
		// This dirty parent edit is unrelated and must survive patch application.
		writeFileSync(join(repo, "parent-only.txt"), "parent dirty edit\n", "utf8");
		const handle = await createWorktreeIsolation(repo);

		writeFileSync(join(handle.worktreePath, "tracked.txt"), "worker edit\n", "utf8");
		rmSync(join(handle.worktreePath, "delete-me.txt"));
		writeFileSync(join(handle.worktreePath, "new-text.txt"), "new text\n", "utf8");
		const binary = Buffer.from([0, 255, 1, 2, 3, 128, 64]);
		writeFileSync(join(handle.worktreePath, "new-binary.bin"), binary);

		const first = handle.finalize();
		const second = handle.finalize();
		expect(second).toBe(first);
		const result = await first;
		expect(result).toEqual({ status: "integrated", integrated: true, hadChanges: true });
		expect(readFileSync(join(repo, "tracked.txt"), "utf8")).toBe("worker edit\n");
		expect(existsSync(join(repo, "delete-me.txt"))).toBe(false);
		expect(readFileSync(join(repo, "new-text.txt"), "utf8")).toBe("new text\n");
		expect(readFileSync(join(repo, "new-binary.bin"))).toEqual(binary);
		expect(readFileSync(join(repo, "parent-only.txt"), "utf8")).toBe("parent dirty edit\n");
		// git apply updates only the working tree; the parent index remains untouched.
		expect(git(repo, ["diff", "--cached", "--name-only"])).toBe("");
		expect(existsSync(handle.tempDir)).toBe(false);
	});

	it("seeds a settled continuation and integrates only follow-on edits", async () => {
		const repo = createRepo();
		repos.push(repo);
		const first = await createWorktreeIsolation(repo);
		writeFileSync(join(first.worktreePath, "tracked.txt"), "generation one\n", "utf8");
		expect(await first.finalize()).toMatchObject({ status: "integrated", integrated: true });
		const seedCheckpoint = await first.snapshotCheckpoint();
		expect(seedCheckpoint.patch.length).toBeGreaterThan(0);

		const continuation = await createWorktreeIsolation(repo, {
			seedCheckpoint,
			seedIsIntegrated: true,
		});
		expect(readFileSync(join(continuation.worktreePath, "tracked.txt"), "utf8")).toBe("generation one\n");
		writeFileSync(join(continuation.worktreePath, "tracked.txt"), "generation two\n", "utf8");
		expect(await continuation.finalize()).toMatchObject({ status: "integrated", integrated: true });
		expect(readFileSync(join(repo, "tracked.txt"), "utf8")).toBe("generation two\n");
		expect(git(repo, ["diff", "--cached", "--name-only"])).toBe("");
	});

	it("integrates only each fork's unique edits after one shared seed", async () => {
		const repo = createRepo();
		repos.push(repo);
		const source = await createWorktreeIsolation(repo);
		writeFileSync(join(source.worktreePath, "tracked.txt"), "shared seed\n", "utf8");
		expect(await source.finalize()).toMatchObject({ status: "integrated", integrated: true });
		const seedCheckpoint = await source.snapshotCheckpoint();

		const firstFork = await createWorktreeIsolation(repo, { seedCheckpoint, seedIsIntegrated: true });
		const secondFork = await createWorktreeIsolation(repo, { seedCheckpoint, seedIsIntegrated: true });
		writeFileSync(join(firstFork.worktreePath, "fork-one.txt"), "one\n", "utf8");
		writeFileSync(join(secondFork.worktreePath, "fork-two.txt"), "two\n", "utf8");
		expect(await firstFork.finalize()).toMatchObject({ status: "integrated", integrated: true });
		expect(await secondFork.finalize()).toMatchObject({ status: "integrated", integrated: true });
		expect(readFileSync(join(repo, "tracked.txt"), "utf8")).toBe("shared seed\n");
		expect(readFileSync(join(repo, "fork-one.txt"), "utf8")).toBe("one\n");
		expect(readFileSync(join(repo, "fork-two.txt"), "utf8")).toBe("two\n");
	});

	it("recognizes an integrated seed after the parent commits it", async () => {
		const repo = createRepo();
		repos.push(repo);
		const first = await createWorktreeIsolation(repo);
		writeFileSync(join(first.worktreePath, "tracked.txt"), "generation one\n", "utf8");
		expect(await first.finalize()).toMatchObject({ status: "integrated", integrated: true });
		const seedCheckpoint = await first.snapshotCheckpoint();
		git(repo, ["add", "tracked.txt"]);
		git(repo, ["commit", "-m", "integrate generation one"]);

		const continuation = await createWorktreeIsolation(repo, {
			seedCheckpoint,
			seedIsIntegrated: true,
		});
		expect(readFileSync(join(continuation.worktreePath, "tracked.txt"), "utf8")).toBe("generation one\n");
		writeFileSync(join(continuation.worktreePath, "tracked.txt"), "generation two\n", "utf8");
		expect(await continuation.finalize()).toMatchObject({ status: "integrated", integrated: true });
		expect(readFileSync(join(repo, "tracked.txt"), "utf8")).toBe("generation two\n");
	});

	it("retains the worktree and binary patch when parent changes conflict", async () => {
		const repo = createRepo();
		repos.push(repo);
		const handle = await createWorktreeIsolation(repo);
		retained.push({ repo, handle });
		writeFileSync(join(handle.worktreePath, "conflict.txt"), "worker version\n", "utf8");
		writeFileSync(join(repo, "conflict.txt"), "parent version\n", "utf8");

		const result = await handle.finalize();
		expect(result.status).toBe("retained");
		expect(result.integrated).toBe(false);
		expect(result.hadChanges).toBe(true);
		expect(result.worktreePath).toBe(handle.worktreePath);
		expect(result.patchPath).toBe(handle.patchPath);
		expect(result.error).toMatch(/Applying isolated patch.*failed/i);
		expect(existsSync(handle.worktreePath)).toBe(true);
		expect(existsSync(handle.patchPath)).toBe(true);
		expect(readFileSync(join(repo, "conflict.txt"), "utf8")).toBe("parent version\n");
		expect(readFileSync(join(handle.worktreePath, "conflict.txt"), "utf8")).toBe("worker version\n");
		expect(readFileSync(handle.patchPath).includes(Buffer.from("worker version"))).toBe(true);
		expect(git(repo, ["diff", "--cached", "--name-only"])).toBe("");
	});

	it("recreates an equivalent untracked/empty cwd in the isolated tree", async () => {
		const repo = createRepo();
		repos.push(repo);
		const empty = join(repo, "untracked", "deep");
		await mkdir(empty, { recursive: true });
		const handle = await createWorktreeIsolation(empty);
		expect(relative(handle.worktreePath, handle.cwd)).toBe(join("untracked", "deep"));
		expect(existsSync(handle.cwd)).toBe(true);
		const result = await handle.finalize();
		expect(result.status).toBe("no_changes");
	});
});
