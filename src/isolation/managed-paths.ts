/** Canonical filesystem guards for paths recovered from durable manifests. */

import { existsSync } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { getProjectRoot, getSubagentsRoot } from "../execution/spawn.ts";

const SESSION_DIR_NAME = /^pi-subagent-session-(?:fork-)?.+$/i;
const WORKTREE_DIR_NAME = /^pi-subagent-worktree-.+$/i;
const PROJECT_DIR_NAME = /^.+-[0-9a-f]{12}$/i;

function comparable(path: string): string {
	const normalized = resolve(path);
	return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function isCanonicalAbsolute(path: string): boolean {
	return isAbsolute(path) && path === resolve(path);
}

export function samePath(left: string, right: string): boolean {
	return comparable(left) === comparable(right);
}

async function isPlainPath(path: string, kind: "directory" | "file"): Promise<boolean> {
	try {
		const entry = await lstat(path);
		return !entry.isSymbolicLink() && (kind === "directory" ? entry.isDirectory() : entry.isFile());
	} catch {
		return false;
	}
}

async function isDirectRealChild(root: string, candidate: string): Promise<boolean> {
	try {
		const [realRoot, realCandidate] = await Promise.all([realpath(root), realpath(candidate)]);
		return samePath(dirname(realCandidate), realRoot);
	} catch {
		return false;
	}
}

async function isManagedDirectory(
	root: string,
	candidate: string,
	namePattern: RegExp,
): Promise<boolean> {
	if (!isCanonicalAbsolute(candidate) || !samePath(dirname(candidate), root) || !namePattern.test(basename(candidate))) {
		return false;
	}
	if (!existsSync(candidate)) return true;
	return await isPlainPath(candidate, "directory") && await isDirectRealChild(root, candidate);
}

async function isManagedContainer(root: string, candidate: string, name: string): Promise<boolean> {
	if (!samePath(candidate, join(root, name))) return false;
	if (!existsSync(candidate)) return true;
	return await isPlainPath(candidate, "directory") && await isDirectRealChild(root, candidate);
}

async function hasCanonicalProjectRoot(configPath: string, cwd: string, projectRoot: string): Promise<boolean> {
	const subagentsRoot = getSubagentsRoot(configPath);
	if (!samePath(projectRoot, getProjectRoot(configPath, cwd))) return false;
	if (!isAbsolute(projectRoot) || !samePath(dirname(projectRoot), subagentsRoot)) return false;
	if (!existsSync(projectRoot)) return true;
	return await isPlainPath(projectRoot, "directory") && await isDirectRealChild(subagentsRoot, projectRoot);
}

export async function isManagedSessionDir(
	configPath: string,
	cwd: string,
	sessionDir: string,
): Promise<boolean> {
	const projectRoot = getProjectRoot(configPath, cwd);
	if (!await hasCanonicalProjectRoot(configPath, cwd, projectRoot)) return false;
	const sessionsRoot = join(projectRoot, "sessions");
	if (!await isManagedContainer(projectRoot, sessionsRoot, "sessions")) return false;
	return isManagedDirectory(sessionsRoot, sessionDir, SESSION_DIR_NAME);
}

export interface PersistedWorktreePaths {
	cwd: string;
	worktreePath: string;
	tempDir: string;
	patchPath: string;
}

export async function isManagedWorktreeLayout(
	configPath: string,
	cwd: string,
	worktree: PersistedWorktreePaths,
): Promise<boolean> {
	const projectRoot = getProjectRoot(configPath, cwd);
	if (!await hasCanonicalProjectRoot(configPath, cwd, projectRoot)) return false;
	const worktreesRoot = join(projectRoot, "worktrees");
	if (!await isManagedContainer(projectRoot, worktreesRoot, "worktrees")) return false;
	if (!await isManagedDirectory(worktreesRoot, worktree.tempDir, WORKTREE_DIR_NAME)) return false;
	if (!isCanonicalAbsolute(worktree.worktreePath) || !samePath(worktree.worktreePath, join(worktree.tempDir, "worktree"))) return false;
	if (!isCanonicalAbsolute(worktree.patchPath) || !samePath(worktree.patchPath, join(worktree.tempDir, "changes.patch"))) return false;
	if (!isCanonicalAbsolute(worktree.cwd)) return false;
	if (existsSync(worktree.worktreePath)) {
		if (!await isPlainPath(worktree.worktreePath, "directory")) return false;
		if (!await isDirectRealChild(worktree.tempDir, worktree.worktreePath)) return false;
	}
	if (existsSync(worktree.patchPath)) {
		if (!await isPlainPath(worktree.patchPath, "file")) return false;
		if (!await isDirectRealChild(worktree.tempDir, worktree.patchPath)) return false;
	}
	return true;
}

/** Return a recovery group only when every persisted artifact has the fixed
 * `<root>/<project>/worktrees/<group>/{worktree,changes.patch}` shape. Existing
 * path components must also stay inside that shape after junction resolution. */
export async function managedRecoveryGroup(
	configPath: string,
	paths: { worktreePath?: string; patchPath?: string },
): Promise<string | undefined> {
	if (paths.worktreePath && !isCanonicalAbsolute(paths.worktreePath)) return undefined;
	if (paths.patchPath && !isCanonicalAbsolute(paths.patchPath)) return undefined;
	const fromWorktree = paths.worktreePath ? dirname(paths.worktreePath) : undefined;
	const fromPatch = paths.patchPath ? dirname(paths.patchPath) : undefined;
	const group = fromWorktree ?? fromPatch;
	if (!group || (fromWorktree && fromPatch && !samePath(fromWorktree, fromPatch))) return undefined;
	if (paths.worktreePath && !samePath(paths.worktreePath, join(group, "worktree"))) return undefined;
	if (paths.patchPath && !samePath(paths.patchPath, join(group, "changes.patch"))) return undefined;
	const worktreesRoot = dirname(group);
	const projectRoot = dirname(worktreesRoot);
	const subagentsRoot = getSubagentsRoot(configPath);
	if (!samePath(worktreesRoot, join(projectRoot, "worktrees")) || !samePath(dirname(projectRoot), subagentsRoot)) {
		return undefined;
	}
	if (!await isManagedDirectory(subagentsRoot, projectRoot, PROJECT_DIR_NAME)) return undefined;
	if (!await isManagedContainer(projectRoot, worktreesRoot, "worktrees")) return undefined;
	if (!await isManagedDirectory(worktreesRoot, group, WORKTREE_DIR_NAME)) return undefined;
	if (paths.worktreePath && existsSync(paths.worktreePath)) {
		if (!await isPlainPath(paths.worktreePath, "directory")) return undefined;
		if (!await isDirectRealChild(group, paths.worktreePath)) return undefined;
	}
	if (paths.patchPath && existsSync(paths.patchPath)) {
		if (!await isPlainPath(paths.patchPath, "file")) return undefined;
		if (!await isDirectRealChild(group, paths.patchPath)) return undefined;
	}
	return group;
}
