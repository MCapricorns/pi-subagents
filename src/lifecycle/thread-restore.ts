/** Durable restoration and startup hygiene for logical sub-agent threads. */

import { type ThinkingLevel } from "../configuration/config.ts";
import {
	discardRecordArtifacts,
	isCurrentBoot,
	isThreadSourceAvailable,
	pruneStaleProjectRoots,
	pruneThreadRecords,
	readReferencedDurablePaths,
	readThreadRecords,
	removeThreadRecord,
	restoredResultFromSummary,
	threadRecordIdentity,
	type ThreadRecord,
} from "./durable.ts";
import { monitor } from "../presentation/monitor.ts";
import { emptyUsage } from "../execution/run-control.ts";
import type { SubagentRuntime, SubagentThread, ThreadState } from "./runtime.ts";
import {
	getProjectRoot,
	getSubagentsRoot,
	RunControl,
	sweepProjectResultArtifacts,
	type SingleResult,
} from "../execution/spawn.ts";
import { samePath } from "../isolation/managed-paths.ts";
import { isProcessAlive, sweepProjectDurableDirs, sweepProjectTempDirs } from "../isolation/temp-hygiene.ts";
import {
	isPathInside,
	restoreWorktreeIsolation,
	worktreeGroupId,
	type WorktreeIsolation,
} from "../isolation/worktree.ts";
import { installThreadLifecycle } from "./thread-lifecycle.ts";

/** Release managed artifacts belonging to a discarded, already-settled record. */
async function discardRestoredRecord(runtime: SubagentRuntime, record: ThreadRecord): Promise<void> {
	await discardRecordArtifacts(record);
	if (record.sessionDir) runtime.sessionDirs.delete(record.sessionDir);
	await removeThreadRecord(runtime.configPath, threadRecordIdentity(record), record.cwd).catch(() => undefined);
}

function createRestoredThread(
	runtime: SubagentRuntime,
	record: ThreadRecord,
	worktree: WorktreeIsolation | undefined,
	state: ThreadState,
): SubagentThread {
	const thread: SubagentThread = {
		durableId: threadRecordIdentity(record),
		id: record.runId,
		generation: record.generation,
		agentName: record.agentName,
		task: record.task,
		phaseId: record.phaseId,
		scope: record.scope,
		writeCapable: record.writeCapable ?? record.agentName !== "scout",
		cwd: record.cwd,
		executionCwd: record.executionCwd,
		...(record.thinkingLevel ? { thinkingLevel: record.thinkingLevel as ThinkingLevel } : {}),
		isolation: record.isolation,
		worktree,
		state,
		control: new RunControl(record.task, record.generation),
		generationCompletion: Promise.resolve(),
		lifecycleVersion: 0,
		elapsedMs: record.elapsedMs,
		sessionId: record.sessionId,
		sessionDir: record.sessionDir,
		lastResult: restoredResultFromSummary(record),
		finalizeIsolation: async () => undefined,
	};
	installThreadLifecycle(thread, { runtime });
	return thread;
}

function belongsToSessionProject(configPath: string, cwd: string, record: ThreadRecord): boolean {
	return samePath(getProjectRoot(configPath, record.cwd), getProjectRoot(configPath, cwd));
}

/** Rebuild interrupted records for this session's checkout after reload.
 * Other projects' parked threads stay on disk for their own window; this process
 * must not restore them or kill their children. Records with a live owner or
 * child are left alone; missing session files do not discard isolated
 * edits. Already-settled records from older versions are removed with their
 * managed artifacts. */
export async function restoreDurableThreads(runtime: SubagentRuntime, cwd: string): Promise<number[]> {
	const records = await readThreadRecords(runtime.configPath);
	const restoredIds: number[] = [];
	const localRecords = records.filter((record) => belongsToSessionProject(runtime.configPath, cwd, record));
	for (const record of localRecords) monitor.ensureNextIdAbove(record.runId);
	for (let record of localRecords) {
		const identity = threadRecordIdentity(record);
		if ([...runtime.threads.values()].some((thread) => thread.durableId === identity)) continue;
		// Another Pi window may own this checkpoint, and PID reuse means a live
		// recorded child is not proof of ownership. Never kill either on restore.
		if (isCurrentBoot(record) && (
			(record.ownerPid !== undefined && record.ownerPid !== process.pid && isProcessAlive(record.ownerPid)) ||
			record.childPids.some(isProcessAlive)
		)) continue;
		if (record.state !== "parked") {
			await discardRestoredRecord(runtime, record);
			continue;
		}
		if (runtime.threads.has(record.runId) || monitor.findRun(record.runId)) {
			record = { ...record, durableId: identity, runId: monitor.reserveRunId() };
		}
		// Keep validated recovery paths even when their files are temporarily
		// missing or unreadable. Availability is checked when a session is used.
		record = { ...record, durableId: identity };
		const worktree = record.worktree && await isThreadSourceAvailable(record)
			? await restoreWorktreeIsolation(record.worktree).catch(() => undefined)
			: undefined;
		const restorationFailed = record.isolation === "worktree" && record.worktree !== undefined && !worktree;
		const thread = createRestoredThread(runtime, record, worktree, restorationFailed ? "failed" : "parked");
		runtime.threads.set(record.runId, thread);
		if (thread.sessionDir) runtime.sessionDirs.add(thread.sessionDir);
		if (restorationFailed) {
			const reason = `Run #${record.runId}'s recorded worktree could not be restored; isolated edits may be unavailable. The durable record and any remaining artifacts were kept for manual recovery by main.`;
			thread.restorationRecord = record;
			const previous = thread.lastResult;
			const failed: SingleResult = {
				agent: record.agentName,
				task: record.task,
				exitCode: 1,
				messages: previous?.messages ?? [],
				stderr: reason,
				usage: previous?.usage ?? emptyUsage(),
				model: previous?.model,
				thinking: previous?.thinking,
				stopReason: "error",
				errorMessage: reason,
				dispatchFailed: true,
				sessionId: thread.sessionId,
				sessionDir: thread.sessionDir,
				projectCwd: record.cwd,
				runId: record.runId,
				isolation: "worktree",
				integrationStatus: "retained",
			};
			thread.lastResult = failed;
			runtime.registerRunResult(record.runId, failed);
			monitor.restoreRun({
				id: record.runId,
				agent: record.agentName,
				task: record.task,
				status: "failed",
				elapsedMs: record.elapsedMs,
				isolation: "worktree",
				integrationStatus: "retained",
			});
			runtime.claimRunDelivery(record.runId, "background");
			runtime.publishRunCompletion(record.runId, {
				agent: record.agentName,
				block: `### Subagent restoration failed: #${record.runId} ${record.agentName}\n\n${reason}`,
				usage: failed.usage,
			}, true);
			continue;
		}
		monitor.restoreRun({
			id: record.runId,
			agent: record.agentName,
			task: record.task,
			status: "parked",
			elapsedMs: record.elapsedMs,
			isolation: record.isolation,
			...(record.worktree
				? {
					integrationStatus: record.worktree.state === "active"
						? ("pending" as const)
						: record.worktree.state,
					...(worktree ? { worktreeId: worktreeGroupId(worktree) } : {}),
				}
				: {}),
		});
		restoredIds.push(record.runId);
	}
	return restoredIds;
}

/** Age out expired records before restoring threads, then sweep leaked state.
 * Each stage is best-effort so a broken manifest never blocks the session.
 * `durableRestore` includes pruning: callers cannot see a restored owner whose
 * checkpoint the same startup is about to delete. Later sweeps run separately. */
export function bootstrapDurableState(runtime: SubagentRuntime, cwd: string): Promise<void> {
	const restore = (async () => {
		try {
			await pruneThreadRecords(runtime.configPath);
		} catch {
			/* unreadable recovery references remain protected */
		}
		try {
			runtime.restoredRunIds = await restoreDurableThreads(runtime, cwd);
		} catch {
			/* restore is best-effort */
		}
	})();
	runtime.durableRestore = restore;
	return (async () => {
		await restore;
		const projectRoots = getSubagentsRoot(runtime.configPath);
		try {
			sweepProjectTempDirs(projectRoots);
		} catch {
			/* temp hygiene is best-effort */
		}
		// Both deleting sweeps below honor the same manifest claims. Reading them
		// validates every record (Git resolution included), so it runs once; an
		// unreadable manifest skips both sweeps rather than deleting claimed work.
		let referenced: Set<string> | undefined;
		try {
			referenced = await readReferencedDurablePaths(runtime.configPath);
		} catch {
			/* durable-state hygiene is best-effort */
		}
		if (referenced) {
			const claimed = [...referenced];
			try {
				// Sessions and worktrees outlive their process on purpose, so only
				// ownership separates a live Pi's state from artifacts a crash
				// abandoned. Valid thread and recovery records always keep their paths.
				sweepProjectDurableDirs(projectRoots, {
					keep: (path) => claimed.some((claim) => isPathInside(path, claim)),
				});
			} catch {
				/* durable-state hygiene is best-effort */
			}
		}
		try {
			// Result excerpts are bounded on write, which never reaches a project
			// that has stopped producing them.
			sweepProjectResultArtifacts(projectRoots);
		} catch {
			/* result retention is best-effort */
		}
		if (referenced) {
			try {
				await pruneStaleProjectRoots(runtime.configPath, { referenced });
			} catch {
				/* project-root hygiene is best-effort */
			}
		}
	})();
}
