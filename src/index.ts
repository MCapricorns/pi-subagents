/**
 * pi-subagents — focused sub-agent delegation for pi.
 *
 * Registers:
 *   - a `subagent` tool that runs explore/worker/reviewer agents as isolated
 *     `pi` child processes (single or parallel),
 *   - a `/subagents-setup` command for selection-only configuration,
 *   - a `before_agent_start` hook that injects a delegation directive into the
 *     parent system prompt so the main model uses the tool proactively.
 *
 * The tool is not registered inside child sub-agent processes, which prevents
 * runaway recursion and keeps child context windows clean.
 */

import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { discoverAgents, type AgentConfig } from "./agents.ts";
import { BackgroundTaskQueue } from "./background.ts";
import {
	completionGroupTriggersTurn,
	completionTriggersTurn,
	createCompletionBatcher,
	formatCompletionMessage,
	type CompletionMessageItem,
} from "./completion.ts";
import { getConfigPath, loadConfig, loadConfigSync, saveConfig } from "./config.ts";
import { repairUnavailableModelOverrides } from "./models.ts";
import { buildDelegationDirective } from "./prompt.ts";
import { runSetup } from "./setup.ts";
import {
	currentSubagentDepth,
	getResultOutput,
	isFailedResult,
	isModelLevelFailure,
	reviewVerdict,
	runSingleAgentWithModelFallback,
	truncateResultOutput,
	writeResultArtifact,
	type SingleResult,
	type SubagentDetails,
	type SubagentLiveEvent,
	type UsageStats,
} from "./spawn.ts";
import { buildFixTaskBrief, buildReReviewBrief, shouldTriggerFixLoop } from "./fixloop.ts";
import {
	activityStateLabel,
	compactLine,
	deriveActivityState,
	formatElapsed,
	formatTaskSummary,
	formatToolActivity,
	formatUsageCompact,
	monitor,
	statusIcon,
	statusLabel,
	type RunChainMeta,
} from "./monitor.ts";

const NON_BLANK_TASK_OPTIONS = { minLength: 1, pattern: "\\S" } as const;

const TaskItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({
		...NON_BLANK_TASK_OPTIONS,
		description: "Self-contained task to delegate (the agent has no memory of this conversation)",
	}),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
});

const SubagentParams = Type.Object({
	agent: Type.Optional(Type.String({ description: "Name of the agent to invoke (single mode)" })),
	task: Type.Optional(
		Type.String({ ...NON_BLANK_TASK_OPTIONS, description: "Self-contained task to delegate (single mode)" }),
	),
	tasks: Type.Optional(Type.Array(TaskItem, { description: "Array of {agent, task} for parallel execution" })),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process (single mode)" })),
});

function emptyUsage(): UsageStats {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
}

function queuedResult(agent: AgentConfig, task: string, thinking?: string): SingleResult {
	return {
		agent: agent.name,
		agentSource: agent.source,
		task,
		exitCode: -1,
		messages: [],
		stderr: "",
		usage: emptyUsage(),
		model: agent.model,
		...(thinking ? { thinking } : {}),
	};
}

function failedStartResult(agentName: string, task: string, errorMessage: string): SingleResult {
	return {
		agent: agentName,
		agentSource: "unknown",
		task,
		exitCode: 1,
		messages: [],
		stderr: errorMessage,
		usage: emptyUsage(),
		errorMessage,
		dispatchFailed: true,
	};
}

/** Failed result for a background task that crashed with an exception (spawn
 * infra, delivery API, ...) instead of returning a normal result. */
function dispatchFailedResult(agent: AgentConfig, task: string, error: unknown, thinking?: string): SingleResult {
	const errorMessage = error instanceof Error ? error.message : String(error);
	return {
		...queuedResult(agent, task, thinking),
		exitCode: 1,
		stderr: errorMessage,
		stopReason: "error",
		errorMessage,
		dispatchFailed: true,
	};
}

function aggregateUsage(results: SingleResult[]): UsageStats {
	const total = emptyUsage();
	for (const r of results) {
		total.input += r.usage.input;
		total.output += r.usage.output;
		total.cacheRead += r.usage.cacheRead;
		total.cacheWrite += r.usage.cacheWrite;
		total.cost += r.usage.cost;
		total.turns += r.usage.turns;
	}
	return total;
}

function formatTokens(count: number): string {
	if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
	if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k`;
	return String(count);
}

function formatUsage(usage: UsageStats): string {
	const parts: string[] = [];
	if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	return parts.join(" ");
}

function formatCompletionBlock(result: SingleResult, maxResultLines: number, cwd?: string): string {
	const status = isFailedResult(result) ? "failed" : "completed";
	const usage = formatUsage(result.usage);
	const output = getResultOutput(result);
	const { text, truncated } = truncateResultOutput(output, maxResultLines);
	const fallbackNote = result.modelFallbackFrom
		? ` (model fell back from ${result.modelFallbackFrom} to ${result.model ?? "main-window model"})`
		: "";
	const retryNote = result.startupRetries
		? ` (recovered after ${result.startupRetries} startup retr${result.startupRetries === 1 ? "y" : "ies"} — concurrent pi startup race)`
		: "";
	const lines = [`### [${result.agent}] ${status}${usage ? ` (${usage})` : ""}${fallbackNote}${retryNote}`, "", `Task: ${formatTaskSummary(result.task, 80, false)}`, "", text];
	if (truncated) {
		// The full text lives on disk so the main agent can read it on demand.
		lines.push("", `(output truncated to ${maxResultLines} lines; full result: ${writeResultArtifact(output, result.agent, cwd)})`);
	}
	return lines.join("\n");
}

/** Instruction appended to a model-level failure: the sub-agent's provider never
 * produced usable output (or the run stalled), so the task is handed back to the
 * main window instead of being left as a dead failure. */
function modelLevelTakeoverNote(result: SingleResult): string {
	const retry = result.modelFallbackFrom ? ", and the retry with the main-window model also failed" : "";
	return `The sub-agent could not complete this task: its model was unavailable or failed (or the run stalled)${retry}. Please execute this task in the main window with your own tools; do not re-dispatch it as a sub-agent.`;
}

export default function (pi: ExtensionAPI): void {
	const configPath = getConfigPath(getAgentDir());
	// Init-time decisions need the config synchronously; the full (migrating)
	// async load runs per tool call.
	const initialConfig = loadConfigSync(configPath);
	const backgroundQueue = new BackgroundTaskQueue(initialConfig.maxConcurrency);
	let sessionActive = true;
	const sendCompletionGroup = (items: CompletionMessageItem[]): void => {
		if (!sessionActive || items.length === 0) return;
		const message = {
			customType: "subagent-result",
			content: formatCompletionMessage(items),
			display: true,
		};
		if (completionGroupTriggersTurn(items)) {
			pi.sendMessage(message, { deliverAs: "followUp", triggerTurn: true });
		} else {
			// No-wake delivery: nextTurn rides along with the next user turn and can
			// never start a continuation by itself. followUp would auto-continue
			// whenever pi is already streaming, defeating the opt-out.
			pi.sendMessage(message, { deliverAs: "nextTurn" });
		}
	};
	const completionBatcher = createCompletionBatcher<CompletionMessageItem>({ emit: sendCompletionGroup });

	// Recursion guard: sub-agent children are leaf processes. The `subagent` tool is
	// excluded from their toolset at spawn (--exclude-tools); this check is defense
	// in depth so a child can never expose the tool back to its model, even if
	// another extension ignores the depth marker.
	if (currentSubagentDepth() >= 1) {
		pi.registerCommand("subagents-setup", {
			description: "Configure pi-subagents (unavailable in nested sub-agent processes)",
			handler: async (_args, ctx) => {
				ctx.ui.notify("pi-subagents setup is unavailable in nested sub-agent processes.", "warning");
			},
		});
		return;
	}

	pi.registerMessageRenderer("subagent-result", (message, _options, theme) =>
		new Text(
			`${theme.fg("toolTitle", theme.bold("subagent result"))}\n${message.content}`,
			0,
			0,
		),
	);

	pi.on("session_shutdown", () => {
		sessionActive = false;
		completionBatcher.dispose();
		backgroundQueue.cancelAll();
		// Clear the monitor so stale runs from this session never leak into the
		// next one (the module-level singleton survives across sessions).
		monitor.clear();
	});

	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: [
			"Delegate a discrete, self-contained task to a specialized sub-agent running in an ISOLATED context window.",
			"Agents: explore (read-only codebase recon), worker (implement/fix/refactor/test, full tools), reviewer (adversarial pre-commit review, read-only).",
			"Modes: single ({agent, task}) or parallel ({tasks: [{agent, task}, ...]}).",
			"It starts agents in the background and immediately returns control to the main window; completion messages automatically wake the main agent to continue.",
			"Each agent has no memory of this conversation — brief it fully (goal, exact paths, constraints, expected output)."
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
			"NEVER sleep, wait, poll, or call other tools alongside subagent — it ends the turn immediately. The main agent is auto-resumed when results arrive; manual waiting only blocks the turn and delays delivery.",
		],
		parameters: SubagentParams,

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			monitor.beginTurn();
			let config = await loadConfig(configPath);
			// Pick up concurrency changes from /subagents-setup without a restart.
			backgroundQueue.setConcurrency(config.maxConcurrency);
			const repairedModels = repairUnavailableModelOverrides(ctx, config.agentModels);
			if (repairedModels.changed) {
				config = { ...config, agentModels: repairedModels.agentModels };
				try {
					await saveConfig(config, configPath);
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
				if (opts?.silent || !sessionActive) return;
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
			): Promise<SingleResult> => {
				const agent = agents.find((candidate) => candidate.name === agentName);
				if (!agent) return failedStartResult(agentName, task, `Unknown agent: "${agentName}".`);
				const thinkingLevel = config.agentThinkingLevels[agent.name] ?? agent.thinking ?? config.thinkingLevel;
				const runId = monitor.addRun(agent.name, task, agent.model, thinkingLevel, meta);
				const onLive = makeLiveHandler(runId);
				try {
					const result = await runSingleAgentWithModelFallback(
						{
							defaultCwd: ctx.cwd,
							agent,
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
					finishRun(runId, isFailedResult(result) ? "failed" : "done");
					return result;
				} catch (error) {
					finishRun(runId, "failed");
					const errorMessage = error instanceof Error ? error.message : String(error);
					return {
						...queuedResult(agent, task, thinkingLevel),
						exitCode: 1,
						stderr: errorMessage,
						stopReason: signal.aborted ? "aborted" : "error",
						errorMessage,
						dispatchFailed: true,
					};
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
			const startFixLoop = (initialReviewerResult: SingleResult, parentGroupId: string, parentRunId: number): void => {
				backgroundQueue.enqueue(
					async (signal) => {
						const chain: SingleResult[] = [initialReviewerResult];
						let lastReviewer = initialReviewerResult;
						for (let round = 1; round <= config.maxFixRounds; round++) {
							if (!sessionActive) break;
							const fixBrief = buildFixTaskBrief(lastReviewer, round, config.maxFixRounds);
							const workerResult = await launchInLoop("worker", fixBrief, signal, {
								groupId: parentGroupId,
								relationLabel: `fix round ${round}`,
							});
							chain.push(workerResult);
							if (!sessionActive || isFailedResult(workerResult)) break;
							const reReviewBrief = buildReReviewBrief(lastReviewer, round);
							const reviewResult = await launchInLoop("reviewer", reReviewBrief, signal, {
								groupId: parentGroupId,
								relationLabel: `re-review round ${round}`,
							});
							chain.push(reviewResult);
							lastReviewer = reviewResult;
							// A crashed re-review must stop the chain like a crashed worker: its
							// output (if any) is not a verdict, and feeding it to the next fix
							// round would brief the worker from garbage.
							if (!sessionActive || isFailedResult(reviewResult)) break;
							if (reviewVerdict(getResultOutput(reviewResult)) === "pass") break;
						}
						// The chain is done (success, exhaustion, or abort): drop the retained
						// parent row, then deliver the whole chain as one group. The loop's
						// outcome always wakes the main agent (a passing chain reports
						// success, a stuck one needs a human).
						monitor.removeRun(parentRunId);
						if (!sessionActive) return;
						const items: CompletionMessageItem[] = chain.map((r) => {
							// A model-level chain run (worker or re-review whose provider never
							// produced output) is handed to the main window like any other
							// sub-agent run: the block carries the takeover note. Dispatch
							// crashes (dispatchFailed) are excluded by the gate itself.
							const modelLevel = isFailedResult(r) && isModelLevelFailure(r);
							return {
								agent: r.agent,
								block: modelLevel
									? `${formatCompletionBlock(r, config.maxResultLines, ctx.cwd)}\n\n${modelLevelTakeoverNote(r)}`
									: formatCompletionBlock(r, config.maxResultLines, ctx.cwd),
								triggerTurn: true,
							};
						});
						sendCompletionGroup(items);
						completionBatcher.flush();
					},
					() => {
						// Cancelled before delivery: clean up the retained parent row (each
						// in-flight chain run was already finished by its launchInLoop path).
						monitor.removeRun(parentRunId);
					},
					(error) => {
						// A crash inside the chain orchestration (failed runs are caught by
						// launchInLoop and delivered as part of the chain) must not vanish:
						// drop the retained parent row, notify, and deliver a failed result
						// so the main agent knows the chain never completed.
						monitor.removeRun(parentRunId);
						if (!sessionActive) return;
						const errorMessage = error instanceof Error ? error.message : String(error);
						try {
							ctx.ui.notify(`✗ auto-fix chain 派发失败: ${errorMessage}`, "error");
							// Keep the triggering review's findings: the chain crashed before any
							// fix round ran, and the main agent needs the review to act on it.
							sendCompletionGroup([
								{
									agent: initialReviewerResult.agent,
									block: `${formatCompletionBlock(initialReviewerResult, config.maxResultLines, ctx.cwd)}\n\nAuto-fix chain crashed before completion: ${errorMessage}. The planned fix rounds did not run; the review above is the triggering reviewer's full output.`,
									triggerTurn: true,
								},
							]);
							completionBatcher.flush();
						} catch {
							/* a second delivery failure must not throw through the queue */
						}
					},
				);
			};

			const startBackground = (agentName: string, task: string, cwd?: string): SingleResult => {
				const agent = agents.find((candidate) => candidate.name === agentName);
				if (!agent) return failedStartResult(agentName, task, `Unknown agent: "${agentName}".`);

				// Effective strength: config override > agent frontmatter default > global default.
				const thinkingLevel = config.agentThinkingLevels[agent.name] ?? agent.thinking ?? config.thinkingLevel;
				const pending = queuedResult(agent, task, thinkingLevel);
				const runId = monitor.addRun(agent.name, task, agent.model, thinkingLevel);
				// Only a main-agent-dispatched reviewer can trigger an auto-fix chain, so
				// only its finish is deferred to the queue task (see startFixLoop).
				const onLive = makeLiveHandler(runId);

				backgroundQueue.enqueue(
					async (backgroundSignal) => {
						let result: SingleResult;
						try {
							result = await runSingleAgentWithModelFallback(
								{
									defaultCwd: ctx.cwd,
									agent,
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
						}

						if (!sessionActive) return;
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
							startFixLoop(result, `fix-${runId}`, runId);
							return;
						}
						const failed = isFailedResult(result);
						// Model-level failures and dispatch crashes get their own dedicated
						// dispatch-failure notification below, so finishRun's generic failure toast is
						// silenced for them (computed before finishRun for that reason).
						const modelLevel = failed && isModelLevelFailure(result);
						const dispatchFailed = result.dispatchFailed === true;
						finishRun(runId, failed ? "failed" : "done", modelLevel || dispatchFailed ? { silent: true } : undefined);
						if (!sessionActive) return;
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
							ctx.ui.notify(`✗ ${result.agent} 派发失败: 模型不可用或出错，任务已交由主窗口执行`, "error");
						} else if (dispatchFailed) {
							// An exception inside the dispatch layer (spawn infra, temp-file/fs
							// errors, ...): the main agent must know so it can re-dispatch.
							ctx.ui.notify(`✗ ${result.agent} 派发失败: ${result.errorMessage ?? "dispatch crashed"}`, "error");
						}
						if (failed) {
							// Failures never wait and never hide behind a success turn: deliver
							// first so the wake-up leads with the failure; held successes follow.
							sendCompletionGroup([completion]);
							completionBatcher.flush();
						} else {
							completionBatcher.push(completion);
						}
					},
					() => finishRun(runId, "failed"),
					(error) => {
						// The task body converts sub-agent failures into delivered results; an
						// exception escaping it (spawn infra, delivery API, ...) must not
						// vanish: notify the user and deliver a failed result so the main
						// agent knows the dispatch failed and can re-dispatch.
						const crashed = dispatchFailedResult(agent, task, error, thinkingLevel);
						finishRun(runId, "failed", { silent: true });
						if (!sessionActive) return;
						try {
							ctx.ui.notify(`✗ ${agent.name} 派发失败: ${crashed.errorMessage}`, "error");
							sendCompletionGroup([
								{
									agent: agent.name,
									block: formatCompletionBlock(crashed, config.maxResultLines, ctx.cwd),
									triggerTurn: true,
								},
							]);
							completionBatcher.flush();
						} catch {
							/* a second delivery failure must not throw through the queue */
						}
					},
				);

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

				const results = params.tasks.map((task) => startBackground(task.agent, task.task, task.cwd));
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

			const result = startBackground(params.agent as string, params.task as string, params.cwd);
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

	pi.registerCommand("subagents-setup", {
		description: "Configure pi-subagents: enable agents, pick per-agent models, toggle proactive injection",
		handler: async (_args, ctx) => {
			await runSetup(ctx, configPath);
		},
	});

	// Persistent widget above the editor showing live sub-agent status.
	pi.on("session_start", (_e, ctx) => {
		if (ctx.mode !== "tui") return;
		ctx.ui.setWidget(
			"pi-subagents",
			(tui, theme) => {
				const unsub = monitor.subscribe(() => tui.requestRender());
				// Tick once a second so elapsed time stays live while runs are active.
				const timer = setInterval(() => {
					if (monitor.getRuns().some((r) => r.status === "queued" || r.status === "running")) {
						tui.requestRender();
					}
				}, 1000);
				return {
						render(width: number): string[] {
							const runs = monitor.getRuns();
							if (runs.length === 0) return [];
							const now = Date.now();
							const lines: string[] = [];
							// Tree layout: each top-level agent is a root whose title/activity hang
							// off it as branches; auto-fix chain runs (groupId) become child nodes
							// under their parent root, with a "│" continuation while more siblings
							// follow. Blank lines separate agent blocks so parallel runs don't blur
							// into one wall of text.
							const dim = (t: string): string => theme.fg("dim", t);
							for (let idx = 0; idx < runs.length; idx++) {
								const r = runs[idx];
								const isChain = Boolean(r.groupId);
								const chainContinues = isChain && runs[idx + 1]?.groupId === r.groupId;
								const activity =
									r.activity && (r.status === "running" || r.status === "queued") ? r.activity : undefined;
								const hasActivity = activity !== undefined;
								const icon = statusIcon(r.status, theme);
								// Chain-internal runs (auto-fix worker/reviewer) are child nodes under
								// their parent reviewer. Their relationLabel ("fix round 1") is more
								// distinguishing than the repeated worker/reviewer name.
								const name = isChain ? (r.relationLabel ?? r.agent) : r.agent;
								// Two lines per run: the header row (icon, run id, agent name) and the
								// live activity branch below. The task summary is deliberately not
								// shown — the task lives in the tool result, and the agent name plus
								// what it is doing right now is enough to tell runs apart. The header
								// stays exactly as it was (accent name, dim stats), matching the
								// referenced sub-agent widgets (tintinweb): the running indicator
								// uses the accent color, everything else is quiet.
								if (!isChain && lines.length > 0) lines.push("");
								const nodeBranch = isChain ? (chainContinues ? "├─ " : "└─ ") : "";
								const left = `${dim(nodeBranch)}${icon} ${dim(`#${r.id}`)} ${isChain ? name : theme.fg("accent", theme.bold(name))}`;

								// Right side: full model ref (provider/model), token usage (in/out +
								// cache read/write), tool count, elapsed, and the soft activity-state
								// annotation (idle / long-running). Trailing the header with a single
								// " · " chain keeps the row compact (no center gap); compactLine
								// clips on overflow, never the right side on its own.
								const model = r.model ?? "?";
								const usage = formatUsageCompact(r.usage);
								const tools = r.toolCount ? `${r.toolCount} tool${r.toolCount === 1 ? "" : "s"}` : "";
								const elapsed = formatElapsed(r, now);
								const metaParts = [model, usage, tools, elapsed].filter(Boolean);
								// Running is conveyed by the icon + elapsed; spell out the label only for
								// the other states (ready / done / stopped) so they are unambiguous.
								if (r.status !== "running") metaParts.push(statusLabel(r.status));
								const state = deriveActivityState(r, now);
								if (state) metaParts.push(activityStateLabel(state));
								if (r.annotation) metaParts.push(r.annotation);
								// Metadata trails the header in dim — quiet, never competing with the
								// accent agent name (the same restraint the referenced widgets use).
								// Trailing with a single " · " chain keeps the row compact (no center
								// gap); compactLine clips on overflow, never the right side on its own.
								const right = metaParts.length ? dim(` · ${metaParts.join(" · ")}`) : "";
								lines.push(compactLine(left, right, width));

								// Current activity ("read src/index.ts", "bash npm test") is the only
								// branch: gray, so it never competes with the agent name or pi's own
								// UI. Chain nodes that still have siblings carry a "│" continuation
								// down to the last one.
								if (hasActivity) {
									const continuation = isChain ? (chainContinues ? "│  " : "   ") : "";
									lines.push(truncateToWidth(`${continuation}${dim("└─ ")}${dim(activity)}`, width));
								}
							}
							return lines;
						},
					invalidate() {},
					dispose() {
						unsub();
						clearInterval(timer);
					},
				};
			},
			{ placement: "aboveEditor" },
		);
	});

	// Proactive dispatch: inject the delegation directive into the parent system prompt.
	pi.on("before_agent_start", async (event, ctx) => {
		const config = await loadConfig(configPath);
		if (!config.proactiveInjection) return undefined;
		const { agents } = discoverAgents(ctx.cwd, {
			scope: config.agentScope,
			enabledNames: config.enabledAgents,
		});
		const directive = buildDelegationDirective(agents);
		if (!directive) return undefined;
		return { systemPrompt: `${event.systemPrompt}\n${directive}` };
	});
}
