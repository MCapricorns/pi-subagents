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
	const failed = isFailedResult(result);
	const failedTools = result.failedTools ?? [];
	const status = failed
		? "failed"
		: failedTools.length > 0
			? `completed with ${failedTools.length} failed tool call${failedTools.length === 1 ? "" : "s"}`
			: "completed";
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
	// A run can exit cleanly while its last tools failed (e.g. a build that broke):
	// the final text alone may claim more than the tools achieved, so surface the
	// failures explicitly and tell the main agent to verify before relying on it.
	if (!failed && failedTools.length > 0) {
		const shown = failedTools.slice(0, 3);
		const more = failedTools.length - shown.length;
		lines.push(
			"",
			`⚠ ${failedTools.length} tool call${failedTools.length === 1 ? "" : "s"} failed during this run — the final text above may not reflect a working state:`,
			...shown.map((tool) => `- ${tool.toolName}: ${tool.error.trim() || "(no output)"}`),
		);
		if (more > 0) lines.push(`- … and ${more} more`);
		lines.push("Verify the actual artifacts before relying on this report.");
	}
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

/** Resolve a run-id request to actual ids: an exact numeric match always wins
 * (so "1" never fans out to 10, 11, …); only when no exact match exists does a
 * prefix match run, as a convenience for partial ids. Keeps single-digit lookups
 * from returning — or, for subagent_stop, acting on — a whole prefix family. */
export function matchRunIds(ids: number[], requested: string): number[] {
	const exact = ids.filter((id) => String(id) === requested);
	if (exact.length > 0) return exact;
	return ids.filter((id) => String(id).startsWith(requested));
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
			// steer: the result is injected after the current tool call even mid-turn, or
			// starts a new turn when idle. followUp would sit in the queue until the whole
			// turn ends — a main agent waiting for the result (sleep/poll) would never see
			// it delivered, which is exactly the "returned but never woken" failure mode.
			pi.sendMessage(message, { deliverAs: "steer", triggerTurn: true });
		} else {
			// No-wake delivery: nextTurn rides along with the next user turn and can
			// never start a continuation by itself. followUp would auto-continue
			// whenever pi is already streaming, defeating the opt-out.
			pi.sendMessage(message, { deliverAs: "nextTurn" });
		}
	};
	const completionBatcher = createCompletionBatcher<CompletionMessageItem>({ emit: sendCompletionGroup });

	// Abort controllers per active run, so subagent_stop can cancel a run in-turn.
	const runControllers = new Map<number, AbortController>();

	// Final results keyed by run id, so `subagent_wait` can hand the model the
	// actual result in-turn instead of it sleeping/polling for a wake-up message.
	const settledRuns = new Map<number, SingleResult>();
	const settledListeners = new Map<number, Set<(result: SingleResult) => void>>();
	const registerRunResult = (runId: number, result: SingleResult): void => {
		settledRuns.set(runId, result);
		const listeners = settledListeners.get(runId);
		if (listeners) {
			settledListeners.delete(runId);
			for (const listener of listeners) {
				try {
					listener(result);
				} catch {
					/* listener errors must never break settling */
				}
			}
		}
	};

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
		settledRuns.clear();
		settledListeners.clear();
		runControllers.clear();
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
			"Each agent has no memory of this conversation — brief it fully (goal, exact paths, constraints, expected output).",
			"To get a result in-turn without sleeping, use the subagent_wait tool."
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
			"NEVER sleep, poll, or call other tools alongside subagent — it ends the turn immediately. The main agent is auto-resumed when results arrive; manual waiting only blocks the turn and delays delivery. The one exception is subagent_wait (below): only when you must stay in the turn.",
			"If you must keep the turn for a result, call subagent_wait (blocks in-tool and returns the result) — never bash sleep/timeout to wait for a sub-agent.",
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
					registerRunResult(runId, result);
					return result;
				} catch (error) {
					finishRun(runId, "failed");
					const errorMessage = error instanceof Error ? error.message : String(error);
					const crashed = {
						...queuedResult(agent, task, thinkingLevel),
						exitCode: 1,
						stderr: errorMessage,
						stopReason: signal.aborted ? "aborted" : "error",
						errorMessage,
						dispatchFailed: true,
					};
					registerRunResult(runId, crashed);
					return crashed;
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
				runControllers.set(parentRunId, backgroundQueue.enqueue(
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
						// success, a stuck one needs a human). Register the parent's final
						// state (the last chain result) before removal so subagent_wait can
						// resolve it.
						registerRunResult(parentRunId, chain[chain.length - 1]);
						runControllers.delete(parentRunId);
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
						runControllers.delete(parentRunId);
						monitor.removeRun(parentRunId);
					},
					(error) => {
						// A crash inside the chain orchestration (failed runs are caught by
						// launchInLoop and delivered as part of the chain) must not vanish:
						// drop the retained parent row, notify, and deliver a failed result
						// so the main agent knows the chain never completed.
						registerRunResult(parentRunId, initialReviewerResult);
						runControllers.delete(parentRunId);
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
				));
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

				runControllers.set(runId, backgroundQueue.enqueue(
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
							registerRunResult(runId, result);
							runControllers.delete(runId);
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
						// Register before delivery so a concurrent subagent_wait resolves with
						// the result even though the run row is already gone from the monitor.
						registerRunResult(runId, result);
						runControllers.delete(runId);
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
					() => {
						runControllers.delete(runId);
						finishRun(runId, "failed");
					},
					(error) => {
						// The task body converts sub-agent failures into delivered results; an
						// exception escaping it (spawn infra, delivery API, ...) must not
						// vanish: notify the user and deliver a failed result so the main
						// agent knows the dispatch failed and can re-dispatch.
						const crashed = dispatchFailedResult(agent, task, error, thinkingLevel);
						finishRun(runId, "failed", { silent: true });
						registerRunResult(runId, crashed);
						runControllers.delete(runId);
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

	// Blocking wait: keeps the turn alive until the targeted run(s) settle, then
	// returns the actual result(s) to the model in-turn. Without it, a model that
	// must stay in the turn falls back to bash sleep/poll — blocking the turn and
	// delaying the very wake-up it is waiting for. Ending the turn and letting the
	// steer-delivered completion wake it is still the preferred path; this tool is
	// for when the result is needed NOW (sequential dependent steps).
	const SUBAGENT_WAIT_DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

	const SubagentWaitParams = Type.Object({
		id: Type.Optional(
			Type.String({
				description: "Run id or prefix shown in the subagent widget (#id). Omit to wait for all active runs in this session.",
			}),
		),
		timeoutMs: Type.Optional(
			Type.Number({
				description: `Give up after this many milliseconds and report the still-running runs (default ${SUBAGENT_WAIT_DEFAULT_TIMEOUT_MS}).`,
			}),
		),
	});

	pi.registerTool({
		name: "subagent_wait",
		label: "Subagent Wait",
		description: [
			"Block the current turn until background sub-agent run(s) finish, then return their results.",
			"Use ONLY when you must stay in the turn and act on the result immediately (sequential dependent steps).",
			"Prefer ending your turn after subagent — the result arrives automatically and wakes you.",
			"NEVER sleep, poll, or wait with bash to get a sub-agent result: end the turn, or call this tool.",
			"The same result is also delivered as a completion message that resumes the main agent, so you may see it twice (once here, once as a wake-up) — that is expected, not a duplicate.",
		].join(" "),
		promptSnippet: "Wait for a background subagent to finish and get its result in-turn (id: run id from the widget; omit for all).",
		promptGuidelines: [
			"Call subagent_wait only when you must keep the turn and need the result now — e.g. the next step depends on it.",
			"After dispatching via subagent, prefer ending the turn: the completion message wakes you automatically (no waiting).",
			"Never use bash sleep/timeout/polling to wait for a sub-agent — it blocks the turn and delays result delivery.",
			"If subagent_wait times out, call it again with a longer timeoutMs or end the turn and wait for the wake-up message.",
		],
		parameters: SubagentWaitParams,

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const config = await loadConfig(configPath);
			// A non-finite or negative timeout would produce a nonsensical note
			// ("timed out after Infinitys") or an instant "timeout" that was never
			// asked for; fall back to the default. Zero is honored as an immediate
			// give-up (clamped to 1ms below).
			const timeoutMs =
				typeof params.timeoutMs === "number" && Number.isFinite(params.timeoutMs) && params.timeoutMs >= 0
					? params.timeoutMs
					: SUBAGENT_WAIT_DEFAULT_TIMEOUT_MS;
			const isActive = (run: { status: string; retained?: boolean }): boolean =>
				run.status === "queued" || run.status === "running" || run.retained === true;

			const requested = params.id?.trim();
			// A run that already settled resolves immediately with its result.
			if (requested) {
				const settledIds = matchRunIds([...settledRuns.keys()], requested);
				if (settledIds.length > 0) {
					return {
						content: [
							{ type: "text", text: settledIds.map((id) => formatCompletionBlock(settledRuns.get(id)!, config.maxResultLines, ctx.cwd)).join("\n\n") },
						],
						details: {},
					};
				}
			}

			const activeRuns = monitor.getRuns().filter(isActive);
			const targetIds = requested ? matchRunIds(activeRuns.map((run) => run.id), requested) : activeRuns.map((run) => run.id);
			const targets = activeRuns.filter((run) => targetIds.includes(run.id));
			if (targets.length === 0) {
				const activeList = activeRuns.map((run) => `#${run.id} ${run.agent}`).join(", ");
				return {
					content: [
						{
							type: "text",
							text: requested
								? `No active subagent run matches "${requested}".${activeList ? ` Active runs: ${activeList}.` : ""}`
								: `No active subagent runs${activeList ? ` (active: ${activeList})` : " right now"}.`,
						},
					],
					details: {},
				};
			}

			const waitForRun = (runId: number): Promise<{ result?: SingleResult; note?: string }> => {
				const already = settledRuns.get(runId);
				if (already) return Promise.resolve({ result: already });
				return new Promise((resolve) => {
					let done = false;
					let timer: ReturnType<typeof setTimeout> | undefined;
					let unsub: (() => void) | undefined;
					const cleanup = (): void => {
						if (timer) clearTimeout(timer);
						if (unsub) unsub();
						signal?.removeEventListener("abort", onAbort);
						const listeners = settledListeners.get(runId);
						if (listeners) {
							listeners.delete(onSettled);
							if (listeners.size === 0) settledListeners.delete(runId);
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
						const current = settledRuns.get(runId);
						if (current) {
							finish({ result: current });
							return;
						}
						if (!monitor.findRun(runId)) {
							// Removal is followed synchronously by registerRunResult in the
							// finishing task; re-check on the next tick so the result wins.
							setTimeout(() => {
								const late = settledRuns.get(runId);
								if (late) finish({ result: late });
								else finish({ note: `run #${runId} was removed before its result was recorded (cancelled or session ended)` });
							}, 0);
						}
					};
					const onAbort = (): void => finish({ note: "wait aborted" });
					let listeners = settledListeners.get(runId);
					if (!listeners) {
						listeners = new Set();
						settledListeners.set(runId, listeners);
					}
					listeners.add(onSettled);
					unsub = monitor.subscribe(onMonitor);
					timer = setTimeout(
						() =>
							finish({
								note: `wait timed out after ${Math.round(timeoutMs / 1000)}s — run #${runId} is still active; call subagent_wait again or end the turn (the result will wake you when ready)`,
							}),
						Math.max(1, timeoutMs),
					);
					if (signal?.aborted) onAbort();
					else signal?.addEventListener("abort", onAbort, { once: true });
				});
			};

			const outcomes = await Promise.all(targets.map((run) => waitForRun(run.id)));
			const blocks = outcomes.map((outcome) =>
				outcome.result ? formatCompletionBlock(outcome.result, config.maxResultLines, ctx.cwd) : (outcome.note ?? "(no outcome)"),
			);
			return { content: [{ type: "text", text: blocks.join("\n\n") }], details: {} };
		},

		renderCall(args, theme) {
			const target = args.id ? `#${args.id}` : "all";
			return new Text(`${theme.fg("toolTitle", theme.bold("subagent_wait "))}${theme.fg("accent", target)}`, 0, 0);
		},

		renderResult(result, _options, theme) {
			const parts = (result.content ?? []) as Array<{ type: string; text?: string }>;
			const text = parts
				.map((part) => (typeof part.text === "string" ? part.text : ""))
				.join(" ")
				.trim();
			const firstLine = text.split("\n").find((line) => line.trim()) ?? "(no output)";
			return new Text(
				`${theme.fg("toolTitle", theme.bold("subagent_wait "))}${theme.fg("dim", firstLine.slice(0, 60))}`,
				0,
				0,
			);
		},
	});

	// Status overview: what is running right now and what finished this session,
	// with per-run details (id, agent, model, usage, elapsed, activity) so the
	// main agent can decide whether to wait, stop, or re-dispatch. Learned from
	// nicobailon/pi-subagents ({action:"status"} + status files): inspect before
	// you act, and report run ids when handing off.
	const SubagentStatusParams = Type.Object({
		id: Type.Optional(
			Type.String({
				description: "Run id or prefix to show the full result for (must already be finished; use subagent_wait to block on an active run).",
			}),
		),
	});

	pi.registerTool({
		name: "subagent_status",
		label: "Subagent Status",
		description: [
			"List active background sub-agent runs (id, agent, model, usage, elapsed, current activity) and recently finished results.",
			"Pass id to read the full result of a finished run; pass no id for the overview.",
			"Use it to decide whether to subagent_wait, subagent_stop, or re-dispatch — never to poll: results arrive by themselves.",
		].join(" "),
		promptSnippet: "Inspect background subagents: active runs, finished results, full result by id.",
		promptGuidelines: [
			"Call subagent_status to see what is running and what already finished; the widget shows the same live state.",
			"Never poll subagent_status in a loop to wait for a run: end the turn (you will be woken) or call subagent_wait.",
			"A finished run's id stays available for the session; its full result is one subagent_status call away.",
		],
		parameters: SubagentStatusParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const config = await loadConfig(configPath);
			const requested = params.id?.trim();

			if (requested) {
				const settledIds = matchRunIds([...settledRuns.keys()], requested);
				if (settledIds.length > 0) {
					return {
						content: [
							{ type: "text", text: settledIds.map((id) => formatCompletionBlock(settledRuns.get(id)!, config.maxResultLines, ctx.cwd)).join("\n\n") },
						],
						details: {},
					};
				}
				const runs = monitor.getRuns();
				const activeId = matchRunIds(runs.map((run) => run.id), requested)[0];
				const active = activeId === undefined ? undefined : runs.find((run) => run.id === activeId);
				if (active) {
					return {
						content: [
							{
								type: "text",
								text: `Run #${active.id} ${active.agent} is still active (${active.activity ?? statusLabel(active.status)}). Use subagent_wait to block for its result, or subagent_stop to cancel it.`,
							},
						],
						details: {},
					};
				}
				return { content: [{ type: "text", text: `No subagent run matches "${requested}".` }], details: {} };
			}

			const now = Date.now();
			const activeRuns = monitor.getRuns().filter(
				(run) => run.status === "queued" || run.status === "running" || run.retained,
			);
			const activeLines = activeRuns.map((run) => {
				const parts = [
					`#${run.id} ${run.agent}`,
					run.model ?? "?",
					formatUsageCompact(run.usage),
					formatElapsed(run, now),
				].filter(Boolean);
				return `- ${parts.join(" · ")} · ${run.activity ?? statusLabel(run.status)}`;
			});
			const completed = [...settledRuns.entries()].slice(-5);
			const completedLines = completed.map(([id, result]) => {
				const usage = formatUsage(result.usage);
				return `- #${id} ${result.agent} · ${isFailedResult(result) ? "failed" : "completed"}${usage ? ` · ${usage}` : ""}`;
			});

			const sections: string[] = [];
			sections.push(`### Active subagent runs (${activeRuns.length})`);
			sections.push(activeLines.length > 0 ? activeLines.join("\n") : "(none)");
			sections.push(`### Finished this session (${settledRuns.size})`);
			sections.push(completedLines.length > 0 ? completedLines.join("\n") : "(none)");
			sections.push("Pass a run id to subagent_status for the full result, or subagent_wait to block for an active run.");
			return { content: [{ type: "text", text: sections.join("\n\n") }], details: {} };
		},

		renderCall(args, theme) {
			return new Text(
				`${theme.fg("toolTitle", theme.bold("subagent_status "))}${theme.fg("accent", args.id ? `#${args.id}` : "overview")}`,
				0,
				0,
			);
		},

		renderResult(result, _options, theme) {
			const parts = (result.content ?? []) as Array<{ type: string; text?: string }>;
			const text = parts
				.map((part) => (typeof part.text === "string" ? part.text : ""))
				.join(" ")
				.trim();
			const firstLine = text.split("\n").find((line) => line.trim()) ?? "(no output)";
			return new Text(
				`${theme.fg("toolTitle", theme.bold("subagent_status "))}${theme.fg("dim", firstLine.slice(0, 60))}`,
				0,
				0,
			);
		},
	});

	// Cancel one or more active runs: aborts the queue controller, which
	// terminates the child and delivers an aborted result (with whatever partial
	// output it produced) so the main agent always knows the run stopped.
	const SubagentStopParams = Type.Object({
		id: Type.Optional(
			Type.String({
				description: "Run id or prefix to stop (see the widget or subagent_status).",
			}),
		),
		all: Type.Optional(Type.Boolean({ description: "Stop every active run (default false)." })),
	});

	pi.registerTool({
		name: "subagent_stop",
		label: "Subagent Stop",
		description: [
			"Cancel one or more active background sub-agent runs: the child process is terminated and an aborted result (with partial output) is delivered.",
			"Pass id (run id or prefix) to stop one run, or all: true to stop every active run.",
		].join(" "),
		promptSnippet: "Stop a running background subagent (id from the widget/subagent_status; or all: true).",
		promptGuidelines: [
			"Stop a run when its task is obsolete, stuck, or superseded — do not leave it burning tokens.",
			"A stopped run reports as failed with 'aborted' and its partial output, so the next step knows it did not complete.",
		],
		parameters: SubagentStopParams,

		async execute(_toolCallId, params, _signal, _onUpdate) {
			const targets =
				params.all === true
					? [...runControllers.keys()]
					: params.id !== undefined && params.id.trim() !== ""
						? matchRunIds([...runControllers.keys()], params.id!.trim())
						: [];

			if (targets.length === 0) {
				const activeList = [...runControllers.keys()].map((id) => `#${id}`).join(", ");
				return {
					content: [
						{
							type: "text",
							text:
								params.all === true
									? "No active subagent runs to stop."
									: `No active subagent run matches "${params.id}".${activeList ? ` Active runs: ${activeList}.` : ""}`,
						},
					],
					details: {},
				};
			}

			const stopped: string[] = [];
			for (const runId of targets) {
				const run = monitor.findRun(runId);
				if (!run) {
					runControllers.delete(runId);
					continue;
				}
				// Abort before registering the synthetic result: abort() only marks the
				// queue entry (drain delivers the cancellation callback later), so the
				// has() re-check right after it distinguishes an entry that never ran
				// from one whose task already started under a stale "queued" status —
				// a started task owns its own (real, partial-output) result.
				const controller = runControllers.get(runId);
				controller?.abort();
				// A queued run never reaches the child-spawn code path, so its abort
				// goes through the queue's cancelled callback with no result object;
				// register a synthetic aborted result so subagent_wait resolves.
				if (run.status === "queued" && runControllers.has(runId)) {
					registerRunResult(runId, {
						agent: run.agent,
						agentSource: "builtin",
						task: run.task,
						exitCode: 1,
						messages: [],
						stderr: "Stopped by subagent_stop before the run started.",
						usage: emptyUsage(),
						model: run.model,
						thinking: run.thinking,
						stopReason: "aborted",
						errorMessage: "Stopped by subagent_stop before the run started.",
					});
				}
				stopped.push(`#${runId} ${run.agent}${run.status === "queued" ? " (queued)" : ""}`);
			}
			return {
				content: [
					{
						type: "text",
						text: `Stopped ${stopped.length} run${stopped.length === 1 ? "" : "s"}: ${stopped.join(", ")}. An aborted result (with partial output) is delivered.`,
					},
				],
				details: {},
			};
		},

		renderCall(args, theme) {
			return new Text(
				`${theme.fg("toolTitle", theme.bold("subagent_stop "))}${theme.fg("accent", args.all === true ? "all" : args.id ? `#${args.id}` : "?")}`,
				0,
				0,
			);
		},

		renderResult(result, _options, theme) {
			const parts = (result.content ?? []) as Array<{ type: string; text?: string }>;
			const text = parts
				.map((part) => (typeof part.text === "string" ? part.text : ""))
				.join(" ")
				.trim();
			const firstLine = text.split("\n").find((line) => line.trim()) ?? "(no output)";
			return new Text(
				`${theme.fg("toolTitle", theme.bold("subagent_stop "))}${theme.fg("dim", firstLine.slice(0, 60))}`,
				0,
				0,
			);
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
