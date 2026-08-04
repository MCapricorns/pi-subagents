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

import type { AgentToolResult } from "@earendil-works/pi-agent-core";
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
	getFinalOutput,
	getResultOutput,
	isFailedResult,
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
import { formatTaskSummary, formatToolActivity, monitor, statusColor, statusIcon, statusLabel, type RunChainMeta } from "./monitor.ts";

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
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	return parts.join(" ");
}

function formatCompletionBlock(result: SingleResult, maxResultLines: number): string {
	const status = isFailedResult(result) ? "failed" : "completed";
	const usage = formatUsage(result.usage);
	const output = getResultOutput(result);
	const { text, truncated } = truncateResultOutput(output, maxResultLines);
	const fallbackNote = result.modelFallbackFrom
		? ` (model fell back from ${result.modelFallbackFrom} to ${result.model ?? "main-window model"})`
		: "";
	const lines = [`### [${result.agent}] ${status}${usage ? ` (${usage})` : ""}${fallbackNote}`, "", `Task: ${formatTaskSummary(result.task)}`, "", text];
	if (truncated) {
		// The full text lives on disk so the main agent can read it on demand.
		lines.push("", `(output truncated to ${maxResultLines} lines; full result: ${writeResultArtifact(output, result.agent)})`);
	}
	return lines.join("\n");
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

	// Recursion guard: sub-agents at the configured depth are leaf processes and
	// cannot delegate again. maxSubagentDepth 0 disables the tool entirely.
	if (currentSubagentDepth() >= initialConfig.maxSubagentDepth) {
		const reason =
			initialConfig.maxSubagentDepth === 0
				? "disabled by maxSubagentDepth 0 in pi-subagents.json"
				: "disabled in nested sub-agent processes";
		pi.registerCommand("subagents-setup", {
			description: `Configure pi-subagents (${reason})`,
			handler: async (_args, ctx) => {
				ctx.ui.notify(`pi-subagents setup is unavailable here (${reason}).`, "warning");
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
		],
		parameters: SubagentParams,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
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
			const finishRun = (runId: number, status: "done" | "failed"): void => {
				monitor.setStatus(runId, status); // stamps endedAt for the elapsed time
				const run = monitor.removeRun(runId);
				if (!run) return; // already finished — stay idempotent
				if (!sessionActive) return;
				const icon = status === "done" ? "✓" : "✗";
				ctx.ui.notify(`${icon} ${monitor.summarize(run)}`, status === "done" ? "info" : "error");
			};

			// Live sub-agent activity → concise one-line status ("thinking",
			// "read src/index.ts", ...), never a raw args blob.
			const makeLiveHandler = (runId: number) => (e: SubagentLiveEvent): void => {
				switch (e.kind) {
					case "status":
						if (e.status === "done" || e.status === "failed") finishRun(runId, e.status);
						else monitor.setStatus(runId, e.status);
						break;
					case "usage":
						monitor.setUsage(runId, e.usage, e.model);
						break;
					case "tool_start":
						monitor.setActivity(runId, formatToolActivity(e.toolName, e.args));
						break;
					case "tool_end":
						if (e.isError) monitor.setActivity(runId, `✗ ${e.toolName} failed`);
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
					};
				}
			};

			/**
			 * Run the auto-fix chain in the background: worker (briefed with the review's
			 * findings) → reviewer re-review, up to maxFixRounds times. The main agent is
			 * not woken mid-loop; the full chain is delivered as one group at the end.
			 * Failures short-circuit: a crashed worker skips its re-review and delivers.
			 */
			const startFixLoop = (initialReviewerResult: SingleResult, parentGroupId: string): void => {
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
							if (!sessionActive) break;
							if (reviewVerdict(getResultOutput(reviewResult)) === "pass") break;
						}
						if (!sessionActive) return;
						// Deliver the whole chain as one group; the loop's outcome always wakes
						// the main agent (a passing chain reports success, a stuck one needs a human).
						const items: CompletionMessageItem[] = chain.map((r) => ({
							agent: r.agent,
							block: formatCompletionBlock(r, config.maxResultLines),
							triggerTurn: true,
						}));
						sendCompletionGroup(items);
						completionBatcher.flush();
					},
					() => {
						// Cancelled: each in-flight run was already finished by its launchInLoop path.
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
							};
							finishRun(runId, "failed");
						}

						if (!sessionActive) return;
						// Auto-fix loop: a REVIEW_FAIL from a main-agent-dispatched reviewer
						// triggers a worker→reviewer chain (up to maxFixRounds) without waking
						// the main agent. Loop-internal re-reviews never reach here (they are
						// awaited inside launchInLoop); the initial review is delivered with
						// the chain at the end.
						if (shouldTriggerFixLoop(result, config)) {
							startFixLoop(result, `fix-${runId}`);
							return;
						}
						const failed = isFailedResult(result);
						const completion: CompletionMessageItem = {
							agent: result.agent,
							block: formatCompletionBlock(result, config.maxResultLines),
							triggerTurn: completionTriggersTurn(result, config.notifyOnReviewPass),
						};
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
				);

				return pending;
			};

			// Sub-agents intentionally detach from the foreground turn. This makes the
			// editor available immediately; completion messages later wake the main agent.
			if (params.tasks && params.tasks.length > 0) {
				if (params.tasks.length > config.maxParallelTasks) {
					return {
						content: [
							{
								type: "text",
								text: `Too many parallel tasks (${params.tasks.length}). Max is ${config.maxParallelTasks} (configurable via /subagents-setup).`,
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
					const preview = t.task.length > 48 ? `${t.task.slice(0, 48)}…` : t.task;
					text += `\n  ${theme.fg("accent", t.agent)} ${theme.fg("dim", preview)}`;
				}
				if (args.tasks.length > 4) text += `\n  ${theme.fg("dim", `… +${args.tasks.length - 4} more`)}`;
				return new Text(text, 0, 0);
			}
			const task: string = args.task ?? "";
			const preview = task.length > 60 ? `${task.slice(0, 60)}…` : task;
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
						const lines: string[] = [];
						for (const r of runs) {
							const icon = statusIcon(r.status, theme);
							const label = theme.fg(statusColor(r.status), statusLabel(r.status));
							// Chain-internal runs (auto-fix worker/reviewer) indent under their
							// parent reviewer; summarize() already carries the relationLabel.
							const head = r.groupId ? theme.fg("dim", "  ↳ ") : " ";
							lines.push(truncateToWidth(`${head}${icon} ${monitor.summarize(r)} · ${label}`, width, ""));
							if (r.status === "queued" || r.status === "running") {
								lines.push(truncateToWidth(theme.fg("dim", `     task: ${formatTaskSummary(r.task)}`), width, ""));
							}
							// Activity sits one indent level below the agent name.
							if (r.activity) lines.push(truncateToWidth(theme.fg("dim", `     ${r.activity}`), width, ""));
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
