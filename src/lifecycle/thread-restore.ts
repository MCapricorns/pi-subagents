/** Durable restoration and startup hygiene for logical sub-agent threads. */

import { rm } from "node:fs/promises";
import { type ThinkingLevel } from "../configuration/config.ts";
import {
	isCurrentBoot,
	pruneStaleProjectRoots,
	pruneThreadRecords,
	readThreadRecords,
	referencedDurablePaths,
	removeThreadRecord,
	restoredResultFromSummary,
	type ThreadRecord,
} from "./durable.ts";
import { monitor } from "../presentation/monitor.ts";
import { emptyUsage } from "../execution/rpc-control.ts";
import type { SubagentRuntime, SubagentThread, ThreadState } from "./runtime.ts";
import {
	getSubagentsRoot,
	RpcRunControl,
	sessionExists,
	sweepProjectResultArtifacts,
	type SingleResult,
} from "../execution/spawn.ts";
import { isProcessAlive, killProcessTree, sweepProjectDurableDirs, sweepProjectTempDirs } from "../isolation/temp-hygiene.ts";
import { readRecoveryRecords, referencedRecoveryPaths } from "../isolation/recovery.ts";
import {
	isPathInside,
	restoreWorktreeIsolation,
	worktreeGroupId,
	type WorktreeIsolation,
} from "../isolation/worktree.ts";
import { installThreadLifecycle } from "./thread-lifecycle.ts";

/** Release managed artifacts belonging to a discarded, already-settled record. */
async function discardRestoredRecord(runtime: SubagentRuntime, record: ThreadRecord): Promise<void> {
	if (record.sessionDir) {
		await rm(record.sessionDir, { recursive: true, force: true }).catch(() => undefined);
		runtime.sessionDirs.delete(record.sessionDir);
	}
	if (record.worktree && (record.worktree.state === "active" || record.worktree.state === "retained")) {
		const worktree = await restoreWorktreeIsolation(record.worktree).catch(() => undefined);
		await worktree?.discard().catch(() => undefined);
	}
	await removeThreadRecord(runtime.configPath, record.runId, record.cwd).catch(() => undefined);
}

function createRestoredThread(
	runtime: SubagentRuntime,
	record: ThreadRecord,
	worktree: WorktreeIsolation | undefined,
	state: ThreadState,
): SubagentThread {
	const thread: SubagentThread = {
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
		control: new RpcRunControl(record.task, record.generation),
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

/** Rebuild interrupted records for manual recovery after reload. Orphaned children
 * are stopped first; missing session files do not discard isolated edits. Already-
 * settled records from older versions are removed with their managed artifacts. */
export async function restoreDurableThreads(runtime: SubagentRuntime): Promise<number[]> {
	const records = await readThreadRecords(runtime.configPath);
	const restoredIds: number[] = [];
	for (const record of records) {
		if (runtime.threads.has(record.runId) || monitor.findRun(record.runId)) continue;
		if (record.state !== "parked") {
			await discardRestoredRecord(runtime, record);
			continue;
		}
		// A child orphaned by reload/crash may still hold the retained session.
		// The on-disk session checkpoint is what survives; kill the writer — but
		// only while the recorded pids are still ours. Across a reboot the same
		// numbers belong to unrelated processes.
		if (isCurrentBoot(record)) {
			for (const pid of record.childPids) {
				if (isProcessAlive(pid)) killProcessTree(pid);
			}
		}
		const sessionValid =
			record.sessionId !== undefined &&
			record.sessionDir !== undefined &&
			sessionExists(record.sessionDir, record.sessionId);
		const restoredRecord = sessionValid ? record : { ...record, sessionId: undefined, sessionDir: undefined };
		const worktree = record.worktree
			? await restoreWorktreeIsolation(record.worktree).catch(() => undefined)
			: undefined;
		const restorationFailed = record.isolation === "worktree" && record.worktree !== undefined && !worktree;
		const thread = createRestoredThread(runtime, restoredRecord, worktree, restorationFailed ? "failed" : "parked");
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

/** Session-start durable bootstrap: restore threads, age out expired records, and
 * sweep leaked temp/state directories. Every stage is best-effort so a broken
 * manifest never blocks the session.
 *
 * Restore is published on the runtime as `durableRestore` before this returns,
 * so callers that must see restored threads await that pass alone and never the
 * hygiene sweeps behind it. Hygiene still runs after restore: pruning decides
 * what to delete from the records restore has already claimed. */
export function bootstrapDurableState(runtime: SubagentRuntime): Promise<void> {
	const restore = (async () => {
		try {
			runtime.restoredRunIds = await restoreDurableThreads(runtime);
		} catch {
			/* restore is best-effort */
		}
	})();
	runtime.durableRestore = restore;
	return (async () => {
		await restore;
		try {
			await pruneThreadRecords(runtime.configPath);
		} catch {
			/* retention is best-effort */
		}
		const projectRoots = getSubagentsRoot(runtime.configPath);
		try {
			sweepProjectTempDirs(projectRoots);
		} catch {
			/* temp hygiene is best-effort */
		}
		try {
			// Sessions and worktrees outlive their process on purpose, so only
			// ownership separates a live Pi's state from artifacts a crash
			// abandoned. Valid thread and recovery records always keep their paths.
			const records = await readThreadRecords(runtime.configPath);
			const recoveryRecords = await readRecoveryRecords(runtime.configPath);
			const referenced = [...referencedDurablePaths(records)];
			referenced.push(...await referencedRecoveryPaths(runtime.configPath, recoveryRecords));
			sweepProjectDurableDirs(projectRoots, {
				keep: (path) => referenced.some((claimed) => isPathInside(path, claimed)),
			});
		} catch {
			/* durable-state hygiene is best-effort */
		}
		try {
			// Result excerpts are bounded on write, which never reaches a project
			// that has stopped producing them.
			sweepProjectResultArtifacts(projectRoots);
		} catch {
			/* result retention is best-effort */
		}
		try {
			await pruneStaleProjectRoots(runtime.configPath);
		} catch {
			/* project-root hygiene is best-effort */
		}
	})();
}
