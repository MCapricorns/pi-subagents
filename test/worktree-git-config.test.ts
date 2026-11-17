import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";
import { runCommand, type CommandRunner } from "../src/isolation/git-command.ts";
import {
	createWorktreeIsolation,
	removeWorktreeGroup,
	type WorktreeIsolation,
} from "../src/isolation/worktree.ts";

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
	return (await execFileAsync("git", args, { cwd })).stdout.trim();
}

async function withRepo(
	run: (repository: string, tempBaseDir: string, track: (w: WorktreeIsolation) => WorktreeIsolation) => Promise<void>,
): Promise<void> {
	const root = await mkdtemp(join(tmpdir(), "pi-worktree-git-config-"));
	const repository = join(root, "repository");
	const tempBaseDir = join(root, "worktrees");
	const tracked: WorktreeIsolation[] = [];
	try {
		await mkdir(repository);
		await git(repository, "init");
		await git(repository, "config", "user.name", "Git Config Test");
		await git(repository, "config", "user.email", "gitconfig@example.invalid");
		await git(repository, "config", "core.autocrlf", "false");
		await writeFile(join(repository, ".gitignore"), "node_modules/\n");
		await writeFile(join(repository, "tracked.txt"), "initial\n");
		await git(repository, "add", ".");
		await git(repository, "commit", "-m", "Initial commit");
		await run(repository, tempBaseDir, (w) => {
			tracked.push(w);
			return w;
		});
	} finally {
		try {
			for (const worktree of tracked) await worktree.discard().catch(() => undefined);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	}
}

describe("worktree Git config, symlink ignore, longpaths, and prune handling", () => {
	it("integrates a worker's new file at the correct path despite diff.noprefix=true and color.ui=always", async () => {
		await withRepo(async (repository, tempBaseDir, track) => {
			await git(repository, "config", "diff.noprefix", "true");
			await git(repository, "config", "color.ui", "always");

			const worktree = track(await createWorktreeIsolation(repository, { tempBaseDir }));
			const targetRel = join("nested", "created-by-worker.txt");
			await mkdir(join(worktree.cwd, "nested"), { recursive: true });
			await writeFile(join(worktree.cwd, targetRel), "created under noprefix and color\n");

			const result = await worktree.finalize();
			assert.deepEqual(result, {
				status: "integrated",
				integrated: true,
				hadChanges: true,
			});
			assert.equal(
				await readFile(join(repository, targetRel), "utf8"),
				"created under noprefix and color\n",
			);
			assert.equal(existsSync(worktree.tempDir), false);
		});
	});

	it("removes node_modules link when git check-ignore in the worktree does not ignore the link", async () => {
		await withRepo(async (repository, tempBaseDir, track) => {
			const pkgDir = join(repository, "node_modules", "sample-pkg");
			await mkdir(pkgDir, { recursive: true });
			await writeFile(join(pkgDir, "index.js"), "export const ok = true;\n");

			let worktreeCheckIgnoreCalled = false;
			const runner: CommandRunner = async (command, args, options) => {
				if (
					command === "git" &&
					args.includes("check-ignore") &&
					options.cwd !== repository
				) {
					worktreeCheckIgnoreCalled = true;
					return { code: 1, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
				}
				return runCommand(command, args, options);
			};

			const worktree = track(await createWorktreeIsolation(repository, { tempBaseDir, runner }));
			assert.equal(worktreeCheckIgnoreCalled, true);
			assert.equal(existsSync(join(worktree.worktreePath, "node_modules")), false);
			assert.equal(existsSync(join(pkgDir, "index.js")), true);

			const result = await worktree.finalize();
			assert.deepEqual(result, {
				status: "no_changes",
				integrated: false,
				hadChanges: false,
			});
		});
	});

	it("passes -c core.longpaths=true on win32 to all git invocations including setup, diff, apply, and rollback", async () => {
		await withRepo(async (repository, tempBaseDir, track) => {
			const pkgDir = join(repository, "node_modules", "sample-pkg");
			await mkdir(pkgDir, { recursive: true });
			await writeFile(join(pkgDir, "index.js"), "export const ok = true;\n");

			const recordedArgs: Array<readonly string[]> = [];
			const runner: CommandRunner = async (command, args, options) => {
				if (command === "git") recordedArgs.push(args);
				return runCommand(command, args, options);
			};

			const worktree = track(await createWorktreeIsolation(repository, { tempBaseDir, runner }));
			await writeFile(join(worktree.cwd, "tracked.txt"), "updated\n");
			const result = await worktree.finalize();
			assert.equal(result.status, "integrated");

			assert.ok(recordedArgs.length > 0);
			for (const args of recordedArgs) {
				if (process.platform === "win32") {
					assert.equal(args[0], "-c");
					assert.equal(args[1], "core.longpaths=true");
				} else {
					assert.notEqual(args[1], "core.longpaths=true");
				}
			}

			// Verify rollback `worktree remove` also receives the same platform prefix.
			const rollbackArgs: Array<readonly string[]> = [];
			const failingRunner: CommandRunner = async (command, args, options) => {
				if (command === "git") {
					rollbackArgs.push(args);
					if (args.includes("worktree") && args.includes("add")) {
						await runCommand(command, args, options);
						throw new Error("simulated failure after worktree add");
					}
				}
				return runCommand(command, args, options);
			};
			await assert.rejects(
				createWorktreeIsolation(repository, { tempBaseDir, runner: failingRunner }),
				/simulated failure after worktree add/,
			);
			const rollbackRemove = rollbackArgs.find(
				(args) => args.includes("worktree") && args.includes("remove"),
			);
			assert.ok(rollbackRemove, "expected rollback worktree remove invocation");
			if (process.platform === "win32") {
				assert.equal(rollbackRemove[0], "-c");
				assert.equal(rollbackRemove[1], "core.longpaths=true");
			} else {
				assert.notEqual(rollbackRemove[1], "core.longpaths=true");
			}
		});
	});

	it("treats git worktree prune failure as non-fatal once tempDir is deleted", async () => {
		await withRepo(async (repository, tempBaseDir, track) => {
			const runner: CommandRunner = async (command, args, options) => {
				if (command === "git" && args.includes("worktree") && args.includes("prune")) {
					return { code: 1, stdout: Buffer.alloc(0), stderr: Buffer.from("prune failed") };
				}
				return runCommand(command, args, options);
			};

			const worktree = track(await createWorktreeIsolation(repository, { tempBaseDir, runner }));
			await writeFile(join(worktree.cwd, "new-file.txt"), "hello\n");

			const result = await worktree.finalize();
			assert.deepEqual(result, {
				status: "integrated",
				integrated: true,
				hadChanges: true,
			});
			assert.equal(existsSync(worktree.tempDir), false);
			assert.equal(await readFile(join(repository, "new-file.txt"), "utf8"), "hello\n");

			// Direct removeWorktreeGroup call with missing tempDir and failing prune returns undefined.
			const directError = await removeWorktreeGroup(
				{
					originalRoot: repository,
					tempDir: join(tempBaseDir, "already-gone"),
					worktreePath: join(tempBaseDir, "already-gone", "worktree"),
				},
				runner,
			);
			assert.equal(directError, undefined);
		});
	});
});
