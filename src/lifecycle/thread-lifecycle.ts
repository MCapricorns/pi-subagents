/**
 * Stable logical-thread generation lifecycle for background sub-agents.
 *
 * Dispatch owns tool policy and role briefs; this module owns one
 * stable parent generation end to end: managed-repository lane use,
 * worktree setup/finalization, queue/process ownership,
 * recovery artifacts, and guarded one-time terminal publication.
 */

import { join, resolve } from "node:path";
import { isWriteCapableAgent, resolveAgentTools, type AgentConfig } from "../delegation/agents.ts";
import type { CompletionMessageItem } from "./completion.ts";
import { loadConfig } from "../configuration/config.ts";
import { dispatchFailedResult, failedStartResult, formatCompletionBlock, modelLevelTakeoverNote, queuedResult } from "../presentation/format.ts";
import { monitor } from "../presentation/monitor.ts";
import { findDuplicateDispatch } from "../delegation/prompt.ts";
import { findWriterLeaseScopeOverlap, normalizePhaseId, normalizePhaseScope } from "../delegation/phase-scope.ts";
import { persistRecoveryRecords, recoveryRecordFromFinalization } from "../isolation/recovery.ts";
import type { SubagentRuntime, SubagentThread, ThreadState } from "./runtime.ts";
import {
	getProjectRoot,
	RpcRunControl,
	isFailedResult,
	isModelLevelFailure,
	runSingleAgentWithMainFallback,
	type SingleResult,
	type SubagentDetails,
	type SubagentLiveEvent,
} from "../execution/spawn.ts";
import {
	isWorktreeCapableAgent,
	persistThreadCheckpoint,
	projectResultsRoot,
	resolveDispatchModelRoute,
	runInManagedRepositoryLane,
	withWorktreeSystemPrompt,
	type DispatchEnvironment,
	type StartBackgroundInternal,
	type StartBackgroundOptions,
	type ThreadLifecycleDeps,
} from "./thread-shared.ts";
import {
	createWorktreeIsolation,
	worktreeGroupId,
	type IsolationMode,
	type WorktreeFinalization,
	type WorktreeIsolation,
} from "../isolation/worktree.ts";

interface BackgroundDispatcherOptions {
	runtime: SubagentRuntime;
	/** Current parent context, config, and role catalog for a fresh dispatch. */
	getEnvironment: () => DispatchEnvironment;
	finishRun: (
		runId: number,
		status: "done" | "failed",
		opts?: { silent?: boolean },
	) => void;
	makeLiveHandler: (
		runId: number,
		generation?: number,
	) => (event: SubagentLiveEvent) => void;
	makeDetails: (
		mode: "single" | "parallel",
		background?: boolean,
	) => (results: SingleResult[]) => SubagentDetails;
}

export function createBackgroundDispatcher(options: BackgroundDispatcherOptions): StartBackgroundInternal {
	const {
		runtime,
		getEnvironment,
		finishRun,
		makeLiveHandler,
		makeDetails,
	} = options;

	const startBackground: StartBackgroundInternal = async (
		agentName: string,
		task: string,
		cwd: string | undefined,
		isolation: IsolationMode = "shared",
		startOptions: StartBackgroundOptions = {},
	): Promise<SingleResult> => {
		if (!runtime.sessionActive) {
			return failedStartResult(agentName, task, "Parent session shut down before this subagent run could start.");
		}
		const baseEnvironment = getEnvironment();
		const runCtx = baseEnvironment.ctx;
		const runConfig = baseEnvironment.config;
		const discoveredAgent = baseEnvironment.agents.find((candidate) => candidate.name === agentName);
		if (!discoveredAgent) return failedStartResult(agentName, task, `Unknown agent: "${agentName}".`);
		const resolveLiveAgentTools = (candidate: AgentConfig): AgentConfig =>
			resolveAgentTools({ ...candidate, tools: discoveredAgent.tools }, runtime.getActiveTools());
		const agent = resolveLiveAgentTools(discoveredAgent);
		const originalCwd = resolve(cwd ?? runCtx.cwd);
		let phaseId: string | undefined;
		let scope: ReturnType<typeof normalizePhaseScope>;
		try {
			phaseId = normalizePhaseId(startOptions.phaseId);
			scope = normalizePhaseScope(startOptions.scope, originalCwd);
		} catch (error) {
			return failedStartResult(agentName, task, error instanceof Error ? error.message : String(error));
		}
		const writeCapable = Boolean(startOptions.writeCapable) || isWriteCapableAgent(agent);
		if (isolation === "worktree" && !isWorktreeCapableAgent(agent)) {
			return {
				...failedStartResult(agentName, task, `Agent "${agentName}" is read-only; worktree isolation is available only to write-capable agents such as artisan.`),
				isolation,
			};
		}
		const duplicate = findDuplicateDispatch(runtime.threads.values(), task, originalCwd, phaseId);
		if (duplicate) {
			return failedStartResult(agentName, task,
				`Run #${duplicate.source.id} (${duplicate.source.agentName}) already owns this logical phase (${duplicate.source.state}). Do not redispatch it; inspect its result or let it finish. Main handles follow-up work.`);
		}
		if (writeCapable && scope) {
			const conflict = findWriterLeaseScopeOverlap(scope, runtime.threads.values());
			if (conflict) {
				return failedStartResult(agentName, task,
					`Declared writer scope ${conflict.overlap.left} overlaps active run #${conflict.lease.id} scope ${conflict.overlap.right}; no run was started.`);
			}
		}
		const projectRoot = getProjectRoot(runtime.configPath, originalCwd);
		const sessionsRoot = join(projectRoot, "sessions");
		const worktreesRoot = join(projectRoot, "worktrees");
		const scratchRoot = join(projectRoot, "tmp");
		let worktree: WorktreeIsolation | undefined;
		let executionCwd = originalCwd;
		let worktreeGroup: string | undefined;
		const resolvedRoute = resolveDispatchModelRoute(agent, runConfig, runCtx);
		const route = isolation === "worktree"
			? { ...resolvedRoute, agent: withWorktreeSystemPrompt(resolvedRoute.agent) }
			: resolvedRoute;
		const thinkingLevel = route.thinkingLevel;
		const runId = monitor.addRun(agent.name, task, route.agent.model, thinkingLevel, { isolation });
		runtime.claimRunDelivery(runId, startOptions.deliveryRoute ?? "background");
		const generation = 1;
		const pending: SingleResult = {
			...queuedResult(route.agent, task, thinkingLevel),
			runId,
			projectCwd: originalCwd,
			isolation,
			...(isolation === "worktree" ? { integrationStatus: "pending" as const } : {}),
		};

		let thread!: SubagentThread;
		const control = new RpcRunControl(task, generation, (phase) => {
			if (runtime.threads.get(runId)?.generation !== generation || phase === "settled") return;
			const state: ThreadState =
				phase === "queued" || phase === "starting"
					? "queued"
					: phase === "interrupting"
						? "interrupting"
						: phase === "stopped"
							? "stopped"
							: "running";
			thread.state = state;
			if (state === "queued") monitor.setStatus(runId, "queued");
			else if (state === "interrupting") monitor.setStatus(runId, "interrupting");
			else if (state === "running") monitor.setStatus(runId, "running");
		});

		thread = {
			id: runId,
			generation,
			agentName: agent.name,
			task,
			phaseId,
			scope,
			writeCapable,
			cwd: originalCwd,
			executionCwd,
			thinkingLevel,
			isolation,
			state: "queued",
			control,
			generationCompletion: Promise.resolve(),
			lifecycleVersion: 0,
			elapsedMs: 0,
			finalizeIsolation: async () => undefined,
		};
		runtime.threads.set(runId, thread);
		const installCurrentLifecycle = (): void => installThreadLifecycle(thread, {
			runtime,
			runCtx,
		});
		if (isolation === "shared" || worktree) installCurrentLifecycle();

		const onLive = makeLiveHandler(runId, generation);
		// Shared write-capable runs serialize on the repository lane so their
		// edits cannot race; the lane wait releases the process slot because it
		// is write serialization, not pool pacing.
		const reserveManagedLane = isolation === "shared" && writeCapable;
		const runGeneration = async (backgroundSignal: AbortSignal, controller: AbortController): Promise<void> => {
				if (runtime.threads.get(runId)?.generation !== generation) return;
				if (isolation === "worktree" && !worktree) {
					const prepared = await createWorktreeIsolation(originalCwd, { tempBaseDir: worktreesRoot });
					if (runtime.threads.get(runId)?.generation !== generation || backgroundSignal.aborted) {
						await prepared.discard().catch(() => undefined);
						return;
					}
					worktree = prepared;
					executionCwd = prepared.cwd;
					worktreeGroup = worktreeGroupId(prepared);
					thread.worktree = prepared;
					thread.executionCwd = executionCwd;
					monitor.setIsolation(runId, "worktree", "pending", worktreeGroup);
					installCurrentLifecycle();
				}
				// The generation body owns a process slot from here (a lane wait, if
				// any, was granted above). Recording the transition synchronously keeps
				// every "queued" surface truthful: only runs still pending in the pool
				// or behind the lane report a wait.
				monitor.setWaitReason(runId, "starting");
				// Model/thinking config may have changed while this generation sat
				// queued behind the concurrency limit. Re-resolve the route at actual
				// start so /subagents-setup edits apply to not-yet-started runs.
				let activeRoute = route;
				let activeIdleTimeoutMs = runConfig.idleTimeoutSec * 1000;
				try {
					const startConfig = await loadConfig(runtime.configPath);
					const resolvedStart = resolveDispatchModelRoute(agent, startConfig, runCtx);
					activeRoute = isolation === "worktree"
						? { ...resolvedStart, agent: withWorktreeSystemPrompt(resolvedStart.agent) }
						: resolvedStart;
					activeIdleTimeoutMs = startConfig.idleTimeoutSec * 1000;
					monitor.setModel(runId, activeRoute.agent.model);
					monitor.setThinking(runId, activeRoute.thinkingLevel);
				} catch {
					/* keep the dispatch-time route when fresh config is unavailable */
				}
				let result: SingleResult;
				try {
					result = await runSingleAgentWithMainFallback(
						{
							defaultCwd: executionCwd,
							agent: activeRoute.agent,
							resolveAgentForAttempt: resolveLiveAgentTools,
							agentName,
							task,
							cwd: executionCwd,
							thinkingLevel: activeRoute.thinkingLevel,
							thinkingLevelForModel: activeRoute.thinkingLevelForModel,
							signal: backgroundSignal,
							onLive,
							control,
							makeDetails: makeDetails("single", true),
							idleTimeoutMs: activeIdleTimeoutMs,
							sessionRoot: sessionsRoot,
							scratchRoot,
						},
						activeRoute.mainFallbackRef,
					);
				} catch (error) {
					const errorMessage = error instanceof Error ? error.message : String(error);
					result = {
						...pending,
						task: control.getObjective(),
						exitCode: 1,
						stderr: errorMessage,
						stopReason: backgroundSignal.aborted ? "aborted" : "error",
						errorMessage,
						dispatchFailed: true,
					};
				}

				// Stale work from a retired parent owns no publication or monitor updates.
				if (runtime.threads.get(runId)?.generation !== generation) return;
				result.runId = runId;
				result.projectCwd = originalCwd;
				result.isolation = isolation;
				thread.task = result.task;
				thread.sessionId = result.sessionId;
				thread.sessionDir = result.sessionDir;
				thread.lastResult = result;
				runtime.retainSession(result);
				monitor.setModel(runId, result.model, result.modelFallbackFrom);
				monitor.setThinking(runId, result.thinking);
				// Checkpoint the session location durably: a crash or reload before
				// settlement still restores this thread with its retained context.
				if (result.sessionId && result.sessionDir) {
					persistThreadCheckpoint(runtime, thread, "parked");
				}

				const lifecycleInterrupted = (): boolean =>
					thread.lifecycleOperation === "stop" || thread.state === "stopped";
				// Stop owns publication once it claims the lifecycle. Leave the partial
				// result on the thread for that owner to finalize and deliver once.
				if (lifecycleInterrupted()) return;

				// A shutdown can win in the microtask gap after the child RPC
				// settles. Never replace the stable top-level session with an
				// aborted partial.
				if (backgroundSignal.aborted || !runtime.sessionActive) return;

				if (thread.retireOnSettle) runtime.retireThreadSession(thread);
				// Claim terminal settlement synchronously before the first slow await.
				// Park therefore either wins while RPC is still active, or is rejected
				// once settlement owns the generation. Destructive stop may supersede
				// this reservation; publication is revalidated after Git finalization.
				const settlementVersion = ++thread.lifecycleVersion;
				thread.lifecycleOperation = "settle";
				const ownsSettlement = (): boolean =>
					runtime.threads.get(runId) === thread &&
					thread.generation === generation &&
					thread.lifecycleVersion === settlementVersion &&
					thread.lifecycleOperation === "settle" &&
					!thread.retired;
				try {
					// The child process has exited. Isolated Git finalization remains
					// lifecycle-owned and awaited, but no longer consumes a process slot.
					if (isolation === "worktree") runtime.backgroundQueue.suspend(controller);
					await thread.finalizeIsolation(generation, result);
				if (!ownsSettlement()) return;

				const failed = isFailedResult(result);
				thread.state = failed ? "failed" : "completed";
				// Stamp the terminal monitor state before projecting it. This gives every
				// path a fixed endedAt even when the row is removed immediately.
				monitor.setStatus(runId, failed ? "failed" : "done");
				thread.elapsedMs = monitor.getElapsedMs(runId) ?? thread.elapsedMs;
				// Persist before the sessionActive check: a shutdown that won the
				// lifecycle race must still leave the settled record on disk.
				persistThreadCheckpoint(runtime, thread, failed ? "failed" : "completed");
				if (!runtime.sessionActive || !ownsSettlement()) return;

				const modelLevel = failed && isModelLevelFailure(result);
				const dispatchFailed = result.dispatchFailed === true;
				const ownedController = thread.queueController;
				if (runtime.runControllers.get(runId) === ownedController) runtime.runControllers.delete(runId);
				thread.queueController = undefined;
				finishRun(
					runId,
					failed ? "failed" : "done",
					modelLevel || dispatchFailed ? { silent: true } : undefined,
				);
				runtime.registerRunResult(runId, result);

				const completion: CompletionMessageItem = {
					agent: result.agent,
					block: modelLevel
						? `${formatCompletionBlock(result, runConfig.maxResultLines, { resultRoot: projectResultsRoot(runtime.configPath, result.projectCwd ?? originalCwd) })}\n\n${modelLevelTakeoverNote(result)}`
						: formatCompletionBlock(result, runConfig.maxResultLines, { resultRoot: projectResultsRoot(runtime.configPath, result.projectCwd ?? originalCwd) }),
					usage: result.usage,
				};
				if (modelLevel) {
					const detail = result.errorMessage?.trim() || "model unavailable or broken";
					runCtx.ui.notify(`✗ ${result.agent} dispatch failed: ${detail} — task handed to the main window`, "error");
				} else if (dispatchFailed) {
					runCtx.ui.notify(`✗ ${result.agent} dispatch failed: ${result.errorMessage ?? "dispatch crashed"}`, "error");
				}
				runtime.publishRunCompletion(runId, completion, failed);
				} finally {
					if (ownsSettlement()) thread.lifecycleOperation = undefined;
				}
			};
		const queuedGeneration = reserveManagedLane
			? async (backgroundSignal: AbortSignal, controller: AbortController): Promise<void> => {
					// Waiting for repository serialization must not consume a process
					// slot. Once the lane is granted, reacquire through the same FIFO
					// scheduler before any child process can spawn.
					runtime.backgroundQueue.suspend(controller);
					monitor.setWaitReason(runId, "repository-lane");
					await runInManagedRepositoryLane(
						originalCwd,
						async () => {
							monitor.setWaitReason(runId, "process-slot");
							if (!(await runtime.backgroundQueue.acquire(controller))) return;
							await runGeneration(backgroundSignal, controller);
						},
						backgroundSignal,
					);
				}
			: runGeneration;
		const queueController = runtime.backgroundQueue.enqueue(
			queuedGeneration,
			() => {
				if (runtime.threads.get(runId)?.generation !== generation) return;
				// A destructive stop owns publication and may still be finalizing an
				// isolated worktree. Do not expose a
				// terminal monitor state before that owner records its outcome.
				if (thread.lifecycleOperation === "stop") return;
				runtime.runControllers.delete(runId);
				thread.queueController = undefined;
				thread.state = "stopped";
				monitor.setStatus(runId, "failed");
				if (!runtime.sessionActive) {
					monitor.removeRun(runId);
					return;
				}
				finishRun(runId, "failed");
			},
			async (error) => {
				if (runtime.threads.get(runId)?.generation !== generation) return;
				// Queue-level crashes use the same settlement reservation as ordinary
				// results. A concurrent destructive stop may supersede it while
				// slow worktree finalization is running, in which case that owner
				// publishes once.
				if (thread.lifecycleOperation === "stop") return;
				const settlementVersion = ++thread.lifecycleVersion;
				thread.lifecycleOperation = "settle";
				const ownsSettlement = (): boolean =>
					runtime.threads.get(runId) === thread &&
					thread.generation === generation &&
					thread.lifecycleVersion === settlementVersion &&
					thread.lifecycleOperation === "settle" &&
					!thread.retired;
				try {
					const errorMessage = error instanceof Error ? error.message : String(error);
					const latest = thread.lastResult;
					const crashed: SingleResult = latest
						? {
							...latest,
							runId,
							projectCwd: originalCwd,
							isolation,
							exitCode: 1,
							stopReason: "error",
							errorMessage: `Subagent dispatch failed: ${errorMessage}`,
							dispatchFailed: true,
						}
						: {
							...dispatchFailedResult(route.agent, control.getObjective(), error, thinkingLevel),
							runId,
							projectCwd: originalCwd,
							isolation,
						};
					thread.lastResult = crashed;
					runtime.retainSession(crashed);
					if (isolation === "worktree" && thread.worktree) runtime.backgroundQueue.suspend(thread.queueController);
					await thread.finalizeIsolation(generation, crashed);
					if (!ownsSettlement()) return;
					thread.state = "failed";
					monitor.setStatus(runId, "failed");
					thread.elapsedMs = monitor.getElapsedMs(runId) ?? thread.elapsedMs;
					persistThreadCheckpoint(runtime, thread, "failed");
					finishRun(runId, "failed", { silent: true });
					runtime.registerRunResult(runId, crashed);
					runtime.runControllers.delete(runId);
					thread.queueController = undefined;
					if (!runtime.sessionActive || !ownsSettlement()) return;
					try {
						runCtx.ui.notify(`✗ ${crashed.agent} dispatch failed: ${crashed.errorMessage}`, "error");
						runtime.publishRunCompletion(runId, {
							agent: crashed.agent,
							block: formatCompletionBlock(crashed, runConfig.maxResultLines, { resultRoot: projectResultsRoot(runtime.configPath, crashed.projectCwd ?? originalCwd) }),
							usage: crashed.usage,
						}, true);
					} catch {
						/* a second delivery failure must not throw through the queue */
					}
				} finally {
					if (ownsSettlement()) thread.lifecycleOperation = undefined;
				}
			},
		);
		thread.queueController = queueController;
		thread.generationCompletion = runtime.backgroundQueue.waitForTask(queueController);
		runtime.runControllers.set(runId, queueController);
		return pending;
	};

	return startBackground;
}

/** Install the shared settlement hook for a fresh run or recovered worktree. */
export function installThreadLifecycle(thread: SubagentThread, deps: ThreadLifecycleDeps): void {
	const { runtime } = deps;
	const runId = thread.id;

	thread.notifyIsolationFailure = (finalization) => {
		const paths = [finalization.worktreePath, finalization.patchPath].filter(Boolean).join(" · ");
		deps.runCtx?.ui.notify(
			`✗ ${thread.agentName} worktree ${finalization.integrated ? "cleanup" : "integration"} failed${paths ? ` · retained ${paths}` : ""}: ${finalization.error ?? "unknown Git integration error"}`,
			"error",
		);
	};

	const generationWorktree = thread.worktree;
	let generationFinalization: Promise<WorktreeFinalization> | undefined;
	thread.finalizeIsolation = async (
		expectedGeneration: number,
		result?: SingleResult,
	): Promise<WorktreeFinalization | undefined> => {
		if (thread.isolation !== "worktree" || !generationWorktree) return undefined;
		if (thread.generation !== expectedGeneration || thread.worktree !== generationWorktree) return undefined;
		// All normal, destructive-stop, and shutdown owners converge here. Cache
		// the lane-protected apply itself so superseding lifecycle paths can project
		// the same finalization onto their own result without acquiring twice.
		if (!generationFinalization) {
			monitor.setIsolation(
				runId,
				"worktree",
				"finalizing",
				worktreeGroupId(generationWorktree),
			);
			generationFinalization = runInManagedRepositoryLane(
				generationWorktree.originalRoot,
				() => generationWorktree.finalize(),
			);
		}
		const finalization = await generationFinalization;
		monitor.setIsolation(runId, "worktree", finalization.status, worktreeGroupId(generationWorktree));
		if (result) {
			result.runId = runId;
			result.isolation = "worktree";
			result.integrationStatus = finalization.status;
			result.integrationApplied = finalization.integrated;
			result.integrationError = finalization.error;
			result.integrationWorktreePath = finalization.worktreePath;
			result.integrationPatchPath = finalization.patchPath;
			if (finalization.status === "retained") {
				const retained = [
					finalization.worktreePath ? `worktree ${finalization.worktreePath}` : undefined,
					finalization.patchPath ? `patch ${finalization.patchPath}` : undefined,
				].filter(Boolean).join(", ");
				const integrationMessage = finalization.integrated
					? `Worktree changes were applied, but cleanup failed${retained ? `; retained ${retained}` : ""}: ${finalization.error ?? "unknown Git cleanup error"}`
					: `Worktree integration failed${retained ? `; retained ${retained}` : ""}: ${finalization.error ?? "unknown Git integration error"}`;
				result.exitCode = 1;
				result.stopReason = "error";
				result.errorMessage = result.errorMessage
					? `${result.errorMessage}\n${integrationMessage}`
					: integrationMessage;
				result.stderr = result.stderr ? `${result.stderr.trimEnd()}\n${integrationMessage}` : integrationMessage;
			}
		}
		if (finalization.status === "retained") {
			if (!thread.isolationFailureNotified) {
				thread.isolationFailureNotified = true;
				try {
					thread.notifyIsolationFailure?.(finalization);
				} catch {
					/* notification failures do not hide retained artifacts */
				}
			}
			// Every retained finalization gets a durable recovery record, so the
			// artifacts stay findable even when the owning process dies next.
			void persistRecoveryRecords(runtime.configPath, [
				recoveryRecordFromFinalization(runId, finalization),
			]).catch(() => undefined);
		}
		return finalization;
	};

}
