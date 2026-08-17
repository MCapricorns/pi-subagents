/**
 * The `subagent` tool: dispatches explore/worker/reviewer agents as isolated pi
 * child processes, single or parallel. Owns the dispatch pipeline: config load,
 * per-agent model-pool resolution, per-run widget tracking, the auto-fix chain
 * (REVIEW_FAIL → worker → re-review), and completion delivery.
 *
 * Vision: a task flagged `vision: true` uses the configured vision model as an
 * explicit primary, then the agent's configured backup and the current
 * main-window model. Stale refs remain in the pool and fail normally at runtime.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import { Type } from "typebox";
import { discoverAgents, type AgentConfig } from "./agents.ts";
import {
	completionTriggersTurn,
	type CompletionMessageItem,
} from "./completion.ts";
import { loadConfig, type SubagentsConfig } from "./config.ts";
import {
	dispatchFailedResult,
	failedStartResult,
	formatCompletionBlock,
	formatUsage,
	modelLevelTakeoverNote,
	queuedResult,
} from "./format.ts";
import {
	buildFixTaskBrief,
	buildReReviewBrief,
	formatChainSummary,
	shouldTriggerFixLoop,
	summarizeChainResult,
	type ChainStep,
} from "./fixloop.ts";
import { currentModelRef, resolveAgentModelPool } from "./models.ts";
import {
	formatTaskSummary,
	formatToolActivity,
	monitor,
	statusIcon,
	type RunChainMeta,
} from "./monitor.ts";
import type { SubagentRuntime, SubagentThread, ThreadState } from "./runtime.ts";
import { forkRetainedSession } from "./session-fork.ts";
import {
	buildFallbackResumeReason,
	buildResumePrompt,
	RpcRunControl,
	getResultOutput,
	isFailedResult,
	isModelLevelFailure,
	reviewVerdict,
	runSingleAgentWithModelFallback,
	type SingleResult,
	type SubagentDetails,
	type SubagentLiveEvent,
	type SubagentRecordEvent,
} from "./spawn.ts";
import { inspectorStore, summarizeToolArgs } from "./trajectory.ts";
import {
	createWorktreeIsolation,
	type IsolationMode,
	type WorktreeFinalization,
	type WorktreeIsolation,
} from "./worktree.ts";

const NON_BLANK_TASK_OPTIONS = { minLength: 1, pattern: "\\S" } as const;
export const FORK_CONTINUATION_PROMPT =
	"Continue from the retained context above. Review the prior work, then take the most useful next step toward completing the existing objective without repeating completed work.";
export const WORKTREE_ISOLATION_INSTRUCTIONS =
	"You are running in a temporary detached Git worktree. Work only in the current cwd; do not create another worktree or manually copy/apply changes to the original checkout. The parent dispatcher will integrate your tracked, deleted, and untracked changes when this thread finally settles.";

export function buildWorktreeTaskPrompt(task: string): string {
	return `${WORKTREE_ISOLATION_INSTRUCTIONS}\n\nTask: ${task}`;
}

function withWorktreeSystemPrompt(agent: AgentConfig): AgentConfig {
	return {
		...agent,
		systemPrompt: `${agent.systemPrompt.trimEnd()}\n\n${WORKTREE_ISOLATION_INSTRUCTIONS}`.trim(),
	};
}

interface DispatchEnvironment {
	ctx: ExtensionContext;
	config: SubagentsConfig;
	agents: AgentConfig[];
	sessionRef?: string;
}

const VISION_DESCRIPTION =
	"Set true when the task may require viewing images (screenshots, mockups, designs) — the configured vision model becomes primary, followed by the agent backup and current main-window model";

const ISOLATION_DESCRIPTION =
	"Filesystem isolation: shared uses the caller's working tree; worktree creates a detached temporary Git worktree (write-capable agents only)";

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
	vision: Type.Optional(Type.Boolean({ description: VISION_DESCRIPTION })),
	isolation: IsolationSchema,
});

const SubagentParams = Type.Object({
	agent: Type.Optional(Type.String({ description: "Name of the agent to invoke (single mode)" })),
	task: Type.Optional(
		Type.String({ ...NON_BLANK_TASK_OPTIONS, description: "Self-contained task to delegate (single mode)" }),
	),
	tasks: Type.Optional(Type.Array(TaskItem, { description: "Array of {agent, task} for parallel execution" })),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process (single mode)" })),
	vision: Type.Optional(Type.Boolean({ description: VISION_DESCRIPTION })),
	isolation: IsolationSchema,
});

export function defaultIsolationMode(mode: "single" | "parallel", agentName: string, requested?: IsolationMode): IsolationMode {
	if (requested) return requested;
	return mode === "parallel" && agentName === "worker" ? "worktree" : "shared";
}

export function isWorktreeCapableAgent(agent: AgentConfig): boolean {
	if (agent.name === "explore" || agent.name === "reviewer") return false;
	if (agent.name === "worker") return true;
	if (!agent.tools) return true;
	return agent.tools.includes("edit") || agent.tools.includes("write");
}

function resolveDispatchModelPool(
	agent: AgentConfig,
	config: SubagentsConfig,
	mainRef: string | undefined,
	vision: boolean,
): { agent: AgentConfig; fallbackModelRefs: string[] } {
	const pool = resolveAgentModelPool({
		primaryRef: vision ? config.visionModel : config.agentModels[agent.name],
		backupRef: config.agentBackupModels[agent.name],
		mainRef,
		declaredDefaultRef: agent.model,
	});
	return {
		agent: { ...agent, model: pool.primaryRef },
		fallbackModelRefs: pool.fallbackModelRefs,
	};
}

export function registerSubagentTool(pi: ExtensionAPI, runtime: SubagentRuntime): void {
	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: [
			"Delegate a discrete, self-contained task to a specialized sub-agent running in an ISOLATED context window.",
			"Agents: explore (read-only codebase recon), worker (implement/fix/refactor/test, full tools), reviewer (adversarial pre-commit review, read-only).",
			"Modes: single ({agent, task}) or parallel ({tasks: [{agent, task}, ...]}).",
			"Isolation: single tasks default to shared; parallel worker tasks default to detached Git worktrees unless isolation: shared is explicit. explore/reviewer cannot use worktree isolation.",
			"Use subagent_control to steer, retarget, park, resume, or fork a thread by its stable run id.",
			"It starts agents in the background and immediately returns control to the main window; completion messages automatically wake the main agent to continue.",
			"Each agent has no memory of this conversation — brief it fully (goal, exact paths, constraints, expected output).",
			"Results arrive as wake-up messages automatically — you do NOT need to wait. If you must get a result in-turn, subagent_wait is a non-blocking lookup by default (pass timeoutMs to block).",
			"Vision: set vision: true when the task may require viewing images (screenshots, mockups, design files — e.g. frontend work) — the configured vision model is primary, followed by that agent's backup and the current main-window model.",
		].join(" "),
		promptSnippet:
			"Start background subagents: explore (read-only search), worker (implement), reviewer (adversarial review); completion automatically resumes the main agent. Simple tasks: use direct tools, not subagents.",
		promptGuidelines: [
			"Delegate only when an isolated context genuinely pays: broad exploration, a self-contained implementation, or a review gate. Handle simple lookups and one-line edits inline with direct tools — never spawn a sub-agent for them.",
			"Use subagent with agent 'explore' for broad or open-ended code search before large changes; a targeted 'where is X' is a direct grep/read.",
			"Use subagent with agent 'worker' for a self-contained implementation task worth a separate context; it plans internally.",
			"Use subagent with agent 'reviewer' for a fresh read-only review before reporting work done or committing.",
			"subagent launches work in the background and ends the current turn; when a result arrives, the main agent is automatically resumed with it.",
			"Run independent tasks in parallel by passing a tasks array to subagent; parallel worker items default to isolation: worktree so their edits are integrated independently. Pass isolation: shared only when workers intentionally need the caller's live uncommitted tree.",
			"Use isolation: worktree only for worker/write-capable agents and only inside a Git repository with a committed HEAD; setup or integration failures never silently fall back to shared.",
			"NEVER sleep or poll, and do NOT call subagent_wait to hold the turn — subagent ends the turn immediately and the result arrives as a message that wakes you automatically (even mid-turn). Ending your turn is the default and the only correct way to wait.",
			"If you must keep the turn for a result, call subagent_wait with an explicit timeoutMs (non-blocking by default) — never bash sleep/timeout to wait for a sub-agent.",
			"When a delegated task may require viewing images (frontend screenshots, mockups, design comparisons), pass vision: true and give the sub-agent the exact image paths — it reads them with its read tool. The configured vision model becomes primary; model-level failures continue through the agent's backup pool and current main-window model.",
			"When a sub-agent result arrives it is already shown to the user — do NOT restate, paraphrase, or summarize it; reply with only your own conclusion or next action (often just one line), since duplicating the result wastes tokens for nothing.",
		],
		parameters: SubagentParams,

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			monitor.beginTurn();
			const config = await loadConfig(runtime.configPath);
			// Pick up concurrency changes from /subagents-setup without a restart.
			runtime.backgroundQueue.setConcurrency(config.maxConcurrency);

			// Finished runs leave the widget immediately. Their final findings are sent
			// back as a custom message that automatically starts a follow-up turn.
			const finishRun = (
				runId: number,
				status: "done" | "failed",
				opts?: { silent?: boolean; retain?: boolean },
			): void => {
				monitor.setStatus(runId, status); // stamps endedAt for the elapsed time
				const run = opts?.retain ? monitor.findRun(runId) : monitor.removeRun(runId);
				if (!run) return; // already finished — stay idempotent
				if (opts?.retain) monitor.setRetained(runId, true);
				if (opts?.silent || !runtime.sessionActive) return;
				const icon = status === "done" ? "✓" : "✗";
				ctx.ui.notify(`${icon} ${monitor.summarize(run)}`, status === "done" ? "info" : "error");
			};

			// Live sub-agent activity → concise one-line status ("thinking",
			// "read src/index.ts", ...), never a raw args blob. In parallel, every
			// live event is appended to the thread's append-only trajectory (status,
			// model-candidate changes, usage, tool starts/ends with a redacted
			// args summary) so /subagents-inspect can replay what happened. The live
			// handler only updates widget status; finishing (removeRun + notify) is
			// owned by the queue task / launchInLoop. That keeps a startup retry —
			// which fires a transient "failed" status before relaunching — from
			// ripping the row out early, and lets the queue task decide between
			// delivering a reviewer's result and starting an auto-fix chain.
			const makeLiveHandler =
				(runId: number, threadId?: number, generation?: number) =>
				(e: SubagentLiveEvent): void => {
					if (generation !== undefined && runtime.threads.get(runId)?.generation !== generation) return;
					switch (e.kind) {
						case "status":
							// Only update the widget status here. Finishing (removeRun + notify) is
							// owned by the queue task / launchInLoop so that a startup retry — which
							// fires a transient "failed" status before relaunching the child — never
							// rips the row out from under the retry or emits a premature "✗" toast.
							monitor.setStatus(runId, e.status);
							break;
						case "model":
							monitor.setModel(runId, e.model, e.fallbackFrom);
							break;
						case "usage":
							monitor.setUsage(runId, e.usage, e.model);
							break;
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
					if (threadId !== undefined) {
						const trajectory = inspectorStore.get(threadId).trajectory;
						switch (e.kind) {
								case "status":
									trajectory.append({ kind: "status", status: e.status });
									break;
								case "model":
									trajectory.append({ kind: "candidate", model: e.model, fallbackFrom: e.fallbackFrom });
									break;
								case "usage":
									trajectory.append({ kind: "usage", usage: { ...e.usage }, model: e.model });
									break;
								case "tool_start":
									trajectory.append({
										kind: "tool_start",
										tool: e.toolName,
										toolCallId: e.toolCallId,
										summary: summarizeToolArgs(e.args),
									});
									break;
								case "tool_end":
									trajectory.append({ kind: "tool_end", tool: e.toolName, toolCallId: e.toolCallId, isError: e.isError });
									break;
								// Text/thinking deltas arrive via onRecord below.
							}
					}
				};

			/** Raw streamed output (text/thinking deltas) → the thread's bounded
			 * transcript buffer; dropped on restart, never carried across generations. */
			const makeRecordHandler =
				(threadId: number, generation?: number) =>
				(e: SubagentRecordEvent): void => {
					if (generation !== undefined && runtime.threads.get(threadId)?.generation !== generation) return;
					const transcript = inspectorStore.get(threadId).transcript;
					if (e.kind === "thinking") transcript.appendThinking(e.delta);
					else transcript.appendText(e.delta);
				};
			const discovery = discoverAgents(ctx.cwd, {
				scope: config.agentScope,
				enabledNames: config.enabledAgents,
			});
			const sessionRef = currentModelRef(ctx);
			const agents = discovery.agents;

			const hasTasks = (params.tasks?.length ?? 0) > 0;
			const hasSingle = Boolean(params.agent) && params.task !== undefined;

			const makeDetails =
				(mode: "single" | "parallel", background = false) =>
				(results: SingleResult[]): SubagentDetails => ({ mode, results, background });

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

			/**
			 * Dispatch one agent inside an auto-fix chain: tracked in the widget with a
			 * groupId/relationLabel, but NOT delivered through the completion flow — the
			 * chain owner assembles and delivers the whole group at the end.
			 */
			const launchInLoop = async (
				agentName: string,
				task: string,
				signal: AbortSignal,
				meta: RunChainMeta,
				vision = false,
			): Promise<{ runId?: number; result: SingleResult }> => {
				const agent = agents.find((candidate) => candidate.name === agentName);
				if (!agent) return { result: failedStartResult(agentName, task, `Unknown agent: "${agentName}".`) };
				// Vision chains keep the vision override as each round's primary while
				// retaining that worker/reviewer's own configured backup pool.
				const pool = resolveDispatchModelPool(agent, config, sessionRef, vision);
				const thinkingLevel = config.agentThinkingLevels[agent.name] ?? agent.thinking ?? config.thinkingLevel;
				const runId = monitor.addRun(agent.name, task, pool.agent.model, thinkingLevel, meta);
				// Chain rounds are real threads: they get their own trajectory so the
				// inspector can show each fix/re-review round's full story.
				const chainState = inspectorStore.get(runId);
				chainState.retainFrom({ agent: agent.name, task, status: "queued", model: pool.agent.model, thinking: thinkingLevel });
				chainState.trajectory.append({
					kind: "dispatch",
					agent: agent.name,
					task,
					model: pool.agent.model,
					thinking: thinkingLevel,
					pool: pool.fallbackModelRefs,
					vision,
					isolation: "shared",
					originalCwd: ctx.cwd,
					isolationCwd: ctx.cwd,
				});
				const onLive = makeLiveHandler(runId, runId);
				const onRecord = makeRecordHandler(runId);
				try {
					const result = await runSingleAgentWithModelFallback(
						{
							defaultCwd: ctx.cwd,
							agent: pool.agent,
							agentName,
							task,
							thinkingLevel,
							signal,
							onLive,
							onRecord,
							makeDetails: makeDetails("single", true),
							idleTimeoutMs: config.idleTimeoutSec * 1000,
						},
						pool.fallbackModelRefs,
					);
					result.runId = runId;
					result.isolation = "shared";
					result.originalCwd = ctx.cwd;
					result.isolationCwd = ctx.cwd;
					runtime.retainSession(result);
					monitor.setModel(runId, result.model, result.modelFallbackFrom);
					chainState.trajectory.append({
						kind: "settled",
						status: isFailedResult(result) ? "failed" : "done",
						model: result.model,
					});
					// Keep the finished round visible in the widget while the chain is
					// still running, with a one-line summary of what it did; the whole
					// group is dropped when the chain resolves (see removeChainGroup).
					monitor.setSummary(runId, summarizeChainResult(result));
					finishRun(runId, isFailedResult(result) ? "failed" : "done", { retain: true });
					const retainedRun = monitor.findRun(runId);
					if (retainedRun) chainState.retainFrom(retainedRun);
					runtime.registerRunResult(runId, result);
					return { runId, result };
				} catch (error) {
					finishRun(runId, "failed", { retain: true });
					chainState.trajectory.append({ kind: "settled", status: "failed", model: pool.agent.model });
					const retainedRun = monitor.findRun(runId);
					if (retainedRun) chainState.retainFrom(retainedRun);
					const errorMessage = error instanceof Error ? error.message : String(error);
					const crashed: SingleResult = {
						...queuedResult(pool.agent, task, thinkingLevel),
						runId,
						isolation: "shared",
						originalCwd: ctx.cwd,
						isolationCwd: ctx.cwd,
						exitCode: 1,
						stderr: errorMessage,
						stopReason: signal.aborted ? "aborted" : "error",
						errorMessage,
						dispatchFailed: true,
					};
					runtime.registerRunResult(runId, crashed);
					return { runId, result: crashed };
				}
			};

			/**
			 * Run the auto-fix chain in the background: worker (briefed with the review's
			 * findings) → reviewer re-review, up to maxFixRounds times. The main agent is
			 * not woken mid-loop; the full chain is delivered as one group at the end.
			 * Failures short-circuit: a crashed worker skips its re-review and delivers.
			 * The triggering reviewer's run stays visible in the widget (annotated) until
			 * the chain resolves, so the ↳ rows have an obvious parent.
			 */
			/** Drop every widget row belonging to an auto-fix chain; the retained
			 * parent row is removed separately (it does not carry the groupId). */
			const removeChainGroup = (groupId: string): void => {
				for (const run of [...monitor.getRuns()]) {
					if (run.groupId === groupId) monitor.removeRun(run.id);
				}
			};

			const startFixLoop = (
				initialReviewerResult: SingleResult,
				parentGroupId: string,
				parentRunId: number,
				vision = false,
			): void => {
				const parentThreadAtStart = runtime.threads.get(parentRunId);
				if (!parentThreadAtStart) return;
				const parentGeneration = parentThreadAtStart.generation;
				const parentControl = parentThreadAtStart.control;
				let fixController: AbortController | undefined;
				const ownsParent = (): boolean => {
					const current = runtime.threads.get(parentRunId);
					return fixController !== undefined &&
						current === parentThreadAtStart &&
						current.generation === parentGeneration &&
						current.control === parentControl &&
						current.queueController === fixController &&
						runtime.runControllers.get(parentRunId) === fixController;
				};
				const clearOwnedController = (): void => {
					if (!fixController) return;
					if (runtime.runControllers.get(parentRunId) === fixController) {
						runtime.runControllers.delete(parentRunId);
					}
					const current = runtime.threads.get(parentRunId);
					if (current === parentThreadAtStart && current.queueController === fixController) {
						current.queueController = undefined;
					}
				};
				fixController = runtime.backgroundQueue.enqueue(
					async (signal) => {
						const chain: ChainStep[] = [
							{ runId: parentRunId, result: initialReviewerResult, relation: "initial review" },
						];
						let lastReviewer = initialReviewerResult;
						for (let round = 1; round <= config.maxFixRounds; round++) {
							if (!runtime.sessionActive) break;
							const fixBrief = buildFixTaskBrief(lastReviewer, round, config.maxFixRounds);
							const workerStep = await launchInLoop("worker", fixBrief, signal, {
								groupId: parentGroupId,
								relationLabel: `fix round ${round}`,
							}, vision);
							if (!ownsParent()) return;
							chain.push({ ...workerStep, relation: `fix round ${round}` });
							if (!runtime.sessionActive || isFailedResult(workerStep.result)) break;
							const reReviewBrief = buildReReviewBrief(lastReviewer, round);
							const reviewStep = await launchInLoop("reviewer", reReviewBrief, signal, {
								groupId: parentGroupId,
								relationLabel: `re-review round ${round}`,
							}, vision);
							if (!ownsParent()) return;
							chain.push({ ...reviewStep, relation: `re-review round ${round}` });
							lastReviewer = reviewStep.result;
							// A crashed re-review must stop the chain like a crashed worker: its
							// output (if any) is not a verdict, and feeding it to the next fix
							// round would brief the worker from garbage.
							if (!runtime.sessionActive || isFailedResult(reviewStep.result)) break;
							if (reviewVerdict(getResultOutput(reviewStep.result)) === "pass") break;
						}
						// Every parent mutation is guarded by the exact generation, control, and
						// queue controller that started this chain. A parked/resumed generation or
						// destructive stop must make this old orchestration a no-op.
						if (!ownsParent()) return;
						const controlledParent = parentThreadAtStart;
						if (controlledParent.retired || controlledParent.state === "stopped") {
							clearOwnedController();
							removeChainGroup(parentGroupId);
							return;
						}
						// Parking an auto-fix chain aborts its in-flight child but preserves the
						// parent's retained checkpoint and suppresses an aborted chain delivery.
						if (controlledParent.state === "parked") {
							clearOwnedController();
							removeChainGroup(parentGroupId);
							monitor.setRetained(parentRunId, false);
							monitor.setStatus(parentRunId, "parked");
							return;
						}
						// The chain is done (success, exhaustion, or abort): drop the retained
						// parent row and its retained round rows, then deliver one condensed
						// summary. Register the parent's final state (the last chain result)
						// before removal so subagent_wait can resolve it.
						const last = chain[chain.length - 1];
						runtime.registerRunResult(parentRunId, last.result);
						removeChainGroup(parentGroupId);
						monitor.removeRun(parentRunId);
						runtime.retainSession(last.result);
						const parentThread = parentThreadAtStart;
						parentThread.agentName = last.result.agent;
						parentThread.task = last.result.task;
						parentThread.sessionId = last.result.sessionId;
						parentThread.sessionDir = last.result.sessionDir;
						parentThread.state = isFailedResult(last.result) ? "failed" : "completed";
						// The chain outcome settles the parent thread's trajectory: the
						// last chain step is its final state.
						const parentInspection = inspectorStore.get(parentRunId);
						parentInspection.trajectory.append({
							kind: "settled",
							status: parentThread.state === "failed" ? "failed" : "done",
							model: last.result.model,
						});
						parentInspection.retainFrom({
							agent: last.result.agent,
							task: last.result.task,
							model: last.result.model,
							status: parentThread.state === "failed" ? "failed" : "done",
							usage: last.result.usage,
						});
						if (!runtime.sessionActive) {
							clearOwnedController();
							return;
						}
						// One compact message instead of every round's raw output: the summary
						// lines cover each step (verdict + what changed/found), and the final
						// step's full report is appended only when its detail is actionable
						// (a FAIL verdict, a crash, or a model-level failure the main agent
						// must take over). Everything else stays one `subagent_status #id`
						// call away.
						let block = formatChainSummary(chain);
						if (isFailedResult(last.result) && isModelLevelFailure(last.result)) {
							block = `${block}\n\n${formatCompletionBlock(last.result, config.maxResultLines, ctx.cwd)}\n\n${modelLevelTakeoverNote(last.result, { runId: parentRunId })}`;
						} else if (isFailedResult(last.result) || reviewVerdict(getResultOutput(last.result)) === "fail") {
							block = `${block}\n\n${formatCompletionBlock(last.result, config.maxResultLines, ctx.cwd)}`;
						}
						runtime.sendCompletionGroup([
							{
								agent: `auto-fix chain (${last.result.agent})`,
								block,
								triggerTurn: true,
							},
						]);
						runtime.completionBatcher.flush();
						clearOwnedController();
					},
					() => {
						if (!ownsParent()) return;
						const controlledParent = parentThreadAtStart;
						clearOwnedController();
						removeChainGroup(parentGroupId);
						if (controlledParent.state === "parked") {
							monitor.setRetained(parentRunId, false);
							monitor.setStatus(parentRunId, "parked");
							return;
						}
						if (!controlledParent.retired) monitor.removeRun(parentRunId);
					},
					(error) => {
						// A crash inside the chain orchestration (failed runs are caught by
						// launchInLoop and delivered as part of the chain) must not vanish, but
						// an obsolete generation/controller must never publish it.
						if (!ownsParent()) return;
						if (parentThreadAtStart.retired || parentThreadAtStart.state === "stopped") {
							clearOwnedController();
							removeChainGroup(parentGroupId);
							return;
						}
						runtime.registerRunResult(parentRunId, initialReviewerResult);
						removeChainGroup(parentGroupId);
						monitor.removeRun(parentRunId);
						if (!runtime.sessionActive) {
							clearOwnedController();
							return;
						}
						const errorMessage = error instanceof Error ? error.message : String(error);
						try {
							ctx.ui.notify(`✗ auto-fix chain dispatch failed: ${errorMessage}`, "error");
							// Keep the triggering review's findings: the chain crashed before any
							// fix round ran, and the main agent needs the review to act on it.
							runtime.sendCompletionGroup([
								{
									agent: initialReviewerResult.agent,
									block: `${formatCompletionBlock(initialReviewerResult, config.maxResultLines, ctx.cwd)}\n\nAuto-fix chain crashed before completion: ${errorMessage}. The planned fix rounds did not run; the review above is the triggering reviewer's full output.`,
									triggerTurn: true,
								},
							]);
							runtime.completionBatcher.flush();
						} catch {
							/* a second delivery failure must not throw through the queue */
						} finally {
							clearOwnedController();
						}
					},
				);
				runtime.runControllers.set(parentRunId, fixController);
				parentThreadAtStart.queueController = fixController;
				const priorCompletion = parentThreadAtStart.generationCompletion;
				parentThreadAtStart.generationCompletion = Promise.all([
					priorCompletion,
					runtime.backgroundQueue.waitForTask(fixController),
				]).then(() => undefined);
			};

			interface SessionSeed {
				sessionId?: string;
				sessionDir?: string;
				prompt?: string;
				worktree?: WorktreeIsolation;
				forkedFromRunId?: number;
				forkObjective?: string;
				modelPool?: string[];
				thinkingLevel?: SubagentThread["thinkingLevel"];
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
				!thread.retired &&
				thread.lifecycleOperation === "resume" &&
				thread.lifecycleVersion === reservation.version &&
				thread.generation === reservation.generation &&
				thread.sessionId === reservation.sessionId &&
				thread.sessionDir === reservation.sessionDir;

			const startBackground = async (
				agentName: string,
				task: string,
				cwd: string | undefined,
				vision = false,
				isolation: IsolationMode = "shared",
				existingThread?: SubagentThread,
				newObjectiveOnResume = false,
				environment?: DispatchEnvironment,
				seed?: SessionSeed,
				resumeReservation?: ResumeReservation,
			): Promise<SingleResult> => {
				if (existingThread && (!resumeReservation || !ownsResumeReservation(existingThread, resumeReservation))) {
					return failedStartResult(agentName, task, `Run #${existingThread.id} changed while resume was preparing; no new generation was started.`);
				}
				const runCtx = environment?.ctx ?? ctx;
				const runConfig = environment?.config ?? config;
				const runAgents = environment?.agents ?? agents;
				const runSessionRef = environment?.sessionRef ?? sessionRef;
				const agent = runAgents.find((candidate) => candidate.name === agentName);
				if (!agent) return failedStartResult(agentName, task, `Unknown agent: "${agentName}".`);
				if (isolation === "worktree" && !isWorktreeCapableAgent(agent)) {
					return {
						...failedStartResult(agentName, task, `Agent "${agentName}" is read-only; worktree isolation is available only to worker/write-capable agents.`),
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
							originalCwd,
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
								originalCwd,
							};
						}
					}
				}
				const executionCwd = worktree?.cwd ?? originalCwd;
				const resolvedPool = resolveDispatchModelPool(agent, runConfig, runSessionRef, vision);
				const inheritedPool = seed?.modelPool?.filter((ref) => ref.trim().length > 0) ?? [];
				const rawPool = inheritedPool.length > 0
					? {
						agent: { ...agent, model: inheritedPool[0] },
						fallbackModelRefs: inheritedPool.slice(1),
					}
					: resolvedPool;
				// Isolation is a persistent system-level invariant, not a one-shot task
				// prefix: queued retargets, live retargets, resumes, and model fallbacks
				// all keep the same worktree boundary.
				const pool = isolation === "worktree"
					? { ...rawPool, agent: withWorktreeSystemPrompt(rawPool.agent) }
					: rawPool;
				const thinkingLevel = seed?.thinkingLevel ?? runConfig.agentThinkingLevels[agent.name] ?? agent.thinking ?? runConfig.thinkingLevel;
				const modelPool = [pool.agent.model, ...pool.fallbackModelRefs].filter((ref): ref is string => Boolean(ref));
				const priorTask = existingThread?.task;
				const priorSessionId = seed?.sessionId ?? existingThread?.sessionId;
				const priorSessionDir = seed?.sessionDir ?? existingThread?.sessionDir;
				if (existingThread && resumeReservation && !ownsResumeReservation(existingThread, resumeReservation)) {
					return failedStartResult(agentName, task, `Run #${existingThread.id} changed while resume was preparing; no new generation was started.`);
				}
				const runId = existingThread?.id ?? monitor.addRun(agent.name, task, pool.agent.model, thinkingLevel, {
					isolation,
					...(seed?.forkedFromRunId !== undefined ? { forkedFromRunId: seed.forkedFromRunId } : {}),
				});
				const generation = (existingThread?.generation ?? 0) + 1;
				const pending: SingleResult = {
					...queuedResult(pool.agent, task, thinkingLevel),
					runId,
					isolation,
					originalCwd,
					isolationCwd: executionCwd,
					...(isolation === "worktree" ? { integrationStatus: "pending" as const } : {}),
					...(seed?.sessionId && seed.sessionDir
						? { sessionId: seed.sessionId, sessionDir: seed.sessionDir, resumed: true }
						: {}),
					...(seed?.forkedFromRunId !== undefined ? { forkedFromRunId: seed.forkedFromRunId } : {}),
				};
				if (existingThread) {
					monitor.restartRun(runId, agent.name, task, pool.agent.model, thinkingLevel, isolation);
					runtime.settledRuns.delete(runId);
				}

				let thread!: SubagentThread;
				const control = new RpcRunControl(task, generation, (phase) => {
					if (runtime.threads.get(runId)?.generation !== generation || phase === "settled") return;
					// Orchestration transitions are part of the trajectory (retrying →
					// retry event, park/stop → terminal control events).
					const trajectory = inspectorStore.get(runId).trajectory;
					if (phase === "retrying") trajectory.append({ kind: "retry", reason: "retrying" });
					else if (phase === "parked") trajectory.append({ kind: "park" });
					else if (phase === "stopped") trajectory.append({ kind: "stop", reason: control.getStopMessage() });
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

				// Inspector projection for this thread id: on restart the append-only
				// event history is kept (bumped generation), while the bounded
				// transcript starts fresh for the new generation.
				const inspectState = inspectorStore.get(runId);
				if (existingThread) {
					inspectState.trajectory.restart();
					inspectState.transcript.clear();
					inspectState.trajectory.append({
						kind: "resume",
						objective: newObjectiveOnResume ? task : undefined,
					});
				}
				inspectState.retainFrom({ agent: agent.name, task, status: "queued", model: pool.agent.model, thinking: thinkingLevel });
				if (seed?.forkedFromRunId !== undefined) {
					inspectState.trajectory.append({
						kind: "fork",
						sourceRunId: seed.forkedFromRunId,
						childRunId: runId,
						objective: seed.forkObjective,
					});
				}
				inspectState.trajectory.append({
					kind: "dispatch",
					agent: agent.name,
					task,
					model: pool.agent.model,
					thinking: thinkingLevel,
					pool: pool.fallbackModelRefs,
					vision,
					resumed: existingThread !== undefined || seed !== undefined,
					isolation,
					originalCwd,
					isolationCwd: executionCwd,
				});
				if (worktree && worktree !== previousWorktree) {
					inspectState.trajectory.append({
						kind: "worktree",
						status: "created",
						originalCwd,
						isolationCwd: executionCwd,
						worktreePath: worktree.worktreePath,
					});
				}

				if (existingThread) {
					thread = existingThread;
					thread.generation = generation;
					thread.agentName = agent.name;
					thread.task = task;
					thread.cwd = originalCwd;
					thread.executionCwd = executionCwd;
					thread.vision = vision;
					thread.modelPool = modelPool;
					thread.thinkingLevel = thinkingLevel;
					thread.isolation = isolation;
					thread.worktree = worktree;
					thread.state = "queued";
					thread.control = control;
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
						vision,
						modelPool,
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
						`✗ worker worktree ${finalization.integrated ? "cleanup" : "integration"} failed${paths ? ` · retained ${paths}` : ""}: ${finalization.error ?? "unknown Git integration error"}`,
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
					inspectState.trajectory.append({
						kind: "worktree",
						status: finalization.status,
						originalCwd: thread.cwd,
						isolationCwd: thread.executionCwd,
						worktreePath: finalization.worktreePath,
						patchPath: finalization.patchPath,
						integrated: finalization.integrated,
						error: finalization.error,
					});
					if (result) {
						result.runId = runId;
						result.isolation = "worktree";
						result.originalCwd = thread.cwd;
						result.isolationCwd = thread.executionCwd;
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
						runtime.retainWorktreeArtifacts(finalization);
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

				const discardUnusedWorktree = async (candidate: WorktreeIsolation | undefined): Promise<void> => {
					if (!candidate) return;
					if (candidate.discard) {
						await candidate.discard().catch(() => undefined);
						return;
					}
					// Compatibility for externally supplied/test handles. Production handles
					// expose discard(), so this fallback never integrates a seeded worktree.
					if (candidate.state === "active") await candidate.finalize().catch(() => undefined);
				};

				const createContinuationWorktree = async (
					source: WorktreeIsolation,
					seedIsIntegrated: boolean,
				): Promise<WorktreeIsolation> => {
					if (source.state === "finalizing") {
						throw new Error(`Run #${runId}'s worktree is still finalizing.`);
					}
					const seedPatch = source.snapshotChanges
						? await source.snapshotChanges()
						: undefined;
					return createWorktreeIsolation(thread.cwd, {
						seedPatch,
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
							const seedAlreadyIntegrated = thread.worktree.state === "integrated" || thread.lastResult?.integrationApplied === true;
							continuationWorktree = await createContinuationWorktree(thread.worktree, seedAlreadyIntegrated);
							seed = { worktree: continuationWorktree };
							if (previousSessionId && previousSessionDir) {
								clonedSession = await forkRetainedSession({
									cwd: previousExecutionCwd,
									targetCwd: continuationWorktree.cwd,
									sessionDir: previousSessionDir,
									sessionId: previousSessionId,
								});
								runtime.sessionDirs.add(clonedSession.sessionDir);
								seed.sessionId = clonedSession.sessionId;
								seed.sessionDir = clonedSession.sessionDir;
							}
						}

						const currentConfig = await loadConfig(runtime.configPath);
						runtime.backgroundQueue.setConcurrency(currentConfig.maxConcurrency);
						const currentAgents = discoverAgents(currentCtx.cwd, {
							scope: currentConfig.agentScope,
							enabledNames: currentConfig.enabledAgents,
						}).agents;
						const nextTask = requestedObjective ?? thread.task;
						const pending = await startBackground(
							thread.agentName,
							nextTask,
							thread.cwd,
							thread.vision,
							thread.isolation,
							thread,
							objective !== undefined,
							{
								ctx: currentCtx,
								config: currentConfig,
								agents: currentAgents,
								sessionRef: currentModelRef(currentCtx),
							},
							seed,
							reservation,
						);
						if (pending.exitCode !== -1) {
							if (clonedSession) {
								runtime.sessionDirs.delete(clonedSession.sessionDir);
								await rm(clonedSession.sessionDir, { recursive: true, force: true }).catch(() => undefined);
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
							runtime.sessionDirs.delete(clonedSession.sessionDir);
							await rm(clonedSession.sessionDir, { recursive: true, force: true }).catch(() => undefined);
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

					// Same lifecycle CAS as resume: a concurrent resume/fork cannot consume
					// or clone this session while the branch copy is in progress.
					const forkVersion = ++thread.lifecycleVersion;
					const forkGeneration = thread.generation;
					const forkSessionId = thread.sessionId;
					const forkSessionDir = thread.sessionDir;
					const ownsFork = (): boolean =>
						!thread.retired &&
						thread.lifecycleOperation === "fork" &&
						thread.lifecycleVersion === forkVersion &&
						thread.generation === forkGeneration &&
						thread.sessionId === forkSessionId &&
						thread.sessionDir === forkSessionDir;
					thread.lifecycleOperation = "fork";
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
							const seedAlreadyIntegrated = thread.worktree.state === "integrated" || thread.lastResult?.integrationApplied === true;
							childWorktree = await createContinuationWorktree(thread.worktree, seedAlreadyIntegrated);
						}
						forkedSession = await forkRetainedSession({
							cwd: thread.executionCwd,
							targetCwd: childWorktree?.cwd ?? thread.cwd,
							sessionDir: thread.sessionDir,
							sessionId: thread.sessionId,
						});
						runtime.sessionDirs.add(forkedSession.sessionDir);
						const currentConfig = await loadConfig(runtime.configPath);
						runtime.backgroundQueue.setConcurrency(currentConfig.maxConcurrency);
						const currentAgents = discoverAgents(thread.cwd, {
							scope: currentConfig.agentScope,
							enabledNames: currentConfig.enabledAgents,
						}).agents;
						if (!ownsFork()) throw new Error(`Run #${runId} changed while fork was preparing; no child was started.`);
						const childTask = forkObjective ?? thread.task;
						const child = await startBackground(
							thread.agentName,
							childTask,
							thread.cwd,
							thread.vision,
							thread.isolation,
							undefined,
							false,
							{
								ctx: currentCtx,
								config: currentConfig,
								agents: currentAgents,
								sessionRef: currentModelRef(currentCtx),
							},
							{
								sessionId: forkedSession.sessionId,
								sessionDir: forkedSession.sessionDir,
								prompt: forkObjective ?? FORK_CONTINUATION_PROMPT,
								worktree: childWorktree,
								forkedFromRunId: runId,
								forkObjective,
								modelPool: [...thread.modelPool],
								thinkingLevel: thread.thinkingLevel,
							},
						);
						if (child.exitCode !== -1 || child.runId === undefined) {
							runtime.sessionDirs.delete(forkedSession.sessionDir);
							await rm(forkedSession.sessionDir, { recursive: true, force: true }).catch(() => undefined);
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
						inspectorStore.get(runId).trajectory.append({
							kind: "fork",
							sourceRunId: runId,
							childRunId,
							objective: forkObjective,
						});
						const sourceResult = runtime.settledRuns.get(runId) ?? thread.lastResult;
						if (sourceResult) sourceResult.forkChildRunIds = [...thread.forkChildRunIds];
						return child;
					} catch (error) {
						if (forkedSession) {
							runtime.sessionDirs.delete(forkedSession.sessionDir);
							await rm(forkedSession.sessionDir, { recursive: true, force: true }).catch(() => undefined);
						}
						await discardUnusedWorktree(childWorktree);
						return failedStartResult(
							thread.agentName,
							forkObjective ?? thread.task,
							`Could not fork retained session for run #${runId}: ${error instanceof Error ? error.message : String(error)}`,
						);
					} finally {
						if (thread.lifecycleVersion === forkVersion && thread.lifecycleOperation === "fork") {
							thread.lifecycleOperation = undefined;
						}
					}
				};

				const onLive = makeLiveHandler(runId, runId, generation);
				const onRecord = makeRecordHandler(runId, generation);
				const queueController = runtime.backgroundQueue.enqueue(
					async (backgroundSignal) => {
						if (runtime.threads.get(runId)?.generation !== generation) return;
						let result: SingleResult;
						try {
							result = await runSingleAgentWithModelFallback(
								{
									defaultCwd: executionCwd,
									agent: pool.agent,
									agentName,
									task,
									cwd: executionCwd,
									thinkingLevel,
									signal: backgroundSignal,
									onLive,
									onRecord,
									control,
									makeDetails: makeDetails("single", true),
									idleTimeoutMs: runConfig.idleTimeoutSec * 1000,
									...(priorSessionId && priorSessionDir
										? {
											sessionId: priorSessionId,
											sessionDir: priorSessionDir,
											stdinText: seed?.prompt ?? (newObjectiveOnResume
												? task
												: buildResumePrompt(priorTask ?? task, buildFallbackResumeReason())),
										}
										: {}),
								},
								pool.fallbackModelRefs,
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
						result.isolation = isolation;
						result.originalCwd = originalCwd;
						result.isolationCwd = executionCwd;
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

						if (result.parked) {
							thread.state = "parked";
							monitor.setStatus(runId, "parked");
							const parkedRun = monitor.findRun(runId);
							if (parkedRun) inspectState.retainFrom({ ...parkedRun, task: result.task, usage: result.usage });
							runtime.settledRuns.delete(runId);
							return;
						}

						if (thread.retireOnSettle) runtime.retireThreadSession(thread);
						const wantsFixLoop = shouldTriggerFixLoop(result, runConfig);
						if (wantsFixLoop && isolation === "shared" && runtime.sessionActive) {
							thread.state = "running";
							finishRun(runId, "done", { silent: true, retain: true });
							monitor.setAnnotation(runId, "auto-fix chain running");
							startFixLoop(result, `fix-${runId}`, runId, vision);
							return;
						}
						// Worktree isolation is rejected for reviewers, the only role that can
						// trigger auto-fix. Keep that invariant explicit: an isolated result is
						// finalized once here and can never start a chain that would integrate
						// the same worktree early.
						await thread.finalizeIsolation(generation, result);
						const failed = isFailedResult(result);
						const stopped = thread.retireOnSettle === true;
						thread.state = stopped ? "stopped" : failed ? "failed" : "completed";
						// Stamp the terminal monitor state before projecting it. This gives every
						// path a fixed endedAt even when the row is removed immediately.
						monitor.setStatus(runId, stopped || failed ? "failed" : "done");
						inspectState.trajectory.append({
							kind: "settled",
							status: stopped ? "stopped" : failed ? "failed" : "done",
							model: result.model,
							isolation,
							...(result.integrationStatus && result.integrationStatus !== "pending"
								? { integrationStatus: result.integrationStatus }
								: {}),
						});
						const terminalRun = monitor.findRun(runId);
						inspectState.retainFrom(terminalRun
							? { ...terminalRun, task: result.task, model: result.model ?? terminalRun.model, usage: result.usage }
							: {
								agent: pool.agent.name,
								task: result.task,
								model: result.model,
								thinking: thinkingLevel,
								status: stopped || failed ? "failed" : "done",
								endedAt: inspectState.trajectory.summary().endedAt,
								usage: result.usage,
							});
						if (!runtime.sessionActive) return;

						const modelLevel = failed && isModelLevelFailure(result);
						const dispatchFailed = result.dispatchFailed === true;
						finishRun(runId, stopped || failed ? "failed" : "done", modelLevel || dispatchFailed ? { silent: true } : undefined);
						runtime.registerRunResult(runId, result);
						const completion: CompletionMessageItem = {
							agent: result.agent,
							block: modelLevel
								? `${formatCompletionBlock(result, runConfig.maxResultLines, runCtx.cwd)}\n\n${modelLevelTakeoverNote(result, { runId })}`
								: formatCompletionBlock(result, runConfig.maxResultLines, runCtx.cwd),
							triggerTurn: completionTriggersTurn(result, runConfig.notifyOnReviewPass),
						};
						if (modelLevel) {
							runCtx.ui.notify(`✗ ${result.agent} dispatch failed: model unavailable or broken — task handed to the main window`, "error");
						} else if (dispatchFailed) {
							runCtx.ui.notify(`✗ ${result.agent} dispatch failed: ${result.errorMessage ?? "dispatch crashed"}`, "error");
						}
						if (failed) {
							runtime.sendCompletionGroup([completion]);
							runtime.completionBatcher.flush();
						} else {
							runtime.completionBatcher.push(completion);
						}
					},
					() => {
						if (runtime.threads.get(runId)?.generation !== generation) return;
						runtime.runControllers.delete(runId);
						thread.queueController = undefined;
						if (thread.state === "parked") {
							monitor.setStatus(runId, "parked");
							return;
						}
						thread.state = "stopped";
						monitor.setStatus(runId, "failed");
						inspectState.trajectory.append({ kind: "settled", status: "stopped", model: monitor.findRun(runId)?.model, isolation });
						const stoppedRun = monitor.findRun(runId);
						if (stoppedRun) inspectState.retainFrom(stoppedRun);
						if (!runtime.sessionActive) {
							monitor.removeRun(runId);
							return;
						}
						finishRun(runId, "failed");
					},
					async (error) => {
						if (runtime.threads.get(runId)?.generation !== generation) return;
						const crashed: SingleResult = {
							...dispatchFailedResult(pool.agent, control.getObjective(), error, thinkingLevel),
							runId,
							isolation,
							originalCwd,
							isolationCwd: executionCwd,
							forkedFromRunId: thread.forkedFromRunId,
						};
						await thread.finalizeIsolation(generation, crashed);
						thread.state = "failed";
						monitor.setStatus(runId, "failed");
						inspectState.trajectory.append({
							kind: "settled",
							status: "failed",
							model: crashed.model,
							isolation,
							...(crashed.integrationStatus && crashed.integrationStatus !== "pending"
								? { integrationStatus: crashed.integrationStatus }
								: {}),
						});
						const crashedRun = monitor.findRun(runId);
						if (crashedRun) inspectState.retainFrom({ ...crashedRun, usage: crashed.usage });
						finishRun(runId, "failed", { silent: true });
						runtime.registerRunResult(runId, crashed);
						runtime.runControllers.delete(runId);
						thread.queueController = undefined;
						if (!runtime.sessionActive) return;
						try {
							runCtx.ui.notify(`✗ ${agent.name} dispatch failed: ${crashed.errorMessage}`, "error");
							runtime.sendCompletionGroup([
								{
									agent: agent.name,
									block: formatCompletionBlock(crashed, runConfig.maxResultLines, runCtx.cwd),
									triggerTurn: true,
								},
							]);
							runtime.completionBatcher.flush();
						} catch {
							/* a second delivery failure must not throw through the queue */
						}
					},
				);
				thread.queueController = queueController;
				thread.generationCompletion = runtime.backgroundQueue.waitForTask(queueController);
				runtime.runControllers.set(runId, queueController);
				return pending;
			};

			// Sub-agents intentionally detach from the foreground turn. This makes the
			// editor available immediately; completion messages later wake the main agent.
			if (params.tasks && params.tasks.length > 0) {
				if (params.tasks.length > config.maxConcurrency) {
					return {
						content: [
							{
								type: "text",
								text: `Too many parallel tasks (${params.tasks.length}). Max is ${config.maxConcurrency} (configurable via /subagents-setup).`,
							},
						],
						details: makeDetails("parallel", true)([]),
					};
				}

				const results: SingleResult[] = [];
				// Preserve caller order (and deterministic completion batching) while
				// preparing each isolated filesystem before its queue entry can start.
				for (const item of params.tasks) {
					results.push(await startBackground(
						item.agent,
						item.task,
						item.cwd,
						item.vision === true,
						defaultIsolationMode("parallel", item.agent, item.isolation as IsolationMode | undefined),
					));
				}
				const started = results.filter((result) => result.exitCode === -1).length;
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
					`Started ${started} background subagent${started === 1 ? "" : "s"}. Results will automatically resume the main agent when ready.`,
					...(failureLines.length > 0
						? [`${failureLines.length} task${failureLines.length === 1 ? "" : "s"} failed before launch:`, ...failureLines]
						: []),
				].join("\n");
				return {
					content: [{ type: "text", text }],
					details: makeDetails("parallel", true)(results),
					terminate: true,
				};
			}

			const result = await startBackground(
				params.agent as string,
				params.task as string,
				params.cwd,
				params.vision === true,
				defaultIsolationMode("single", params.agent as string, params.isolation as IsolationMode | undefined),
			);
			if (result.exitCode !== -1) {
				throw new Error(getResultOutput(result));
			}
			return {
				content: [{ type: "text", text: `Started ${result.agent} in the background. Its result will automatically resume the main agent when ready.` }],
				details: makeDetails("single", true)([result]),
				terminate: true,
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
				const model = `${r.model ?? "?"}${r.modelFallbackFrom ? ` (pool fallback from ${r.modelFallbackFrom})` : ""}`;
				const isolation = r.isolation === "worktree" ? ` · worktree ${r.integrationStatus ?? "active"}` : "";
				const line = `${theme.fg("toolTitle", theme.bold("subagent "))}${icon} ${theme.fg("accent", r.agent)} ${theme.fg("dim", `· ${model}${r.thinking ? ` · thinking ${r.thinking}` : ""}${isolation}${pending ? " · background" : ""}${usage ? ` · ${usage}` : ""}`)}`;
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
				const model = `${r.model ?? "?"}${r.modelFallbackFrom ? ` (pool fallback from ${r.modelFallbackFrom})` : ""}`;
				const isolation = r.isolation === "worktree" ? ` · worktree ${r.integrationStatus ?? "active"}` : "";
				lines.push(`  ${icon} ${theme.fg("accent", r.agent)} ${theme.fg("dim", `· ${model}${r.thinking ? ` · thinking ${r.thinking}` : ""}${isolation}${pending ? " · background" : ""}${usage ? ` · ${usage}` : ""}`)}`);
			}
			return new Text(lines.join("\n"), 0, 0);
		},
	});
}
