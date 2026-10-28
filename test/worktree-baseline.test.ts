import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";
import {
	createWorktreeIsolation,
	restoreWorktreeIsolation,
	worktreeSnapshot,
	type WorktreeIsolation,
} from "../src/isolation/worktree.ts";

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
	return (await execFileAsync("git", args, { cwd })).stdout.trim();
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
	run: (repository: string, isolate: (cwd?: string) => Promise<WorktreeIsolation>) => Promise<void>,
): Promise<void> {
	const root = await mkdtemp(join(tmpdir(), "pi-worktree-baseline-"));
	const repository = join(root, "repository");
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
		await run(repository, async (cwd = repository) => {
			const worktree = await createWorktreeIsolation(cwd, { tempBaseDir: join(root, "worktrees") });
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
			assert.equal(await worktree.hasPendingChanges(), false);

			const snapshot = worktreeSnapshot(worktree)!;
			const restored = await restoreWorktreeIsolation(snapshot);
			assert.ok(restored);
			assert.equal(await restored.hasPendingChanges(), false);
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
			assert.equal(await second.hasPendingChanges(), false);
			const moduleB = moduleA + "export const second = first + 1;\n";
			await writeFile(join(second.cwd, "module.ts"), moduleB);
			assert.equal(await second.hasPendingChanges(), true);
			assert.equal((await second.finalize()).status, "integrated");
			assert.equal(await readFile(join(repository, "module.ts"), "utf8"), moduleB);
			assert.deepEqual(await callerState(repository), before);
			const checkpoint = second.getContinuationCheckpoint()!;
			assert.equal(checkpoint.baseHead, second.head);
			assert.equal(await git(repository, "show", checkpoint.commit + ":module.ts"), moduleB.trim());
			assert.equal(await git(repository, "show", checkpoint.baseHead + ":module.ts"), moduleA.trim());
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
});
