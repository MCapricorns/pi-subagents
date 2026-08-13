/**
 * The `subagent` tool: dispatches explore/worker/reviewer agents as isolated pi
 * child processes, single or parallel. Owns the dispatch pipeline: config load
 * + unavailable-model repair, per-run widget tracking, the auto-fix chain
 * (REVIEW_FAIL → worker → re-review), and completion delivery.
 *
 * Vision: a task flagged `vision: true` runs on the configured vision-capable
 * model (config.visionModel); when none is configured it falls back to the main
 * session's current model. If the configured vision model is no longer
 * available, the user is asked (TUI picker) to pick a replacement, which is
 * persisted; outside the TUI it degrades to the main-session model with a
 * warning.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { discoverAgents, type AgentConfig } from "./agents.ts";
import {
	completionTriggersTurn,
	type CompletionMessageItem,
} from "./completion.ts";
import { loadConfig, saveConfig, type SubagentsConfig } from "./config.ts";
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
import { availableModelRefs, repairUnavailableModelOverrides, resolveVisionModelRef } from "./models.ts";
import {
	formatTaskSummary,
	formatToolActivity,
	monitor,
	statusIcon,
	type RunChainMeta,
} from "./monitor.ts";
import type { SubagentRuntime } from "./runtime.ts";
import {
	getResultOutput,
	isFailedResult,
	isModelLevelFailure,
	reviewVerdict,
	runSingleAgentWithModelFallback,
	type SingleResult,
	type SubagentDetails,
	type SubagentLiveEvent,
} from "./spawn.ts";
import { promptSelectOne } from "./ui.ts";

const NON_BLANK_TASK_OPTIONS = { minLength: 1, pattern: "\\S" } as const;

const VISION_DESCRIPTION =
	"Set true when the task may require viewing images (screenshots, mockups, designs) — the sub-agent then runs on the configured vision-capable model, or the main session's current model when none is configured";

const TaskItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({
		...NON_BLANK_TASK_OPTIONS,
		description: "Self-contained task to delegate (the agent has no memory of this conversation)",
	}),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
	vision: Type.Optional(Type.Boolean({ description: VISION_DESCRIPTION })),
});

const SubagentParams = Type.Object({
	agent: Type.Optional(Type.String({ description: "Name of the agent to invoke (single mode)" })),
	task: Type.Optional(
		Type.String({ ...NON_BLANK_TASK_OPTIONS, description: "Self-contained task to delegate (single mode)" }),
	),
	tasks: Type.Optional(Type.Array(TaskItem, { description: "Array of {agent, task} for parallel execution" })),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process (single mode)" })),
	vision: Type.Optional(Type.Boolean({ description: VISION_DESCRIPTION })),
});

/** True when any dispatched task carries the vision flag. */
function hasVisionTask(params: { vision?: boolean; tasks?: Array<{ vision?: boolean }> }): boolean {
	return params.vision === true || (params.tasks ?? []).some((t) => t.vision === true);
}

/**
 * When the configured vision model is unavailable, ask the user to pick a
 * replacement (TUI) and persist it; outside the TUI, warn and fall back to the
 * main session's model. Returns the repaired vision model (undefined = use the
 * main-session fallback).
 */
async function repairVisionModelForDispatch(
	ctx: ExtensionContext,
	config: SubagentsConfig,
	configPath: string,
): Promise<string | undefined> {
	const configured = config.visionModel?.trim();
	if (!configured) return undefined;
	const refs = availableModelRefs(ctx);
	if (refs.includes(configured)) return configured;

	if (ctx.mode === "tui" && refs.length > 0) {
		try {
			const picked = await promptSelectOne(
				ctx,
				`Vision model "${configured}" is unavailable. Pick a replacement?`,
				"Type to filter • ↑/↓ • Enter selects • Esc falls back to the main session's model",
				refs.map((ref) => ({ value: ref, label: ref })),
			);
			if (picked !== undefined) {
				try {
					await saveConfig({ ...config, visionModel: picked }, configPath);
					ctx.ui.notify(`Vision model switched to ${picked}.`, "info");
				} catch {
					/* persistence failure is non-fatal; the pick still applies this dispatch */
				}
				return picked;
			}
		} catch {
			/* a failed picker must never break the dispatch */
		}
		ctx.ui.notify(`Vision model left as "${configured}"; this dispatch runs without the vision override.`, "warning");
		return undefined;
	}
	ctx.ui.notify(
		`Configured vision model "${configured}" is unavailable; this dispatch uses the main session's model.`,
		"warning",
	);
	return undefined;
}

export function registerSubagentTool(pi: ExtensionAPI, runtime: SubagentRuntime): void {
	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: [
			"Delegate a discrete, self-contained task to a specialized sub-agent running in an ISOLATED context window.",
			"Agents: explore (read-only codebase recon), worker (implement/fix/refactor/test, full tools), reviewer (adversarial pre-commit review, read-only).",
			"Modes: single ({agent, task}) or parallel ({tasks: [{agent, task}, ...]}).",
			"It starts agents in the background and immediately returns control to the main window; completion messages automatically wake the main agent to continue.",
			"Each agent has no memory of this conversation — brief it fully (goal, exact paths, constraints, expected output).",
			"Results arrive as wake-up messages automatically — you do NOT need to wait. If you must get a result in-turn, subagent_wait is a non-blocking lookup by default (pass timeoutMs to block).",
			"Vision: set vision: true when the task may require viewing images (screenshots, mockups, design files — e.g. frontend work) — the sub-agent then runs on the vision-capable model configured in /subagents-setup, or the main session's current model when none is configured.",
		].join(" "),
		promptSnippet:
			"Start background subagents: explore (read-only search), worker (implement), reviewer (adversarial review); completion automatically resumes the main agent. Simple tasks: use direct tools, not subagents.",
		promptGuidelines: [
			"Delegate only when an isolated context genuinely pays: broad exploration, a self-contained implementation, or a review gate. Handle simple lookups and one-line edits inline with direct tools — never spawn a sub-agent for them.",
			"Use subagent with agent 'explore' for broad or open-ended code search before large changes; a targeted 'where is X' is a direct grep/read.",
			"Use subagent with agent 'worker' for a self-contained implementation task worth a separate context; it plans internally.",
			"Use subagent with agent 'reviewer' for a fresh read-only review before reporting work done or committing.",
			"subagent launches work in the background and ends the current turn; when a result arrives, the main agent is automatically resumed with it.",
			"Run independent tasks in parallel by passing a tasks array to subagent; let the automatically resumed main agent start dependent work after results arrive.",
			"NEVER sleep or poll, and do NOT call subagent_wait to hold the turn — subagent ends the turn immediately and the result arrives as a message that wakes you automatically (even mid-turn). Ending your turn is the default and the only correct way to wait.",
			"If you must keep the turn for a result, call subagent_wait with an explicit timeoutMs (non-blocking by default) — never bash sleep/timeout to wait for a sub-agent.",
			"When a delegated task may require viewing images (frontend screenshots, mockups, design comparisons), pass vision: true and give the sub-agent the exact image paths — it reads them with its read tool. The sub-agent then runs on the configured vision-capable model, or the main session's current model when none is configured.",
			"When a sub-agent result arrives it is already shown to the user — do NOT restate, paraphrase, or summarize it; reply with only your own conclusion or next action (often just one line), since duplicating the result wastes tokens for nothing.",
		],
		parameters: SubagentParams,

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			monitor.beginTurn();
			let config = await loadConfig(runtime.configPath);
			// Pick up concurrency changes from /subagents-setup without a restart.
			runtime.backgroundQueue.setConcurrency(config.maxConcurrency);
			const repairedModels = repairUnavailableModelOverrides(ctx, config.agentModels);
			if (repairedModels.changed) {
				config = { ...config, agentModels: repairedModels.agentModels };
				try {
					await saveConfig(config, runtime.configPath);
					ctx.ui.notify(
						repairedModels.fallbackRef
							? `Unavailable sub-agent models switched to ${repairedModels.fallbackRef} and saved to config.`
							: "Unavailable sub-agent model overrides removed; no main-window model is available.",
						"warning",
					);
				} catch (error) {
					ctx.ui.notify(
						`Could not persist repaired sub-agent model config: ${error instanceof Error ? error.message : String(error)}`,
						"warning",
					);
				}
			}

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
			// "read src/index.ts", ...), never a raw args blob. The live handler only
			// updates widget status; finishing (removeRun + notify) is owned by the
			// queue task / launchInLoop. That keeps a startup retry — which fires a
			// transient "failed" status before relaunching — from ripping the row out
			// early, and lets the queue task decide between delivering a reviewer's
			// result and starting an auto-fix chain (a triggered chain keeps the
			// parent row annotated until it completes).
			const makeLiveHandler = (runId: number) => (e: SubagentLiveEvent): void => {
				switch (e.kind) {
					case "status":
						// Only update the widget status here. Finishing (removeRun + notify) is
						// owned by the queue task / launchInLoop so that a startup retry — which
						// fires a transient "failed" status before relaunching the child — never
						// rips the row out from under the retry or emits a premature "✗" toast.
						monitor.setStatus(runId, e.status);
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
			});

			// Effective model precedence: setup override > current session model > frontmatter default.
			const sessionRef = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
			const agents: AgentConfig[] = discovery.agents.map((agent) => ({
				...agent,
				model: config.agentModels[agent.name] ?? sessionRef ?? agent.model,
			}));

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

			// A vision-flagged dispatch with a stale vision model asks the user for a
			// replacement before spawning (the persisted pick also fixes future runs).
			// Runs only after parameter validation, so an invalid call never pops a picker.
			const visionRequested = hasVisionTask(params);
			let visionModel = config.visionModel;
			if (visionRequested && visionModel !== undefined && !availableModelRefs(ctx).includes(visionModel.trim())) {
				visionModel = await repairVisionModelForDispatch(ctx, config, runtime.configPath);
			}
			// Vision-flagged dispatches run on the configured vision model, else the
			// main session's current model (the documented fallback), else the agent's
			// own model as the last resort.
			const visionRef = resolveVisionModelRef(ctx, visionModel);
			const withVision = (agent: AgentConfig, vision: boolean): AgentConfig =>
				vision && visionRef ? { ...agent, model: visionRef } : agent;

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
				// A vision-flagged chain (e.g. a review of UI screenshots) keeps its rounds
				// on the vision model: the fix worker and re-review re-read the same images.
				const effectiveAgent = withVision(agent, vision);
				const thinkingLevel = config.agentThinkingLevels[agent.name] ?? agent.thinking ?? config.thinkingLevel;
				const runId = monitor.addRun(agent.name, task, effectiveAgent.model, thinkingLevel, meta);
				const onLive = makeLiveHandler(runId);
				try {
					const result = await runSingleAgentWithModelFallback(
						{
							defaultCwd: ctx.cwd,
							agent: effectiveAgent,
							agentName,
							task,
							thinkingLevel,
							signal,
							onLive,
							makeDetails: makeDetails("single", true),
							idleTimeoutMs: config.idleTimeoutSec * 1000,
						},
						sessionRef,
					);
					// Keep the finished round visible in the widget while the chain is
					// still running, with a one-line summary of what it did; the whole
					// group is dropped when the chain resolves (see removeChainGroup).
					monitor.setSummary(runId, summarizeChainResult(result));
					finishRun(runId, isFailedResult(result) ? "failed" : "done", { retain: true });
					runtime.registerRunResult(runId, result);
					return { runId, result };
				} catch (error) {
					finishRun(runId, "failed", { retain: true });
					const errorMessage = error instanceof Error ? error.message : String(error);
					const crashed = {
						...queuedResult(agent, task, thinkingLevel),
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
				runtime.runControllers.set(parentRunId, runtime.backgroundQueue.enqueue(
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
							chain.push({ ...workerStep, relation: `fix round ${round}` });
							if (!runtime.sessionActive || isFailedResult(workerStep.result)) break;
							const reReviewBrief = buildReReviewBrief(lastReviewer, round);
							const reviewStep = await launchInLoop("reviewer", reReviewBrief, signal, {
								groupId: parentGroupId,
								relationLabel: `re-review round ${round}`,
							}, vision);
							chain.push({ ...reviewStep, relation: `re-review round ${round}` });
							lastReviewer = reviewStep.result;
							// A crashed re-review must stop the chain like a crashed worker: its
							// output (if any) is not a verdict, and feeding it to the next fix
							// round would brief the worker from garbage.
							if (!runtime.sessionActive || isFailedResult(reviewStep.result)) break;
							if (reviewVerdict(getResultOutput(reviewStep.result)) === "pass") break;
						}
						// The chain is done (success, exhaustion, or abort): drop the retained
						// parent row and its retained round rows, then deliver one condensed
						// summary. Register the parent's final state (the last chain result)
						// before removal so subagent_wait can resolve it.
						runtime.registerRunResult(parentRunId, chain[chain.length - 1].result);
						runtime.runControllers.delete(parentRunId);
						removeChainGroup(parentGroupId);
						monitor.removeRun(parentRunId);
						if (!runtime.sessionActive) return;
						// One compact message instead of every round's raw output: the summary
						// lines cover each step (verdict + what changed/found), and the final
						// step's full report is appended only when its detail is actionable
						// (a FAIL verdict, a crash, or a model-level failure the main agent
						// must take over). Everything else stays one `subagent_status #id`
						// call away.
						const last = chain[chain.length - 1];
						let block = formatChainSummary(chain);
						if (isFailedResult(last.result) && isModelLevelFailure(last.result)) {
							block = `${block}\n\n${formatCompletionBlock(last.result, config.maxResultLines, ctx.cwd)}\n\n${modelLevelTakeoverNote(last.result)}`;
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
					},
					() => {
						// Cancelled before delivery: clean up the retained parent row and
						// every retained chain row (each in-flight chain run was already
						// finished by its launchInLoop path).
						runtime.runControllers.delete(parentRunId);
						removeChainGroup(parentGroupId);
						monitor.removeRun(parentRunId);
					},
					(error) => {
						// A crash inside the chain orchestration (failed runs are caught by
						// launchInLoop and delivered as part of the chain) must not vanish:
						// drop the retained rows, notify, and deliver a failed result
						// so the main agent knows the chain never completed.
						runtime.registerRunResult(parentRunId, initialReviewerResult);
						runtime.runControllers.delete(parentRunId);
						removeChainGroup(parentGroupId);
						monitor.removeRun(parentRunId);
						if (!runtime.sessionActive) return;
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
						}
					},
				));
			};

			const startBackground = (agentName: string, task: string, cwd?: string, vision = false): SingleResult => {
				const agent = agents.find((candidate) => candidate.name === agentName);
				if (!agent) return failedStartResult(agentName, task, `Unknown agent: "${agentName}".`);
				// A vision-flagged task runs on the configured vision model (or the main
				// session's current model), overriding the agent's own model — the
				// per-agent model may not support images.
				const effectiveAgent = withVision(agent, vision);

				// Effective strength: config override > agent frontmatter default > global default.
				const thinkingLevel = config.agentThinkingLevels[agent.name] ?? agent.thinking ?? config.thinkingLevel;
				const pending = queuedResult(effectiveAgent, task, thinkingLevel);
				const runId = monitor.addRun(agent.name, task, effectiveAgent.model, thinkingLevel);
				// Only a main-agent-dispatched reviewer can trigger an auto-fix chain, so
				// only its finish is deferred to the queue task (see startFixLoop).
				const onLive = makeLiveHandler(runId);

				runtime.runControllers.set(runId, runtime.backgroundQueue.enqueue(
					async (backgroundSignal) => {
						let result: SingleResult;
						try {
							result = await runSingleAgentWithModelFallback(
								{
									defaultCwd: ctx.cwd,
									agent: effectiveAgent,
									agentName,
									task,
									cwd,
									thinkingLevel,
									signal: backgroundSignal,
									onLive,
									makeDetails: makeDetails("single", true),
									idleTimeoutMs: config.idleTimeoutSec * 1000,
								},
								sessionRef,
							);
						} catch (error) {
							const errorMessage = error instanceof Error ? error.message : String(error);
							result = {
								...pending,
								exitCode: 1,
								stderr: errorMessage,
								stopReason: backgroundSignal.aborted ? "aborted" : "error",
								errorMessage,
								dispatchFailed: true,
							};
							// The dedicated dispatch-failure notification below replaces the generic
							// failure toast for dispatch crashes, so finish silently here.
							finishRun(runId, "failed", { silent: true });
							runtime.registerRunResult(runId, result);
							runtime.runControllers.delete(runId);
						}

						if (!runtime.sessionActive) return;
						// Auto-fix loop: a REVIEW_FAIL from a main-agent-dispatched reviewer
						// triggers a worker→reviewer chain (up to maxFixRounds) without waking
						// the main agent. Loop-internal re-reviews never reach here (they are
						// awaited inside launchInLoop); the initial review is delivered with
						// the chain at the end. While the chain runs, the triggering review
						// stays in the widget (annotated) so the chain rows have an obvious
						// parent; no premature "done" notification is shown.
						if (shouldTriggerFixLoop(result, config)) {
							// The session is known active here (checked above), so the chain
							// always starts: keep the triggering review in the widget
							// (annotated) without a premature "done" notification, and let
							// startFixLoop deliver the whole chain and drop the parent row.
							finishRun(runId, "done", { silent: true, retain: true });
							monitor.setAnnotation(runId, "auto-fix chain running");
							startFixLoop(result, `fix-${runId}`, runId, vision);
							return;
						}
						const failed = isFailedResult(result);
						// Model-level failures and dispatch crashes get their own dedicated
						// dispatch-failure notification below, so finishRun's generic failure toast is
						// silenced for them (computed before finishRun for that reason).
						const modelLevel = failed && isModelLevelFailure(result);
						const dispatchFailed = result.dispatchFailed === true;
						finishRun(runId, failed ? "failed" : "done", modelLevel || dispatchFailed ? { silent: true } : undefined);
						// Register before delivery so a concurrent subagent_wait resolves with
						// the result even though the run row is already gone from the monitor.
						runtime.registerRunResult(runId, result);
						runtime.runControllers.delete(runId);
						if (!runtime.sessionActive) return;
						// Model-level failure: the configured model is unavailable or broke
						// and the retry with the main-window model (when distinct) also
						// failed. Instead of leaving a dead failure, hand the task to the
						// main window — the main agent executes it itself with its own tools.
						const completion: CompletionMessageItem = {
							agent: result.agent,
							block: modelLevel
								? `${formatCompletionBlock(result, config.maxResultLines, ctx.cwd)}\n\n${modelLevelTakeoverNote(result)}`
								: formatCompletionBlock(result, config.maxResultLines, ctx.cwd),
							triggerTurn: completionTriggersTurn(result, config.notifyOnReviewPass),
						};
						if (modelLevel) {
							ctx.ui.notify(`✗ ${result.agent} dispatch failed: model unavailable or broken — task handed to the main window`, "error");
						} else if (dispatchFailed) {
							// An exception inside the dispatch layer (spawn infra, temp-file/fs
							// errors, ...): the main agent must know so it can re-dispatch.
							ctx.ui.notify(`✗ ${result.agent} dispatch failed: ${result.errorMessage ?? "dispatch crashed"}`, "error");
						}
						if (failed) {
							// Failures never wait and never hide behind a success turn: deliver
							// first so the wake-up leads with the failure; held successes follow.
							runtime.sendCompletionGroup([completion]);
							runtime.completionBatcher.flush();
						} else {
							runtime.completionBatcher.push(completion);
						}
					},
					() => {
						runtime.runControllers.delete(runId);
						finishRun(runId, "failed");
					},
					(error) => {
						// The task body converts sub-agent failures into delivered results; an
						// exception escaping it (spawn infra, delivery API, ...) must not
						// vanish: notify the user and deliver a failed result so the main
						// agent knows the dispatch failed and can re-dispatch.
						const crashed = dispatchFailedResult(agent, task, error, thinkingLevel);
						finishRun(runId, "failed", { silent: true });
						runtime.registerRunResult(runId, crashed);
						runtime.runControllers.delete(runId);
						if (!runtime.sessionActive) return;
						try {
							ctx.ui.notify(`✗ ${agent.name} dispatch failed: ${crashed.errorMessage}`, "error");
							runtime.sendCompletionGroup([
								{
									agent: agent.name,
									block: formatCompletionBlock(crashed, config.maxResultLines, ctx.cwd),
									triggerTurn: true,
								},
							]);
							runtime.completionBatcher.flush();
						} catch {
							/* a second delivery failure must not throw through the queue */
						}
					},
				));

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

				const results = params.tasks.map((task) => startBackground(task.agent, task.task, task.cwd, task.vision === true));
				const started = results.filter((result) => result.exitCode === -1).length;
				const failures = results.filter((result) => result.exitCode !== -1);
				return {
					content: [
						{
							type: "text",
							text:
								started > 0
									? `Started ${started} background subagent${started === 1 ? "" : "s"}. Results will automatically resume the main agent when ready.`
									: failures.map((result) => getResultOutput(result)).join("\n"),
						},
					],
					details: makeDetails("parallel", true)(results),
					isError: failures.length > 0,
					terminate: true,
				};
			}

			const result = startBackground(params.agent as string, params.task as string, params.cwd, params.vision === true);
			if (result.exitCode !== -1) {
				return {
					content: [{ type: "text", text: getResultOutput(result) }],
					details: makeDetails("single")([result]),
					isError: true,
				};
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
					text += `\n  ${theme.fg("accent", t.agent)} ${theme.fg("dim", preview)}`;
				}
				if (args.tasks.length > 4) text += `\n  ${theme.fg("dim", `… +${args.tasks.length - 4} more`)}`;
				return new Text(text, 0, 0);
			}
			const task: string = args.task ?? "";
			const preview = formatTaskSummary(task, 60);
			return new Text(
				`${theme.fg("toolTitle", theme.bold("subagent "))}${theme.fg("accent", args.agent ?? "?")} ${theme.fg("dim", preview)}`,
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
				const model = `${r.model ?? "?"}${r.modelFallbackFrom ? ` (fell back from ${r.modelFallbackFrom})` : ""}`;
				const line = `${theme.fg("toolTitle", theme.bold("subagent "))}${icon} ${theme.fg("accent", r.agent)} ${theme.fg("dim", `· ${model}${r.thinking ? ` · thinking ${r.thinking}` : ""}${pending ? " · background" : ""}${usage ? ` · ${usage}` : ""}`)}`;
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
				const model = `${r.model ?? "?"}${r.modelFallbackFrom ? ` (fell back from ${r.modelFallbackFrom})` : ""}`;
				lines.push(`  ${icon} ${theme.fg("accent", r.agent)} ${theme.fg("dim", `· ${model}${r.thinking ? ` · thinking ${r.thinking}` : ""}${pending ? " · background" : ""}${usage ? ` · ${usage}` : ""}`)}`);
			}
			return new Text(lines.join("\n"), 0, 0);
		},
	});
}
