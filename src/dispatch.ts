/**
 * The `subagent` tool: dispatches the enabled agents (explorer, worker, cleaner,
 * documenter, synthesizer, reviewer, plus custom roles) as isolated pi
 * child processes, single or parallel. Owns the public dispatch contract,
 * per-run status tracking, the managed worker/cleaner → reviewer gate, and
 * internal step launching. Stable thread generations, final integration, and
 * completion ownership live in thread-lifecycle.ts.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { join, resolve } from "node:path";
import { Type } from "typebox";
import { discoverAgents, isWriteCapableAgent, resolveAgentTools, type AgentConfig } from "./agents.ts";
import { loadConfig } from "./config.ts";
import { formatCompletionBlock, formatUsage, queuedResult } from "./format.ts";
import {
	buildFinalReviewBrief,
	buildReReviewBrief,
	buildReviewerFixBrief,
	MAX_REVIEW_FIX_ROUNDS,
	type ChainStep,
	type ManagedWorkflowOutcome,
	type ReviewMode,
} from "./workflow.ts";
import {
	formatTaskSummary,
	formatToolActivity,
	monitor,
	statusIcon,
	type RunChainMeta,
	type RunWaitReason,
	type WorkflowStage,
	type WorkflowStageStatus,
} from "./monitor.ts";
import type { SubagentRuntime } from "./runtime.ts";
import { persistThreadCheckpoint } from "./thread-lifecycle.ts";
import {
	getProjectRoot,
	getResultOutput,
	isFailedResult,
	reviewVerdict,
	runSingleAgentWithMainFallback,
	type SingleResult,
	type SubagentDetails,
	type SubagentLiveEvent,
} from "./spawn.ts";
import {
	createBackgroundDispatcher,
	projectResultsRoot,
	resolveDispatchModelRoute,
	runInManagedRepositoryLane,
	withWorktreeSystemPrompt,
	type DispatchEnvironment,
	type ManagedWorkflowRequest,
} from "./thread-lifecycle.ts";
import type { IsolationMode } from "./worktree.ts";

export { isWorktreeCapableAgent, runInManagedRepositoryLane } from "./thread-lifecycle.ts";

const NON_BLANK_TASK_OPTIONS = { minLength: 1, pattern: "\\S" } as const;

const ISOLATION_DESCRIPTION =
	"Filesystem isolation: shared uses the caller's working tree; worktree creates a detached temporary Git worktree (write-capable agents, including worker, cleaner, and documenter, only)";

const IsolationSchema = Type.Optional(
	StringEnum(["shared", "worktree"] as const, { description: ISOLATION_DESCRIPTION }),
);

const WaitSchema = Type.Optional(
	Type.Boolean({
		description:
			"Block until every run started by this call settles, then return their results in-turn (each result still arrives as a completion message too). Only for one-shot (pi -p) sessions or a next step that needs these results within this turn.",
	}),
);

const REVIEW_DESCRIPTION =
	"Gate intensity for a worker/cleaner task: \"gate\" (default) runs one automatic reviewer after success; \"none\" skips it for mechanical, low-risk edits (typos, comments, doc strings, config value tweaks) that you verify yourself. Keep the default whenever behavior can change.";

const ReviewSchema = Type.Optional(
	StringEnum(["gate", "none"] as const, { description: REVIEW_DESCRIPTION }),
);

const TaskItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({
		...NON_BLANK_TASK_OPTIONS,
		description: "Self-contained task to delegate (the agent has no memory of this conversation)",
	}),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
	isolation: IsolationSchema,
	review: ReviewSchema,
});

const SubagentParams = Type.Object({
	agent: Type.Optional(Type.String({ description: "Name of the agent to invoke (single mode)" })),
	task: Type.Optional(
		Type.String({ ...NON_BLANK_TASK_OPTIONS, description: "Self-contained task to delegate (single mode)" }),
	),
	tasks: Type.Optional(Type.Array(TaskItem, { description: "Array of {agent, task} for parallel execution" })),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process (single mode)" })),
	isolation: IsolationSchema,
	review: ReviewSchema,
	wait: WaitSchema,
});

/** Roles that default to worktree isolation in parallel dispatches even when
 * the live catalog cannot be consulted (render-only call sites). Custom
 * write-capable agents join them via isWriteCapableAgent on the execute path. */
const WORKTREE_DEFAULT_AGENTS = new Set(["worker", "cleaner", "documenter"]);

/** Resolve the default isolation for a dispatch. Precedence: an explicit
 * per-call request, then the role's own frontmatter declaration (`worktree`
 * honored for write-capable roles only; `shared` always), then the parallel
 * write default — parallel write-capable agents get a detached worktree
 * because shared writers serialize on the repository lane, so defaulting them
 * to shared would turn one parallel batch into a convoy that also parks
 * process slots. */
export function defaultIsolationMode(
	mode: "single" | "parallel",
	agentName: string,
	requested?: IsolationMode,
	writeCapable = WORKTREE_DEFAULT_AGENTS.has(agentName),
	declared?: IsolationMode,
): IsolationMode {
	if (requested) return requested;
	if (declared === "shared") return "shared";
	if (declared === "worktree" && writeCapable) return "worktree";
	return mode === "parallel" && writeCapable ? "worktree" : "shared";
}

function workflowStageStatus(result: SingleResult, relation?: string): WorkflowStageStatus {
	if (isFailedResult(result)) return "failed";
	if (relation === "review fix") return "done";
	if (result.agent !== "reviewer") return "done";
	const verdict = reviewVerdict(getResultOutput(result));
	if (verdict === "fail") return "changes";
	return verdict === "pass" ? "done" : "failed";
}

/** The runtime-granted write continuation of a failed gate: same reviewer
 * role, model, and retained session, but the read-only boundary is lifted for
 * this one stage so it applies its own fix instructions. One line only: the
 * full fix-stage contract is already in the retained session's prompt. */
function withReviewerFixStageAgent(agent: AgentConfig): AgentConfig {
	return {
		...agent,
		tools: undefined,
		systemPrompt: `${agent.systemPrompt.trimEnd()}\n\nRuntime workflow context: FIX STAGE — your gate just returned REVIEW_FAIL. Your read-only boundary is lifted for this stage only: apply your own fix instructions exactly as specified, verify, and report what changed; never edit during a review and never emit a verdict here.`,
	};
}

export function registerSubagentTool(pi: ExtensionAPI, runtime: SubagentRuntime): void {
	// Latest dispatch environment. The dispatcher is created once per process so
	// restored threads can resume before any dispatch has run; each execute
	// refreshes the fallback context, config, and agent catalog it resolves.
	const environmentRef: { current: DispatchEnvironment | undefined } = { current: undefined };

	// Finished runs leave the active monitor immediately. Their final findings
	// are sent as a custom message that starts a follow-up turn.
	const finishRun = (
		runId: number,
		status: "done" | "failed",
		opts?: { silent?: boolean },
	): void => {
		monitor.setStatus(runId, status); // stamps endedAt for the elapsed time
		const run = monitor.removeRun(runId);
		if (!run) return; // already finished — stay idempotent
		if (opts?.silent || !runtime.sessionActive) return;
		const icon = status === "done" ? "✓" : "✗";
		environmentRef.current?.ctx.ui.notify(`${icon} #${run.id} ${monitor.summarize(run)}`, status === "done" ? "info" : "error");
	};

	// Live sub-agent activity → concise one-line status ("thinking",
	// "read src/index.ts", ...), never a raw args blob. The live handler
	// only updates monitor state; the queue task / launchInWorkflow owns
	// terminal removal, notification, and downstream workflow decisions.
	const makeLiveHandler =
		(runId: number, generation?: number) =>
		(e: SubagentLiveEvent): void => {
			if (generation !== undefined && runtime.threads.get(runId)?.generation !== generation) return;
			switch (e.kind) {
				case "status":
					monitor.setStatus(runId, e.status);
					// A fresh running segment refreshes the durable checkpoint (session
					// path plus child pids) so a crash mid-generation still restores.
					if (e.status === "running") {
						const thread = runtime.threads.get(runId);
						if (thread?.sessionId && thread.sessionDir) {
							persistThreadCheckpoint(runtime, thread, "parked");
						}
					}
					break;
				case "model":
					monitor.setModel(runId, e.model, e.fallbackFrom);
					monitor.setThinking(runId, e.thinking);
					break;
				case "usage":
					monitor.setUsage(runId, e.usage, e.model);
					break;
				case "session": {
					runtime.retainSession({ sessionDir: e.sessionDir });
					const thread = runtime.threads.get(runId);
					if (thread && (generation === undefined || runtime.threads.get(runId)?.generation === generation)) {
						thread.sessionId = e.sessionId;
						thread.sessionDir = e.sessionDir;
						persistThreadCheckpoint(runtime, thread, "parked");
					}
					break;
				}
				case "tool_start":
					monitor.recordToolStart(runId, e.toolName, formatToolActivity(e.toolName, e.args));
					break;
				case "tool_end":
					monitor.recordToolEnd(runId, e.toolName, e.isError);
					break;
				case "thinking":
					monitor.setActivity(runId, "thinking");
					break;
				case "text":
					// A text delta is model output, not a filesystem write.
					monitor.setActivity(runId, "responding");
					break;
			}
		};

	const makeDetails =
		(mode: "single" | "parallel", background = false) =>
		(results: SingleResult[]): SubagentDetails => ({ mode, results, background });

	/** Pacing note appended to dispatch confirmations whenever runs are actually
	 * waiting. Slot waits and repository-lane waits are stated separately with
	 * the real capacity: a lane-serialized shared writer or a starting child
	 * must never read as an exhausted pool, or the model stops dispatching while
	 * slots are free. Empty when nothing is waiting. */
	const queuePacingNote = (): string => {
		const runs = monitor.getRuns();
		const queuedWith = (reason: RunWaitReason): number =>
			runs.filter((run) => run.status === "queued" && run.waitReason === reason).length;
		const slotWaiting = queuedWith("process-slot");
		const laneWaiting = queuedWith("repository-lane");
		if (slotWaiting === 0 && laneWaiting === 0) return "";
		const executing = runs.filter((run) =>
			run.status === "running" || run.status === "interrupting" || (run.status === "queued" && run.waitReason === "starting"),
		).length;
		const capacity = runtime.backgroundQueue.capacity;
		const freeSlots = Math.max(0, capacity - runtime.backgroundQueue.activeCount);
		const parts = [`${executing} running`];
		if (slotWaiting > 0) {
			parts.push(`${slotWaiting} waiting for a free process slot (capacity ${capacity}); they start automatically as slots free`);
		}
		if (laneWaiting > 0) {
			parts.push(
				`${laneWaiting} shared-checkout writer${laneWaiting === 1 ? "" : "s"} waiting for the repository write lane — write serialization, not slot capacity` +
					(slotWaiting === 0 ? ` (${freeSlots} of ${capacity} slots free; parallel writers avoid the lane via worktree isolation)` : ""),
			);
		}
		return ` Pacing: ${parts.join(" · ")}. Keep dispatching independent units.`;
	};

	/** Launch one workflow-internal child in a fresh model context. It sees the
	 * parent's exact repository/worktree state and is registered by its own id,
	 * but never enters top-level lifecycle policy or completion delivery.
	 * `stage` continues a retained session (the reviewer fix stage) and/or
	 * replaces the resolved agent (lifting the reviewer read-only boundary). */
	const launchInWorkflow = async (
		request: ManagedWorkflowRequest,
		agentName: string,
		task: string,
		meta: RunChainMeta,
		stage: {
			agentOverride?: AgentConfig;
			session?: { sessionId: string; sessionDir: string };
		} = {},
	): Promise<{ runId: number; result: SingleResult }> => {
		const discoveredAgent = request.agents.find((candidate) => candidate.name === agentName);
		if (!discoveredAgent) {
			throw new Error(`Managed workflow requires enabled agent "${agentName}", but discovery did not provide it.`);
		}
		const boundaryAgent = stage.agentOverride ?? discoveredAgent;
		const resolveLiveAgentTools = (candidate: AgentConfig): AgentConfig =>
			resolveAgentTools({ ...candidate, tools: boundaryAgent.tools }, runtime.getActiveTools());
		const agent = resolveLiveAgentTools(boundaryAgent);
		// Workflow policy (agents) stays fixed for the chain, but model/thinking
		// routes are re-read per stage so config edits apply to stages that have
		// not launched yet.
		const stageConfig = await loadConfig(runtime.configPath).catch(() => request.config);
		const resolvedRoute = resolveDispatchModelRoute(agent, stageConfig, request.ctx);
		const route = request.isolation === "worktree"
			? { ...resolvedRoute, agent: withWorktreeSystemPrompt(resolvedRoute.agent) }
			: resolvedRoute;
		const thinkingLevel = route.thinkingLevel;
		const runId = monitor.addRun(agent.name, task, route.agent.model, thinkingLevel, {
			...meta,
			isolation: request.isolation,
			...(request.worktreeId ? { worktreeId: request.worktreeId } : {}),
			// Workflow-internal children spawn immediately: they never enter the
			// process queue, so they must never be reported as slot-waiting.
			waitReason: "starting",
		});
		const onLive = makeLiveHandler(runId);
		const projectRoot = getProjectRoot(runtime.configPath, request.executionCwd);
		try {
			const result = await runSingleAgentWithMainFallback(
				{
					defaultCwd: request.executionCwd,
					cwd: request.executionCwd,
					agent: route.agent,
					resolveAgentForAttempt: resolveLiveAgentTools,
					agentName,
					task,
					thinkingLevel,
					thinkingLevelForModel: route.thinkingLevelForModel,
					signal: request.signal,
					onLive,
					makeDetails: makeDetails("single", true),
					idleTimeoutMs: stageConfig.idleTimeoutSec * 1000,
					sessionRoot: join(projectRoot, "sessions"),
					scratchRoot: join(projectRoot, "tmp"),
					...(stage.session
						? { sessionId: stage.session.sessionId, sessionDir: stage.session.sessionDir, stdinText: task }
						: {}),
				},
				route.mainFallbackRef,
			);
			result.runId = runId;
			result.projectCwd = request.projectCwd;
			result.isolation = request.isolation;
			runtime.retainSession(result);
			monitor.setModel(runId, result.model, result.modelFallbackFrom);
			monitor.setThinking(runId, result.thinking);
			finishRun(runId, isFailedResult(result) ? "failed" : "done", { silent: true });
			runtime.registerRunResult(runId, result);
			return { runId, result };
		} catch (error) {
			finishRun(runId, "failed", { silent: true });
			const errorMessage = error instanceof Error ? error.message : String(error);
			const crashed: SingleResult = {
				...queuedResult(route.agent, task, thinkingLevel),
				runId,
				projectCwd: request.projectCwd,
				isolation: request.isolation,
				exitCode: 1,
				stderr: errorMessage,
				stopReason: request.signal.aborted ? "aborted" : "error",
				errorMessage,
				dispatchFailed: true,
			};
			runtime.registerRunResult(runId, crashed);
			return { runId, result: crashed };
		}
	};

	/** Drop any in-flight internal row. Normal internal settlement already
	 * removes rows; this is a cancellation/crash guard. */
	const removeWorkflowGroup = (groupId: string): void => {
		for (const run of [...monitor.getRuns()]) {
			if (run.groupId === groupId) monitor.removeRun(run.id);
		}
	};

	/** Run every downstream role inline under the parent generation's queue
	 * controller. That gives park/stop/shutdown one lifecycle owner and keeps
	 * isolated worktrees unintegrated until the final reviewer settles. */
	const runManagedWorkflow = async (
		request: ManagedWorkflowRequest,
	): Promise<ManagedWorkflowOutcome> => {
		const initialStepRunId = monitor.reserveRunId();
		const initialStepResult: SingleResult = {
			...request.initialResult,
			runId: initialStepRunId,
		};
		runtime.registerRunResult(initialStepRunId, initialStepResult);
		const steps: ChainStep[] = [{
			runId: initialStepRunId,
			result: initialStepResult,
			relation: request.plan.initialRelation,
		}];
		const enabled = (name: string): boolean =>
			request.agents.some((candidate) => candidate.name === name);
		const canContinue = (): boolean => runtime.sessionActive && !request.signal.aborted;

		// Keep a live parent-owned projection because settled internal rows are
		// intentionally removed. Only real/currently planned stages enter it.
		const initialStageRelation = initialStepResult.agent === "worker"
			? "implement"
			: initialStepResult.agent === "cleaner"
				? "cleanup"
				: "review";
		const workflowStages: WorkflowStage[] = [{
			agent: initialStepResult.agent,
			relation: initialStageRelation,
			status: workflowStageStatus(initialStepResult),
		}];
		let reviewStage: WorkflowStage | undefined;
		if (enabled("reviewer")) {
			reviewStage = { agent: "reviewer", relation: "review", status: "pending" };
			workflowStages.push(reviewStage);
		}
		const publishWorkflowStages = (): void => {
			monitor.setWorkflowStages(request.parentRunId, workflowStages);
		};
		publishWorkflowStages();

		const launchStep = async (
			agentName: string,
			task: string,
			relation: string,
			stage: WorkflowStage,
			stageOptions: {
				agentOverride?: AgentConfig;
				session?: { sessionId: string; sessionDir: string };
			} = {},
		): Promise<SingleResult> => {
			if (!enabled(agentName)) {
				throw new Error(`Managed workflow cannot launch disabled or missing agent "${agentName}".`);
			}
			stage.status = "active";
			publishWorkflowStages();
			try {
				const step = await launchInWorkflow(request, agentName, task, {
					groupId: request.groupId,
					relationLabel: relation,
					parentRunId: request.parentRunId,
				}, stageOptions);
				stage.status = workflowStageStatus(step.result, relation);
				publishWorkflowStages();
				request.rememberLatest(step.result);
				steps.push({ ...step, relation });
				return step.result;
			} catch (error) {
				stage.status = "failed";
				publishWorkflowStages();
				throw error;
			}
		};

		try {
			// Park/stop/shutdown may win after the top-level child settles but
			// before this continuation starts. Preserve that stable checkpoint and
			// never create an already-aborted downstream child.
			if (!canContinue()) return { steps };
			if (reviewStage) {
				const discoveredReviewer = request.agents.find((candidate) => candidate.name === "reviewer")!;
				let gateReview = await launchStep(
					"reviewer",
					buildFinalReviewBrief(initialStepResult),
					"final review",
					reviewStage,
				);
				// The failing gate owns its fixes: the same retained
				// reviewer session applies its own fix instructions with write access,
				// then a converging re-review verifies the fixes. The cap only stops
				// pathological burn and hands the still-failing gate to the main agent.
				for (let round = 1; round <= MAX_REVIEW_FIX_ROUNDS; round++) {
					const gateSession = gateReview.sessionId && gateReview.sessionDir
						? { sessionId: gateReview.sessionId, sessionDir: gateReview.sessionDir }
						: undefined;
					if (reviewVerdict(getResultOutput(gateReview)) !== "fail" || !gateSession || !canContinue()) break;
					const fixStage: WorkflowStage = { agent: "reviewer", relation: "review fix", status: "pending" };
					workflowStages.push(fixStage);
					publishWorkflowStages();
					const fixResult = await launchStep(
						"reviewer",
						buildReviewerFixBrief(getResultOutput(gateReview)),
						"review fix",
						fixStage,
						{ agentOverride: withReviewerFixStageAgent(discoveredReviewer), session: gateSession },
					);
					if (isFailedResult(fixResult) || !canContinue()) break;
					const reReviewStage: WorkflowStage = { agent: "reviewer", relation: "review", status: "pending" };
					workflowStages.push(reReviewStage);
					publishWorkflowStages();
					gateReview = await launchStep(
						"reviewer",
						buildReReviewBrief(fixResult, round),
						round === 1 ? "re-review" : `re-review ${round}`,
						reReviewStage,
					);
				}
			}
			return { steps };
		} finally {
			removeWorkflowGroup(request.groupId);
		}
	};

	/** In-turn blocking behind `wait: true`: hold the turn until every run
	 * started by this call settles, then hand back their result blocks. This is
	 * the one blocking path — a one-shot (pi -p) parent cannot end its turn and
	 * be woken by the completion message, and a directly dependent next step
	 * needs the results now. No timer: children are bounded by the idle
	 * watchdog, and the turn's abort signal remains the escape hatch. */
	const awaitStartedRuns = async (
		runIds: number[],
		signal: AbortSignal | undefined,
		maxResultLines: number,
		fallbackCwd: string,
	): Promise<string> => {
		const waitForRun = (runId: number): Promise<{ result?: SingleResult; note?: string }> => {
			const already = runtime.settledRuns.get(runId);
			if (already) return Promise.resolve({ result: already });
			return new Promise((resolve) => {
				let done = false;
				let unsub: (() => void) | undefined;
				const cleanup = (): void => {
					if (unsub) unsub();
					signal?.removeEventListener("abort", onAbort);
					const listeners = runtime.settledListeners.get(runId);
					if (listeners) {
						listeners.delete(onSettled);
						if (listeners.size === 0) runtime.settledListeners.delete(runId);
					}
				};
				const finish = (outcome: { result?: SingleResult; note?: string }): void => {
					if (done) return;
					done = true;
					cleanup();
					resolve(outcome);
				};
				const onSettled = (result: SingleResult): void => finish({ result });
				const onMonitor = (): void => {
					const current = runtime.settledRuns.get(runId);
					if (current) {
						finish({ result: current });
						return;
					}
					const live = monitor.findRun(runId);
					if (live?.status === "parked") {
						finish({ note: `run #${runId} was parked at a stable checkpoint; use subagent_control resume to continue it` });
						return;
					}
					if (!live) {
						// Removal is followed synchronously by registerRunResult in the
						// finishing task; re-check on the next tick so the result wins.
						setTimeout(() => {
							const late = runtime.settledRuns.get(runId);
							if (late) finish({ result: late });
							else finish({ note: `run #${runId} was removed before its result was recorded (cancelled or session ended)` });
						}, 0);
					}
				};
				const onAbort = (): void => finish({ note: "wait aborted" });
				let listeners = runtime.settledListeners.get(runId);
				if (!listeners) {
					listeners = new Set();
					runtime.settledListeners.set(runId, listeners);
				}
				listeners.add(onSettled);
				unsub = monitor.subscribe(onMonitor);
				if (signal?.aborted) onAbort();
				else signal?.addEventListener("abort", onAbort, { once: true });
			});
		};
		const outcomes = await Promise.all(runIds.map(waitForRun));
		return outcomes.map((outcome) =>
			outcome.result
				? formatCompletionBlock(outcome.result, maxResultLines, { resultRoot: projectResultsRoot(runtime.configPath, outcome.result.projectCwd ?? fallbackCwd) })
				: (outcome.note ?? "(no outcome)"),
		).join("\n\n");
	};

	const startBackground = createBackgroundDispatcher({
		runtime,
		getEnvironment: () => {
			if (!environmentRef.current) {
				throw new Error("pi-subagents dispatch environment is not ready yet.");
			}
			return environmentRef.current;
		},
		finishRun,
		makeLiveHandler,
		makeDetails,
		runManagedWorkflow,
	});
	runtime.dispatcher = startBackground;

	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: [
			"Dispatch enabled agents as isolated leaf Pi child processes: single {agent, task} or parallel {tasks: [...]}. Dispatching never blocks your turn — runs proceed in the background and each completion resumes you automatically; never poll or restate delivered results.",
			"Put every genuinely independent unit in one `tasks` array: there is no per-call cap, and runs beyond the machine's free process slots simply wait and start as slots free.",
			"Parallel write-capable agents default to a detached Git worktree so writers run concurrently; explicit `shared` keeps the caller's checkout and serializes same-repository writers. Worktree setup failure never silently falls back to shared.",
			"Successful worker/cleaner runs get one automatic reviewer gate; pass review: \"none\" on a worker/cleaner task to skip it for mechanical, low-risk edits you verify yourself. A REVIEW_FAIL from a gate you dispatched directly returns its findings to you. A configured child-model failure continues the retained session on the current main model.",
		].join(" "),
		promptSnippet:
			"Dispatch isolated background agents for recon, implementation, cleanup, docs, or review; never blocks your turn, and REVIEW_FAIL findings return to you to fix.",
		parameters: SubagentParams,

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			// Run ids are allocated below; restore raises the allocator above every
			// id a durable record still owns, so a dispatch racing it could hand a
			// fresh run the id of a parked thread and overwrite its record.
			await runtime.durableRestore;
			monitor.beginTurn();
			const config = await loadConfig(runtime.configPath);

			const discovery = discoverAgents(ctx.cwd, {
				scope: config.agentScope,
				enabledNames: config.enabledAgents,
				projectTrusted: ctx.isProjectTrusted?.() === true,
			});
			const agents = discovery.agents;
			// Refresh the dispatcher's fallback environment so control operations
			// (resume of restored threads) never run on a stale context.
			environmentRef.current = { ctx, config, agents };

			const hasTasks = (params.tasks?.length ?? 0) > 0;
			const hasSingle = Boolean(params.agent) && params.task !== undefined;

			const catalog = agents.map((a) => a.name).join(", ") || "none";

			if (Number(hasTasks) + Number(hasSingle) !== 1) {
				return {
					content: [
						{
							type: "text",
							text: `Invalid parameters. Provide exactly one mode: single {agent, task} or parallel {tasks: [...]}. Enabled agents: ${catalog}.`,
						},
					],
					details: makeDetails("single")([]),
				};
			}

			if (hasTasks) {
				const blankTaskIndex = params.tasks?.findIndex(({ task }) => task.trim().length === 0) ?? -1;
				if (blankTaskIndex !== -1) {
					return {
						content: [
							{
								type: "text",
								text: `Invalid parameters. tasks[${blankTaskIndex}].task must contain at least one non-whitespace character. No background tasks were started. Enabled agents: ${catalog}.`,
							},
						],
						details: makeDetails("parallel")([]),
					};
				}
			} else if (params.task?.trim().length === 0) {
				return {
					content: [
						{
							type: "text",
							text: `Invalid parameters. task must contain at least one non-whitespace character. Enabled agents: ${catalog}.`,
						},
					],
					details: makeDetails("single")([]),
				};
			}

			// Sub-agents run detached from the foreground turn: the editor stays
			// available and completion messages later wake the main agent. The turn is
			// NOT terminated here — the model can keep dispatching independent units
			// or do its own work, and the background queue paces how many child
			// processes actually run at once, so no per-call task cap is enforced.
			if (params.tasks && params.tasks.length > 0) {
				const results: SingleResult[] = [];
				// Preserve caller order (and deterministic completion batching) while
				// preparing each isolated filesystem before its queue entry can start.
				for (const item of params.tasks) {
					const catalogAgent = agents.find((candidate) => candidate.name === item.agent);
					results.push(await startBackground(
						item.agent,
						item.task,
						item.cwd,
						defaultIsolationMode(
							"parallel",
							item.agent,
							item.isolation as IsolationMode | undefined,
							catalogAgent ? isWriteCapableAgent(catalogAgent) : undefined,
							catalogAgent?.isolation,
						),
						{ review: item.review as ReviewMode | undefined },
					));
				}
				const startedRuns = results.filter((result) => result.exitCode === -1);
				const started = startedRuns.length;
				const startedRefs = startedRuns.map((result) =>
					result.runId === undefined ? result.agent : `#${result.runId} ${result.agent}`,
				);
				const failureLines = results.flatMap((result, index) => {
					if (result.exitCode === -1) return [];
					const reason = getResultOutput(result).trim() || "unknown startup failure";
					return [
						`- tasks[${index}] (${params.tasks![index]!.agent}) failed to start: ${reason.replace(/\n/g, "\n  ")}`,
					];
				});
				if (started === 0) {
					// Pi marks custom-tool failures only when execute throws; returning an
					// `isError` property is still a successful AgentToolResult.
					throw new Error(`No background subagents were started.\n${failureLines.join("\n")}`);
				}
				if (params.wait) {
					const startedIds = startedRuns
						.map((result) => result.runId)
						.filter((id): id is number => id !== undefined);
					const blocks = await awaitStartedRuns(startedIds, signal, config.maxResultLines, ctx.cwd);
					const text = [
						`Started ${started} subagent${started === 1 ? "" : "s"} (${startedRefs.join(", ")}) and waited in-turn.`,
						...(failureLines.length > 0
							? [`${failureLines.length} task${failureLines.length === 1 ? "" : "s"} failed before launch:`, ...failureLines]
							: []),
						"",
						blocks,
					].join("\n");
					return {
						content: [{ type: "text", text }],
						details: makeDetails("parallel", true)(results),
					};
				}
				const text = [
					`Started ${started} background subagent${started === 1 ? "" : "s"}: ${startedRefs.join(", ")}. They run in the background and never block you — dispatch more independent units now or keep working; each result resumes you automatically when you are idle.`,
					...(failureLines.length > 0
						? [`${failureLines.length} task${failureLines.length === 1 ? "" : "s"} failed before launch:`, ...failureLines]
						: []),
				].join("\n") + queuePacingNote();
				return {
					content: [{ type: "text", text }],
					details: makeDetails("parallel", true)(results),
				};
			}

			const singleCatalogAgent = agents.find((candidate) => candidate.name === params.agent);
			const result = await startBackground(
				params.agent as string,
				params.task as string,
				params.cwd,
				defaultIsolationMode(
					"single",
					params.agent as string,
					params.isolation as IsolationMode | undefined,
					singleCatalogAgent ? isWriteCapableAgent(singleCatalogAgent) : undefined,
					singleCatalogAgent?.isolation,
				),
				{ review: params.review as ReviewMode | undefined },
			);
			if (result.exitCode !== -1) {
				throw new Error(getResultOutput(result));
			}
			const runRef = result.runId === undefined ? result.agent : `#${result.runId} ${result.agent}`;
			if (params.wait && result.runId !== undefined) {
				const blocks = await awaitStartedRuns([result.runId], signal, config.maxResultLines, ctx.cwd);
				return {
					content: [{ type: "text", text: `Started ${runRef} and waited in-turn.\n\n${blocks}` }],
					details: makeDetails("single", true)([result]),
				};
			}
			return {
				content: [{ type: "text", text: `Started ${runRef} in the background. It never blocks you — dispatch more independent units now or keep working; its result resumes you automatically when you are idle.${queuePacingNote()}` }],
				details: makeDetails("single", true)([result]),
			};

		},

		renderCall(args, theme) {
			if (args.tasks && args.tasks.length > 0) {
				let text = `${theme.fg("toolTitle", theme.bold("subagent "))}${theme.fg("accent", `parallel (${args.tasks.length})`)}`;
			for (const t of args.tasks.slice(0, 4)) {
				const preview = formatTaskSummary(t.task, 48);
				const isolation = defaultIsolationMode("parallel", t.agent, t.isolation) === "worktree" ? " [worktree]" : "";
				const gate = t.review === "none" ? " [no gate]" : "";
				text += `\n  ${theme.fg("accent", t.agent)}${theme.fg("dim", `${isolation}${gate}`)} ${theme.fg("dim", preview)}`;
			}
				if (args.tasks.length > 4) text += `\n  ${theme.fg("dim", `… +${args.tasks.length - 4} more`)}`;
				return new Text(text, 0, 0);
			}
			const task: string = args.task ?? "";
			const preview = formatTaskSummary(task, 60);
			const isolation = args.isolation === "worktree" ? " [worktree]" : "";
			const gate = args.review === "none" ? " [no gate]" : "";
			return new Text(
				`${theme.fg("toolTitle", theme.bold("subagent "))}${theme.fg("accent", args.agent ?? "?")}${theme.fg("dim", `${isolation}${gate}`)} ${theme.fg("dim", preview)}`,
				0,
				0,
			);
		},

		renderResult(result, _options, theme) {
			const details = result.details as SubagentDetails | undefined;
			if (!details || details.results.length === 0) return new Text(theme.fg("dim", "(no output)"), 0, 0);

			if (details.mode === "single") {
				const r = details.results[0];
				const pending = r.exitCode === -1;
				const icon = statusIcon(pending ? "running" : isFailedResult(r) ? "failed" : "done", theme);
				const usage = formatUsage(r.usage);
				const model = `${r.model ?? "?"}${r.modelFallbackFrom ? ` (main after ${r.modelFallbackFrom} failed)` : ""}`;
				const isolation = r.isolation === "worktree" ? ` · worktree ${r.integrationStatus ?? "active"}` : "";
				const runId = r.runId === undefined ? "" : `${theme.fg("dim", `#${r.runId}`)} `;
				const line = `${theme.fg("toolTitle", theme.bold("subagent "))}${icon} ${runId}${theme.fg("accent", r.agent)} ${theme.fg("dim", `· ${model}${r.thinking ? ` · thinking ${r.thinking}` : ""}${isolation}${pending ? " · background" : ""}${usage ? ` · ${usage}` : ""}`)}`;
				return new Text(line, 0, 0);
			}

			// Parallel mode: header + one compact line per agent
			const lines: string[] = [
				`${theme.fg("toolTitle", theme.bold("subagent "))}${theme.fg("accent", `parallel (${details.results.length})`)}`,
			];
			for (const r of details.results) {
				const pending = r.exitCode === -1;
				const icon = statusIcon(pending ? "running" : isFailedResult(r) ? "failed" : "done", theme);
				const usage = formatUsage(r.usage);
				const model = `${r.model ?? "?"}${r.modelFallbackFrom ? ` (main after ${r.modelFallbackFrom} failed)` : ""}`;
				const isolation = r.isolation === "worktree" ? ` · worktree ${r.integrationStatus ?? "active"}` : "";
				const runId = r.runId === undefined ? "" : `${theme.fg("dim", `#${r.runId}`)} `;
				lines.push(`  ${icon} ${runId}${theme.fg("accent", r.agent)} ${theme.fg("dim", `· ${model}${r.thinking ? ` · thinking ${r.thinking}` : ""}${isolation}${pending ? " · background" : ""}${usage ? ` · ${usage}` : ""}`)}`);
			}
			return new Text(lines.join("\n"), 0, 0);
		},
	});
}
