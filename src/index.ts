/**
 * pi-subagents — focused sub-agent delegation for pi.
 *
 * Registers:
 *   - a `subagent` tool that runs explore/plan/worker/reviewer agents as isolated
 *     `pi` child processes (single or parallel),
 *   - a `/subagents-setup` command for selection-only configuration,
 *   - a `before_agent_start` hook that injects a delegation directive into the
 *     parent system prompt so the main model uses the tool proactively.
 *
 * The tool is NOT registered inside nested sub-agent processes beyond
 * MAX_SUBAGENT_DEPTH, which both prevents runaway recursion and keeps child
 * context windows clean.
 */

import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { StringEnum } from "@earendil-works/pi-ai";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { discoverAgents, type AgentConfig } from "./agents.ts";
import { getConfigPath, loadConfig } from "./config.ts";
import { buildDelegationDirective } from "./prompt.ts";
import { runSetup } from "./setup.ts";
import {
	MAX_CONCURRENCY,
	MAX_PARALLEL_TASKS,
	MAX_SUBAGENT_DEPTH,
	currentSubagentDepth,
	getFinalOutput,
	getResultOutput,
	isFailedResult,
	mapWithConcurrencyLimit,
	runSingleAgent,
	truncateParallelOutput,
	type OnUpdateCallback,
	type SingleResult,
	type SubagentDetails,
	type UsageStats,
} from "./spawn.ts";

const TaskItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Self-contained task to delegate (the agent has no memory of this conversation)" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
});

const SubagentParams = Type.Object({
	agent: Type.Optional(Type.String({ description: "Name of the agent to invoke (single mode)" })),
	task: Type.Optional(Type.String({ description: "Self-contained task to delegate (single mode)" })),
	tasks: Type.Optional(Type.Array(TaskItem, { description: "Array of {agent, task} for parallel execution" })),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process (single mode)" })),
});

function emptyUsage(): UsageStats {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
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

export default function (pi: ExtensionAPI): void {
	const configPath = getConfigPath(getAgentDir());

	// Recursion guard: do not register the tool deep inside nested sub-agents.
	if (currentSubagentDepth() >= MAX_SUBAGENT_DEPTH) {
		pi.registerCommand("subagents-setup", {
			description: "Configure pi-subagents (disabled in nested sub-agent processes)",
			handler: async (_args, ctx) => {
				ctx.ui.notify("pi-subagents setup is unavailable inside a nested sub-agent.", "warning");
			},
		});
		return;
	}

	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: [
			"Delegate a discrete, self-contained task to a specialized sub-agent running in an ISOLATED context window.",
			"Agents: explore (read-only codebase recon), plan (implementation plan, opt-in), worker (implement/fix/refactor/test, full tools), reviewer (adversarial pre-commit review, read-only).",
			"Modes: single ({agent, task}) or parallel ({tasks: [{agent, task}, ...]}).",
			"Use it to keep the main conversation clean: delegate the work, then orchestrate and verify the results yourself.",
			"Each agent has no memory of this conversation — brief it fully (goal, exact paths, constraints, expected output).",
		].join(" "),
		promptSnippet:
			"Delegate discrete tasks to isolated sub-agents: explore (read-only search), worker (implement), reviewer (adversarial pre-commit review); plan is opt-in.",
		promptGuidelines: [
			"Use subagent to delegate discrete, self-contained tasks so the main context stays clean; do orchestration and verification yourself.",
			"Use subagent with agent 'explore' for broad or open-ended code search before large changes.",
			"Use subagent with agent 'worker' to implement a well-scoped task; it plans internally.",
			"Use subagent with agent 'reviewer' for a fresh read-only review before reporting work done or committing.",
			"Run independent tasks in parallel by passing a tasks array to subagent; keep dependent work sequential.",
		],
		parameters: SubagentParams,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const config = await loadConfig(configPath);
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
			const hasSingle = Boolean(params.agent && params.task);

			const makeDetails =
				(mode: "single" | "parallel") =>
				(results: SingleResult[]): SubagentDetails => ({ mode, results });

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

			// ---- Parallel mode ----
			if (params.tasks && params.tasks.length > 0) {
				if (params.tasks.length > MAX_PARALLEL_TASKS) {
					return {
						content: [
							{ type: "text", text: `Too many parallel tasks (${params.tasks.length}). Max is ${MAX_PARALLEL_TASKS}.` },
						],
						details: makeDetails("parallel")([]),
					};
				}

				const allResults: SingleResult[] = params.tasks.map((t) => ({
					agent: t.agent,
					agentSource: "unknown",
					task: t.task,
					exitCode: -1,
					messages: [],
					stderr: "",
					usage: emptyUsage(),
				}));

				const emitParallelUpdate = (): void => {
					if (!onUpdate) return;
					const done = allResults.filter((r) => r.exitCode !== -1).length;
					onUpdate({
						content: [{ type: "text", text: `Parallel: ${done}/${allResults.length} done...` }],
						details: makeDetails("parallel")([...allResults]),
					});
				};

				const results = await mapWithConcurrencyLimit(params.tasks, MAX_CONCURRENCY, async (t, index) => {
					const perTaskUpdate: OnUpdateCallback | undefined = onUpdate
						? (partial) => {
								const current = partial.details?.results[0];
								if (current) {
									allResults[index] = current;
									emitParallelUpdate();
								}
							}
						: undefined;
					const result = await runSingleAgent({
						defaultCwd: ctx.cwd,
						agent: agents.find((a) => a.name === t.agent),
						agentName: t.agent,
						task: t.task,
						cwd: t.cwd,
						signal,
						onUpdate: perTaskUpdate,
						makeDetails: makeDetails("parallel"),
					});
					allResults[index] = result;
					emitParallelUpdate();
					return result;
				});

				const successCount = results.filter((r) => !isFailedResult(r)).length;
				const summaries = results.map((r) => {
					const output = truncateParallelOutput(getResultOutput(r));
					const status = isFailedResult(r) ? "failed" : "completed";
					const usage = formatUsage(r.usage);
					return `### [${r.agent}] ${status}${usage ? ` (${usage})` : ""}\n\n${output}`;
				});
				return {
					content: [
						{
							type: "text",
							text: `Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n---\n\n")}`,
						},
					],
					details: makeDetails("parallel")(results),
				};
			}

			// ---- Single mode ----
			const result = await runSingleAgent({
				defaultCwd: ctx.cwd,
				agent: agents.find((a) => a.name === params.agent),
				agentName: params.agent as string,
				task: params.task as string,
				cwd: params.cwd,
				signal,
				onUpdate,
				makeDetails: makeDetails("single"),
			});

			if (isFailedResult(result)) {
				return {
					content: [{ type: "text", text: `Agent ${result.agent} ${result.stopReason || "failed"}: ${getResultOutput(result)}` }],
					details: makeDetails("single")([result]),
					isError: true,
				};
			}
			return {
				content: [{ type: "text", text: getFinalOutput(result.messages) || "(no output)" }],
				details: makeDetails("single")([result]),
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
			const usage = formatUsage(aggregateUsage(details.results));
			const header =
				details.mode === "parallel"
					? `${theme.fg("toolTitle", theme.bold("subagent "))}${theme.fg("accent", `parallel (${details.results.length})`)}`
					: `${theme.fg("toolTitle", theme.bold("subagent "))}${theme.fg("accent", details.results[0].agent)}`;
			const suffix = usage ? `  ${theme.fg("dim", usage)}` : "";
			return new Text(header + suffix, 0, 0);
		},
	});

	pi.registerCommand("subagents-setup", {
		description: "Configure pi-subagents: enable agents, pick per-agent models, toggle proactive injection",
		handler: async (_args, ctx) => {
			await runSetup(ctx, configPath);
		},
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
