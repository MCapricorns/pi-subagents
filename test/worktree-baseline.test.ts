import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";
import { runCommand, type CommandRunner } from "../src/isolation/git-command.ts";
import {
	createWorktreeIsolation,
	isPathInside,
	restoreWorktreeIsolation,
	worktreeSnapshot,
	type WorktreeIsolation,
} from "../src/isolation/worktree.ts";

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
	return (await execFileAsync("git", args, { cwd })).stdout.trim();
}

/** Uncommitted worktree state against its baseline, including untracked files. */
async function pendingChanges(worktree: WorktreeIsolation): Promise<string> {
	return git(worktree.worktreePath, "status", "--porcelain", "--untracked-files=all");
}

async function callerState(cwd: string) {
	return {
		index: await readFile(resolve(cwd, await git(cwd, "rev-parse", "--git-path", "index"))),
		headFile: await readFile(resolve(cwd, await git(cwd, "rev-parse", "--git-path", "HEAD"))),
		head: await git(cwd, "rev-parse", "HEAD"),
		branch: await git(cwd, "symbolic-ref", "HEAD"),
		history: await git(cwd, "log", "--format=raw", "HEAD"),
		reflog: await git(cwd, "reflog", "HEAD"),
	};
}

async function withRepository(
	run: (repository: string, isolate: (
		cwd?: string, options?: Omit<Parameters<typeof createWorktreeIsolation>[1], "tempBaseDir">,
	) => Promise<WorktreeIsolation>) => Promise<void>,
	directoryName = "repository",
): Promise<void> {
	const root = await mkdtemp(join(tmpdir(), "pi-worktree-baseline-"));
	const repository = join(root, directoryName);
	const worktrees: WorktreeIsolation[] = [];
	try {
		await mkdir(repository);
		await git(repository, "init");
		await git(repository, "config", "user.name", "Baseline Test");
		await git(repository, "config", "user.email", "baseline@example.invalid");
		await git(repository, "config", "core.autocrlf", "false");
		await writeFile(join(repository, ".gitignore"), "ignored.txt\n");
		await writeFile(join(repository, "tracked.txt"), "committed\n");
		await writeFile(join(repository, "deleted.txt"), "delete me\n");
		await git(repository, "add", ".");
		await git(repository, "commit", "-m", "Initial fixture");
		await run(repository, async (cwd = repository, options) => {
			const worktree = await createWorktreeIsolation(cwd, { ...options, tempBaseDir: join(root, "worktrees") });
			worktrees.push(worktree);
			return worktree;
		});
	} finally {
		try {
			for (const worktree of worktrees) await worktree.discard();
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	}
}

describe("worktree caller baselines (real Git)", () => {
	it("snapshots staged, unstaged, added, deleted and untracked content without changing the caller", async () => {
		await withRepository(async (repository, isolate) => {
			await writeFile(join(repository, "tracked.txt"), "staged version\n");
			await writeFile(join(repository, "added.txt"), "staged addition\n");
			await git(repository, "add", "tracked.txt", "added.txt");
			await writeFile(join(repository, "tracked.txt"), "staged and unstaged version\n");
			await writeFile(join(repository, "added.txt"), "staged addition with unstaged edits\n");
			await rm(join(repository, "deleted.txt"));
			await mkdir(join(repository, "nested"));
			const binary = Buffer.from([0, 1, 255, 13, 10]);
			await writeFile(join(repository, "nested", "untracked.bin"), binary);
			await writeFile(join(repository, "ignored.txt"), "excluded\n");
			const before = await callerState(repository);

			const worktree = await isolate(join(repository, "nested"));
			assert.equal(await readFile(join(worktree.worktreePath, "tracked.txt"), "utf8"), "staged and unstaged version\n");
			assert.equal(await readFile(join(worktree.worktreePath, "added.txt"), "utf8"), "staged addition with unstaged edits\n");
			assert.deepEqual(await readFile(join(worktree.cwd, "untracked.bin")), binary);
			assert.equal(existsSync(join(worktree.worktreePath, "deleted.txt")), false);
			assert.equal(existsSync(join(worktree.worktreePath, "ignored.txt")), false);
			assert.deepEqual(await callerState(repository), before);
			assert.equal(await git(worktree.worktreePath, "rev-parse", "HEAD"), worktree.head);
			assert.equal(worktree.integrationBaseHead, worktree.head);
			assert.notEqual(worktree.head, before.head);
			assert.equal(await git(repository, "rev-parse", worktree.head + "^"), before.head);
			assert.equal(await pendingChanges(worktree), "");

			const snapshot = worktreeSnapshot(worktree)!;
			const restored = await restoreWorktreeIsolation(snapshot);
			assert.ok(restored);
			assert.equal(await pendingChanges(restored), "");
			assert.deepEqual(await restored.finalize(), { status: "no_changes", integrated: false, hadChanges: false });
			assert.equal(restored.getContinuationCheckpoint()?.commit, worktree.head);
			assert.equal(existsSync(worktree.tempDir), false);
			assert.deepEqual(await callerState(repository), before);
			assert.equal(await readFile(join(repository, "tracked.txt"), "utf8"), "staged and unstaged version\n");
			assert.deepEqual(await readFile(join(repository, "nested", "untracked.bin")), binary);
			assert.equal(existsSync(join(repository, "deleted.txt")), false);
			assert.equal(await readFile(join(repository, "ignored.txt"), "utf8"), "excluded\n");
		});
	});

	it("lets a dependent writer extend an integrated but uncommitted module without replaying its creation", async () => {
		await withRepository(async (repository, isolate) => {
			const before = await callerState(repository);
			const first = await isolate();
			const moduleA = "export const first = 1;\n";
			await writeFile(join(first.cwd, "module.ts"), moduleA);
			assert.equal((await first.finalize()).status, "integrated");
			assert.equal(await readFile(join(repository, "module.ts"), "utf8"), moduleA);
			assert.deepEqual(await callerState(repository), before);

			const second = await isolate();
			assert.equal(await readFile(join(second.cwd, "module.ts"), "utf8"), moduleA);
			assert.equal(await pendingChanges(second), "");
			const moduleB = moduleA + "export const second = first + 1;\n";
			await writeFile(join(second.cwd, "module.ts"), moduleB);
			assert.match(await pendingChanges(second), /module\.ts/u);
			assert.equal((await second.finalize()).status, "integrated");
			assert.equal(await readFile(join(repository, "module.ts"), "utf8"), moduleB);
			assert.deepEqual(await callerState(repository), before);
			const checkpoint = second.getContinuationCheckpoint()!;
			assert.equal(checkpoint.baseHead, second.head);
			assert.equal(await git(repository, "show", checkpoint.commit + ":module.ts"), moduleB.trim());
			assert.equal(await git(repository, "show", checkpoint.baseHead + ":module.ts"), moduleA.trim());
			const snapshot = worktreeSnapshot(second)!;
			const restored = await restoreWorktreeIsolation(snapshot);
			assert.ok(restored);
			assert.deepEqual(worktreeSnapshot(restored), snapshot, "a restored checkpoint keeps its Git references");
			assert.deepEqual(await restored.finalize(), { status: "integrated", integrated: true, hadChanges: true });
			assert.equal(await readFile(join(repository, "module.ts"), "utf8"), moduleB);
		});
	});

	it("retains a patch when its recovery checkpoint commit fails", async () => {
		await withRepository(async (repository, isolate) => {
			const runner: CommandRunner = (command, args, options) => {
				if (args.includes("pi-subagents isolated checkpoint")) throw new Error("checkpoint creation unavailable");
				return runCommand(command, args, options);
			};
			const worktree = await isolate(undefined, { runner });
			await writeFile(join(worktree.cwd, "tracked.txt"), "isolated edit\n");
			const outcome = await worktree.finalize();
			assert.equal(outcome.status, "retained");
			assert.equal(outcome.hadChanges, true);
			assert.match(outcome.error ?? "", /checkpoint creation unavailable/u);
			assert.equal(outcome.patchPath, worktree.patchPath);
			assert.match(await readFile(worktree.patchPath, "utf8"), /\+isolated edit/u);
			assert.equal(await readFile(join(repository, "tracked.txt"), "utf8"), "committed\n");
		});
	});

	it("integrates independent writers while preserving caller changes made after their shared dirty baseline", async () => {
		await withRepository(async (repository, isolate) => {
			await writeFile(join(repository, "tracked.txt"), "dirty baseline\n");
			await writeFile(join(repository, "untracked.txt"), "untracked baseline\n");
			const before = await callerState(repository);
			const [first, second] = await Promise.all([isolate(), isolate()]);
			for (const worktree of [first, second]) {
				assert.equal(await readFile(join(worktree.cwd, "tracked.txt"), "utf8"), "dirty baseline\n");
				assert.equal(await readFile(join(worktree.cwd, "untracked.txt"), "utf8"), "untracked baseline\n");
			}
			await writeFile(join(repository, "tracked.txt"), "later caller edit\n");
			await rm(join(repository, "untracked.txt"));
			await writeFile(join(first.cwd, "first.txt"), "first child\n");
			await writeFile(join(second.cwd, "second.txt"), "second child\n");
			assert.equal((await first.finalize()).status, "integrated");
			assert.equal((await second.finalize()).status, "integrated");
			assert.equal(await readFile(join(repository, "first.txt"), "utf8"), "first child\n");
			assert.equal(await readFile(join(repository, "second.txt"), "utf8"), "second child\n");
			assert.equal(await readFile(join(repository, "tracked.txt"), "utf8"), "later caller edit\n");
			assert.equal(existsSync(join(repository, "untracked.txt")), false);
			assert.deepEqual(await callerState(repository), before);
		});
	});

	it("creates and integrates five concurrent isolated worktrees without Git metadata races", async () => {
		await withRepository(async (repository, isolate) => {
			await writeFile(join(repository, "tracked.txt"), "shared baseline\n");
			const before = await callerState(repository);
			const baselineCache = new Map<string, string>();
			let baselineCommits = 0;
			const runner: CommandRunner = (command, args, options) => {
				if (args.includes("pi-subagents caller baseline")) baselineCommits++;
				return runCommand(command, args, options);
			};
			const worktrees = await Promise.all(Array.from({ length: 5 }, () => isolate(undefined, { baselineCache, runner })));
			assert.equal(baselineCommits, 1);
			assert.equal(new Set(worktrees.map((worktree) => worktree.head)).size, 1);
			await Promise.all(
				worktrees.map((worktree, index) =>
					writeFile(join(worktree.cwd, `parallel-${index}.txt`), `worker-${index}\n`),
				),
			);
			const outcomes = await Promise.all(worktrees.map((worktree) => worktree.finalize()));
			for (const [index, outcome] of outcomes.entries()) {
				assert.equal(outcome.status, "integrated", outcome.error);
				assert.equal(await readFile(join(repository, `parallel-${index}.txt`), "utf8"), `worker-${index}\n`);
				assert.equal(existsSync(worktrees[index]!.tempDir), false);
			}
			assert.equal(await readFile(join(repository, "tracked.txt"), "utf8"), "shared baseline\n");
			assert.deepEqual(await callerState(repository), before);
		});
	});

	it("treats dot-dot-prefixed child names as inside the root while rejecting parents and siblings", () => {
		const root = resolve("repo");
		assert.equal(isPathInside(root, root), true);
		assert.equal(isPathInside(root, join(root, "..cache", "file")), true);
		assert.equal(isPathInside(root, resolve("other")), false);
		assert.equal(isPathInside(root, dirname(root)), false);
	});

	it("discovers checkouts whose directory name ends in a space", { skip: process.platform === "win32" }, async () => {
		await withRepository(async (_repository, isolate) => {
			const worktree = await isolate();
			assert.equal(await readFile(join(worktree.cwd, "tracked.txt"), "utf8"), "committed\n");
		}, "repository ");
	});
});
