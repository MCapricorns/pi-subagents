/**
 * Interactive configuration wizard for /subagents-setup.
 *
 * The UI intentionally has no backup pool or global thinking menu. Each agent
 * gets one optional model override; failures hand directly to the current main
 * model. Thinking defaults to Auto and manual choices are limited to levels Pi
 * reports as supported by the selected model.
 */

import { stat } from "node:fs/promises";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
	AGENT_SCOPE_VALUES,
	BUILTIN_AGENT_NAMES,
	CLEANER_DEFAULTED_FEATURE,
	DOCUMENTER_DEFAULTED_FEATURE,
	DEFAULT_CONFIG,
	DEFAULT_ENABLED_AGENTS,
	DEFAULT_IDLE_TIMEOUT_SEC,
	DEFAULT_MAX_CONCURRENCY,
	DEFAULT_MAX_FIX_ROUNDS,
	DEFAULT_THINKING_LEVEL,
	type AgentScope,
	type SubagentsConfig,
	type ThinkingLevel,
	errorMessage,
	getConfigPath,
	loadConfig,
	saveConfig,
} from "./config.ts";
import {
	CURRENT_MAIN_MODEL,
	applyAgentModelChoice,
	availableModelsInScope,
	buildModelPickerItems,
	currentModelRef,
	findModelByRef,
	modelRef,
	resolveThinkingLevel,
	supportedThinkingLevels,
} from "./models.ts";
import { promptSelectMany, promptSelectOne } from "./ui.ts";
import { discoverAgents } from "./agents.ts";

const AUTO_THINKING = "__auto_thinking__";

function actualAgentThinkingDefault(
	ctx: ExtensionCommandContext,
	config: SubagentsConfig,
	agentName: string,
): ThinkingLevel {
	const { agents } = discoverAgents(ctx.cwd, {
		scope: config.agentScope,
		enabledNames: config.enabledAgents,
		projectTrusted: ctx.isProjectTrusted(),
	});
	return agents.find((agent) => agent.name === agentName)?.thinking ?? DEFAULT_THINKING_LEVEL;
}

/** Short, selection-friendly descriptions for the built-in agents. */
const MODULE_HINTS: Record<string, string> = {
	explorer: "read-only codebase recon (fast model)",
	worker: "implement / fix / refactor / test (full tools)",
	cleaner: "apply proven cleanup and deduplicate code (full tools)",
	documenter: "sync diff or whole-codebase comments/docs (docs write)",
	reviewer: "read-only audits and pre-commit gates",
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
		"Space toggles • Enter confirms • Esc returns to settings",
		items,
		current,
	);
}

async function pickConfiguredModel(
	ctx: ExtensionCommandContext,
	title: string,
	configuredRef: string | undefined,
	escNote: string,
): Promise<string | undefined> {
	const models = availableModelsInScope(ctx);
	const items = buildModelPickerItems({
		models,
		configuredRef,
		mainRef: currentModelRef(ctx),
	});
	return promptSelectOne(
		ctx,
		title,
		`Type to filter by provider, model, capability, or thinking level • ↑/↓ • Enter selects • Esc ${escNote}`,
		items,
		configuredRef ?? CURRENT_MAIN_MODEL,
	);
}

async function pickAgentModel(
	ctx: ExtensionCommandContext,
	agentName: string,
	currentRef: string | undefined,
	escNote = "cancels this setup pass",
): Promise<string | undefined> {
	return pickConfiguredModel(ctx, `Model for "${agentName}"?`, currentRef, escNote);
}

const THINKING_LEVEL_HINTS: Record<ThinkingLevel, string> = {
	off: "no reasoning tokens",
	minimal: "minimal reasoning",
	low: "light reasoning",
	medium: "balanced reasoning",
	high: "deep reasoning",
	xhigh: "extra-deep reasoning",
	max: "strongest reasoning",
};

function effectiveModelForChoice(
	ctx: ExtensionCommandContext,
	choice: string,
): Model<Api> | undefined {
	if (choice === CURRENT_MAIN_MODEL) return ctx.model;
	return findModelByRef(availableModelsInScope(ctx), choice);
}

/** Auto is the default. Manual rows are exactly the levels Pi exposes for the
 * selected model; unsupported xhigh/max entries never appear. */
async function pickAgentStrength(
	ctx: ExtensionCommandContext,
	agentName: string,
	model: Model<Api> | undefined,
	current: ThinkingLevel | undefined,
	agentDefault: ThinkingLevel,
	escNote = "cancels this setup pass",
): Promise<ThinkingLevel | typeof AUTO_THINKING | undefined> {
	const supported = supportedThinkingLevels(model);
	const automatic = resolveThinkingLevel(model, agentDefault);
	// No model metadata, or a non-reasoning model whose only valid value is off:
	// Auto is already the complete and least surprising choice.
	if (supported.length <= 1) return AUTO_THINKING;

	const currentEffective = current ? resolveThinkingLevel(model, current) : undefined;
	const modelName = model ? modelRef(model) : "current main model";
	const options = [
		{
			value: AUTO_THINKING,
			label: `auto — ${automatic} for ${modelName}${current === undefined ? " (current, recommended)" : " (recommended)"}`,
		},
		...supported.map((level) => ({
			value: level,
			label: `${level} — ${THINKING_LEVEL_HINTS[level]}${current !== undefined && currentEffective === level ? " (current)" : ""}`,
		})),
	];
	return promptSelectOne(
		ctx,
		`Thinking for "${agentName}"?`,
		`Only levels supported by ${modelName} are shown • Enter selects • Esc ${escNote}`,
		options,
		current === undefined ? AUTO_THINKING : currentEffective,
	) as Promise<ThinkingLevel | typeof AUTO_THINKING | undefined>;
}

async function pickAgentToConfigure(
	ctx: ExtensionCommandContext,
	enabledAgents: readonly string[],
): Promise<string | undefined> {
	if (enabledAgents.length === 0) {
		ctx.ui.notify("No agents are enabled. Enable agents first.", "warning");
		return undefined;
	}
	return promptSelectOne(
		ctx,
		"Configure which agent?",
		"Type to filter • ↑/↓ • Enter selects • Esc returns to settings",
		enabledAgents.map((name) => ({ value: name, label: moduleLabel(name) })),
	);
}

interface ConfiguredAgentChoice {
	name: string;
	model: string;
	strength: ThinkingLevel | typeof AUTO_THINKING;
}

/** Configure one agent while preserving the UI back stack: thinking → model →
 * agent selection. Esc from agent selection ends this configuration pass. */
async function configureOneAgent(
	ctx: ExtensionCommandContext,
	config: SubagentsConfig,
): Promise<ConfiguredAgentChoice | undefined> {
	while (true) {
		const name = await pickAgentToConfigure(ctx, config.enabledAgents);
		if (name === undefined) return undefined;

		while (true) {
			const modelChoice = await pickAgentModel(
				ctx,
				name,
				config.agentModels[name],
				"returns to agent selection",
			);
			if (modelChoice === undefined) break;
			const model = effectiveModelForChoice(ctx, modelChoice);
			const strength = await pickAgentStrength(
				ctx,
				name,
				model,
				config.agentThinkingLevels[name],
				actualAgentThinkingDefault(ctx, config, name),
				"returns to model selection",
			);
			if (strength === undefined) continue;
			return { name, model: modelChoice, strength };
		}
	}
}

async function pickInjection(ctx: ExtensionCommandContext, current: boolean): Promise<boolean | undefined> {
	const on = "On — inject the delegation directive (recommended)";
	const off = "Off — rely on tool descriptions only";
	const choice = await ctx.ui.select("Proactive dispatch injection?", [current ? `${on} (current)` : on, current ? off : `${off} (current)`]);
	if (choice === undefined) return undefined;
	return choice.startsWith("On");
}

const CONCURRENCY_STEPS = [1, 2, 3, 4, 6, 8, 12, 16];
const FIX_ROUNDS_STEPS = [0, 1, 2, 3, 5];
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
	return choice === undefined ? undefined : Number.parseInt(choice, 10);
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
	return AGENT_SCOPE_VALUES.find((scope) => choice.startsWith(scope));
}

function keepAgentEntries<T>(record: Record<string, T>, enabled: readonly string[]): Record<string, T> {
	const keep = new Set(enabled);
	return Object.fromEntries(Object.entries(record).filter(([name]) => keep.has(name)));
}

async function runFullSetup(ctx: ExtensionCommandContext, configPath: string, base: SubagentsConfig): Promise<boolean> {
	const enabled = await pickEnabledAgents(ctx, base.enabledAgents);
	if (enabled === undefined) return false;

	let agentModels = keepAgentEntries(base.agentModels, enabled);
	for (const agentName of enabled) {
		const choice = await pickAgentModel(ctx, agentName, agentModels[agentName]);
		if (choice === undefined) return false;
		agentModels = applyAgentModelChoice(agentModels, agentName, choice);
	}

	const injection = await pickInjection(ctx, base.proactiveInjection);
	if (injection === undefined) return false;
	const scope = await pickScope(ctx, base.agentScope);
	if (scope === undefined) return false;
	const maxConcurrency = await pickCount(
		ctx,
		"Max sub-agents running at once?",
		CONCURRENCY_STEPS,
		base.maxConcurrency,
		DEFAULT_MAX_CONCURRENCY,
	);
	if (maxConcurrency === undefined) return false;
	const maxFixRounds = await pickCount(
		ctx,
		"Reviewer worker-fix rounds? (0 = no automatic fixes)",
		FIX_ROUNDS_STEPS,
		base.maxFixRounds,
		DEFAULT_MAX_FIX_ROUNDS,
	);
	if (maxFixRounds === undefined) return false;
	const idleTimeoutSec = await pickCount(
		ctx,
		"Idle timeout in seconds? (0 = disabled)",
		IDLE_TIMEOUT_STEPS,
		base.idleTimeoutSec,
		DEFAULT_IDLE_TIMEOUT_SEC,
	);
	if (idleTimeoutSec === undefined) return false;

	const next: SubagentsConfig = {
		enabledAgents: enabled,
		agentModels,
		// Full setup returns every agent to capability-aware Auto thinking.
		agentThinkingLevels: {},
		notifyOnReviewPass: base.notifyOnReviewPass,
		maxResultLines: base.maxResultLines,
		proactiveInjection: injection,
		agentScope: scope,
		maxConcurrency,
		maxFixRounds,
		idleTimeoutSec,
		// Full setup is an explicit decision point: mark role-enable migrations as
		// processed so the user's saved selection is kept as-is.
		announcedFeatures: [...new Set([
			...base.announcedFeatures,
			CLEANER_DEFAULTED_FEATURE,
			DOCUMENTER_DEFAULTED_FEATURE,
		])],
	};
	await saveConfig(next, configPath);
	ctx.ui.notify(`pi-subagents configured with Auto thinking. Saved to ${configPath}`, "info");
	return true;
}

async function updateRuntimeSetting(
	ctx: ExtensionCommandContext,
	config: SubagentsConfig,
): Promise<SubagentsConfig | undefined> {
	while (true) {
		const choice = await ctx.ui.select("Runtime setting", [
			"Proactive injection",
			"Agent scope",
			"Max concurrency",
			"Reviewer worker-fix rounds",
			"Idle timeout",
		]);
		if (choice === undefined) return undefined;
		const next = { ...config };
		if (choice.startsWith("Proactive")) {
			const value = await pickInjection(ctx, config.proactiveInjection);
			if (value === undefined) continue;
			next.proactiveInjection = value;
		} else if (choice.startsWith("Agent scope")) {
			const value = await pickScope(ctx, config.agentScope);
			if (value === undefined) continue;
			next.agentScope = value;
		} else if (choice.startsWith("Max concurrency")) {
			const value = await pickCount(ctx, "Max sub-agents running at once?", CONCURRENCY_STEPS, config.maxConcurrency, DEFAULT_MAX_CONCURRENCY);
			if (value === undefined) continue;
			next.maxConcurrency = value;
		} else if (choice.startsWith("Reviewer")) {
			const value = await pickCount(ctx, "Reviewer worker-fix rounds?", FIX_ROUNDS_STEPS, config.maxFixRounds, DEFAULT_MAX_FIX_ROUNDS);
			if (value === undefined) continue;
			next.maxFixRounds = value;
		} else {
			const value = await pickCount(ctx, "Idle timeout in seconds?", IDLE_TIMEOUT_STEPS, config.idleTimeoutSec, DEFAULT_IDLE_TIMEOUT_SEC);
			if (value === undefined) continue;
			next.idleTimeoutSec = value;
		}
		return next;
	}
}

async function runMenu(ctx: ExtensionCommandContext, configPath: string, config: SubagentsConfig): Promise<void> {
	while (true) {
		const choice = await ctx.ui.select("pi-subagents settings", [
			"Enable/disable agents",
			"Configure an agent (model + thinking)",
			"Runtime settings",
			"Full re-setup",
		]);
		if (choice === undefined) return;
		if (choice.startsWith("Full")) {
			if (await runFullSetup(ctx, configPath, config)) return;
			continue;
		}

		let next: SubagentsConfig = {
			...config,
			agentModels: { ...config.agentModels },
			agentThinkingLevels: { ...config.agentThinkingLevels },
		};
		if (choice.startsWith("Enable")) {
			const enabled = await pickEnabledAgents(ctx, config.enabledAgents);
			if (enabled === undefined) continue;
			next.enabledAgents = enabled;
			// Newly enabling cleaner inherits the reviewer's configured model and
			// thinking level, so the file reflects what cleaner will actually run
			// instead of silently falling back to the current main model.
			if (!config.enabledAgents.includes("cleaner") && enabled.includes("cleaner")) {
				if (!next.agentModels.cleaner && config.agentModels.reviewer) {
					next.agentModels.cleaner = config.agentModels.reviewer;
				}
				if (!next.agentThinkingLevels.cleaner && config.agentThinkingLevels.reviewer) {
					next.agentThinkingLevels.cleaner = config.agentThinkingLevels.reviewer;
				}
			}
			// Documenter intentionally follows the faster explorer route. Fresh
			// installs leave it unselected; enabling it later inherits any explorer
			// overrides instead of silently choosing a stronger model.
			if (!config.enabledAgents.includes("documenter") && enabled.includes("documenter")) {
				if (!next.agentModels.documenter && config.agentModels.explorer) {
					next.agentModels.documenter = config.agentModels.explorer;
				}
				if (!next.agentThinkingLevels.documenter && config.agentThinkingLevels.explorer) {
					next.agentThinkingLevels.documenter = config.agentThinkingLevels.explorer;
				}
			}
			next.agentModels = keepAgentEntries(next.agentModels, enabled);
			next.agentThinkingLevels = keepAgentEntries(next.agentThinkingLevels, enabled);
		} else if (choice.startsWith("Configure")) {
			// Per-agent loop: thinking Esc returns to that agent's model picker;
			// model Esc returns to the agent picker; agent-picker Esc saves completed
			// choices and returns to this settings menu.
			let configuredAny = false;
			while (true) {
				const picked = await configureOneAgent(ctx, next);
				if (!picked) break;
				configuredAny = true;
				next.agentModels = applyAgentModelChoice(next.agentModels, picked.name, picked.model);
				if (picked.strength === AUTO_THINKING) delete next.agentThinkingLevels[picked.name];
				else next.agentThinkingLevels[picked.name] = picked.strength;
			}
			if (!configuredAny) continue;
			await saveConfig(next, configPath);
			ctx.ui.notify(`pi-subagents updated. Saved to ${configPath}`, "info");
			config = next;
			continue;
		} else {
			const updated = await updateRuntimeSetting(ctx, next);
			if (updated === undefined) continue;
			next = updated;
		}

		await saveConfig(next, configPath);
		ctx.ui.notify(`pi-subagents updated. Saved to ${configPath}`, "info");
		return;
	}
}

/** Entry point for the /subagents-setup command. */
export async function runSetup(ctx: ExtensionCommandContext, configPath: string = getConfigPath()): Promise<void> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify("/subagents-setup requires Pi's interactive TUI.", "error");
		return;
	}
	try {
		const exists = await configExists(configPath);
		const config = await loadConfig(configPath);
		if (exists) await runMenu(ctx, configPath, config);
		else if (!(await runFullSetup(ctx, configPath, { ...DEFAULT_CONFIG, enabledAgents: [...DEFAULT_ENABLED_AGENTS] }))) {
			ctx.ui.notify("pi-subagents setup cancelled.", "info");
		}
	} catch (error) {
		ctx.ui.notify(`pi-subagents setup failed: ${errorMessage(error)}`, "error");
	}
}
