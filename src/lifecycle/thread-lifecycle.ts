/**
 * Stable logical-thread generation lifecycle for background sub-agents.
 *
 * Dispatch owns tool policy and role briefs; this module owns one
 * stable parent generation end to end: managed-repository lane use,
 * worktree setup/finalization, queue/process ownership,
 * retained-session resume, and guarded one-time terminal publication.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
	discoverAgents,
	isWriteCapableAgent,
	resolveAgentTools,
	type AgentConfig,
} from "../delegation/agents.ts";
import { type CompletionMessageItem } from "./completion.ts";
import { loadConfig } from "../configuration/config.ts";
import {
	dispatchFailedResult,
	failedStartResult,
	formatCompletionBlock,
	modelLevelTakeoverNote,
	queuedResult,
} from "../presentation/format.ts";
import { monitor } from "../presentation/monitor.ts";
import { findDuplicateDispatch } from "../delegation/prompt.ts";
import {
	findWriterLeaseScopeOverlap,
	mergePhaseScopes,
	normalizePhaseId,
	normalizePhaseScope,
} from "../delegation/phase-scope.ts";
import { persistRecoveryRecords, recoveryRecordFromFinalization } from "../isolation/recovery.ts";
import type { SubagentRuntime, SubagentThread, ThreadState } from "./runtime.ts";
import { forkRetainedSession } from "../execution/session-fork.ts";
import {
	buildAppendedObjectivePrompt,
	buildResumePrompt,
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
	beginRuntimePreflight,
	isWorktreeCapableAgent,
	ownsResumeReservation,
	persistThreadCheckpoint,
	projectResultsRoot,
	quiesced,
	resolveDispatchModelRoute,
	runInManagedRepositoryLane,
	withWorktreeSystemPrompt,
	type DispatchEnvironment,
	type ResumeReservation,
	type SessionSeed,
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
	/** Live dispatch environment; resolved lazily so control operations work
	 * before the first dispatch of a process (restored threads). */
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
		const {
			phaseId: requestedPhaseId,
			scope: requestedScope,
			writeCapable: requestedWriteCapable,
			existingThread,
			appendedObjectiveOnResume = false,
			environment,
			seed,
			resumeReservation,
			deliveryRoute = "background",
		} = startOptions;
		if (!runtime.sessionActive) {
			return failedStartResult(agentName, task, "Parent session shut down before this subagent generation could start.");
		}
		if (existingThread && (!resumeReservation || !ownsResumeReservation(runtime, existingThread, resumeReservation))) {
			return failedStartResult(agentName, task, `Run #${existingThread.id} changed while resume was preparing; no new generation was started.`);
		}
		const baseEnvironment = environment ?? getEnvironment();
		const runCtx = baseEnvironment.ctx;
		const runConfig = baseEnvironment.config;
		const runAgents = baseEnvironment.agents;
		const discoveredAgent = runAgents.find((candidate) => candidate.name === agentName);
		if (!discoveredAgent) return failedStartResult(agentName, task, `Unknown agent: "${agentName}".`);
		const resolveLiveAgentTools = (candidate: AgentConfig): AgentConfig =>
			resolveAgentTools({ ...candidate, tools: discoveredAgent.tools }, runtime.getActiveTools());
		const agent = resolveLiveAgentTools(discoveredAgent);

		const originalCwd = resolve(cwd ?? runCtx.cwd);
		let phaseId: string | undefined;
		let scope: ReturnType<typeof normalizePhaseScope>;
		try {
			phaseId = normalizePhaseId(existingThread ? existingThread.phaseId : requestedPhaseId);
			const requested = normalizePhaseScope(requestedScope, originalCwd);
			scope = existingThread ? mergePhaseScopes(existingThread.scope, requested) : requested;
		} catch (error) {
			return failedStartResult(agentName, task, error instanceof Error ? error.message : String(error));
		}
		const currentWriteCapable = isWriteCapableAgent(agent);
		const priorWriteCapable = existingThread
			? (existingThread.writeCapable ?? existingThread.agentName !== "scout")
			: Boolean(requestedWriteCapable);
		const writeCapable = priorWriteCapable || currentWriteCapable;
		if (isolation === "worktree" && !isWorktreeCapableAgent(agent)) {
			return {
				...failedStartResult(agentName, task, `Agent "${agentName}" is read-only; worktree isolation is available only to write-capable agents such as artisan.`),
				isolation,
			};
		}
		if (!existingThread) {
			const duplicate = findDuplicateDispatch(runtime.threads.values(), task, originalCwd, phaseId);
			if (duplicate?.kind === "active") {
				return failedStartResult(
					agentName,
					task,
					`Duplicate active dispatch matches run #${duplicate.source.id} (${duplicate.source.agentName}). Use that logical thread instead; resume #${duplicate.source.id} when it is eligible.`,
				);
			}
			if (duplicate?.kind === "settled") {
				// The same brief on the same tree would re-buy work whose result main
				// already holds; the retained session continues it for a fraction.
				return failedStartResult(
					agentName,
					task,
					`Run #${duplicate.source.id} (${duplicate.source.agentName}) already ${duplicate.source.state} this logical phase and kept its context; its result was delivered. Resume #${duplicate.source.id} with an appended objective instead of paying for a second run${phaseId ? "; keep using the same phaseId on that thread" : ", or restate the brief with what changed"}.`,
				);
			}
		}
		if (writeCapable && scope) {
			const conflict = findWriterLeaseScopeOverlap(scope, runtime.threads.values(), existingThread?.id);
			if (conflict) {
				return failedStartResult(
					agentName,
					task,
					`Declared writer scope ${conflict.overlap.left} overlaps active run #${conflict.lease.id} scope ${conflict.overlap.right}; no new generation was started.`,
				);
			}
		}
		const projectRoot = getProjectRoot(runtime.configPath, originalCwd);
		const sessionsRoot = join(projectRoot, "sessions");
		const worktreesRoot = join(projectRoot, "worktrees");
		const scratchRoot = join(projectRoot, "tmp");
		const previousWorktree = existingThread?.worktree;
		let worktree = seed?.worktree ?? previousWorktree;
		if (isolation === "worktree" && worktree && worktree.state !== "active") {
			return {
				...failedStartResult(agentName, task, `Run #${existingThread?.id ?? "?"} has no active continuation worktree.`),
				isolation,
				integrationStatus: worktree.state === "finalizing" ? "pending" : worktree.state,
			};
		}
		let executionCwd = worktree?.cwd ?? originalCwd;
		let worktreeGroup = worktree ? worktreeGroupId(worktree) : undefined;
		// A resume re-runs at the strength its dispatch asked for, so the retained
		// request survives generations (and, via the durable record, restarts).
		const resolvedRoute = resolveDispatchModelRoute(agent, runConfig, runCtx);
		// Isolation is a persistent system-level invariant, not a one-shot task
		// prefix: resumes and main-model
		// handoffs all keep the same worktree boundary.
		const route = isolation === "worktree"
			? { ...resolvedRoute, agent: withWorktreeSystemPrompt(resolvedRoute.agent) }
			: resolvedRoute;
		const thinkingLevel = route.thinkingLevel;
		const priorTask = existingThread?.task;
		const priorSessionId = seed?.sessionId ?? existingThread?.sessionId;
		const priorSessionDir = seed?.sessionDir ?? existingThread?.sessionDir;
		const runId = existingThread?.id ?? monitor.addRun(agent.name, task, route.agent.model, thinkingLevel, {
			isolation,
			...(worktreeGroup ? { worktreeId: worktreeGroup } : {}),
		});
		runtime.claimRunDelivery(runId, deliveryRoute);
		const generation = (existingThread?.generation ?? 0) + 1;
		const pending: SingleResult = {
			...queuedResult(route.agent, task, thinkingLevel),
			runId,
			projectCwd: originalCwd,
			isolation,
			...(isolation === "worktree" ? { integrationStatus: "pending" as const } : {}),
			...(seed?.sessionId && seed.sessionDir
				? { sessionId: seed.sessionId, sessionDir: seed.sessionDir }
				: {}),
		};
		if (existingThread) {
			monitor.restartRun(runId, agent.name, task, route.agent.model, thinkingLevel, isolation, {
				elapsedMs: existingThread.elapsedMs,
				continuationKind: appendedObjectiveOnResume ? "resume-appended" : "resume-retained",
				...(worktreeGroup ? { worktreeId: worktreeGroup } : {}),
			});
			runtime.settledRuns.delete(runId);
		}

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


		if (existingThread) {
			thread = existingThread;
			thread.generation = generation;
			thread.agentName = agent.name;
			thread.task = task;
			thread.phaseId = phaseId;
			thread.scope = scope;
			thread.writeCapable = writeCapable;
			thread.cwd = originalCwd;
			thread.executionCwd = executionCwd;
			thread.thinkingLevel = thinkingLevel;
			thread.isolation = isolation;
			thread.worktree = worktree;
			thread.state = "queued";
			thread.control = control;
			// A newly admitted generation owns no output yet. Keeping the prior
			// generation here would make a queued stop publish stale task,
			// session metadata as this generation's partial.
			thread.lastResult = undefined;
			if (seed?.sessionId && seed.sessionDir) {
				thread.sessionId = seed.sessionId;
				thread.sessionDir = seed.sessionDir;
			}
			thread.retireOnSettle = false;
			thread.isolationFailureNotified = false;
		} else {
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
				worktree,
				state: "queued",
				control,
				generationCompletion: Promise.resolve(),
				lifecycleVersion: 0,
				elapsedMs: 0,
				sessionId: seed?.sessionId,
				sessionDir: seed?.sessionDir,
				resume: async () => failedStartResult(agent.name, task, "Thread resume was not initialized."),
				finalizeIsolation: async () => undefined,
			};
			runtime.threads.set(runId, thread);
		}
		const installCurrentLifecycle = (): void => installThreadLifecycle(thread, {
			runtime,
			runCtx,
			startBackground: (...args) => startBackground(...args),
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
							...(priorSessionId && priorSessionDir
								? {
									sessionId: priorSessionId,
									sessionDir: priorSessionDir,
									stdinText: appendedObjectiveOnResume
										? buildAppendedObjectivePrompt(priorTask ?? task, task)
										: buildResumePrompt(priorTask ?? task, "the retained thread was resumed"),
								}
								: {}),
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

				// A stale process/generation may finish after a superseded resume. It owns
				// no monitor mutation, result registration, or completion delivery.
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
					thread.lifecycleOperation === "stop" ||
					thread.lifecycleOperation === "park" ||
					thread.state === "stopped";
				// Destructive stop and park own publication once they have
				// synchronously claimed the lifecycle. Leave the partial result/session
				// on the thread; stop waits for this queue task, finalizes isolation,
				// and emits exactly one aborted result, while park records the
				// checkpoint and answers through its own tool result.
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
						? `${formatCompletionBlock(result, runConfig.maxResultLines, { resultRoot: projectResultsRoot(runtime.configPath, result.projectCwd ?? originalCwd) })}\n\n${modelLevelTakeoverNote(result, { runId })}`
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
				// isolated worktree; a park owns the checkpoint. Do not expose a
				// terminal monitor state before that owner records its outcome.
				if (thread.lifecycleOperation === "stop" || thread.lifecycleOperation === "park") return;
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
				// results. A concurrent destructive stop or park may supersede it while
				// slow worktree finalization is running, in which case that owner
				// publishes once.
				if (thread.lifecycleOperation === "stop" || thread.lifecycleOperation === "park") return;
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

/** Install resume/finalize control surfaces on a thread. Called for
 * every fresh generation (closures refresh with the current dispatch context)
 * and for threads restored from the durable manifest, whose startBackground
 * resolves the live dispatcher at call time. */
export function installThreadLifecycle(thread: SubagentThread, deps: ThreadLifecycleDeps): void {
	const { runtime, startBackground } = deps;
	const runId = thread.id;
	const projectRoot = getProjectRoot(runtime.configPath, thread.cwd);
	const sessionsRoot = join(projectRoot, "sessions");
	const worktreesRoot = join(projectRoot, "worktrees");

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

	const cleanupTrackedSessionDir = async (sessionDir: string, action: string): Promise<void> => {
		try {
			await rm(sessionDir, { recursive: true, force: true });
			runtime.sessionDirs.delete(sessionDir);
		} catch (error) {
			// Keep ownership so shutdown can retry; losing the path here leaks a
			// cloned session containing retained model context on Windows locks.
			try {
				deps.runCtx?.ui.notify(
					`✗ ${action}; retained ${sessionDir} for shutdown cleanup: ${error instanceof Error ? error.message : String(error)}`,
					"error",
				);
			} catch {
				/* cleanup ownership remains tracked even if the UI is unavailable */
			}
		}
	};

	const discardUnusedWorktree = async (candidate: WorktreeIsolation | undefined): Promise<void> => {
		if (!candidate) return;
		try {
			await candidate.discard();
		} catch (error) {
			const retainedPath = existsSync(candidate.worktreePath)
				? candidate.worktreePath
				: existsSync(candidate.tempDir)
					? candidate.tempDir
					: undefined;
			const finalization: WorktreeFinalization = {
				status: "retained",
				integrated: false,
				hadChanges: false,
				originalRoot: candidate.originalRoot,
				...(retainedPath ? { worktreePath: retainedPath } : {}),
				...(existsSync(candidate.patchPath) ? { patchPath: candidate.patchPath } : {}),
				error: `Discarding unused continuation failed: ${error instanceof Error ? error.message : String(error)}`,
			};
			await persistRecoveryRecords(runtime.configPath, [
				recoveryRecordFromFinalization(runId, finalization),
			]).catch(() => undefined);
			try {
				thread.notifyIsolationFailure?.(finalization);
			} catch {
				/* parent UI may already be shutting down */
			}
		}
	};

	const createContinuationWorktree = async (
		source: WorktreeIsolation,
		seedIsIntegrated: boolean,
	): Promise<WorktreeIsolation> => {
		if (source.state === "finalizing") {
			throw new Error(`Run #${runId}'s worktree is still finalizing.`);
		}
		const seedCheckpoint = await source.snapshotCheckpoint();
		return createWorktreeIsolation(thread.cwd, {
			seedCheckpoint,
			seedIsIntegrated,
			tempBaseDir: worktreesRoot,
		});
	};

	thread.resume = async (
		objective?: string,
		resumeCtx?: ExtensionContext,
		metadata?: { scope?: Parameters<typeof normalizePhaseScope>[0] },
	): Promise<SingleResult> => {
		const requestedObjective = objective?.trim();
		if (!runtime.sessionActive || runtime.threads.get(runId) !== thread) {
			return failedStartResult(thread.agentName, thread.task, `Run #${runId} belongs to a parent session that has shut down.`);
		}
		if (objective !== undefined && !requestedObjective) {
			return failedStartResult(thread.agentName, thread.task, "resume objective must be non-blank when provided.");
		}
		const continuationPhaseId = thread.phaseId;
		let continuationScope: ReturnType<typeof normalizePhaseScope>;
		try {
			const additionalScope = normalizePhaseScope(metadata?.scope, thread.cwd);
			continuationScope = mergePhaseScopes(thread.scope, additionalScope);
		} catch (error) {
			return failedStartResult(thread.agentName, thread.task, error instanceof Error ? error.message : String(error));
		}
		if (thread.retired) return failedStartResult(thread.agentName, thread.task, `Run #${runId} was retired by subagent_stop.`);
		if (thread.resumeUnavailableReason) {
			return failedStartResult(thread.agentName, thread.task, thread.resumeUnavailableReason);
		}
		if (thread.lifecycleOperation) {
			return failedStartResult(thread.agentName, thread.task, `Run #${runId} is already resuming.`);
		}
		if (!["parked", "completed", "failed"].includes(thread.state)) {
			return failedStartResult(thread.agentName, thread.task, `Run #${runId} is ${thread.state}; it must be parked or settled before resume.`);
		}

		// Lifecycle CAS: claim synchronously before the first await, then cancel
		// and fully quiesce any superseded queue/process before cloning or
		// reusing its session. A second resume sees this claim immediately.
		const previousState = thread.state;
		const previousSessionId = thread.sessionId;
		const previousSessionDir = thread.sessionDir;
		const previousExecutionCwd = thread.executionCwd;
		const reservation: ResumeReservation = {
			version: ++thread.lifecycleVersion,
			generation: thread.generation,
			sessionId: previousSessionId,
			sessionDir: previousSessionDir,
		};
		thread.admissionScope = continuationScope;
		thread.lifecycleOperation = "resume";
		thread.state = "resuming";
		const finishPreflight = beginRuntimePreflight(runtime);
		const supersededController = thread.queueController;
		runtime.backgroundQueue.cancel(supersededController);
		runtime.runControllers.delete(runId);

		let continuationWorktree: WorktreeIsolation | undefined;
		let clonedSession: Awaited<ReturnType<typeof forkRetainedSession>> | undefined;
		try {
			// Never wait forever on a previous generation that is still settling
			// (e.g. blocked behind the managed repository lane in finalization).
			if (!(await quiesced(thread.generationCompletion))) {
				if (ownsResumeReservation(runtime, thread, reservation)) thread.state = previousState;
				return failedStartResult(
					thread.agentName,
					thread.task,
					`Run #${runId}'s previous generation is still settling; retry the resume shortly.`,
				);
			}
			if (!ownsResumeReservation(runtime, thread, reservation)) {
				return failedStartResult(
					thread.agentName,
					thread.task,
					thread.retired
						? `Run #${runId} was retired by subagent_stop; no new generation was started.`
						: `Run #${runId} changed while resume was preparing; no new generation was started.`,
				);
			}
			thread.state = "resuming";
			const currentCtx = resumeCtx ?? deps.runCtx;
			if (!currentCtx) {
				throw new Error(`Run #${runId} has no dispatch context for resume.`);
			}
			let seed: SessionSeed | undefined;
			if (thread.isolation === "worktree" && thread.worktree?.state !== "active") {
				if (!thread.worktree) throw new Error(`Run #${runId} has no isolated worktree checkpoint.`);
				const seedAlreadyIntegrated =
					thread.worktree.state === "integrated" ||
					thread.worktree.state === "no_changes" ||
					thread.lastResult?.integrationApplied === true;
				continuationWorktree = await createContinuationWorktree(thread.worktree, seedAlreadyIntegrated);
				if (!ownsResumeReservation(runtime, thread, reservation)) {
					throw new Error(`Run #${runId} changed while its continuation worktree was being created.`);
				}
				seed = { worktree: continuationWorktree };
				if (previousSessionId && previousSessionDir) {
					clonedSession = await forkRetainedSession({
						cwd: previousExecutionCwd,
						targetCwd: continuationWorktree.cwd,
						sessionDir: previousSessionDir,
						sessionId: previousSessionId,
						targetRoot: sessionsRoot,
					});
					runtime.sessionDirs.add(clonedSession.sessionDir);
					if (!ownsResumeReservation(runtime, thread, reservation)) {
						throw new Error(`Run #${runId} changed while its retained session was being cloned.`);
					}
					seed.sessionId = clonedSession.sessionId;
					seed.sessionDir = clonedSession.sessionDir;
				}
			}

			const currentConfig = await loadConfig(runtime.configPath);
			if (!ownsResumeReservation(runtime, thread, reservation)) {
				throw new Error(`Run #${runId} changed while resume configuration was loading.`);
			}
			const currentAgents = discoverAgents(currentCtx.cwd, {
				scope: currentConfig.agentScope,
				enabledNames: currentConfig.enabledAgents,
				projectTrusted: currentCtx.isProjectTrusted?.() === true,
			}).agents;
			const nextTask = requestedObjective ?? thread.task;
			const pending = await startBackground(
				thread.agentName,
				nextTask,
				thread.cwd,
				thread.isolation,
				{
					existingThread: thread,
					phaseId: continuationPhaseId,
					scope: continuationScope,
					appendedObjectiveOnResume: objective !== undefined,
					environment: {
						ctx: currentCtx,
						config: currentConfig,
						agents: currentAgents,
					},
					seed,
					resumeReservation: reservation,
				},
			);
			if (pending.exitCode !== -1) {
				if (clonedSession) {
					await cleanupTrackedSessionDir(
						clonedSession.sessionDir,
						`Could not discard failed resume session clone for run #${runId}`,
					);
				}
				await discardUnusedWorktree(continuationWorktree);
				if (ownsResumeReservation(runtime, thread, reservation)) thread.state = previousState;
				return pending;
			}

			// The cloned branch replaces the removed-worktree session for this
			// logical id. Keep an undeletable old dir in runtime cleanup if needed.
			if (clonedSession && previousSessionDir && previousSessionDir !== clonedSession.sessionDir) {
				try {
					await rm(previousSessionDir, { recursive: true, force: true });
					runtime.sessionDirs.delete(previousSessionDir);
				} catch {
					/* shutdown retries cleanup of the old retained branch */
				}
			}
			return pending;
		} catch (error) {
			if (clonedSession) {
				await cleanupTrackedSessionDir(
					clonedSession.sessionDir,
					`Could not discard interrupted resume session clone for run #${runId}`,
				);
			}
			await discardUnusedWorktree(continuationWorktree);
			if (ownsResumeReservation(runtime, thread, reservation)) {
				thread.state = previousState;
				thread.sessionId = previousSessionId;
				thread.sessionDir = previousSessionDir;
				thread.executionCwd = previousExecutionCwd;
			}
			return failedStartResult(
				thread.agentName,
				requestedObjective ?? thread.task,
				`Could not resume run #${runId}: ${error instanceof Error ? error.message : String(error)}`,
			);
		} finally {
			finishPreflight();
			if (thread.lifecycleVersion === reservation.version) thread.admissionScope = undefined;
			if (
				thread.lifecycleOperation === "resume" &&
				thread.lifecycleVersion === reservation.version
			) {
				thread.lifecycleOperation = undefined;
			}
		}
	};
}
