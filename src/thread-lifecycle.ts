/**
 * Stable logical-thread generation lifecycle for background sub-agents.
 *
 * Dispatch owns the public tool contract and auto-fix policy; this module owns
 * one thread generation end to end: worktree setup/finalization, queue/process
 * ownership, retained-session resume/fork, and guarded terminal publication.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import { discoverAgents, type AgentConfig } from "./agents.ts";
import { completionTriggersTurn, type CompletionMessageItem } from "./completion.ts";
import {
	DEFAULT_THINKING_LEVEL,
	loadConfig,
	type SubagentsConfig,
	type ThinkingLevel,
} from "./config.ts";
import {
	dispatchFailedResult,
	failedStartResult,
	formatCompletionBlock,
	modelLevelTakeoverNote,
	queuedResult,
} from "./format.ts";
import { shouldTriggerFixLoop } from "./fixloop.ts";
import {
	availableModelsInScope,
	currentModelRef,
	findModelByRef,
	modelRef,
	resolveAgentModelRoute,
	resolveThinkingLevel,
} from "./models.ts";
import { monitor } from "./monitor.ts";
import { persistRecoveryRecords, recoveryRecordFromFinalization } from "./recovery.ts";
import type { SubagentRuntime, SubagentThread, ThreadState } from "./runtime.ts";
import { forkRetainedSession } from "./session-fork.ts";
import {
	buildResumePrompt,
	RpcRunControl,
	isFailedResult,
	isModelLevelFailure,
	runSingleAgentWithMainFallback,
	type SingleResult,
	type SubagentDetails,
	type SubagentLiveEvent,
} from "./spawn.ts";
import {
	createWorktreeIsolation,
	type IsolationMode,
	type WorktreeFinalization,
	type WorktreeIsolation,
} from "./worktree.ts";

export const FORK_CONTINUATION_PROMPT =
	"Continue from the retained context above. Review the prior work, then take the most useful next step toward completing the existing objective without repeating completed work.";

const WORKTREE_ISOLATION_INSTRUCTIONS =
	"You are running in a temporary detached Git worktree. Work only in the current cwd; do not create another worktree or manually copy/apply changes to the original checkout. The parent dispatcher will integrate your tracked, deleted, and untracked changes when this thread finally settles.";

function withWorktreeSystemPrompt(agent: AgentConfig): AgentConfig {
	return {
		...agent,
		systemPrompt: `${agent.systemPrompt.trimEnd()}\n\n${WORKTREE_ISOLATION_INSTRUCTIONS}`.trim(),
	};
}

export function isWorktreeCapableAgent(agent: AgentConfig): boolean {
	if (agent.name === "explore" || agent.name === "reviewer") return false;
	if (agent.name === "worker") return true;
	if (!agent.tools) return true;
	return agent.tools.includes("edit") || agent.tools.includes("write");
}

interface DispatchEnvironment {
	ctx: ExtensionContext;
	config: SubagentsConfig;
	agents: AgentConfig[];
}

interface DispatchModelRoute {
	agent: AgentConfig;
	mainFallbackRef?: string;
	thinkingLevel: ThinkingLevel;
	thinkingLevelForModel: (ref?: string) => ThinkingLevel;
}

export function resolveDispatchModelRoute(
	agent: AgentConfig,
	config: SubagentsConfig,
	ctx: ExtensionContext,
): DispatchModelRoute {
	const availableModels = availableModelsInScope(ctx);
	const mainRef = currentModelRef(ctx);
	const route = resolveAgentModelRoute({
		selectedRef: config.agentModels[agent.name],
		mainRef,
		declaredDefaultRef: agent.model,
		availableRefs: availableModels.map(modelRef),
	});
	const preferred = config.agentThinkingLevels[agent.name] ?? agent.thinking ?? DEFAULT_THINKING_LEVEL;
	const thinkingLevelForModel = (ref?: string): ThinkingLevel => {
		const model = ref === mainRef && ctx.model
			? ctx.model
			: findModelByRef(availableModels, ref);
		return resolveThinkingLevel(model, preferred);
	};
	return {
		agent: { ...agent, model: route.primaryRef },
		mainFallbackRef: route.mainFallbackRef,
		thinkingLevel: thinkingLevelForModel(route.primaryRef),
		thinkingLevelForModel,
	};
}

interface BackgroundDispatcherOptions extends DispatchEnvironment {
	runtime: SubagentRuntime;
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
	startFixLoop: (
		initialReviewerResult: SingleResult,
		parentGroupId: string,
		parentRunId: number,
		executionCwd: string,
	) => void;
}

type BackgroundStarter = (
	agentName: string,
	task: string,
	cwd: string | undefined,
	isolation?: IsolationMode,
) => Promise<SingleResult>;

export function createBackgroundDispatcher(options: BackgroundDispatcherOptions): BackgroundStarter {
	const {
		runtime,
		ctx,
		config,
		agents,
		finishRun,
		makeLiveHandler,
		makeDetails,
		startFixLoop,
	} = options;
	interface SessionSeed {
		sessionId?: string;
		sessionDir?: string;
		prompt?: string;
		worktree?: WorktreeIsolation;
		forkedFromRunId?: number;
	}

	interface ResumeReservation {
		version: number;
		generation: number;
		sessionId?: string;
		sessionDir?: string;
	}

	const ownsResumeReservation = (
		thread: SubagentThread,
		reservation: ResumeReservation,
	): boolean =>
		runtime.sessionActive &&
		runtime.threads.get(thread.id) === thread &&
		!thread.retired &&
		thread.lifecycleOperation === "resume" &&
		thread.lifecycleVersion === reservation.version &&
		thread.generation === reservation.generation &&
		thread.sessionId === reservation.sessionId &&
		thread.sessionDir === reservation.sessionDir;

	const beginPreflight = (): (() => void) => {
		let resolvePreflight!: () => void;
		const preflight = new Promise<void>((resolve) => {
			resolvePreflight = resolve;
		});
		runtime.preflightOperations.add(preflight);
		return () => {
			runtime.preflightOperations.delete(preflight);
			resolvePreflight();
		};
	};

	const startBackground = async (
		agentName: string,
		task: string,
		cwd: string | undefined,
		isolation: IsolationMode = "shared",
		existingThread?: SubagentThread,
		newObjectiveOnResume = false,
		environment?: DispatchEnvironment,
		seed?: SessionSeed,
		resumeReservation?: ResumeReservation,
	): Promise<SingleResult> => {
		if (!runtime.sessionActive) {
			return failedStartResult(agentName, task, "Parent session shut down before this subagent generation could start.");
		}
		if (existingThread && (!resumeReservation || !ownsResumeReservation(existingThread, resumeReservation))) {
			return failedStartResult(agentName, task, `Run #${existingThread.id} changed while resume was preparing; no new generation was started.`);
		}
		const runCtx = environment?.ctx ?? ctx;
		const runConfig = environment?.config ?? config;
		const runAgents = environment?.agents ?? agents;
		const agent = runAgents.find((candidate) => candidate.name === agentName);
		if (!agent) return failedStartResult(agentName, task, `Unknown agent: "${agentName}".`);
		if (isolation === "worktree" && !isWorktreeCapableAgent(agent)) {
			return {
				...failedStartResult(agentName, task, `Agent "${agentName}" is read-only; worktree isolation is available only to write-capable agents such as worker or cleaner.`),
				isolation,
			};
		}

		const originalCwd = resolve(cwd ?? runCtx.cwd);
		const previousWorktree = existingThread?.worktree;
		let worktree = seed?.worktree ?? previousWorktree;
		if (isolation === "worktree") {
			if (worktree && worktree.state !== "active") {
				return {
					...failedStartResult(agentName, task, `Run #${existingThread?.id ?? "?"} has no active continuation worktree.`),
					isolation,
					integrationStatus: worktree.state === "finalizing" ? "pending" : worktree.state,
				};
			}
			if (!worktree) {
				try {
					worktree = await createWorktreeIsolation(originalCwd);
				} catch (error) {
					return {
						...failedStartResult(agentName, task, error instanceof Error ? error.message : String(error)),
						isolation,
					};
				}
			}
		}
		const executionCwd = worktree?.cwd ?? originalCwd;
		const resolvedRoute = resolveDispatchModelRoute(agent, runConfig, runCtx);
		// Isolation is a persistent system-level invariant, not a one-shot task
		// prefix: queued retargets, live retargets, resumes, and main-model
		// handoffs all keep the same worktree boundary.
		const route = isolation === "worktree"
			? { ...resolvedRoute, agent: withWorktreeSystemPrompt(resolvedRoute.agent) }
			: resolvedRoute;
		const thinkingLevel = route.thinkingLevel;
		const priorTask = existingThread?.task;
		const priorSessionId = seed?.sessionId ?? existingThread?.sessionId;
		const priorSessionDir = seed?.sessionDir ?? existingThread?.sessionDir;
		if (existingThread && resumeReservation && !ownsResumeReservation(existingThread, resumeReservation)) {
			return failedStartResult(agentName, task, `Run #${existingThread.id} changed while resume was preparing; no new generation was started.`);
		}
		const runId = existingThread?.id ?? monitor.addRun(agent.name, task, route.agent.model, thinkingLevel, {
			isolation,
			...(seed?.forkedFromRunId !== undefined ? { forkedFromRunId: seed.forkedFromRunId } : {}),
		});
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
			...(seed?.forkedFromRunId !== undefined ? { forkedFromRunId: seed.forkedFromRunId } : {}),
		};
		if (existingThread) {
			monitor.restartRun(runId, agent.name, task, route.agent.model, thinkingLevel, isolation);
			runtime.settledRuns.delete(runId);
		}

		let thread!: SubagentThread;
		const control = new RpcRunControl(task, generation, (phase) => {
			if (runtime.threads.get(runId)?.generation !== generation || phase === "settled") return;
			const state: ThreadState =
				phase === "queued" || phase === "starting"
					? "queued"
					: phase === "steering"
						? "steering"
						: phase === "interrupting"
							? "interrupting"
							: phase === "parked"
								? "parked"
								: phase === "stopped"
									? "stopped"
									: "running";
			thread.state = state;
			if (state === "queued") monitor.setStatus(runId, "queued");
			else if (state === "steering") monitor.setStatus(runId, "steering");
			else if (state === "interrupting") monitor.setStatus(runId, "interrupting");
			else if (state === "parked") monitor.setStatus(runId, "parked");
			else if (state === "running") monitor.setStatus(runId, "running");
		});


		if (existingThread) {
			thread = existingThread;
			thread.generation = generation;
			thread.agentName = agent.name;
			thread.task = task;
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
				cwd: originalCwd,
				executionCwd,
				thinkingLevel,
				isolation,
				worktree,
				state: "queued",
				control,
				generationCompletion: Promise.resolve(),
				lifecycleVersion: 0,
				sessionId: seed?.sessionId,
				sessionDir: seed?.sessionDir,
				forkedFromRunId: seed?.forkedFromRunId,
				forkChildRunIds: [],
				park: async () => {
					throw new Error("Thread park was not initialized.");
				},
				resume: async () => failedStartResult(agent.name, task, "Thread resume was not initialized."),
				fork: async () => failedStartResult(agent.name, task, "Thread fork was not initialized."),
				finalizeIsolation: async () => undefined,
			};
			runtime.threads.set(runId, thread);
		}
		thread.notifyIsolationFailure = (finalization) => {
			const paths = [finalization.worktreePath, finalization.patchPath].filter(Boolean).join(" · ");
			runCtx.ui.notify(
				`✗ ${agent.name} worktree ${finalization.integrated ? "cleanup" : "integration"} failed${paths ? ` · retained ${paths}` : ""}: ${finalization.error ?? "unknown Git integration error"}`,
				"error",
			);
		};
		thread.finalizeIsolation = async (
			expectedGeneration: number,
			result?: SingleResult,
		): Promise<WorktreeFinalization | undefined> => {
			if (thread.isolation !== "worktree" || !thread.worktree) return undefined;
			if (thread.generation !== expectedGeneration) return undefined;
			const finalization = await thread.worktree.finalize();
			monitor.setIsolation(runId, "worktree", finalization.status);
			if (result) {
				result.runId = runId;
				result.isolation = "worktree";
				result.integrationStatus = finalization.status;
				result.integrationApplied = finalization.integrated;
				result.integrationError = finalization.error;
				result.integrationWorktreePath = finalization.worktreePath;
				result.integrationPatchPath = finalization.patchPath;
				result.forkedFromRunId = thread.forkedFromRunId;
				result.forkChildRunIds = [...thread.forkChildRunIds];
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
					runCtx.ui.notify(
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
			});
		};

		thread.park = async (): Promise<"queued" | "active"> => {
			if (thread.retired) throw new Error(`Run #${runId} was retired by subagent_stop.`);
			if (thread.lifecycleOperation) throw new Error(`Run #${runId} is already handling ${thread.lifecycleOperation}.`);
			if (thread.state === "parked") return "active";
			const phase = thread.control.getPhase();
			const queued = thread.state === "queued" && phase === "queued";
			if (
				!queued &&
				((phase === "settled" && thread.state !== "running") ||
					!["starting", "running", "steering", "interrupting", "retrying", "settled"].includes(phase))
			) {
				throw new Error(`Run #${runId} is ${thread.state}; only active work can be parked.`);
			}

			const version = ++thread.lifecycleVersion;
			const generation = thread.generation;
			const completion = thread.generationCompletion;
			const controller = thread.queueController;
			thread.lifecycleOperation = "park";
			try {
				if (queued) {
					thread.control.parkPending();
					runtime.backgroundQueue.cancel(controller);
				} else {
					await thread.control.park();
					// Auto-fix orchestration has no live RPC attempt once its parent
					// review settled, so cancel its queue owner explicitly.
					if (phase === "settled") runtime.backgroundQueue.cancel(controller);
				}
				await completion;
				if (
					thread.generation !== generation ||
					thread.lifecycleVersion !== version ||
					thread.lifecycleOperation !== "park"
				) {
					throw new Error(`Run #${runId} changed while parking.`);
				}
				thread.state = "parked";
				thread.queueController = undefined;
				runtime.runControllers.delete(runId);
				monitor.setStatus(runId, "parked");
				return queued ? "queued" : "active";
			} finally {
				if (thread.lifecycleVersion === version && thread.lifecycleOperation === "park") {
					thread.lifecycleOperation = undefined;
				}
			}
		};

		thread.resume = async (objective?: string, resumeCtx?: ExtensionContext): Promise<SingleResult> => {
			const requestedObjective = objective?.trim();
			if (!runtime.sessionActive || runtime.threads.get(runId) !== thread) {
				return failedStartResult(thread.agentName, thread.task, `Run #${runId} belongs to a parent session that has shut down.`);
			}
			if (objective !== undefined && !requestedObjective) {
				return failedStartResult(thread.agentName, thread.task, "resume objective must be non-blank when provided.");
			}
			if (thread.retired) return failedStartResult(thread.agentName, thread.task, `Run #${runId} was retired by subagent_stop.`);
			if (thread.lifecycleOperation) {
				return failedStartResult(thread.agentName, thread.task, `Run #${runId} is already ${thread.lifecycleOperation === "resume" ? "resuming" : "being forked"}.`);
			}
			if (!["parked", "completed", "failed"].includes(thread.state)) {
				return failedStartResult(thread.agentName, thread.task, `Run #${runId} is ${thread.state}; it must be parked or settled before resume.`);
			}

			// Lifecycle CAS: claim synchronously before the first await, then cancel
			// and fully quiesce any superseded queue/process before cloning or
			// reusing its session. A second resume/fork sees this claim immediately.
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
			thread.lifecycleOperation = "resume";
			thread.state = "resuming";
			const finishPreflight = beginPreflight();
			const supersededController = thread.queueController;
			runtime.backgroundQueue.cancel(supersededController);
			runtime.runControllers.delete(runId);

			let continuationWorktree: WorktreeIsolation | undefined;
			let clonedSession: Awaited<ReturnType<typeof forkRetainedSession>> | undefined;
			try {
				await thread.generationCompletion;
				if (!ownsResumeReservation(thread, reservation)) {
					return failedStartResult(
						thread.agentName,
						thread.task,
						thread.retired
							? `Run #${runId} was retired by subagent_stop; no new generation was started.`
							: `Run #${runId} changed while resume was preparing; no new generation was started.`,
					);
				}
				thread.state = "resuming";
				const currentCtx = resumeCtx ?? runCtx;
				let seed: SessionSeed | undefined;
				if (thread.isolation === "worktree" && thread.worktree?.state !== "active") {
					if (!thread.worktree) throw new Error(`Run #${runId} has no isolated worktree checkpoint.`);
					const seedAlreadyIntegrated =
						thread.worktree.state === "integrated" ||
						thread.worktree.state === "no_changes" ||
						thread.lastResult?.integrationApplied === true;
					continuationWorktree = await createContinuationWorktree(thread.worktree, seedAlreadyIntegrated);
					if (!ownsResumeReservation(thread, reservation)) {
						throw new Error(`Run #${runId} changed while its continuation worktree was being created.`);
					}
					seed = { worktree: continuationWorktree };
					if (previousSessionId && previousSessionDir) {
						clonedSession = await forkRetainedSession({
							cwd: previousExecutionCwd,
							targetCwd: continuationWorktree.cwd,
							sessionDir: previousSessionDir,
							sessionId: previousSessionId,
						});
						runtime.sessionDirs.add(clonedSession.sessionDir);
						if (!ownsResumeReservation(thread, reservation)) {
							throw new Error(`Run #${runId} changed while its retained session was being cloned.`);
						}
						seed.sessionId = clonedSession.sessionId;
						seed.sessionDir = clonedSession.sessionDir;
					}
				}

				const currentConfig = await loadConfig(runtime.configPath);
				if (!ownsResumeReservation(thread, reservation)) {
					throw new Error(`Run #${runId} changed while resume configuration was loading.`);
				}
				runtime.backgroundQueue.setConcurrency(currentConfig.maxConcurrency);
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
					thread,
					objective !== undefined,
					{
						ctx: currentCtx,
						config: currentConfig,
						agents: currentAgents,
					},
					seed,
					reservation,
				);
				if (pending.exitCode !== -1) {
					if (clonedSession) {
						await cleanupTrackedSessionDir(
							clonedSession.sessionDir,
							`Could not discard failed resume session clone for run #${runId}`,
						);
					}
					await discardUnusedWorktree(continuationWorktree);
					if (ownsResumeReservation(thread, reservation)) thread.state = previousState;
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
				if (ownsResumeReservation(thread, reservation)) {
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
				if (
					thread.lifecycleOperation === "resume" &&
					thread.lifecycleVersion === reservation.version
				) {
					thread.lifecycleOperation = undefined;
				}
			}
		};

		thread.fork = async (objective?: string, forkCtx?: ExtensionContext): Promise<SingleResult> => {
			const forkObjective = objective?.trim();
			if (!runtime.sessionActive || runtime.threads.get(runId) !== thread) {
				return failedStartResult(thread.agentName, thread.task, `Run #${runId} belongs to a parent session that has shut down.`);
			}
			if (objective !== undefined && !forkObjective) {
				return failedStartResult(thread.agentName, thread.task, "fork objective must be non-blank when provided.");
			}
			if (thread.retired || thread.state === "stopped") {
				return failedStartResult(thread.agentName, thread.task, `Run #${runId} was retired by subagent_stop and cannot be forked.`);
			}
			if (thread.lifecycleOperation) {
				return failedStartResult(thread.agentName, thread.task, `Run #${runId} is already ${thread.lifecycleOperation === "resume" ? "resuming" : "being forked"}.`);
			}
			if (thread.state === "queued" && !thread.sessionId) {
				return failedStartResult(thread.agentName, thread.task, `Run #${runId} is queued and has no retained session to fork.`);
			}
			if (["queued", "running", "steering", "interrupting"].includes(thread.state)) {
				return failedStartResult(thread.agentName, thread.task, `Run #${runId} is active; park it first with subagent_control { action: "park", id: ${runId} }, then fork the stable session.`);
			}
			if (!["parked", "completed", "failed"].includes(thread.state)) {
				return failedStartResult(thread.agentName, thread.task, `Run #${runId} is ${thread.state} and has no forkable retained checkpoint.`);
			}
			if (!thread.sessionId || !thread.sessionDir) {
				return failedStartResult(thread.agentName, thread.task, `Run #${runId} has no retained session to fork (it may have been parked before starting).`);
			}
			if (thread.isolation === "worktree") {
				const worktreeState = thread.worktree?.state;
				const seedIntegrated =
					worktreeState === "integrated" ||
					worktreeState === "no_changes" ||
					thread.lastResult?.integrationApplied === true;
				if (!seedIntegrated) {
					return failedStartResult(
						thread.agentName,
						thread.task,
						`Run #${runId}'s isolated checkpoint has not been integrated. Resume and settle it before forking so its seed is applied exactly once.`,
					);
				}
			}

			// Same lifecycle CAS as resume: a concurrent resume/fork cannot consume
			// or clone this session while the branch copy is in progress.
			const forkVersion = ++thread.lifecycleVersion;
			const forkGeneration = thread.generation;
			const forkSessionId = thread.sessionId;
			const forkSessionDir = thread.sessionDir;
			const ownsFork = (): boolean =>
				runtime.sessionActive &&
				runtime.threads.get(runId) === thread &&
				!thread.retired &&
				thread.lifecycleOperation === "fork" &&
				thread.lifecycleVersion === forkVersion &&
				thread.generation === forkGeneration &&
				thread.sessionId === forkSessionId &&
				thread.sessionDir === forkSessionDir;
			thread.lifecycleOperation = "fork";
			const finishPreflight = beginPreflight();
			let childWorktree: WorktreeIsolation | undefined;
			let forkedSession: Awaited<ReturnType<typeof forkRetainedSession>> | undefined;
			try {
				await thread.generationCompletion;
				if (!ownsFork()) {
					return failedStartResult(thread.agentName, thread.task, `Run #${runId} changed while fork was preparing; no child was started.`);
				}
				const currentCtx = forkCtx ?? runCtx;
				if (thread.isolation === "worktree") {
					if (!thread.worktree) throw new Error(`Run #${runId} has no isolated worktree checkpoint.`);
					const seedAlreadyIntegrated =
						thread.worktree.state === "integrated" ||
						thread.worktree.state === "no_changes" ||
						thread.lastResult?.integrationApplied === true;
					childWorktree = await createContinuationWorktree(thread.worktree, seedAlreadyIntegrated);
					if (!ownsFork()) throw new Error(`Run #${runId} changed while its fork worktree was being created.`);
				}
				forkedSession = await forkRetainedSession({
					cwd: thread.executionCwd,
					targetCwd: childWorktree?.cwd ?? thread.cwd,
					sessionDir: thread.sessionDir,
					sessionId: thread.sessionId,
				});
				runtime.sessionDirs.add(forkedSession.sessionDir);
				if (!ownsFork()) throw new Error(`Run #${runId} changed while its retained session was being forked.`);
				const currentConfig = await loadConfig(runtime.configPath);
				if (!ownsFork()) throw new Error(`Run #${runId} changed while fork configuration was loading.`);
				runtime.backgroundQueue.setConcurrency(currentConfig.maxConcurrency);
				const currentAgents = discoverAgents(currentCtx.cwd, {
					scope: currentConfig.agentScope,
					enabledNames: currentConfig.enabledAgents,
					projectTrusted: currentCtx.isProjectTrusted?.() === true,
				}).agents;
				if (!ownsFork()) throw new Error(`Run #${runId} changed while fork was preparing; no child was started.`);
				const childTask = forkObjective ?? thread.task;
				const child = await startBackground(
					thread.agentName,
					childTask,
					thread.cwd,
					thread.isolation,
					undefined,
					false,
					{
						ctx: currentCtx,
						config: currentConfig,
						agents: currentAgents,
					},
					{
						sessionId: forkedSession.sessionId,
						sessionDir: forkedSession.sessionDir,
						prompt: forkObjective ?? FORK_CONTINUATION_PROMPT,
						worktree: childWorktree,
						forkedFromRunId: runId,
					},
				);
				if (child.exitCode !== -1 || child.runId === undefined) {
					await cleanupTrackedSessionDir(
						forkedSession.sessionDir,
						`Could not discard failed fork session clone for run #${runId}`,
					);
					await discardUnusedWorktree(childWorktree);
					return child;
				}

				// Once the independent child is enqueued it remains valid even if the
				// source is retired; just skip source-side relationship mutation.
				if (!ownsFork()) return child;
				const childRunId = child.runId;
				if (!thread.forkChildRunIds.includes(childRunId)) thread.forkChildRunIds.push(childRunId);
				const childThread = runtime.threads.get(childRunId);
				if (childThread) childThread.forkedFromRunId = runId;
				monitor.setForkRelation(runId, childRunId);
				const sourceResult = runtime.settledRuns.get(runId) ?? thread.lastResult;
				if (sourceResult) sourceResult.forkChildRunIds = [...thread.forkChildRunIds];
				return child;
			} catch (error) {
				if (forkedSession) {
					await cleanupTrackedSessionDir(
						forkedSession.sessionDir,
						`Could not discard interrupted fork session clone for run #${runId}`,
					);
				}
				await discardUnusedWorktree(childWorktree);
				return failedStartResult(
					thread.agentName,
					forkObjective ?? thread.task,
					`Could not fork retained session for run #${runId}: ${error instanceof Error ? error.message : String(error)}`,
				);
			} finally {
				finishPreflight();
				if (thread.lifecycleVersion === forkVersion && thread.lifecycleOperation === "fork") {
					thread.lifecycleOperation = undefined;
				}
			}
		};

		const onLive = makeLiveHandler(runId, generation);
		const queueController = runtime.backgroundQueue.enqueue(
			async (backgroundSignal) => {
				if (runtime.threads.get(runId)?.generation !== generation) return;
				let result: SingleResult;
				try {
					result = await runSingleAgentWithMainFallback(
						{
							defaultCwd: executionCwd,
							agent: route.agent,
							agentName,
							task,
							cwd: executionCwd,
							thinkingLevel,
							thinkingLevelForModel: route.thinkingLevelForModel,
							signal: backgroundSignal,
							onLive,
							control,
							makeDetails: makeDetails("single", true),
							idleTimeoutMs: runConfig.idleTimeoutSec * 1000,
							...(priorSessionId && priorSessionDir
								? {
									sessionId: priorSessionId,
									sessionDir: priorSessionDir,
									stdinText: seed?.prompt ?? (newObjectiveOnResume
										? task
										: buildResumePrompt(priorTask ?? task, "the retained thread was resumed")),
								}
								: {}),
						},
						route.mainFallbackRef,
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

				// A stale process/generation may finish after a park/resume race. It owns
				// no monitor mutation, result registration, or completion delivery.
				if (runtime.threads.get(runId)?.generation !== generation) return;
				result.runId = runId;
				result.projectCwd = originalCwd;
				result.isolation = isolation;
				result.forkedFromRunId = thread.forkedFromRunId;
				result.forkChildRunIds = [...thread.forkChildRunIds];
				thread.queueController = undefined;
				runtime.runControllers.delete(runId);
				thread.task = result.task;
				thread.sessionId = result.sessionId;
				thread.sessionDir = result.sessionDir;
				thread.lastResult = result;
				runtime.retainSession(result);
				monitor.setModel(runId, result.model, result.modelFallbackFrom);
				monitor.setThinking(runId, result.thinking);

				// Destructive stop owns publication once it has synchronously claimed
				// the lifecycle. Leave the partial result/session on the thread; the
				// stop path waits for this queue task, finalizes isolation, and emits
				// exactly one aborted result.
				if (thread.lifecycleOperation === "stop") return;

				if (result.parked) {
					thread.state = "parked";
					monitor.setStatus(runId, "parked");
					runtime.settledRuns.delete(runId);
					return;
				}

				if (thread.retireOnSettle) runtime.retireThreadSession(thread);
				const wantsFixLoop = shouldTriggerFixLoop(result, runConfig);
				if (wantsFixLoop && isolation === "shared" && runtime.sessionActive) {
					thread.state = "running";
					// The review being done does not mean the logical run is over:
					// the same row now represents the chain until it resolves.
					monitor.setStatus(runId, "running");
					monitor.setActivity(runId, "auto-fix chain running");
					startFixLoop(result, `fix-${runId}`, runId, thread.executionCwd);
					return;
				}
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
					// Worktree isolation is rejected for reviewers, the only role that can
					// trigger auto-fix. Keep that invariant explicit: an isolated result is
					// finalized once here and can never start a chain that would integrate
					// the same worktree early.
					await thread.finalizeIsolation(generation, result);
					if (!ownsSettlement()) return;

					const failed = isFailedResult(result);
					thread.state = failed ? "failed" : "completed";
					// Stamp the terminal monitor state before projecting it. This gives every
					// path a fixed endedAt even when the row is removed immediately.
					monitor.setStatus(runId, failed ? "failed" : "done");
					if (!runtime.sessionActive || !ownsSettlement()) return;

					const modelLevel = failed && isModelLevelFailure(result);
					const dispatchFailed = result.dispatchFailed === true;
					finishRun(runId, failed ? "failed" : "done", modelLevel || dispatchFailed ? { silent: true } : undefined);
					runtime.registerRunResult(runId, result);
					const completion: CompletionMessageItem = {
						agent: result.agent,
						block: modelLevel
							? `${formatCompletionBlock(result, runConfig.maxResultLines, result.projectCwd ?? originalCwd)}\n\n${modelLevelTakeoverNote(result, { runId })}`
							: formatCompletionBlock(result, runConfig.maxResultLines, result.projectCwd ?? originalCwd),
						triggerTurn: completionTriggersTurn(result, runConfig.notifyOnReviewPass),
						usage: result.usage,
					};
					if (modelLevel) {
						const detail = result.errorMessage?.trim() || "model unavailable or broken";
						runCtx.ui.notify(`✗ ${result.agent} dispatch failed: ${detail} — task handed to the main window`, "error");
					} else if (dispatchFailed) {
						runCtx.ui.notify(`✗ ${result.agent} dispatch failed: ${result.errorMessage ?? "dispatch crashed"}`, "error");
					}
					if (failed) {
						runtime.sendCompletionGroup([completion]);
						runtime.completionBatcher.flush();
					} else {
						runtime.completionBatcher.push(completion);
					}
				} finally {
					if (ownsSettlement()) thread.lifecycleOperation = undefined;
				}
			},
			() => {
				if (runtime.threads.get(runId)?.generation !== generation) return;
				// Queued park/stop owns publication and may still be finalizing an
				// isolated worktree. Do not expose a terminal monitor state before
				// that owner records the checkpoint or aborted result.
				if (thread.lifecycleOperation === "park" || thread.lifecycleOperation === "stop") return;
				runtime.runControllers.delete(runId);
				thread.queueController = undefined;
				if (thread.state === "parked") {
					monitor.setStatus(runId, "parked");
					return;
				}
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
				// results. A concurrent destructive stop may supersede it while slow
				// worktree finalization is running, in which case stop publishes once.
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
					const crashed: SingleResult = {
						...dispatchFailedResult(route.agent, control.getObjective(), error, thinkingLevel),
						runId,
						isolation,
						forkedFromRunId: thread.forkedFromRunId,
					};
					await thread.finalizeIsolation(generation, crashed);
					if (!ownsSettlement()) return;
					thread.state = "failed";
					monitor.setStatus(runId, "failed");
					finishRun(runId, "failed", { silent: true });
					runtime.registerRunResult(runId, crashed);
					runtime.runControllers.delete(runId);
					thread.queueController = undefined;
					if (!runtime.sessionActive || !ownsSettlement()) return;
					try {
						runCtx.ui.notify(`✗ ${agent.name} dispatch failed: ${crashed.errorMessage}`, "error");
						runtime.sendCompletionGroup([
							{
								agent: agent.name,
								block: formatCompletionBlock(crashed, runConfig.maxResultLines, crashed.projectCwd ?? originalCwd),
								triggerTurn: true,
								usage: crashed.usage,
							},
						]);
						runtime.completionBatcher.flush();
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
