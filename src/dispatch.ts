/**
 * The `subagent` tool: dispatches explorer/worker/cleaner/documenter/reviewer agents as isolated pi
 * child processes, single or parallel. Owns the public dispatch contract,
 * per-run status tracking, the managed worker/cleaner → reviewer gate, and
 * internal step launching. Stable thread generations, final integration, and
 * completion ownership live in thread-lifecycle.ts.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { resolve } from "node:path";
import { Type } from "typebox";
import { discoverAgents, resolveAgentTools, type AgentConfig } from "./agents.ts";
import { getStateRoot } from "./durable.ts";
import { loadConfig } from "./config.ts";
import { formatUsage, queuedResult } from "./format.ts";
import {
	buildFinalReviewBrief,
	buildReReviewBrief,
	buildReviewerFixBrief,
	MAX_REVIEW_FIX_ROUNDS,
	type ChainStep,
	type ManagedWorkflowOutcome,
} from "./workflow.ts";
import {
	formatTaskSummary,
	formatToolActivity,
	monitor,
	statusIcon,
	type RunChainMeta,
	type WorkflowStage,
	type WorkflowStageStatus,
} from "./monitor.ts";
import type { SubagentRuntime } from "./runtime.ts";
import { persistThreadCheckpoint } from "./thread-lifecycle.ts";
import {
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

const TaskItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({
		...NON_BLANK_TASK_OPTIONS,
		description: "Self-contained task to delegate (the agent has no memory of this conversation)",
	}),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
	isolation: IsolationSchema,
});

const SubagentParams = Type.Object({
	agent: Type.Optional(Type.String({ description: "Name of the agent to invoke (single mode)" })),
	task: Type.Optional(
		Type.String({ ...NON_BLANK_TASK_OPTIONS, description: "Self-contained task to delegate (single mode)" }),
	),
	tasks: Type.Optional(Type.Array(TaskItem, { description: "Array of {agent, task} for parallel execution" })),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process (single mode)" })),
	isolation: IsolationSchema,
});

export function defaultIsolationMode(mode: "single" | "parallel", agentName: string, requested?: IsolationMode): IsolationMode {
	if (requested) return requested;
	return mode === "parallel" && agentName === "worker" ? "worktree" : "shared";
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
 * this one stage so it applies its own fix instructions. */
function withReviewerFixStageAgent(agent: AgentConfig): AgentConfig {
	return {
		...agent,
		tools: undefined,
		systemPrompt: `${agent.systemPrompt.trimEnd()}\n\nRuntime workflow context: FIX STAGE — your gate just returned REVIEW_FAIL. Your read-only boundary is lifted for this stage only: apply your own fix instructions exactly as you specified them, run the narrowest decisive checks, and report what changed. Never edit during a review and never emit a verdict in a fix stage.`,
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
		});
		const onLive = makeLiveHandler(runId);
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
					sessionRoot: getStateRoot(runtime.configPath),
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
				// The failing gate owns its fixes until it passes: the same retained
				// reviewer session applies its own fix instructions with write access,
				// then a fresh gate re-scans the complete diff. Nobody outside the
				// loop has to guess what satisfies the gate; the cap only stops
				// pathological burn and hands the still-failing gate to the main agent.
				for (let round = 1; round <= MAX_REVIEW_FIX_ROUNDS; round++) {
					const gateSession = gateReview.sessionId && gateReview.sessionDir
						? { sessionId: gateReview.sessionId, sessionDir: gateReview.sessionDir }
						: undefined;
					if (reviewVerdict(getResultOutput(gateReview)) !== "fail" || !gateSession || !canContinue()) break;
					const fixStage: WorkflowStage = { agent: "reviewer", relation: "fix", status: "pending" };
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
			"Dispatch enabled agents as isolated leaf Pi child processes, singly or in parallel. Dispatching never blocks your turn — runs proceed in the background and each completion resumes you automatically; never poll or restate delivered results.",
			"Put every genuinely independent unit in one `tasks` array (no per-call cap; extras queue for a free process slot). Single tasks share the checkout; parallel workers default to detached Git worktrees — write-capable agents only, and setup failure never silently falls back to shared.",
			"Successful worker/cleaner runs get one automatic reviewer gate; a failing gate is fixed by the reviewer itself in a write-enabled continuation of the same session and re-reviewed until it passes. A REVIEW_FAIL from a gate you dispatched directly returns its findings to you — fix them inline or via a briefed worker without waiting for the user.",
			"A configured child-model failure continues the retained session on the current main model. Resume a parked or settled thread with subagent_control by run id; use subagent_stop for destructive cancellation.",
		].join(" "),
		promptSnippet:
			"Dispatch isolated background agents for recon, implementation, cleanup, docs, or review; never blocks your turn, and REVIEW_FAIL findings return to you to fix.",
		parameters: SubagentParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
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
					results.push(await startBackground(
						item.agent,
						item.task,
						item.cwd,
						defaultIsolationMode("parallel", item.agent, item.isolation as IsolationMode | undefined),
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
				const text = [
					`Started ${started} background subagent${started === 1 ? "" : "s"}: ${startedRefs.join(", ")}. They run in the background and never block you — dispatch more independent units now or keep working; each result resumes you automatically when you are idle.`,
					...(failureLines.length > 0
						? [`${failureLines.length} task${failureLines.length === 1 ? "" : "s"} failed before launch:`, ...failureLines]
						: []),
				].join("\n");
				return {
					content: [{ type: "text", text }],
					details: makeDetails("parallel", true)(results),
				};
			}

			const result = await startBackground(
				params.agent as string,
				params.task as string,
				params.cwd,
				defaultIsolationMode("single", params.agent as string, params.isolation as IsolationMode | undefined),
			);
			if (result.exitCode !== -1) {
				throw new Error(getResultOutput(result));
			}
			const runRef = result.runId === undefined ? result.agent : `#${result.runId} ${result.agent}`;
			return {
				content: [{ type: "text", text: `Started ${runRef} in the background. It never blocks you — dispatch more independent units now or keep working; its result resumes you automatically when you are idle.` }],
				details: makeDetails("single", true)([result]),
			};

		},

		renderCall(args, theme) {
			if (args.tasks && args.tasks.length > 0) {
				let text = `${theme.fg("toolTitle", theme.bold("subagent "))}${theme.fg("accent", `parallel (${args.tasks.length})`)}`;
				for (const t of args.tasks.slice(0, 4)) {
					const preview = formatTaskSummary(t.task, 48);
					const isolation = defaultIsolationMode("parallel", t.agent, t.isolation) === "worktree" ? " [worktree]" : "";
					text += `\n  ${theme.fg("accent", t.agent)}${theme.fg("dim", isolation)} ${theme.fg("dim", preview)}`;
				}
				if (args.tasks.length > 4) text += `\n  ${theme.fg("dim", `… +${args.tasks.length - 4} more`)}`;
				return new Text(text, 0, 0);
			}
			const task: string = args.task ?? "";
			const preview = formatTaskSummary(task, 60);
			const isolation = args.isolation === "worktree" ? " [worktree]" : "";
			return new Text(
				`${theme.fg("toolTitle", theme.bold("subagent "))}${theme.fg("accent", args.agent ?? "?")}${theme.fg("dim", isolation)} ${theme.fg("dim", preview)}`,
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
