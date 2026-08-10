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
	DEFAULT_IDLE_TIMEOUT_SEC,
	DEFAULT_MAX_CONCURRENCY,
	DEFAULT_MAX_FIX_ROUNDS,
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

/** Single-agent model pick; the inherit option drops any existing override.
 * `escNote` describes what Esc does at this pick (whole-wizard cancel in the
 * full setup vs. ending the per-agent loop in the menu). */
async function pickAgentModel(
	ctx: ExtensionCommandContext,
	name: string,
	currentRef: string | undefined,
	refs: readonly string[],
	escNote = "cancels setup",
): Promise<string | typeof INHERIT | undefined> {
	const items = [
		{
			value: INHERIT,
			label: currentRef
				? `(use main session's model — drop override "${currentRef}")`
				: "(use main session's current model — no override)",
		},
		...refs.map((ref) => ({ value: ref, label: ref === currentRef ? `${ref} (current)` : ref })),
	];
	return promptSelectOne(
		ctx,
		`Model for "${name}"`,
		`Type to filter • ↑/↓ • PgUp/PgDn • Enter selects • Esc ${escNote}`,
		items,
	);
}

/** Vision model pick for image tasks (screenshots/mockups); the inherit option
 * leaves it unset, so vision-flagged dispatches fall back to the main session's
 * current model. */
async function pickVisionModel(
	ctx: ExtensionCommandContext,
	currentRef: string | undefined,
	refs: readonly string[],
): Promise<string | typeof INHERIT | undefined> {
	const items = [
		{
			value: INHERIT,
			label: currentRef
				? `(not set — vision tasks fall back to the main session's model; drop "${currentRef}")`
				: "(not set — vision tasks fall back to the main session's current model)",
		},
		...refs.map((ref) => ({ value: ref, label: ref === currentRef ? `${ref} (current)` : ref })),
	];
	return promptSelectOne(
		ctx,
		"Vision-capable model for image tasks (screenshots, mockups, designs)?",
		"Type to filter • ↑/↓ • PgUp/PgDn • Enter selects • Esc cancels setup",
		items,
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
		const modelChoice = await pickAgentModel(ctx, name, currentModels[name], refs);
		if (modelChoice === undefined) return undefined; // Esc aborts the whole wizard
		if (modelChoice !== INHERIT) models[name] = modelChoice;

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

/** Single strength pick for one agent; the inherit option keeps the effective default.
 * `escNote` describes what Esc does at this pick (whole-wizard cancel in the
 * full setup vs. ending the per-agent loop in the menu). */
async function pickAgentStrength(
	ctx: ExtensionCommandContext,
	agentName: string,
	current: ThinkingLevel | undefined,
	defaultLevel: ThinkingLevel,
	defaults: ReadonlyMap<string, ThinkingLevel>,
	escNote = "cancels setup",
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
		`Type to filter • ↑/↓ • Enter selects • Esc ${escNote}`,
		[{ value: INHERIT, label: inheritLabel }, ...options],
	);
	if (choice === undefined) return undefined;
	return choice === INHERIT ? INHERIT : (choice as ThinkingLevel);
}

/** Pick one enabled agent to reconfigure. Resolves undefined on Esc. */
async function pickAgentToConfigure(
	ctx: ExtensionCommandContext,
	enabledAgents: readonly string[],
): Promise<string | undefined> {
	if (enabledAgents.length === 0) {
		ctx.ui.notify("No agents are enabled. Enable agents first.", "warning");
		return undefined;
	}
	const items = enabledAgents.map((name) => ({ value: name, label: moduleLabel(name) }));
	return promptSelectOne(
		ctx,
		"Configure which agent?",
		"Type to filter • ↑/↓ • PgUp/PgDn • Enter selects • Esc stops",
		items,
	);
}

/**
 * Configure a single agent picked from the enabled set: choose its model, then
 * its thinking strength. Only that one agent is touched, so re-running the menu
 * to tweak one agent no longer walks every enabled agent. Both picks offer an
 * "inherit" option that drops any existing per-agent override for that field.
 * Resolves undefined when the user presses Esc at any step; the caller keeps
 * changes from agents already configured earlier in the same pass.
 */
async function configureOneAgent(
	ctx: ExtensionCommandContext,
	enabledAgents: readonly string[],
	currentModels: Record<string, string>,
	currentStrengths: Record<string, ThinkingLevel>,
	defaultLevel: ThinkingLevel,
	defaults: ReadonlyMap<string, ThinkingLevel>,
): Promise<
	| {
			name: string;
			model: string | typeof INHERIT;
			modelsAvailable: boolean;
			strength: ThinkingLevel | typeof INHERIT;
	  }
	| undefined
> {
	const name = await pickAgentToConfigure(ctx, enabledAgents);
	if (name === undefined) return undefined; // Esc cancels

	const refs = availableModelRefs(ctx);
	const modelsAvailable = refs.length > 0;
	let model: string | typeof INHERIT = INHERIT;
	if (!modelsAvailable) {
		ctx.ui.notify("No Pi models are currently available; model override left unchanged.", "warning");
	} else {
		const modelChoice = await pickAgentModel(ctx, name, currentModels[name], refs, "stops — earlier agent picks are kept");
		if (modelChoice === undefined) return undefined; // Esc ends the loop
		model = modelChoice;
	}

	const strength = await pickAgentStrength(ctx, name, currentStrengths[name], defaultLevel, defaults, "stops — earlier agent picks are kept");
	if (strength === undefined) return undefined; // Esc ends the loop

	return { name, model, modelsAvailable, strength };
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
/** Preset rounds offered for the auto-fix loop (0 disables it). */
const FIX_ROUNDS_STEPS = [0, 1, 2, 3, 5];
/** Preset seconds offered for the idle timeout (0 disables it). */
const IDLE_TIMEOUT_STEPS = [0, 30, 60, 90, 120, 180, 300, 600];

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

	let nextVisionModel: string | undefined;
	// No models available: keep the vision model unset (vision tasks then fall
	// back to the main session's model) instead of showing a one-option picker.
	const refs = availableModelRefs(ctx);
	if (refs.length === 0) {
		ctx.ui.notify("No Pi models are currently available; vision model left unset.", "warning");
	} else {
		const visionModel = await pickVisionModel(ctx, base.visionModel, refs);
		if (visionModel === undefined) return notifyCancelled(ctx);
		if (visionModel !== INHERIT) nextVisionModel = visionModel;
	}

	const injection = await pickInjection(ctx, base.proactiveInjection);
	if (injection === undefined) return notifyCancelled(ctx);

	const scope = await pickScope(ctx, base.agentScope);
	if (scope === undefined) return notifyCancelled(ctx);

	const maxConcurrency = await pickCount(
		ctx,
		"Max sub-agents running at once (and per parallel call)? (extra work queues)",
		CONCURRENCY_STEPS,
		base.maxConcurrency,
		DEFAULT_MAX_CONCURRENCY,
	);
	if (maxConcurrency === undefined) return notifyCancelled(ctx);

		const maxFixRounds = await pickCount(
			ctx,
			"Auto-fix rounds when a reviewer returns REQUEST_CHANGES? (0 = main agent handles fixes)",
			FIX_ROUNDS_STEPS,
			base.maxFixRounds,
			DEFAULT_MAX_FIX_ROUNDS,
		);
		if (maxFixRounds === undefined) return notifyCancelled(ctx);

		const idleTimeoutSec = await pickCount(
			ctx,
			"Idle timeout in seconds? (0 = disabled, kills a sub-agent whose output goes silent)",
			IDLE_TIMEOUT_STEPS,
			base.idleTimeoutSec,
			DEFAULT_IDLE_TIMEOUT_SEC,
		);
		if (idleTimeoutSec === undefined) return notifyCancelled(ctx);

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
		maxFixRounds,
		idleTimeoutSec,
		announcedFeatures: base.announcedFeatures,
	};
	if (nextVisionModel !== undefined) next.visionModel = nextVisionModel;
	await saveConfig(next, configPath);
	ctx.ui.notify(`pi-subagents configured. Saved to ${configPath}`, "info");
}

async function runMenu(ctx: ExtensionCommandContext, configPath: string, config: SubagentsConfig): Promise<void> {
	const choice = await ctx.ui.select("pi-subagents is already configured. What would you like to change?", [
		"Enable/disable agents",
		"Configure an agent (model + thinking)",
		"Change vision model (image tasks)",
		"Toggle proactive injection",
		"Change agent scope",
		"Change max concurrent sub-agents",
		"Change max fix rounds",
		"Change idle timeout",
		"Full re-setup",
	]);
	if (choice === undefined) return notifyCancelled(ctx);

	if (choice.startsWith("Full")) return runFullSetup(ctx, configPath, config);

	let next: SubagentsConfig = { ...config, agentModels: { ...config.agentModels } };

	if (choice.startsWith("Enable")) {
		const enabled = await pickEnabledAgents(ctx, config.enabledAgents);
		if (enabled === undefined) return notifyCancelled(ctx);
		next.enabledAgents = enabled;
	} else if (choice.startsWith("Configure an agent")) {
		// Per-agent loop: pick one agent, then its model and thinking strength, then
		// return to the agent picker so several agents can be configured in one
		// pass. Esc at any step ends the loop; agents already configured in this
		// pass are kept.
		const defaults = builtinThinkingDefaults();
		let configuredAny = false;
		next.agentThinkingLevels = { ...config.agentThinkingLevels };
		while (true) {
			const picked = await configureOneAgent(
				ctx,
				next.enabledAgents,
				next.agentModels,
				next.agentThinkingLevels,
				next.thinkingLevel,
				defaults,
			);
			if (picked === undefined) break; // Esc ends the loop
			configuredAny = true;
			if (picked.modelsAvailable) {
				if (picked.model === INHERIT) delete next.agentModels[picked.name];
				else next.agentModels[picked.name] = picked.model;
			}
			if (picked.strength === INHERIT) delete next.agentThinkingLevels[picked.name];
			else next.agentThinkingLevels[picked.name] = picked.strength;
		}
		if (!configuredAny) return notifyCancelled(ctx);
		next.agentModels = repairStaleModels(ctx, next.agentModels);
	} else if (choice.startsWith("Toggle")) {
		const injection = await pickInjection(ctx, config.proactiveInjection);
		if (injection === undefined) return notifyCancelled(ctx);
		next.proactiveInjection = injection;
	} else if (choice.startsWith("Change vision")) {
		const refs = availableModelRefs(ctx);
		if (refs.length === 0) {
			ctx.ui.notify("No Pi models are currently available; vision model left unchanged.", "warning");
			return;
		}
		const visionModel = await pickVisionModel(ctx, config.visionModel, refs);
		if (visionModel === undefined) return notifyCancelled(ctx);
		if (visionModel === INHERIT) delete next.visionModel;
		else next.visionModel = visionModel;
	} else if (choice.startsWith("Change agent scope")) {
		const scope = await pickScope(ctx, config.agentScope);
		if (scope === undefined) return notifyCancelled(ctx);
		next.agentScope = scope;
	} else if (choice.startsWith("Change max concurrent")) {
		const maxConcurrency = await pickCount(
			ctx,
			"Max sub-agents running at once (and per parallel call)? (extra work queues)",
			CONCURRENCY_STEPS,
			config.maxConcurrency,
			DEFAULT_MAX_CONCURRENCY,
		);
		if (maxConcurrency === undefined) return notifyCancelled(ctx);
		next.maxConcurrency = maxConcurrency;
	} else if (choice.startsWith("Change max fix")) {
		const maxFixRounds = await pickCount(
			ctx,
			"Auto-fix rounds when a reviewer returns REQUEST_CHANGES? (0 = main agent handles fixes)",
			FIX_ROUNDS_STEPS,
			config.maxFixRounds,
			DEFAULT_MAX_FIX_ROUNDS,
		);
		if (maxFixRounds === undefined) return notifyCancelled(ctx);
		next.maxFixRounds = maxFixRounds;
	} else if (choice.startsWith("Change idle")) {
		const idleTimeoutSec = await pickCount(
			ctx,
			"Idle timeout in seconds? (0 = disabled, kills a sub-agent whose output goes silent)",
			IDLE_TIMEOUT_STEPS,
			config.idleTimeoutSec,
			DEFAULT_IDLE_TIMEOUT_SEC,
		);
		if (idleTimeoutSec === undefined) return notifyCancelled(ctx);
		next.idleTimeoutSec = idleTimeoutSec;
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
