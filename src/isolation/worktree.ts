/**
 * Detached Git worktree isolation for write-capable sub-agents.
 *
 * A handle is created before a child is queued and stays owned by the logical
 * thread across retries, model candidates, and resumes. Finalize
 * is idempotent: it records a binary patch, applies it to the original working
 * tree without touching its index, then removes/prunes the temporary worktree.
 * Failed integration deliberately retains both the worktree and patch.
 */

import { existsSync, symlinkSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import {
	GIT_COMMAND_TIMEOUT_MS,
	GIT_OUTPUT_MAX_BYTES,
	runCommand,
	type CommandResult,
	type CommandRunner,
	WORKTREE_PATCH_MAX_BYTES,
} from "./git-command.ts";
import { writeTempOwnerMarker } from "./temp-hygiene.ts";

export type IsolationMode = "shared" | "worktree";

const WORKTREE_TEMP_DIR_PREFIX = "pi-subagent-worktree-";

/** Short stable identity of one isolated worktree group (the mkdtemp suffix).
 * Continuation generations create a fresh worktree, so the identity
 * visibly changes when the group's filesystem boundary changes. */
export function worktreeGroupId(worktree: Pick<WorktreeIsolation, "tempDir">): string {
	const base = worktree.tempDir.split(/[\\/]/).filter(Boolean).pop() ?? worktree.tempDir;
	return base.startsWith(WORKTREE_TEMP_DIR_PREFIX)
		? base.slice(WORKTREE_TEMP_DIR_PREFIX.length)
		: base;
}

export interface WorktreeTarget {
	/** Canonical cwd requested by the caller. */
	originalCwd: string;
	/** Canonical top-level directory of the source Git worktree. */
	originalRoot: string;
	/** Path from originalRoot to originalCwd (empty for the root). */
	relativeCwd: string;
	head: string;
}

export interface WorktreeCheckpoint {
	/** Commit checked out when this isolated generation began. */
	baseHead: string;
	/** Synthetic commit whose tree is the generation's complete final state. */
	commit: string;
	/** Binary delta from baseHead, retained for size checks and diagnostics. */
	patch: Buffer;
}

export interface WorktreeCheckpointRef {
	baseHead: string;
	commit: string;
}

/** Persistable projection of one worktree handle: enough to rebuild the
 * handle after a reload or restart. Patch bytes are deliberately omitted —
 * only the checkpoint commit, which lives in the shared repository object
 * store, is needed to seed a continuation. */
export interface WorktreeSnapshot {
	originalCwd: string;
	originalRoot: string;
	cwd: string;
	worktreePath: string;
	tempDir: string;
	patchPath: string;
	head: string;
	integrationBaseHead: string;
	state: "active" | "retained" | "integrated" | "no_changes";
	checkpoint?: WorktreeCheckpointRef;
}

export interface WorktreeCreateOptions {
	runner?: CommandRunner;
	/** Parent directory for the worktree group: the project-scoped durable
	 * worktrees root, so isolation never lands in the OS temp directory. */
	tempBaseDir: string;
	/** Complete source generation checkpoint merged onto the current HEAD. */
	seedCheckpoint?: WorktreeCheckpoint;
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
	/** Repository a recovery path can prune stale worktree metadata against. */
	originalRoot?: string;
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
	/** Diff base for final integration; a continuation baseline commit when
	 * the generation was seeded with already-integrated work. */
	readonly integrationBaseHead: string;
	readonly state: "active" | "finalizing" | WorktreeFinalizationStatus;
	/** Checkpoint retained after finalization for continuation resumes. */
	getContinuationCheckpoint(): WorktreeCheckpoint | undefined;
	/** Capture the complete isolated filesystem state for a fresh continuation.
	 * The synthetic commit lets Git merge an already-committed seed without
	 * attempting to apply the same patch twice. */
	snapshotCheckpoint(): Promise<WorktreeCheckpoint>;
	/** Remove a newly-created continuation that failed before it was dispatched. */
	discard(): Promise<void>;
	/** Whether anything is pending against the integration base — the same
	 * question finalization answers as `hadChanges`, asked before settlement so
	 * policy can tell a run that produced a diff from one that produced none. */
	hasPendingChanges(): Promise<boolean>;
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

function cloneCheckpoint(checkpoint: WorktreeCheckpoint): WorktreeCheckpoint {
	return { ...checkpoint, patch: Buffer.from(checkpoint.patch) };
}

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
	env?: Record<string, string>,
): Promise<CommandResult> {
	let result: CommandResult;
	try {
		result = await runner("git", args, {
			cwd,
			input,
			env,
			timeoutMs: GIT_COMMAND_TIMEOUT_MS,
			maxOutputBytes: GIT_OUTPUT_MAX_BYTES,
		});
	} catch (error) {
		throw new Error(`${action} failed: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (result.code !== 0) throw commandFailure(action, result);
	return result;
}

/** True only when candidate is root itself or a descendant (cross-platform). */
export function isPathInside(root: string, candidate: string): boolean {
	const rel = relative(root, candidate);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** Delete one isolated worktree group: Git's own removal keeps metadata
 * authoritative, but Git on Windows cannot always delete deep checkouts
 * ("Filename too long"), so the Node removal decides the outcome and the prune
 * clears any stale registration left behind. Returns an error string when
 * artifacts still exist afterwards. */
export async function removeWorktreeGroup(
	paths: { originalRoot?: string; tempDir: string; worktreePath: string },
	runner: CommandRunner = runCommand,
): Promise<string | undefined> {
	let removeError: string | undefined;
	if (paths.originalRoot && existsSync(paths.worktreePath)) {
		// core.longpaths only exists in Git for Windows, and some POSIX builds
		// reject unknown -c core keys, so the flag stays platform-gated.
		const longPaths = process.platform === "win32" ? ["-c", "core.longpaths=true"] : [];
		try {
			await runGit(
				runner,
				paths.originalRoot,
				[...longPaths, "worktree", "remove", "--force", paths.worktreePath],
				`Removing isolated worktree ${paths.worktreePath}`,
			);
		} catch (error) {
			removeError = error instanceof Error ? error.message : String(error);
		}
	}
	try {
		await rm(paths.tempDir, { recursive: true, force: true });
	} catch (error) {
		const rmError = error instanceof Error ? error.message : String(error);
		return removeError
			? `${removeError}; removing temporary directory failed: ${rmError}`
			: `Removing temporary directory failed: ${rmError}`;
	}
	if (!paths.originalRoot) return undefined;
	try {
		await runGit(
			runner,
			paths.originalRoot,
			["worktree", "prune"],
			`Pruning Git worktree metadata for ${paths.originalRoot}`,
		);
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
	return undefined;
}

interface RepositoryLocation {
	originalCwd: string;
	originalRoot: string;
}

/** Resolve the canonical repository root without requiring a committed HEAD.
 * Managed repository lanes use this for empty repositories as well as normal
 * worktrees; worktree creation validates HEAD separately below. */
async function resolveRepositoryLocation(
	cwd: string,
	runner: CommandRunner,
): Promise<RepositoryLocation> {
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
	return { originalCwd, originalRoot };
}

export async function resolveRepositoryRoot(
	cwd: string,
	runner: CommandRunner = runCommand,
): Promise<string> {
	return (await resolveRepositoryLocation(cwd, runner)).originalRoot;
}

/** Resolve and validate the Git repository/worktree that contains cwd. */
export async function resolveWorktreeTarget(
	cwd: string,
	runner: CommandRunner = runCommand,
): Promise<WorktreeTarget> {
	const { originalCwd, originalRoot } = await resolveRepositoryLocation(cwd, runner);
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
	/** Full workspace checkpoint relative to the generation's starting HEAD,
	 * retained after cleanup so settled threads can continue safely. */
	private continuationCheckpoint?: WorktreeCheckpoint;

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
		readonly integrationBaseHead: string = head,
		restored?: {
			state: WorktreeIsolation["state"];
			checkpoint?: WorktreeCheckpoint;
		},
	) {
		if (restored) {
			this.currentState = restored.state;
			if (restored.checkpoint) this.continuationCheckpoint = cloneCheckpoint(restored.checkpoint);
		}
	}

	get state(): WorktreeIsolation["state"] {
		return this.currentState;
	}

	getContinuationCheckpoint(): WorktreeCheckpoint | undefined {
		return this.continuationCheckpoint ? cloneCheckpoint(this.continuationCheckpoint) : undefined;
	}

	async snapshotCheckpoint(): Promise<WorktreeCheckpoint> {
		if (this.continuationCheckpoint) return cloneCheckpoint(this.continuationCheckpoint);
		if (this.currentState === "no_changes") {
			return { baseHead: this.head, commit: this.head, patch: Buffer.alloc(0) };
		}
		if (!existsSync(this.worktreePath)) {
			throw new Error(`Cannot snapshot isolated worktree after it was removed: ${this.worktreePath}`);
		}
		const snapshot = await this.collectChanges(this.head);
		this.continuationCheckpoint = await this.createCheckpoint(snapshot.stdout);
		return cloneCheckpoint(this.continuationCheckpoint);
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

	async hasPendingChanges(): Promise<boolean> {
		// A settled worktree already recorded the answer; asking Git again after
		// removal would fail. Diffing the integration base (not HEAD) keeps a
		// continuation honest: only this generation's own work counts.
		if (this.currentState === "no_changes") return false;
		if (this.currentState !== "active" || !existsSync(this.worktreePath)) return true;
		const diff = await this.collectChanges(this.integrationBaseHead);
		return diff.stdout.length > 0;
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

	private async createCheckpoint(patch: Buffer): Promise<WorktreeCheckpoint> {
		if (patch.length === 0) {
			return { baseHead: this.head, commit: this.head, patch: Buffer.alloc(0) };
		}
		await runGit(
			this.runner,
			this.worktreePath,
			["add", "-A", "--", "."],
			`Preparing isolated checkpoint in ${this.worktreePath}`,
		);
		const tree = await runGit(
			this.runner,
			this.worktreePath,
			["write-tree"],
			`Writing isolated checkpoint tree in ${this.worktreePath}`,
		);
		const treeId = tree.stdout.toString("utf8").trim();
		if (!treeId) throw new Error("Git returned no isolated checkpoint tree id.");
		const commit = await runGit(
			this.runner,
			this.worktreePath,
			[
				"-c", "user.name=pi-subagents",
				"-c", "user.email=pi-subagents@example.invalid",
				"commit-tree", treeId,
				"-p", this.head,
				"-m", "pi-subagents isolated checkpoint",
			],
			`Creating isolated checkpoint commit in ${this.worktreePath}`,
		);
		const commitId = commit.stdout.toString("utf8").trim();
		if (!commitId) throw new Error("Git returned no isolated checkpoint commit id.");
		return { baseHead: this.head, commit: commitId, patch: Buffer.from(patch) };
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
			this.continuationCheckpoint = await this.createCheckpoint(snapshot.stdout);
			hadChanges = diff.stdout.length > 0;
			if (hadChanges) {
				await writeFile(this.patchPath, diff.stdout, { flag: "wx" });
				patchWritten = true;
				integrated = await this.applyPatchThreeWay();
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
			originalRoot: this.originalRoot,
			...(existsSync(this.worktreePath) ? { worktreePath: this.worktreePath } : {}),
			...(patchWritten && existsSync(this.patchPath) ? { patchPath: this.patchPath } : {}),
			error,
		};
	}

	/** Apply the patch as a three-way merge against its recorded preimage
	 * blobs, so parallel workers that touched disjoint regions (or disjoint
	 * files) of the same checkout integrate cleanly instead of the whole patch
	 * failing on context drift. A genuine overlap still fails and retains the
	 * artifacts, with conflict markers left in place for the main model to
	 * resolve. `--3way` implies `--index` and demands a working tree matching
	 * that index, so everything runs against a private copy of the checkout's
	 * index: the copy first absorbs the current unstaged state (`add -A`),
	 * making the working tree "ours" of the merge, and the user's real staged
	 * state is never touched. The repository lane serializes finalization, and
	 * each `git apply` validates and writes in one process. */
	private async applyPatchThreeWay(): Promise<boolean> {
		const indexCopy = join(this.tempDir, "apply-index");
		try {
			const indexPath = resolve(
				this.originalRoot,
				(await runGit(
					this.runner,
					this.originalRoot,
					["rev-parse", "--git-path", "index"],
					`Resolving index path for ${this.originalRoot}`,
				)).stdout.toString("utf8").trim(),
			);
			if (!existsSync(indexPath)) {
				await runGit(
					this.runner,
					this.originalRoot,
					["apply", "--binary", "--whitespace=nowarn", this.patchPath],
					`Applying isolated patch to ${this.originalRoot}`,
				);
				return true;
			}
			await copyFile(indexPath, indexCopy);
			await runGit(
				this.runner,
				this.originalRoot,
				["add", "-A", "--", "."],
				`Staging checkout state for isolated merge in ${this.originalRoot}`,
				undefined,
				{ GIT_INDEX_FILE: indexCopy },
			);
			await runGit(
				this.runner,
				this.originalRoot,
				["apply", "--binary", "--3way", "--whitespace=nowarn", this.patchPath],
				`Three-way applying isolated patch to ${this.originalRoot}`,
				undefined,
				{ GIT_INDEX_FILE: indexCopy },
			);
			return true;
		} finally {
			await rm(indexCopy, { force: true }).catch(() => undefined);
		}
	}

	/** Return an error string instead of throwing so applied work is never retried. */
	private removeAndPrune(): Promise<string | undefined> {
		return removeWorktreeGroup(
			{ originalRoot: this.originalRoot, worktreePath: this.worktreePath, tempDir: this.tempDir },
			this.runner,
		);
	}
}

/** Link the origin checkout's `node_modules` into a fresh worktree, because a
 * worktree holds only tracked files and the verification commands a child is
 * asked to run (`npm run check`, `npm test`) would otherwise fail on missing
 * dependencies. A junction is used on Windows: unlike a directory symlink it
 * needs neither administrator rights nor Developer Mode. The link is skipped
 * unless Git ignores the directory, since Git descends into it and an unignored
 * `node_modules` would enter the integration patch and be written back over the
 * real dependency tree. Best effort — a worktree without the link is still
 * usable, so failure must never abort isolation. */
async function linkNodeModules(
	runner: CommandRunner,
	originalRoot: string,
	worktreePath: string,
): Promise<void> {
	const target = join(originalRoot, "node_modules");
	const link = join(worktreePath, "node_modules");
	if (!existsSync(target) || existsSync(link)) return;
	try {
		const ignored = await runner("git", ["check-ignore", "-q", "--", "node_modules"], {
			cwd: originalRoot,
			timeoutMs: GIT_COMMAND_TIMEOUT_MS,
			maxOutputBytes: GIT_OUTPUT_MAX_BYTES,
		});
		if (ignored.code !== 0) return;
		symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
	} catch {
		/* dependency linking is an optimization, never a setup requirement */
	}
}

/**
 * Create a detached worktree at repository HEAD. The returned cwd mirrors the
 * caller's subdirectory inside that new worktree.
 */
export async function createWorktreeIsolation(
	cwd: string,
	options: WorktreeCreateOptions,
): Promise<WorktreeIsolation> {
	const runner = options.runner ?? runCommand;
	const target = await resolveWorktreeTarget(cwd, runner);
	const tempBase = resolve(options.tempBaseDir);
	await mkdir(tempBase, { recursive: true });
	const tempDir = await mkdtemp(join(tempBase, "pi-subagent-worktree-"));
	// Ownership is how a later load tells a worktree still in use from one a
	// crash abandoned, since neither has a durable record until it checkpoints.
	writeTempOwnerMarker(tempDir);
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
		await linkNodeModules(runner, target.originalRoot, worktreePath);

		let integrationBaseHead = target.head;
		const checkpoint = options.seedCheckpoint;
		if (checkpoint && checkpoint.patch.length > WORKTREE_PATCH_MAX_BYTES) {
			throw new Error(
				`Isolated checkpoint exceeds the ${WORKTREE_PATCH_MAX_BYTES}-byte patch limit (${checkpoint.patch.length} bytes).`,
			);
		}
		if (checkpoint && checkpoint.patch.length > 0) {
			// Merge the checkpoint commit with today's HEAD instead of blindly
			// applying its old patch. If the parent committed generation one after
			// integration, Git recognizes the equivalent tree and produces HEAD
			// unchanged; unrelated newer commits are preserved by the three-way merge.
			const merged = await runGit(
				runner,
				worktreePath,
				["merge-tree", "--write-tree", "--messages", target.head, checkpoint.commit],
				`Merging isolated checkpoint into continuation ${worktreePath}`,
			);
			const mergedTree = merged.stdout.toString("utf8").split(/\r?\n/, 1)[0]?.trim();
			if (!mergedTree) throw new Error("Git returned no merged continuation tree id.");
			await runGit(
				runner,
				worktreePath,
				["read-tree", "--reset", "-u", mergedTree],
				`Materializing isolated checkpoint in ${worktreePath}`,
			);
			if (options.seedIsIntegrated) {
				const commit = await runGit(
					runner,
					worktreePath,
					[
						"-c", "user.name=pi-subagents",
						"-c", "user.email=pi-subagents@example.invalid",
						"commit-tree", mergedTree,
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

/** Snapshot only states whose filesystem or repository objects still exist.
 * Transient (`finalizing`) and discarded handles are not persistable. */
export function worktreeSnapshot(worktree: WorktreeIsolation): WorktreeSnapshot | undefined {
	const state = worktree.state;
	if (state !== "active" && state !== "retained" && state !== "integrated" && state !== "no_changes") {
		return undefined;
	}
	const checkpoint = worktree.getContinuationCheckpoint();
	return {
		originalCwd: worktree.originalCwd,
		originalRoot: worktree.originalRoot,
		cwd: worktree.cwd,
		worktreePath: worktree.worktreePath,
		tempDir: worktree.tempDir,
		patchPath: worktree.patchPath,
		head: worktree.head,
		integrationBaseHead: worktree.integrationBaseHead,
		state,
		...(checkpoint && checkpoint.patch.length > 0
			? { checkpoint: { baseHead: checkpoint.baseHead, commit: checkpoint.commit } }
			: {}),
	};
}

/** Validate an untrusted persisted snapshot; null when it is unusable. */
export function normalizeWorktreeSnapshot(value: unknown): WorktreeSnapshot | null {
	if (!value || typeof value !== "object") return null;
	const raw = value as Record<string, unknown>;
	const fields: Record<string, string> = {};
	for (const key of [
		"originalCwd",
		"originalRoot",
		"cwd",
		"worktreePath",
		"tempDir",
		"patchPath",
		"head",
		"integrationBaseHead",
	] as const) {
		if (typeof raw[key] !== "string" || !raw[key]) return null;
		fields[key] = raw[key] as string;
	}
	if (raw.state !== "active" && raw.state !== "retained" && raw.state !== "integrated" && raw.state !== "no_changes") {
		return null;
	}
	let checkpoint: WorktreeCheckpointRef | undefined;
	if (raw.checkpoint && typeof raw.checkpoint === "object") {
		const rawCheckpoint = raw.checkpoint as Record<string, unknown>;
		if (typeof rawCheckpoint.baseHead !== "string" || !rawCheckpoint.baseHead) return null;
		if (typeof rawCheckpoint.commit !== "string" || !rawCheckpoint.commit) return null;
		checkpoint = { baseHead: rawCheckpoint.baseHead, commit: rawCheckpoint.commit };
	}
	return {
		originalCwd: fields.originalCwd!,
		originalRoot: fields.originalRoot!,
		cwd: fields.cwd!,
		worktreePath: fields.worktreePath!,
		tempDir: fields.tempDir!,
		patchPath: fields.patchPath!,
		head: fields.head!,
		integrationBaseHead: fields.integrationBaseHead!,
		state: raw.state,
		...(checkpoint ? { checkpoint } : {}),
	};
}

/** Rebuild a handle from a persisted snapshot. Returns undefined when the
 * on-disk worktree that an active/retained snapshot promises is gone; settled
 * states (integrated/no_changes) intentionally need no filesystem. The
 * restored checkpoint carries no patch bytes — only its commit is consumed by
 * continuation seeds. */
export async function restoreWorktreeIsolation(
	snapshot: WorktreeSnapshot,
	options: { runner?: CommandRunner } = {},
): Promise<WorktreeIsolation | undefined> {
	if (
		(snapshot.state === "active" || snapshot.state === "retained") &&
		!existsSync(snapshot.worktreePath)
	) {
		return undefined;
	}
	return new GitWorktreeIsolation(
		snapshot.originalCwd,
		snapshot.originalRoot,
		snapshot.cwd,
		snapshot.worktreePath,
		snapshot.tempDir,
		snapshot.patchPath,
		snapshot.head,
		options.runner ?? runCommand,
		snapshot.integrationBaseHead,
		{
			state: snapshot.state,
			...(snapshot.checkpoint
				? { checkpoint: { ...snapshot.checkpoint, patch: Buffer.alloc(0) } }
				: {}),
		},
	);
}
