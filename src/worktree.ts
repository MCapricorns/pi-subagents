/**
 * Detached Git worktree isolation for write-capable sub-agents.
 *
 * A handle is created before a child is queued and stays owned by the logical
 * thread across retries, model candidates, retargets, and park/resume. Finalize
 * is idempotent: it records a binary patch, applies it to the original working
 * tree without touching its index, then removes/prunes the temporary worktree.
 * Failed integration deliberately retains both the worktree and patch.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

export type IsolationMode = "shared" | "worktree";

export interface CommandRunOptions {
	cwd: string;
	input?: Buffer;
	signal?: AbortSignal;
}

export interface CommandResult {
	code: number;
	stdout: Buffer;
	stderr: Buffer;
}

/** Injectable, shell-free command runner used by every Git operation. */
export type CommandRunner = (
	command: string,
	args: readonly string[],
	options: CommandRunOptions,
) => Promise<CommandResult>;

/** Default argument-safe runner. stdout remains a Buffer for binary patches. */
export const runCommand: CommandRunner = (command, args, options) =>
	new Promise<CommandResult>((resolveResult, reject) => {
		const child = spawn(command, [...args], {
			cwd: options.cwd,
			shell: false,
			windowsHide: true,
			stdio: ["pipe", "pipe", "pipe"],
			signal: options.signal,
		});
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		child.stdout?.on("data", (chunk: Buffer | string) =>
			stdout.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)),
		);
		child.stderr?.on("data", (chunk: Buffer | string) =>
			stderr.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)),
		);
		child.once("error", reject);
		child.once("close", (code) => {
			resolveResult({
				code: code ?? 1,
				stdout: Buffer.concat(stdout),
				stderr: Buffer.concat(stderr),
			});
		});
		child.stdin?.once("error", () => undefined);
		child.stdin?.end(options.input);
	});

export interface WorktreeTarget {
	/** Canonical cwd requested by the caller. */
	originalCwd: string;
	/** Canonical top-level directory of the source Git worktree. */
	originalRoot: string;
	/** Path from originalRoot to originalCwd (empty for the root). */
	relativeCwd: string;
	head: string;
}

export interface WorktreeCreateOptions {
	runner?: CommandRunner;
	/** Test hook; production uses the OS temp directory. */
	tempBaseDir?: string;
	/** Full source-thread patch used to seed a continuation/fork worktree. */
	seedPatch?: Buffer;
	/** The seed is already present in the parent checkout, so only later edits
	 * should be integrated when this continuation settles. */
	seedIsIntegrated?: boolean;
}

export type WorktreeFinalizationStatus = "integrated" | "no_changes" | "retained";

export interface WorktreeFinalization {
	status: WorktreeFinalizationStatus;
	/** True once the patch was successfully applied to the original worktree. */
	integrated: boolean;
	hadChanges: boolean;
	worktreePath?: string;
	patchPath?: string;
	error?: string;
}

export interface WorktreeIsolation {
	readonly originalCwd: string;
	readonly originalRoot: string;
	readonly cwd: string;
	readonly worktreePath: string;
	readonly tempDir: string;
	readonly patchPath: string;
	readonly head: string;
	readonly state: "active" | "finalizing" | WorktreeFinalizationStatus;
	/** Capture the complete isolated filesystem delta for a fresh continuation.
	 * Optional only so external/test handles written against older releases stay usable. */
	snapshotChanges?(): Promise<Buffer>;
	/** Remove a newly-created continuation that failed before it was dispatched. */
	discard?(): Promise<void>;
	/** Idempotent across stale generations and repeated stop/shutdown paths. */
	finalize(): Promise<WorktreeFinalization>;
}

export class WorktreeSetupError extends Error {
	constructor(
		message: string,
		readonly retainedPaths: readonly string[] = [],
	) {
		super(message);
		this.name = "WorktreeSetupError";
	}
}

const ERROR_OUTPUT_MAX = 8_000;

function outputText(result: CommandResult): string {
	const text = (result.stderr.length > 0 ? result.stderr : result.stdout).toString("utf8").trim();
	if (text.length <= ERROR_OUTPUT_MAX) return text;
	return `${text.slice(0, ERROR_OUTPUT_MAX - 1)}…`;
}

function commandFailure(action: string, result: CommandResult): Error {
	const detail = outputText(result);
	return new Error(`${action} failed (exit ${result.code})${detail ? `: ${detail}` : "."}`);
}

async function runGit(
	runner: CommandRunner,
	cwd: string,
	args: readonly string[],
	action: string,
	input?: Buffer,
): Promise<CommandResult> {
	let result: CommandResult;
	try {
		result = await runner("git", args, { cwd, input });
	} catch (error) {
		throw new Error(`${action} failed to start: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (result.code !== 0) throw commandFailure(action, result);
	return result;
}

/** True only when candidate is root itself or a descendant (cross-platform). */
export function isPathInside(root: string, candidate: string): boolean {
	const rel = relative(root, candidate);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** Resolve and validate the Git repository/worktree that contains cwd. */
export async function resolveWorktreeTarget(
	cwd: string,
	runner: CommandRunner = runCommand,
): Promise<WorktreeTarget> {
	const requested = resolve(cwd);
	try {
		if (!(await stat(requested)).isDirectory()) throw new Error("not a directory");
	} catch (error) {
		throw new WorktreeSetupError(
			`Worktree isolation requires an existing directory; cwd ${requested} is unavailable (${error instanceof Error ? error.message : String(error)}).`,
		);
	}
	const originalCwd = await realpath(requested);
	let topLevel: CommandResult;
	try {
		topLevel = await runGit(
			runner,
			originalCwd,
			["rev-parse", "--show-toplevel"],
			`Git repository discovery for ${originalCwd}`,
		);
	} catch (error) {
		throw new WorktreeSetupError(
			`Worktree isolation requires cwd to be inside a Git worktree/repository: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	const reportedRoot = topLevel.stdout.toString("utf8").trim();
	if (!reportedRoot) {
		throw new WorktreeSetupError(`Git repository discovery for ${originalCwd} returned no top-level path.`);
	}
	const originalRoot = await realpath(resolve(reportedRoot));
	if (!isPathInside(originalRoot, originalCwd)) {
		throw new WorktreeSetupError(
			`Requested cwd ${originalCwd} is not inside Git worktree root ${originalRoot}.`,
		);
	}
	let headResult: CommandResult;
	try {
		headResult = await runGit(
			runner,
			originalRoot,
			["rev-parse", "--verify", "HEAD"],
			`Resolving HEAD for ${originalRoot}`,
		);
	} catch (error) {
		throw new WorktreeSetupError(
			`Worktree isolation requires a repository with a committed HEAD: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	return {
		originalCwd,
		originalRoot,
		relativeCwd: relative(originalRoot, originalCwd),
		head: headResult.stdout.toString("utf8").trim(),
	};
}

class GitWorktreeIsolation implements WorktreeIsolation {
	private currentState: WorktreeIsolation["state"] = "active";
	private finalization?: Promise<WorktreeFinalization>;
	private discardPromise?: Promise<void>;
	/** Full workspace snapshot relative to the repository HEAD, retained in
	 * memory after successful cleanup so settled threads can continue safely. */
	private continuationPatch?: Buffer;

	constructor(
		readonly originalCwd: string,
		readonly originalRoot: string,
		readonly cwd: string,
		readonly worktreePath: string,
		readonly tempDir: string,
		readonly patchPath: string,
		readonly head: string,
		private readonly runner: CommandRunner,
		/** May be a synthetic tree commit representing a seed that the parent
		 * checkout already contains. Finalization then integrates only new edits. */
		private readonly integrationBaseHead: string = head,
	) {}

	get state(): WorktreeIsolation["state"] {
		return this.currentState;
	}

	async snapshotChanges(): Promise<Buffer> {
		if (this.continuationPatch !== undefined) return Buffer.from(this.continuationPatch);
		if (this.currentState === "no_changes") return Buffer.alloc(0);
		if (!existsSync(this.worktreePath)) {
			throw new Error(`Cannot snapshot isolated worktree after it was removed: ${this.worktreePath}`);
		}
		const snapshot = await this.collectChanges(this.head);
		return Buffer.from(snapshot.stdout);
	}

	discard(): Promise<void> {
		if (this.discardPromise) return this.discardPromise;
		if (this.finalization) {
			return this.finalization.then(() => undefined);
		}
		this.currentState = "finalizing";
		this.discardPromise = this.removeAndPrune().then((error) => {
			if (error) {
				this.currentState = "retained";
				throw new Error(error);
			}
			this.currentState = "no_changes";
		});
		return this.discardPromise;
	}

	finalize(): Promise<WorktreeFinalization> {
		if (this.finalization) return this.finalization;
		this.currentState = "finalizing";
		this.finalization = this.finalizeOnce().then((result) => {
			this.currentState = result.status;
			return result;
		});
		return this.finalization;
	}

	private async collectChanges(baseHead: string): Promise<CommandResult> {
		await runGit(
			this.runner,
			this.worktreePath,
			["add", "-N", "--", "."],
			`Collecting untracked files in isolated worktree ${this.worktreePath}`,
		);
		return runGit(
			this.runner,
			this.worktreePath,
			["diff", "--binary", baseHead, "--"],
			`Collecting isolated changes from ${this.worktreePath}`,
		);
	}

	private async finalizeOnce(): Promise<WorktreeFinalization> {
		let hadChanges = false;
		let patchWritten = false;
		let integrated = false;
		try {
			const diff = await this.collectChanges(this.integrationBaseHead);
			const snapshot = this.integrationBaseHead === this.head
				? diff
				: await this.collectChanges(this.head);
			this.continuationPatch = Buffer.from(snapshot.stdout);
			hadChanges = diff.stdout.length > 0;
			if (hadChanges) {
				await writeFile(this.patchPath, diff.stdout, { flag: "wx" });
				patchWritten = true;
				await runGit(
					this.runner,
					this.originalRoot,
					["apply", "--binary", "--whitespace=nowarn", this.patchPath],
					`Applying isolated patch to ${this.originalRoot}`,
				);
				integrated = true;
			}

			const cleanupError = await this.removeAndPrune();
			if (cleanupError) {
				return this.retainedResult(hadChanges, integrated, patchWritten, cleanupError);
			}
			return {
				status: hadChanges ? "integrated" : "no_changes",
				integrated,
				hadChanges,
			};
		} catch (error) {
			return this.retainedResult(
				hadChanges,
				integrated,
				patchWritten,
				error instanceof Error ? error.message : String(error),
			);
		}
	}

	private retainedResult(
		hadChanges: boolean,
		integrated: boolean,
		patchWritten: boolean,
		error: string,
	): WorktreeFinalization {
		return {
			status: "retained",
			integrated,
			hadChanges,
			...(existsSync(this.worktreePath) ? { worktreePath: this.worktreePath } : {}),
			...(patchWritten && existsSync(this.patchPath) ? { patchPath: this.patchPath } : {}),
			error,
		};
	}

	/** Return an error string instead of throwing so applied work is never retried. */
	private async removeAndPrune(): Promise<string | undefined> {
		try {
			await runGit(
				this.runner,
				this.originalRoot,
				["worktree", "remove", "--force", this.worktreePath],
				`Removing isolated worktree ${this.worktreePath}`,
			);
		} catch (error) {
			return error instanceof Error ? error.message : String(error);
		}
		let pruneError: string | undefined;
		try {
			await runGit(
				this.runner,
				this.originalRoot,
				["worktree", "prune"],
				`Pruning Git worktree metadata for ${this.originalRoot}`,
			);
		} catch (error) {
			pruneError = error instanceof Error ? error.message : String(error);
		}
		try {
			await rm(this.tempDir, { recursive: true, force: true });
		} catch (error) {
			const rmError = error instanceof Error ? error.message : String(error);
			return pruneError ? `${pruneError}; removing temporary directory failed: ${rmError}` : `Removing temporary directory failed: ${rmError}`;
		}
		return pruneError;
	}
}

/**
 * Create a detached worktree at repository HEAD. The returned cwd mirrors the
 * caller's subdirectory inside that new worktree.
 */
export async function createWorktreeIsolation(
	cwd: string,
	options: WorktreeCreateOptions = {},
): Promise<WorktreeIsolation> {
	const runner = options.runner ?? runCommand;
	const target = await resolveWorktreeTarget(cwd, runner);
	const tempBase = options.tempBaseDir ? resolve(options.tempBaseDir) : tmpdir();
	await mkdir(tempBase, { recursive: true });
	const tempDir = await mkdtemp(join(tempBase, "pi-subagent-worktree-"));
	const worktreePath = join(tempDir, "worktree");
	const patchPath = join(tempDir, "changes.patch");
	let added = false;
	try {
		await runGit(
			runner,
			target.originalRoot,
			["worktree", "add", "--detach", worktreePath, "HEAD"],
			`Creating detached worktree from ${target.originalRoot}`,
		);
		added = true;
		const isolatedCwd = target.relativeCwd ? join(worktreePath, target.relativeCwd) : worktreePath;
		// A requested subdirectory can be untracked/empty in the source worktree;
		// recreate the directory so the child still starts at the equivalent path.
		await mkdir(isolatedCwd, { recursive: true });

		let integrationBaseHead = target.head;
		if (options.seedPatch && options.seedPatch.length > 0) {
			await runGit(
				runner,
				worktreePath,
				["apply", "--binary", "--whitespace=nowarn", "-"],
				`Seeding isolated continuation ${worktreePath}`,
				options.seedPatch,
			);
			if (options.seedIsIntegrated) {
				await runGit(
					runner,
					worktreePath,
					["add", "-A", "--", "."],
					`Preparing continuation baseline in ${worktreePath}`,
				);
				const tree = await runGit(
					runner,
					worktreePath,
					["write-tree"],
					`Writing continuation baseline tree in ${worktreePath}`,
				);
				const treeId = tree.stdout.toString("utf8").trim();
				const commit = await runGit(
					runner,
					worktreePath,
					[
						"-c", "user.name=pi-subagents",
						"-c", "user.email=pi-subagents@example.invalid",
						"commit-tree", treeId,
						"-p", target.head,
						"-m", "pi-subagents continuation baseline",
					],
					`Creating continuation baseline commit in ${worktreePath}`,
				);
				integrationBaseHead = commit.stdout.toString("utf8").trim();
				if (!integrationBaseHead) throw new Error("Git returned no continuation baseline commit id.");
			}
		}

		return new GitWorktreeIsolation(
			target.originalCwd,
			target.originalRoot,
			isolatedCwd,
			worktreePath,
			tempDir,
			patchPath,
			target.head,
			runner,
			integrationBaseHead,
		);
	} catch (error) {
		const rollbackErrors: string[] = [];
		if (added || existsSync(worktreePath)) {
			try {
				await runGit(
					runner,
					target.originalRoot,
					["worktree", "remove", "--force", worktreePath],
					`Rolling back isolated worktree ${worktreePath}`,
				);
			} catch (rollbackError) {
				rollbackErrors.push(rollbackError instanceof Error ? rollbackError.message : String(rollbackError));
			}
		}
		try {
			await runGit(
				runner,
				target.originalRoot,
				["worktree", "prune"],
				`Pruning Git worktree metadata after setup failure`,
			);
		} catch (rollbackError) {
			rollbackErrors.push(rollbackError instanceof Error ? rollbackError.message : String(rollbackError));
		}
		try {
			await rm(tempDir, { recursive: true, force: true });
		} catch (rollbackError) {
			rollbackErrors.push(`Removing ${tempDir} failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`);
		}
		const retainedPaths = [worktreePath, patchPath, tempDir].filter((path) => existsSync(path));
		const cause = error instanceof Error ? error.message : String(error);
		throw new WorktreeSetupError(
			`Could not create isolated Git worktree: ${cause}${rollbackErrors.length > 0 ? ` Rollback errors: ${rollbackErrors.join("; ")}` : ""}${retainedPaths.length > 0 ? ` Retained artifacts: ${retainedPaths.join(", ")}` : ""}`,
			retainedPaths,
		);
	}
}
