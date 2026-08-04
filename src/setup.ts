/**
 * Interactive configuration wizard for /subagents-setup.
 *
 * Everything is selection-driven (no free-text answers): a multi-select for which
 * agents to enable, a per-agent single-select for model overrides (fuzzy filter +
 * paging), and simple menus for the injection toggle and agent scope. Config is
 * written to <agentDir>/pi-subagents.json.
 */

import { stat } from "node:fs/promises";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
	AGENT_SCOPE_VALUES,
	BUILTIN_AGENT_NAMES,
	DEFAULT_CONFIG,
	DEFAULT_ENABLED_AGENTS,
	DEFAULT_MAX_CONCURRENCY,
	DEFAULT_MAX_PARALLEL_TASKS,
	THINKING_LEVEL_VALUES,
	type AgentScope,
	type SubagentsConfig,
	type ThinkingLevel,
	errorMessage,
	getConfigPath,
	loadConfig,
	saveConfig,
} from "./config.ts";
import { availableModelRefs, repairUnavailableModelOverrides } from "./models.ts";
import { promptSelectMany, promptSelectOne } from "./ui.ts";
import { loadBuiltinAgents } from "./agents.ts";

const INHERIT = "__inherit__";

/** Effective per-agent default strength from builtin frontmatter (config overrides win at spawn). */
function builtinThinkingDefaults(): Map<string, ThinkingLevel> {
	const map = new Map<string, ThinkingLevel>();
	for (const agent of loadBuiltinAgents()) {
		if (agent.thinking) map.set(agent.name, agent.thinking);
	}
	return map;
}

/** Short, selection-friendly descriptions for the built-in agents. */
const MODULE_HINTS: Record<string, string> = {
	explore: "read-only codebase recon (fast model)",
	worker: "implement / fix / refactor / test (full tools)",
	reviewer: "adversarial pre-commit review (read-only)",
};

function moduleLabel(name: string): string {
	const hint = MODULE_HINTS[name];
	return hint ? `${name} — ${hint}` : name;
}

async function configExists(configPath: string): Promise<boolean> {
	try {
		await stat(configPath);
		return true;
	} catch {
		return false;
	}
}

async function pickEnabledAgents(
	ctx: ExtensionCommandContext,
	current: readonly string[],
): Promise<string[] | undefined> {
	const items = BUILTIN_AGENT_NAMES.map((name) => ({ value: name, label: moduleLabel(name) }));
	return promptSelectMany(
		ctx,
		"Enable which sub-agents?",
		"Space toggles • Enter confirms • Esc cancels",
		items,
		current,
	);
}

async function pickAgentModelsAndStrength(
	ctx: ExtensionCommandContext,
	enabledAgents: readonly string[],
	currentModels: Record<string, string>,
	currentStrengths: Record<string, ThinkingLevel>,
	defaultLevel: ThinkingLevel,
	defaults: ReadonlyMap<string, ThinkingLevel>,
): Promise<{ models: Record<string, string>; strengths: Record<string, ThinkingLevel> } | undefined> {
	const refs = availableModelRefs(ctx);
	if (refs.length === 0) {
		ctx.ui.notify("No Pi models are currently available; model overrides left unchanged.", "warning");
		return { models: { ...currentModels }, strengths: { ...currentStrengths } };
	}

	const models: Record<string, string> = {};
	const strengths: Record<string, ThinkingLevel> = {};
	for (const name of enabledAgents) {
		const currentRef = currentModels[name];
		const items = [
			{
				value: INHERIT,
				label: currentRef
					? `(use main session's model — drop override "${currentRef}")`
					: "(use main session's current model — no override)",
			},
			...refs.map((ref) => ({ value: ref, label: ref === currentRef ? `${ref} (current)` : ref })),
		];
		const choice = await promptSelectOne(
			ctx,
			`Model for "${name}"`,
			"Type to filter • ↑/↓ • PgUp/PgDn • Enter selects • Esc cancels setup",
			items,
		);
		if (choice === undefined) return undefined; // Esc aborts the whole wizard
		if (choice !== INHERIT) models[name] = choice;

		// Convenience: the model pick is immediately followed by the strength pick,
		// so per-agent model + strength are configured in one pass.
		const strength = await pickAgentStrength(ctx, name, currentStrengths[name], defaultLevel, defaults);
		if (strength === undefined) return undefined; // Esc aborts the whole wizard
		if (strength !== INHERIT) strengths[name] = strength;
	}
	return { models, strengths };
}

const THINKING_LEVEL_HINTS: Record<ThinkingLevel, string> = {
	off: "no reasoning tokens (fastest)",
	minimal: "minimal reasoning",
	low: "light reasoning",
	medium: "balanced reasoning",
	high: "deep reasoning",
	xhigh: "extra-deep reasoning",
	max: "strongest reasoning",
};

/** Single strength pick for one agent; the inherit option keeps the effective default. */
async function pickAgentStrength(
	ctx: ExtensionCommandContext,
	agentName: string,
	current: ThinkingLevel | undefined,
	defaultLevel: ThinkingLevel,
	defaults: ReadonlyMap<string, ThinkingLevel>,
): Promise<ThinkingLevel | typeof INHERIT | undefined> {
	const options = THINKING_LEVEL_VALUES.map((level) => ({
		value: level,
		label: current === level ? `${level} — ${THINKING_LEVEL_HINTS[level]} (current)` : `${level} — ${THINKING_LEVEL_HINTS[level]}`,
	}));
	const agentDefault = defaults.get(agentName);
	const inheritLabel = agentDefault
		? `(inherit agent default — ${agentDefault})`
		: `(inherit global default — ${defaultLevel})`;
	const choice = await promptSelectOne(
		ctx,
		`Thinking strength for "${agentName}"?`,
		"Type to filter • ↑/↓ • Enter selects • Esc cancels setup",
		[{ value: INHERIT, label: inheritLabel }, ...options],
	);
	if (choice === undefined) return undefined;
	return choice === INHERIT ? INHERIT : (choice as ThinkingLevel);
}

/** Strength picks for every enabled agent (inherit keeps the effective default). */
async function pickAgentStrengths(
	ctx: ExtensionCommandContext,
	enabledAgents: readonly string[],
	currentStrengths: Record<string, ThinkingLevel>,
	defaultLevel: ThinkingLevel,
	defaults: ReadonlyMap<string, ThinkingLevel>,
): Promise<Record<string, ThinkingLevel> | undefined> {
	const strengths: Record<string, ThinkingLevel> = {};
	for (const name of enabledAgents) {
		const strength = await pickAgentStrength(ctx, name, currentStrengths[name], defaultLevel, defaults);
		if (strength === undefined) return undefined; // Esc aborts
		if (strength !== INHERIT) strengths[name] = strength;
	}
	return strengths;
}

async function pickThinkingLevel(
	ctx: ExtensionCommandContext,
	current: ThinkingLevel,
): Promise<ThinkingLevel | undefined> {
	const options = THINKING_LEVEL_VALUES.map((level) =>
		level === current ? `${level} — ${THINKING_LEVEL_HINTS[level]} (current)` : `${level} — ${THINKING_LEVEL_HINTS[level]}`,
	);
	const choice = await ctx.ui.select("Default thinking strength for sub-agents?", options);
	if (choice === undefined) return undefined;
	return THINKING_LEVEL_VALUES.find((level) => choice.startsWith(`${level} —`));
}

async function pickInjection(ctx: ExtensionCommandContext, current: boolean): Promise<boolean | undefined> {
	const on = "On — inject the delegation directive into the system prompt (recommended)";
	const off = "Off — do not inject (rely on the tool description alone)";
	const choice = await ctx.ui.select("Proactive dispatch injection?", [current ? `${on} (current)` : on, current ? off : `${off} (current)`]);
	if (choice === undefined) return undefined;
	return choice.startsWith("On");
}

/** Preset steps offered for the two numeric limits (selection-only wizard). */
const CONCURRENCY_STEPS = [1, 2, 3, 4, 6, 8, 12, 16];
const PARALLEL_TASK_STEPS = [2, 4, 6, 8, 12, 16, 24, 32];

async function pickCount(
	ctx: ExtensionCommandContext,
	title: string,
	steps: readonly number[],
	current: number,
	defaultValue: number,
): Promise<number | undefined> {
	const values = [...new Set([...steps, current])].sort((a, b) => a - b);
	const options = values.map((value) => {
		const tags = [value === current ? "current" : "", value === defaultValue ? "default" : ""]
			.filter(Boolean)
			.join(", ");
		return tags ? `${value} (${tags})` : String(value);
	});
	const choice = await ctx.ui.select(title, options);
	if (choice === undefined) return undefined;
	return Number.parseInt(choice, 10);
}

async function pickScope(ctx: ExtensionCommandContext, current: AgentScope): Promise<AgentScope | undefined> {
	const labels: Record<AgentScope, string> = {
		user: "user — built-in + ~/.pi/agent/agents (default)",
		project: "project — built-in + nearest .pi/agents only",
		both: "both — user agents, overridden by project agents",
	};
	const options = AGENT_SCOPE_VALUES.map((scope) =>
		scope === current ? `${labels[scope]} (current)` : labels[scope],
	);
	const choice = await ctx.ui.select("Which agent directories to discover from?", options);
	if (choice === undefined) return undefined;
	const scope = AGENT_SCOPE_VALUES.find((s) => choice.startsWith(s));
	return scope;
}

/** Replace unavailable overrides with a model usable by the current main window. */
function repairStaleModels(ctx: ExtensionCommandContext, agentModels: Record<string, string>): Record<string, string> {
	const repair = repairUnavailableModelOverrides(ctx, agentModels);
	if (repair.changed) {
		const detail = repair.fallbackRef
			? `Switched ${repair.replaced} unavailable model override(s) to ${repair.fallbackRef}.`
			: `Removed ${repair.removed} unavailable model override(s); no model is currently available.`;
		ctx.ui.notify(detail, "warning");
	}
	return repair.agentModels;
}

async function repairConfigModels(
	ctx: ExtensionCommandContext,
	configPath: string,
	config: SubagentsConfig,
): Promise<SubagentsConfig> {
	const repairedModels = repairUnavailableModelOverrides(ctx, config.agentModels);
	if (!repairedModels.changed) return config;

	const repaired = { ...config, agentModels: repairedModels.agentModels };
	try {
		await saveConfig(repaired, configPath);
		ctx.ui.notify(`Repaired unavailable model overrides in ${configPath}.`, "warning");
	} catch (error) {
		ctx.ui.notify(`Could not persist repaired model overrides: ${errorMessage(error)}`, "warning");
	}
	return repaired;
}

async function runFullSetup(ctx: ExtensionCommandContext, configPath: string, base: SubagentsConfig): Promise<void> {
	const enabled = await pickEnabledAgents(ctx, base.enabledAgents);
	if (enabled === undefined) return notifyCancelled(ctx);

	// Global default first, so per-agent strength picks can show "inherit" against it.
	const thinkingLevel = await pickThinkingLevel(ctx, base.thinkingLevel);
	if (thinkingLevel === undefined) return notifyCancelled(ctx);

	const defaults = builtinThinkingDefaults();
	const picked = await pickAgentModelsAndStrength(ctx, enabled, base.agentModels, base.agentThinkingLevels, thinkingLevel, defaults);
	if (picked === undefined) return notifyCancelled(ctx);

	const injection = await pickInjection(ctx, base.proactiveInjection);
	if (injection === undefined) return notifyCancelled(ctx);

	const scope = await pickScope(ctx, base.agentScope);
	if (scope === undefined) return notifyCancelled(ctx);

	const maxConcurrency = await pickCount(
		ctx,
		"Max sub-agents running at once? (extra work queues)",
		CONCURRENCY_STEPS,
		base.maxConcurrency,
		DEFAULT_MAX_CONCURRENCY,
	);
	if (maxConcurrency === undefined) return notifyCancelled(ctx);

	const maxParallelTasks = await pickCount(
		ctx,
		"Max tasks in one parallel subagent call?",
		PARALLEL_TASK_STEPS,
		base.maxParallelTasks,
		DEFAULT_MAX_PARALLEL_TASKS,
	);
	if (maxParallelTasks === undefined) return notifyCancelled(ctx);

	const next: SubagentsConfig = {
		enabledAgents: enabled,
		agentModels: repairStaleModels(ctx, picked.models),
		agentThinkingLevels: picked.strengths,
		thinkingLevel,
		notifyOnReviewPass: base.notifyOnReviewPass,
		maxResultLines: base.maxResultLines,
		proactiveInjection: injection,
		agentScope: scope,
		maxConcurrency,
		maxParallelTasks,
		maxSubagentDepth: base.maxSubagentDepth,
	};
	await saveConfig(next, configPath);
	ctx.ui.notify(`pi-subagents configured. Saved to ${configPath}`, "info");
}

async function runMenu(ctx: ExtensionCommandContext, configPath: string, config: SubagentsConfig): Promise<void> {
	const choice = await ctx.ui.select("pi-subagents is already configured. What would you like to change?", [
		"Enable/disable agents",
		"Change agent models",
		"Change thinking strength",
		"Toggle proactive injection",
		"Change agent scope",
		"Change max concurrent sub-agents",
		"Change max parallel tasks",
		"Full re-setup",
	]);
	if (choice === undefined) return notifyCancelled(ctx);

	if (choice.startsWith("Full")) return runFullSetup(ctx, configPath, config);

	let next: SubagentsConfig = { ...config, agentModels: { ...config.agentModels } };

	if (choice.startsWith("Enable")) {
		const enabled = await pickEnabledAgents(ctx, config.enabledAgents);
		if (enabled === undefined) return notifyCancelled(ctx);
		next.enabledAgents = enabled;
	} else if (choice.startsWith("Change agent models")) {
		const defaults = builtinThinkingDefaults();
		const picked = await pickAgentModelsAndStrength(
			ctx,
			config.enabledAgents,
			config.agentModels,
			config.agentThinkingLevels,
			config.thinkingLevel,
			defaults,
		);
		if (picked === undefined) return notifyCancelled(ctx);
		next.agentModels = repairStaleModels(ctx, picked.models);
		next.agentThinkingLevels = picked.strengths;
	} else if (choice.startsWith("Change thinking")) {
		// Global first so per-agent "inherit" labels reflect the value that will be stored.
		const thinkingLevel = await pickThinkingLevel(ctx, config.thinkingLevel);
		if (thinkingLevel === undefined) return notifyCancelled(ctx);
		next.thinkingLevel = thinkingLevel;
		const strengths = await pickAgentStrengths(ctx, config.enabledAgents, config.agentThinkingLevels, thinkingLevel, builtinThinkingDefaults());
		if (strengths === undefined) return notifyCancelled(ctx);
		next.agentThinkingLevels = strengths;
	} else if (choice.startsWith("Toggle")) {
		const injection = await pickInjection(ctx, config.proactiveInjection);
		if (injection === undefined) return notifyCancelled(ctx);
		next.proactiveInjection = injection;
	} else if (choice.startsWith("Change agent scope")) {
		const scope = await pickScope(ctx, config.agentScope);
		if (scope === undefined) return notifyCancelled(ctx);
		next.agentScope = scope;
	} else if (choice.startsWith("Change max concurrent")) {
		const maxConcurrency = await pickCount(
			ctx,
			"Max sub-agents running at once? (extra work queues)",
			CONCURRENCY_STEPS,
			config.maxConcurrency,
			DEFAULT_MAX_CONCURRENCY,
		);
		if (maxConcurrency === undefined) return notifyCancelled(ctx);
		next.maxConcurrency = maxConcurrency;
	} else if (choice.startsWith("Change max parallel")) {
		const maxParallelTasks = await pickCount(
			ctx,
			"Max tasks in one parallel subagent call?",
			PARALLEL_TASK_STEPS,
			config.maxParallelTasks,
			DEFAULT_MAX_PARALLEL_TASKS,
		);
		if (maxParallelTasks === undefined) return notifyCancelled(ctx);
		next.maxParallelTasks = maxParallelTasks;
	}

	await saveConfig(next, configPath);
	ctx.ui.notify(`pi-subagents updated. Saved to ${configPath}`, "info");
}

function notifyCancelled(ctx: ExtensionCommandContext): void {
	ctx.ui.notify("pi-subagents setup cancelled.", "info");
}

/** Entry point for the /subagents-setup command. */
export async function runSetup(ctx: ExtensionCommandContext, configPath: string = getConfigPath()): Promise<void> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify("/subagents-setup requires Pi's interactive TUI.", "error");
		return;
	}
	try {
		const exists = await configExists(configPath);
		const loaded = await loadConfig(configPath);
		const config = await repairConfigModels(ctx, configPath, loaded);
		if (exists) await runMenu(ctx, configPath, config);
		else await runFullSetup(ctx, configPath, { ...DEFAULT_CONFIG, enabledAgents: [...DEFAULT_ENABLED_AGENTS] });
	} catch (error) {
		ctx.ui.notify(`pi-subagents setup failed: ${errorMessage(error)}`, "error");
	}
}
