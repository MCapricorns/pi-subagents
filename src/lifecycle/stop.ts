/** Shared destructive stop: claim every lifecycle before awaiting child or Git cleanup. */

import { existsSync } from "node:fs";
import { emptyUsage } from "../execution/run-control.ts";
import type { SingleResult } from "../execution/spawn.ts";
import { persistRecoveryRecords, recoveryRecordFromFinalization } from "../isolation/recovery.ts";
import type { WorktreeFinalization } from "../isolation/worktree.ts";
import { monitor } from "../presentation/monitor.ts";
import { removeThreadRecord } from "./durable.ts";
import type { SubagentRuntime, SubagentThread } from "./runtime.ts";
import { CONTROL_QUIESCE_TIMEOUT_MS, quiesced } from "./thread-shared.ts";

export async function stopThreads(runtime: SubagentRuntime, targets: readonly number[], reason?: string) {
	const completionResults: SingleResult[] = [];
	const claimed: Array<{
		runId: number;
		thread: SubagentThread;
		run: ReturnType<typeof monitor.findRun>;
		previousState: SubagentThread["state"];
		wasQueued: boolean;
		wasActive: boolean;
		generation: number;
		controller: AbortController | undefined;
		completion: Promise<void>;
		stopVersion: number;
		stopMessage: string;
	}> = [];
	for (const runId of targets) {
		const thread = runtime.threads.get(runId);
		if (!thread) continue;
		const previousState = thread.state;
		const wasQueued = previousState === "queued";
		const wasActive = thread.lifecycleOperation !== undefined || ["queued", "running", "interrupting"].includes(previousState);
		const stopVersion = ++thread.lifecycleVersion;
		thread.lifecycleOperation = "stop";
		thread.retired = true;
		thread.retireOnSettle = true;
		thread.state = "stopped";
		const stopMessage = reason ?? (wasQueued
			? "Stopped by subagent_stop before the run started."
			: wasActive ? "Stopped by subagent_stop."
				: previousState === "parked" ? "Stopped by subagent_stop from an interrupted checkpoint."
					: "Retired by subagent_stop.");
		claimed.push({
			runId, thread, run: monitor.findRun(runId), previousState, wasQueued, wasActive,
			generation: thread.generation,
			controller: thread.queueController,
			completion: thread.generationCompletion,
			stopVersion, stopMessage,
		});
	}

	// Interrupt every claimed generation before awaiting any one of them.
	// An isolated stop may need the repository lane for final integration;
	// cancelling all holders first prevents stop-all from waiting behind a
	// later shared workflow that this same operation has not interrupted yet.
	const interruptionPromises = claimed.map(({ thread, stopMessage, controller }) => {
		const stopping = thread.control.stop(stopMessage).catch(() => undefined);
		runtime.backgroundQueue.cancel(controller);
		return stopping;
	});

	const stopped: string[] = [];
	const retainedIntegration: string[] = [];
	const pendingIntegration: string[] = [];
	for (const [claimIndex, claim] of claimed.entries()) {
		const {
			runId,
			thread,
			run,
			previousState,
			wasQueued,
			wasActive,
			generation,
			controller,
			completion,
			stopVersion,
			stopMessage,
		} = claim;
		// Every wait here is bounded: the queue task can sit for minutes in
		// worktree finalization or behind the managed repository lane, and an
		// unkillable child can stall even process termination. Stop owns the
		// lifecycle synchronously, so a stuck tail settles silently after we
		// proceed; none of its late paths can publish a second result.
		await quiesced(interruptionPromises[claimIndex]);
		if (!(await quiesced(completion))) runtime.backgroundQueue.cancel(controller);
		if (runtime.runControllers.get(runId) === controller) runtime.runControllers.delete(runId);
		if (thread.queueController === controller) thread.queueController = undefined;

		// Dispatch yields publication ownership as soon as stop claims the
		// lifecycle. Synthesize and publish the one aborted result here only when
		// this stop actually interrupted unfinished work.
		let stoppedResult: SingleResult | undefined;
		if (
			wasQueued ||
			previousState === "parked" ||
			!runtime.settledRuns.has(runId)
		) {
			const prior = thread.lastResult;
			stoppedResult = prior
				? {
					...prior,
					exitCode: 1,
					stopReason: "aborted",
					errorMessage: stopMessage,
					runId,
				}
				: {
					agent: thread.agentName,
					task: thread.task,
					exitCode: 1,
					messages: [],
					stderr: stopMessage,
					usage: emptyUsage(),
					model: run?.model,
					thinking: run?.thinking,
					projectCwd: thread.cwd,
					stopReason: "aborted",
					errorMessage: stopMessage,
					runId,
					isolation: thread.isolation,
				};
			const worktree = thread.worktree;
			let finalization: WorktreeFinalization | undefined;
			try {
				finalization = await Promise.race([
					thread.finalizeIsolation(generation, stoppedResult),
					new Promise<undefined>((resolve) => {
						const timer = setTimeout(() => resolve(undefined), CONTROL_QUIESCE_TIMEOUT_MS);
						if (typeof timer.unref === "function") timer.unref();
					}),
				]);
			} catch {
				/* an unexpected finalize rejection must not block the stop */
			}
			if (finalization === undefined) {
				// Integration is still settling in the background. Point a
				// durable recovery record at the artifacts so the isolated work
				// stays findable even if the background tail later fails; a
				// successful tail removes them and the record self-prunes.
				if (thread.isolation === "worktree" && worktree) {
					stoppedResult.integrationStatus = "pending";
					stoppedResult.integrationWorktreePath = worktree.worktreePath;
					await persistRecoveryRecords(runtime.configPath, [
						recoveryRecordFromFinalization(runId, {
							status: "retained",
							integrated: false,
							hadChanges: false,
							...(existsSync(worktree.worktreePath) ? { worktreePath: worktree.worktreePath } : {}),
							...(existsSync(worktree.patchPath) ? { patchPath: worktree.patchPath } : {}),
							error: "subagent_stop timed out waiting for worktree integration; it continues in the background",
						}),
					]).catch(() => undefined);
					pendingIntegration.push(`#${runId}`);
				}
			} else if (finalization.status === "retained") {
				retainedIntegration.push(`#${runId}`);
			}
			runtime.registerRunResult(runId, stoppedResult);
			thread.lastResult = stoppedResult;
		}
		monitor.setStatus(runId, "failed");
		if (stoppedResult) completionResults.push(stoppedResult);
		// Leave the terminal row for the footer; beginTurn sweeps it.
		runtime.retireThreadSession(thread);
		// The destructive retire removes the durable record with the session;
		// an id never resurrects after subagent_stop.
		await removeThreadRecord(runtime.configPath, runId, thread.cwd).catch(() => undefined);
		if (thread.lifecycleVersion === stopVersion && thread.lifecycleOperation === "stop") {
			thread.lifecycleOperation = undefined;
		}
		stopped.push(`#${runId} ${thread.agentName}${wasQueued ? " (queued)" : wasActive ? "" : ` (${previousState})`}`);
	}
	return { stopped, retainedIntegration, pendingIntegration, completionResults };
}
