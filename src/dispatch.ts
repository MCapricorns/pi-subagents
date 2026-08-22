/**
 * The `subagent` tool: dispatches explore/worker/cleaner/reviewer agents as isolated pi
 * child processes, single or parallel. Owns the public dispatch contract,
 * per-run status tracking, the auto-fix chain (REVIEW_FAIL → worker → re-review),
 * and completion delivery. Stable thread generations live in thread-lifecycle.ts.
 *
 * Vision: a task flagged `vision: true` uses the configured vision model, then
 * hands directly to the current main-window model on model/provider failure.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { Type } from "typebox";
import { discoverAgents } from "./agents.ts";
import { loadConfig } from "./config.ts";
import {
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
	type ChainStep,
} from "./fixloop.ts";
import {
	formatTaskSummary,
	formatToolActivity,
	monitor,
	statusIcon,
	sumUsage,
	type RunChainMeta,
} from "./monitor.ts";
import type { SubagentRuntime } from "./runtime.ts";
import {
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
	createBackgroundDispatcher,
	resolveDispatchModelRoute,
} from "./thread-lifecycle.ts";
import { resolveWorktreeTarget, type IsolationMode } from "./worktree.ts";

export { FORK_CONTINUATION_PROMPT, isWorktreeCapableAgent } from "./thread-lifecycle.ts";

const NON_BLANK_TASK_OPTIONS = { minLength: 1, pattern: "\\S" } as const;

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
								parentRunId,
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
							const reReviewBrief = buildReReviewBrief(lastReviewer, round, workerStep.result);
							const reviewStep = await launchInLoop("reviewer", reReviewBrief, executionCwd, signal, {
								groupId: parentGroupId,
								relationLabel: `re-review round ${round}`,
								parentRunId,
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
								usage: sumUsage(chain.map((step) => step.result.usage)),
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
									usage: initialReviewerResult.usage,
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

			const startBackground = createBackgroundDispatcher({
				runtime,
				ctx,
				config,
				agents,
				finishRun,
				makeLiveHandler,
				makeDetails,
				startFixLoop,
			});

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
