/** Pi SessionManager-backed cloning of a retained sub-agent session branch. */

import { SessionManager } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface ForkedSession {
	sessionDir: string;
	sessionId: string;
	sessionFile: string;
}

/** Locate one retained session by its authoritative header id. */
export async function findRetainedSessionFile(
	sessionDir: string,
	sessionId: string,
): Promise<string> {
	// The retained header may point at a worktree that has since been removed.
	// The session id is authoritative inside this explicit private directory;
	// listing the directory directly avoids a stale-cwd filter rejecting it.
	const sessions = await SessionManager.listAll(sessionDir);
	const matches = sessions.filter((session) => session.id === sessionId);
	if (matches.length === 0) {
		throw new Error(`Retained session ${sessionId} was not found in ${sessionDir}.`);
	}
	if (matches.length > 1) {
		throw new Error(`Retained session id ${sessionId} is ambiguous in ${sessionDir}.`);
	}
	return matches[0].path;
}

/**
 * Copy only the source file's active branch into a new isolated temp session
 * directory. SessionManager performs all JSONL/tree handling; source state is
 * never mutated.
 */
export async function forkRetainedSession(options: {
	/** Cwd stored in the source session header (used for exact lookup). */
	cwd: string;
	/** Optional cwd for the cloned session header and future child tools. */
	targetCwd?: string;
	sessionDir: string;
	sessionId: string;
}): Promise<ForkedSession> {
	const sourceSessionFile = await findRetainedSessionFile(
		options.sessionDir,
		options.sessionId,
	);
	const sessionDir = await mkdtemp(join(tmpdir(), "pi-subagent-session-fork-"));
	try {
		// Supplying the new directory makes createBranchedSession write there.
		// cwdOverride rewrites the cloned header so a settled isolated session can
		// safely continue in its fresh worktree instead of a removed old path.
		const manager = SessionManager.open(
			sourceSessionFile,
			sessionDir,
			options.targetCwd ?? options.cwd,
		);
		const leafId = manager.getLeafId();
		if (!leafId) throw new Error(`Retained session ${options.sessionId} has no active branch to fork.`);
		const sessionFile = manager.createBranchedSession(leafId);
		if (!sessionFile) throw new Error("Pi SessionManager did not create a persistent fork.");
		// Pi defers branch files that contain no assistant response. Such a file
		// cannot be resumed by RPC without creating a blank session, so reject
		// rather than pretending context was preserved.
		if (!existsSync(sessionFile)) {
			throw new Error(`Forked session branch has no persisted assistant checkpoint at ${sessionFile}.`);
		}
		return {
			sessionDir,
			sessionId: manager.getSessionId(),
			sessionFile,
		};
	} catch (error) {
		await rm(sessionDir, { recursive: true, force: true }).catch(() => undefined);
		throw error;
	}
}
