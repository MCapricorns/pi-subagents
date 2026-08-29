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
import { describe, expect, it, type TestContext } from "vitest";
import {
	createWorktreeIsolation,
	resolveRepositoryRoot,
	resolveWorktreeTarget,
	runCommand,
	type CommandRunner,
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

/** Per-test cleanup registration keeps concurrent tests from draining each
 * other's repositories: artifacts are recorded against the owning test's
 * context (the global onTestFinished cannot attribute callers reliably under
 * describe.concurrent) instead of a module-level afterEach sweep. */
function trackDir(ctx: TestContext, dir: string): void {
	ctx.onTestFinished(() => {
		rmSync(dir, { recursive: true, force: true });
	});
}

function trackWorktree(ctx: TestContext, repo: string, ...handles: WorktreeIsolation[]): void {
	ctx.onTestFinished(() => {
		for (const handle of handles) {
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
	});
}

describe.concurrent("bounded Git command runner", () => {
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

// Every lifecycle test spawns dozens of git subprocesses; on Windows that alone
// can exceed the default 5s per test, so the whole block gets a wider ceiling.
describe.concurrent("Git worktree isolation lifecycle", { timeout: 30_000 }, () => {
	it("rejects cwd outside a Git worktree without degrading to shared", async (ctx) => {
		const dir = mkdtempSync(join(tmpdir(), "pi-subagents-not-git-"));
		trackDir(ctx, dir);
		await expect(resolveWorktreeTarget(dir)).rejects.toThrow(/inside a Git worktree\/repository/i);
		await expect(createWorktreeIsolation(dir)).rejects.toThrow(/inside a Git worktree\/repository/i);
	});

	it("canonicalizes root and nested paths in an empty repository without requiring HEAD", async (ctx) => {
		const repo = mkdtempSync(join(tmpdir(), "pi-subagents-empty-repo-"));
		trackDir(ctx, repo);
		git(repo, ["init"]);
		const nested = join(repo, "nested");
		mkdirSync(nested, { recursive: true });

		const rootIdentity = await resolveRepositoryRoot(repo);
		const nestedIdentity = await resolveRepositoryRoot(nested);
		expect(nestedIdentity).toBe(rootIdentity);
		await expect(resolveWorktreeTarget(nested)).rejects.toThrow(/committed HEAD/i);
	});

	it("creates a detached worktree and mirrors a requested subdirectory", async (ctx) => {
		const repo = createRepo();
		trackDir(ctx, repo);
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

	it("integrates tracked edits, deletion, untracked text/binary without staging or clobbering parent edits", async (ctx) => {
		const repo = createRepo();
		trackDir(ctx, repo);
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

	it("integrates only each fork's unique edits after one shared seed", async (ctx) => {
		const repo = createRepo();
		trackDir(ctx, repo);
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

	it("three-way merges a later fork whose patch context drifted in the checkout", async (ctx) => {
		const repo = createRepo();
		trackDir(ctx, repo);
		const lines = ["one", "two", "three", "four", "five", "six", "seven"];
		writeFileSync(join(repo, "tracked.txt"), `${lines.join("\n")}\n`, "utf8");
		git(repo, ["add", "."]);
		git(repo, ["commit", "-qm", "seven lines"]);

		const firstFork = await createWorktreeIsolation(repo);
		const secondFork = await createWorktreeIsolation(repo);
		trackWorktree(ctx, repo, firstFork, secondFork);
		// The second fork's patch context includes line one, which the first
		// fork will have already changed by the time it integrates.
		writeFileSync(join(firstFork.worktreePath, "tracked.txt"), `${["A1", ...lines.slice(1)].join("\n")}\n`, "utf8");
		writeFileSync(join(secondFork.worktreePath, "tracked.txt"), `${[...lines.slice(0, 3), "B4", ...lines.slice(4)].join("\n")}\n`, "utf8");

		// Integration is serialized by the repository lane in production; drive
		// the same order here.
		expect(await firstFork.finalize()).toMatchObject({ status: "integrated", integrated: true });
		expect(await secondFork.finalize()).toMatchObject({ status: "integrated", integrated: true });
		const merged = readFileSync(join(repo, "tracked.txt"), "utf8").split("\n");
		expect(merged[0]).toBe("A1");
		expect(merged[3]).toBe("B4");
		// The three-way apply still never stages anything for the user.
		expect(git(repo, ["diff", "--cached", "--name-only"])).toBe("");
	});

	it("retains a later fork that edits the same lines as an integrated one", async (ctx) => {
		const repo = createRepo();
		trackDir(ctx, repo);
		const firstFork = await createWorktreeIsolation(repo);
		const secondFork = await createWorktreeIsolation(repo);
		trackWorktree(ctx, repo, firstFork, secondFork);
		writeFileSync(join(firstFork.worktreePath, "tracked.txt"), "fork one\n", "utf8");
		writeFileSync(join(secondFork.worktreePath, "tracked.txt"), "fork two\n", "utf8");

		expect(await firstFork.finalize()).toMatchObject({ status: "integrated", integrated: true });
		const conflicted = await secondFork.finalize();
		expect(conflicted.status).toBe("retained");
		expect(conflicted.integrated).toBe(false);
		expect(conflicted.patchPath).toBeDefined();
		// A genuine overlap leaves conflict markers in the checkout (ours =
		// the integrated winner, theirs = the losing fork) plus the retained
		// worktree and patch, so the main model can resolve it in place.
		const conflictedFile = readFileSync(join(repo, "tracked.txt"), "utf8");
		expect(conflictedFile).toContain("fork one");
		expect(conflictedFile).toContain("fork two");
		expect(conflictedFile).toContain("<<<<<<< ours");
		expect(git(repo, ["diff", "--cached", "--name-only"])).toBe("");
	});

	it("recognizes an integrated seed after the parent commits it", async (ctx) => {
		const repo = createRepo();
		trackDir(ctx, repo);
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

	it("retains the worktree and binary patch when parent changes conflict", async (ctx) => {
		const repo = createRepo();
		trackDir(ctx, repo);
		const handle = await createWorktreeIsolation(repo);
		trackWorktree(ctx, repo, handle);
		writeFileSync(join(handle.worktreePath, "conflict.txt"), "worker version\n", "utf8");
		writeFileSync(join(repo, "conflict.txt"), "parent version\n", "utf8");

		const result = await handle.finalize();
		expect(result.status).toBe("retained");
		expect(result.integrated).toBe(false);
		expect(result.hadChanges).toBe(true);
		expect(result.worktreePath).toBe(handle.worktreePath);
		expect(result.patchPath).toBe(handle.patchPath);
		expect(result.error).toMatch(/(three-way applying|applying) isolated patch.*failed/i);
		expect(existsSync(handle.worktreePath)).toBe(true);
		expect(existsSync(handle.patchPath)).toBe(true);
		// Both sides of the unresolved overlap stay visible: conflict markers
		// carry the parent's version in the checkout while the worktree and
		// patch keep the worker's.
		const conflictedFile = readFileSync(join(repo, "conflict.txt"), "utf8");
		expect(conflictedFile).toContain("parent version");
		expect(conflictedFile).toContain("worker version");
		expect(conflictedFile).toContain("<<<<<<< ours");
		expect(readFileSync(join(handle.worktreePath, "conflict.txt"), "utf8")).toBe("worker version\n");
		expect(readFileSync(handle.patchPath).includes(Buffer.from("worker version"))).toBe(true);
		expect(git(repo, ["diff", "--cached", "--name-only"])).toBe("");
	});

	it("recreates an equivalent untracked/empty cwd in the isolated tree", async (ctx) => {
		const repo = createRepo();
		trackDir(ctx, repo);
		const empty = join(repo, "untracked", "deep");
		await mkdir(empty, { recursive: true });
		const handle = await createWorktreeIsolation(empty);
		expect(relative(handle.worktreePath, handle.cwd)).toBe(join("untracked", "deep"));
		expect(existsSync(handle.cwd)).toBe(true);
		const result = await handle.finalize();
		expect(result.status).toBe("no_changes");
	});
});
