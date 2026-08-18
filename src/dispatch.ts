/**
 * The `subagent` tool: dispatches explore/worker/cleaner/reviewer agents as isolated pi
 * child processes, single or parallel. Owns the dispatch pipeline: config load,
 * per-agent selected→main model routing, per-run status tracking, the auto-fix chain
 * (REVIEW_FAIL → worker → re-review), and completion delivery.
 *
 * Vision: a task flagged `vision: true` uses the configured vision model, then
 * hands directly to the current main-window model on model/provider failure.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { existsSync } from "node:fs";
import { realpath, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { Type } from "typebox";
import { discoverAgents, type AgentConfig } from "./agents.ts";
import {
	completionTriggersTurn,
	type CompletionMessageItem,
} from "./completion.ts";
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
	formatUsage,
	modelLevelTakeoverNote,
	queuedResult,
} from "./format.ts";
import {
	buildFixTaskBrief,
	buildReReviewBrief,
	formatChainSummary,
	shouldTriggerFixLoop,
	type ChainStep,
} from "./fixloop.ts";
import {
	availableModelsInScope,
	currentModelRef,
	findModelByRef,
	modelRef,
	resolveAgentModelRoute,
	resolveThinkingLevel,
} from "./models.ts";
import {
	formatTaskSummary,
	formatToolActivity,
	monitor,
	statusIcon,
	type RunChainMeta,
} from "./monitor.ts";
import type { SubagentRuntime, SubagentThread, ThreadState } from "./runtime.ts";
import { persistRecoveryRecords, recoveryRecordFromFinalization } from "./recovery.ts";
import { forkRetainedSession } from "./session-fork.ts";
import {
	buildResumePrompt,
	RpcRunControl,
	getResultOutput,
	isFailedResult,
	isModelLevelFailure,
	reviewVerdict,
	runSingleAgentWithMainFallback,
	type SingleResult,
	type SubagentDetails,
	type SubagentLiveEvent,
} from "./spawn.ts";
import {
	createWorktreeIsolation,
	resolveWorktreeTarget,
	type IsolationMode,
	type WorktreeFinalization,
	type WorktreeIsolation,
} from "./worktree.ts";

const NON_BLANK_TASK_OPTIONS = { minLength: 1, pattern: "\\S" } as const;
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

interface DispatchEnvironment {
	ctx: ExtensionContext;
	config: SubagentsConfig;
	agents: AgentConfig[];
}

const VISION_DESCRIPTION =
	"Set true when the task may require viewing images (screenshots, mockups, designs) — the configured vision model is used first, then model-level failures hand directly to the current main-window model";

const ISOLATION_DESCRIPTION =
	"Filesystem isolation: shared uses the caller's working tree; worktree creates a detached temporary Git worktree (write-capable agents, including worker and cleaner, only)";

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

const autoFixRootTails = new Map<string, Promise<void>>();

async function canonicalAutoFixRoot(cwd: string): Promise<string> {
	try {
		return (await resolveWorktreeTarget(cwd)).originalRoot;
	} catch {
		try {
			return await realpath(resolve(cwd));
		} catch {
			return resolve(cwd);
		}
	}
}

/** Keep the complete worker→review loop exclusive for one canonical repository.
 * Child processes have independent file-mutation queues, so queue concurrency
 * alone cannot make shared-checkout edits safe. */
function serializeAutoFixChain(
	cwd: string,
	task: (signal: AbortSignal) => Promise<void>,
): (signal: AbortSignal) => Promise<void> {
	return async (signal) => {
		if (signal.aborted) return;
		const root = await canonicalAutoFixRoot(cwd);
		const key = process.platform === "win32" ? root.toLowerCase() : root;
		const previous = autoFixRootTails.get(key) ?? Promise.resolve();
		let release!: () => void;
		const gate = new Promise<void>((resolveGate) => {
			release = resolveGate;
		});
		const tail = previous.catch(() => undefined).then(() => gate);
		autoFixRootTails.set(key, tail);
		await previous.catch(() => undefined);
		try {
			if (!signal.aborted) await task(signal);
		} finally {
			release();
			if (autoFixRootTails.get(key) === tail) autoFixRootTails.delete(key);
		}
	};
}

interface DispatchModelRoute {
	agent: AgentConfig;
	mainFallbackRef?: string;
	thinkingLevel: ThinkingLevel;
	thinkingLevelForModel: (ref?: string) => ThinkingLevel;
}

function resolveDispatchModelRoute(
	agent: AgentConfig,
	config: SubagentsConfig,
	ctx: ExtensionContext,
	vision: boolean,
): DispatchModelRoute {
	const availableModels = availableModelsInScope(ctx);
	const mainRef = currentModelRef(ctx);
	const route = resolveAgentModelRoute({
		selectedRef: vision ? config.visionModel : config.agentModels[agent.name],
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

export function registerSubagentTool(pi: ExtensionAPI, runtime: SubagentRuntime): void {
	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: [
			"Delegate a discrete, self-contained task to a specialized sub-agent running in an ISOLATED context window.",
			"Built-in roles (only configured enabled agents can dispatch): explore (read-only codebase recon), worker (implement/fix/refactor/test, full tools), cleaner (explicit evidence-first cleanup, full/write tools), reviewer (adversarial pre-commit gate, read-only).",
			"When cleaner is enabled, route explicit cleanup intent in any language (for example dead code, redundancy, simplification, or over-engineering), including a requested periodic cleanup pass. Audit/find/inspect/report is read-only evidence, while explicit remove/clean/simplify/refactor permits verified edits. Generic code review goes to reviewer. Never route cleaner by PR count or as the pre-commit gate; reviewer reviews its edits.",
			"Modes: single ({agent, task}) or parallel ({tasks: [{agent, task}, ...]}).",
			"Isolation: single tasks default to shared; parallel worker tasks default to detached Git worktrees unless isolation: shared is explicit. Cleaner is write-capable and can opt into worktree isolation; explore/reviewer cannot use it.",
			"Use subagent_control to steer, retarget, park, resume, or fork a thread by its stable run id.",
			"It starts agents in the background and immediately returns control to the main window; completion messages automatically wake the main agent to continue.",
			"Each agent has no memory of this conversation — brief it fully (goal, exact paths, constraints, expected output).",
			"Results arrive as wake-up messages automatically — you do NOT need to wait. If you must get a result in-turn, subagent_wait is a non-blocking lookup by default (pass timeoutMs to block).",
			"Vision: set vision: true when the task may require viewing images (screenshots, mockups, design files — e.g. frontend work) — the configured vision model is used first, then model-level failures hand directly to the current main-window model.",
		].join(" "),
		promptSnippet:
			"Start background subagents: explore (read-only search), worker (implement), cleaner (explicit evidence-first cleanup), reviewer (pre-commit review); completion automatically resumes the main agent. Simple tasks: use direct tools, not subagents.",
		promptGuidelines: [
			"Delegate only when an isolated context genuinely pays: broad exploration, a self-contained implementation, explicit evidence-first cleanup, or a review gate. Handle simple lookups and one-line edits inline with direct tools — never spawn a sub-agent for them.",
			"Use subagent with agent 'explore' for broad or open-ended code search before large changes; a targeted 'where is X' is a direct grep/read.",
			"Treat explore output as a retrieval index, not authority: re-read load-bearing files before editing or deciding deletion, security, compatibility, persistence, or dynamic reachability. The cheapest model can cost more through rework on complex dynamic, concurrent, migration, or security-sensitive code; choose a stronger model or specialist there.",
			"Use subagent with agent 'worker' for a self-contained implementation task worth a separate context; it plans internally.",
			"When cleaner is enabled, use subagent with agent 'cleaner' only for explicit cleanup intent in any language (for example dead code, redundancy, simplification, or over-engineering) or a requested periodic cleanup pass. Audit/find/inspect/report means read-only ranked evidence; apply only for explicit remove/clean/simplify/refactor wording. Generic code review goes to reviewer. Never trigger cleaner from PR count or as a pre-commit gate; send non-trivial cleaner edits to reviewer.",
			"Use subagent with agent 'reviewer' for the fresh read-only gate before reporting non-trivial work done or committing, including after cleaner edits.",
			"subagent launches work in the background and ends the current turn; when a result arrives, the main agent is automatically resumed with it.",
			"Run independent tasks in parallel by passing a tasks array to subagent; parallel worker items default to isolation: worktree so their edits are integrated independently. Pass isolation: shared only when workers intentionally need the caller's live uncommitted tree.",
			"Use isolation: worktree only for worker, cleaner, or another write-capable agent and only inside a Git repository with a committed HEAD; parallel worker tasks default to worktree, while cleaner must opt in. Setup or integration failures never silently fall back to shared.",
			"NEVER sleep or poll, and do NOT call subagent_wait to hold the turn — subagent ends the turn immediately and the result arrives as a message that wakes you automatically (even mid-turn). Ending your turn is the default and the only correct way to wait.",
			"If you must keep the turn for a result, call subagent_wait with an explicit timeoutMs (non-blocking by default) — never bash sleep/timeout to wait for a sub-agent.",
			"When a delegated task may require viewing images (frontend screenshots, mockups, design comparisons), pass vision: true and give the sub-agent the exact image paths — it reads them with its read tool. The configured vision model is used first; model-level failures hand directly to the current main-window model.",
			"When a sub-agent result arrives it is already shown to the user — do NOT restate, paraphrase, or summarize it; reply with only your own conclusion or next action (often just one line), since duplicating the result wastes tokens for nothing.",
		],
		parameters: SubagentParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			monitor.beginTurn();
			const config = await loadConfig(runtime.configPath);
			// Pick up concurrency changes from /subagents-setup without a restart.
			runtime.backgroundQueue.setConcurrency(config.maxConcurrency);

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
				ctx.ui.notify(`${icon} ${monitor.summarize(run)}`, status === "done" ? "info" : "error");
			};

			// Live sub-agent activity → concise one-line status ("thinking",
			// "read src/index.ts", ...), never a raw args blob. The live handler
			// only updates monitor state; finishing (removeRun + notify) is owned
			// by the queue task / launchInLoop. That keeps a startup retry —
			// which fires a transient "failed" status before relaunching — from
			// ripping the row out early, and lets the queue task decide between
			// delivering a reviewer's result and starting an auto-fix chain.
			const makeLiveHandler =
				(runId: number, generation?: number) =>
				(e: SubagentLiveEvent): void => {
					if (generation !== undefined && runtime.threads.get(runId)?.generation !== generation) return;
					switch (e.kind) {
						case "status":
							// Only update monitor status here. Finishing (removeRun + notify) is
							// owned by the queue task / launchInLoop so that a startup retry — which
							// fires a transient "failed" status before relaunching the child — never
							// rips the row out from under the retry or emits a premature "✗" toast.
							monitor.setStatus(runId, e.status);
							break;
						case "model":
							monitor.setModel(runId, e.model, e.fallbackFrom);
							monitor.setThinking(runId, e.thinking);
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
				};

			const discovery = discoverAgents(ctx.cwd, {
				scope: config.agentScope,
				enabledNames: config.enabledAgents,
				projectTrusted: ctx.isProjectTrusted?.() === true,
			});
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
			 * Dispatch one agent inside an auto-fix chain: tracked in monitor state with a
			 * groupId/relationLabel, but NOT delivered through the completion flow — the
			 * chain owner assembles and delivers the whole group at the end.
			 */
			const launchInLoop = async (
				agentName: string,
				task: string,
				executionCwd: string,
				signal: AbortSignal,
				meta: RunChainMeta,
				vision = false,
			): Promise<{ runId?: number; result: SingleResult }> => {
				const agent = agents.find((candidate) => candidate.name === agentName);
				if (!agent) return { result: failedStartResult(agentName, task, `Unknown agent: "${agentName}".`) };
				// Vision chains use the vision override first; every model-level failure
				// hands directly to the current main model with re-clamped thinking.
				const route = resolveDispatchModelRoute(agent, config, ctx, vision);
				const thinkingLevel = route.thinkingLevel;
				const runId = monitor.addRun(agent.name, task, route.agent.model, thinkingLevel, meta);
				const onLive = makeLiveHandler(runId);
				try {
					const result = await runSingleAgentWithMainFallback(
						{
							defaultCwd: executionCwd,
							cwd: executionCwd,
							agent: route.agent,
							agentName,
							task,
							thinkingLevel,
							thinkingLevelForModel: route.thinkingLevelForModel,
							signal,
							onLive,
							makeDetails: makeDetails("single", true),
							idleTimeoutMs: config.idleTimeoutSec * 1000,
						},
						route.mainFallbackRef,
					);
					result.runId = runId;
					result.projectCwd = executionCwd;
					result.isolation = "shared";
					runtime.retainSession(result);
					monitor.setModel(runId, result.model, result.modelFallbackFrom);
					monitor.setThinking(runId, result.thinking);
					// The parent row represents the chain. Internal rounds leave live
					// status as soon as they settle; their reports remain addressable by id.
					finishRun(runId, isFailedResult(result) ? "failed" : "done", { silent: true });
					runtime.registerRunResult(runId, result);
					return { runId, result };
				} catch (error) {
					finishRun(runId, "failed", { silent: true });
					const errorMessage = error instanceof Error ? error.message : String(error);
					const crashed: SingleResult = {
						...queuedResult(route.agent, task, thinkingLevel),
						runId,
						projectCwd: executionCwd,
						isolation: "shared",
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
			 * The triggering reviewer stays in monitor state until the chain resolves.
			 */
			/** Drop any in-flight monitor row belonging to an auto-fix chain; the
			 * parent is removed separately (it does not carry the groupId). */
			const removeChainGroup = (groupId: string): void => {
				for (const run of [...monitor.getRuns()]) {
					if (run.groupId === groupId) monitor.removeRun(run.id);
				}
			};

			const startFixLoop = (
				initialReviewerResult: SingleResult,
				parentGroupId: string,
				parentRunId: number,
				executionCwd: string,
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
					serializeAutoFixChain(executionCwd, async (signal) => {
						if (!ownsParent()) return;
						// The parent id belongs to the stable logical thread and will point at
						// the chain outcome. Archive the triggering review under its own id so
						// every id advertised by the chain summary resolves to that exact step.
						const initialStepRunId = monitor.reserveRunId();
						const initialStepResult: SingleResult = {
							...initialReviewerResult,
							runId: initialStepRunId,
						};
						runtime.registerRunResult(initialStepRunId, initialStepResult);
						const chain: ChainStep[] = [
							{ runId: initialStepRunId, result: initialStepResult, relation: "initial review" },
						];
						let lastReviewer = initialStepResult;
						for (let round = 1; round <= config.maxFixRounds; round++) {
							if (!runtime.sessionActive) break;
							const fixBrief = buildFixTaskBrief(lastReviewer, round, config.maxFixRounds);
							const workerStep = await launchInLoop("worker", fixBrief, executionCwd, signal, {
								groupId: parentGroupId,
								relationLabel: `fix round ${round}`,
							}, vision);
							// Preserve the newest sub-step before checking chain ownership. A
							// destructive stop invalidates ownsParent() while this child is
							// aborting, and its partial output must become the parent's stopped
							// result instead of falling back to the old triggering review.
							if (
								runtime.threads.get(parentRunId) === parentThreadAtStart &&
								parentThreadAtStart.generation === parentGeneration
							) {
								parentThreadAtStart.lastResult = workerStep.result;
								parentThreadAtStart.agentName = workerStep.result.agent;
								parentThreadAtStart.task = workerStep.result.task;
								parentThreadAtStart.sessionId = workerStep.result.sessionId;
								parentThreadAtStart.sessionDir = workerStep.result.sessionDir;
								runtime.retainSession(workerStep.result);
							}
							if (!ownsParent()) return;
							chain.push({ ...workerStep, relation: `fix round ${round}` });
							if (!runtime.sessionActive || isFailedResult(workerStep.result)) break;
							const reReviewBrief = buildReReviewBrief(lastReviewer, round);
							const reviewStep = await launchInLoop("reviewer", reReviewBrief, executionCwd, signal, {
								groupId: parentGroupId,
								relationLabel: `re-review round ${round}`,
							}, vision);
							if (
								runtime.threads.get(parentRunId) === parentThreadAtStart &&
								parentThreadAtStart.generation === parentGeneration
							) {
								parentThreadAtStart.lastResult = reviewStep.result;
								parentThreadAtStart.agentName = reviewStep.result.agent;
								parentThreadAtStart.task = reviewStep.result.task;
								parentThreadAtStart.sessionId = reviewStep.result.sessionId;
								parentThreadAtStart.sessionDir = reviewStep.result.sessionDir;
								runtime.retainSession(reviewStep.result);
							}
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
						// parent's checkpoint and suppresses an aborted chain delivery.
						if (controlledParent.state === "parked") {
							clearOwnedController();
							removeChainGroup(parentGroupId);
							monitor.setStatus(parentRunId, "parked");
							return;
						}
						// The chain is done (success, exhaustion, or abort): drop its monitor
						// rows, then deliver one condensed
						// summary. Register the parent's final state (the last chain result)
						// before removal so subagent_wait can resolve it. Clone instead of
						// mutating: the internal step remains addressable under its own run id.
						const last = chain[chain.length - 1];
						const parentResult: SingleResult = {
							...last.result,
							runId: parentRunId,
						};
						runtime.registerRunResult(parentRunId, parentResult);
						removeChainGroup(parentGroupId);
						monitor.removeRun(parentRunId);
						runtime.retainSession(parentResult);
						const parentThread = parentThreadAtStart;
						parentThread.lastResult = parentResult;
						parentThread.agentName = last.result.agent;
						parentThread.task = last.result.task;
						parentThread.sessionId = last.result.sessionId;
						parentThread.sessionDir = last.result.sessionDir;
						parentThread.state = isFailedResult(last.result) ? "failed" : "completed";
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
							block = `${block}\n\n${formatCompletionBlock(last.result, config.maxResultLines, executionCwd)}\n\n${modelLevelTakeoverNote(last.result, { runId: parentRunId })}`;
						} else if (isFailedResult(last.result) || reviewVerdict(getResultOutput(last.result)) === "fail") {
							block = `${block}\n\n${formatCompletionBlock(last.result, config.maxResultLines, executionCwd)}`;
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
					}),
					() => {
						if (!ownsParent()) return;
						const controlledParent = parentThreadAtStart;
						clearOwnedController();
						removeChainGroup(parentGroupId);
						if (controlledParent.state === "parked") {
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
									block: `${formatCompletionBlock(initialReviewerResult, config.maxResultLines, executionCwd)}\n\nAuto-fix chain crashed before completion: ${errorMessage}. The planned fix rounds did not run; the review above is the triggering reviewer's full output.`,
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
				vision = false,
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
				const resolvedRoute = resolveDispatchModelRoute(agent, runConfig, runCtx, vision);
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
					thread.vision = vision;
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
						vision,
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
							thread.vision,
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
							thread.vision,
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
								forkObjective,
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
							startFixLoop(result, `fix-${runId}`, runId, thread.executionCwd, vision);
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
					`Started ${started} background subagent${started === 1 ? "" : "s"}: ${startedRefs.join(", ")}. Results will automatically resume the main agent when ready.`,
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
			const runRef = result.runId === undefined ? result.agent : `#${result.runId} ${result.agent}`;
			return {
				content: [{ type: "text", text: `Started ${runRef} in the background. Its result will automatically resume the main agent when ready.` }],
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
