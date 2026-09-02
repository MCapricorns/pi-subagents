/**
 * Interactive configuration wizard for /subagents-setup.
 *
 * The wizard stays one level deep: which agents run, then a model and an
 * optional thinking override per agent. Role thinking defaults apply until
 * the user picks a level. Everything else (agent scope, idle timeout, result
 * lines) is config-file-only.
 */

import { stat } from "node:fs/promises";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
	AGENT_PROFILES,
	BUILTIN_AGENT_NAMES,
	DEFAULT_CONFIG,
	DEFAULT_ENABLED_AGENTS,
	REQUIRED_ENABLED_AGENTS,
	agentProfile,
	errorMessage,
	getConfigPath,
	loadConfig,
	roleThinkingLevel,
	saveConfig,
	withRequiredAgents,
	type SubagentsConfig,
	type ThinkingLevel,
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

const THINKING_LEVEL_HINTS: Record<ThinkingLevel, string> = {
	off: "no reasoning tokens",
	minimal: "minimal reasoning",
	low: "light reasoning",
	medium: "balanced reasoning",
	high: "deep reasoning",
	xhigh: "extra-deep reasoning",
	max: "strongest reasoning",
};

function agentPickerItems(): Array<{ value: string; label: string; description: string }> {
	return BUILTIN_AGENT_NAMES.map((name) => {
		const profile = AGENT_PROFILES[name];
		const required = (REQUIRED_ENABLED_AGENTS as readonly string[]).includes(name);
		return {
			value: name,
			label: required ? `${name} (always on)` : name,
			description: `${profile.summary} — ${profile.remark}`,
		};
	});
}

function moduleLabel(name: string): string {
	const profile = agentProfile(name);
	return profile ? `${name} — ${profile.summary}` : name;
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
	const picked = await promptSelectMany(
		ctx,
		"Which agents should run?",
		"Each line is a role and its job. All three stay on. Space toggles • Enter confirms • Esc back",
		agentPickerItems(),
		current,
	);
	if (picked === undefined) return undefined;
	const enabled = withRequiredAgents(picked);
	const forced = REQUIRED_ENABLED_AGENTS.filter((name) => !picked.includes(name));
	if (forced.length > 0) {
		ctx.ui.notify(
			`pi-subagents: ${forced.join(", ")} stay enabled — the shipped team stays on.`,
			"info",
		);
	}
	return enabled;
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
		`Type to filter by provider, model, or capability • ↑/↓ • Enter selects • Esc ${escNote}`,
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
	const profile = agentProfile(agentName);
	const duty = profile ? ` — ${profile.summary}` : "";
	return pickConfiguredModel(ctx, `Model for ${agentName}${duty}?`, currentRef, escNote);
}

function effectiveModelForChoice(
	ctx: ExtensionCommandContext,
	choice: string,
): Model<Api> | undefined {
	if (choice === CURRENT_MAIN_MODEL) return ctx.model;
	return findModelByRef(availableModelsInScope(ctx), choice);
}

/** Role default is the first row. Picking it clears a stored override. */
async function pickAgentStrength(
	ctx: ExtensionCommandContext,
	agentName: string,
	model: Model<Api> | undefined,
	current: ThinkingLevel | undefined,
	escNote = "cancels this setup pass",
): Promise<ThinkingLevel | undefined> {
	const supported = supportedThinkingLevels(model);
	const roleDefault = resolveThinkingLevel(model, roleThinkingLevel(agentName));
	if (supported.length <= 1) return roleDefault;

	const currentEffective = current ? resolveThinkingLevel(model, current) : roleDefault;
	const modelName = model ? modelRef(model) : "current main model";
	const options = supported.map((level) => {
		const tags = [
			level === roleDefault ? "role default" : "",
			current !== undefined && currentEffective === level ? "current" : "",
		].filter(Boolean);
		return {
			value: level,
			label: `${level} — ${THINKING_LEVEL_HINTS[level]}${tags.length ? ` (${tags.join(", ")})` : ""}`,
		};
	});
	return promptSelectOne(
		ctx,
		`Thinking for ${agentName}?`,
		`${agentName} defaults to ${roleDefault} on ${modelName} • Enter selects • Esc ${escNote}`,
		options,
		currentEffective,
	) as Promise<ThinkingLevel | undefined>;
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
		"Name, then what it owns • ↑/↓ • Enter selects • Esc returns to settings",
		enabledAgents.map((name) => {
			const profile = agentProfile(name);
			return {
				value: name,
				label: moduleLabel(name),
				description: profile?.remark,
			};
		}),
	);
}

interface ConfiguredAgentChoice {
	name: string;
	model: string;
	strength: ThinkingLevel;
}

async function configureOneAgent(
	ctx: ExtensionCommandContext,
	config: SubagentsConfig,
): Promise<ConfiguredAgentChoice | undefined> {
	while (true) {
		const name = await pickAgentToConfigure(ctx, config.enabledAgents);
		if (name === undefined) return undefined;
		const profile = agentProfile(name);
		if (profile) ctx.ui.notify(`${name}: ${profile.remark}`, "info");

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
				"returns to model selection",
			);
			if (strength === undefined) continue;
			return { name, model: modelChoice, strength };
		}
	}
}

function keepAgentEntries<T>(record: Record<string, T>, enabled: readonly string[]): Record<string, T> {
	const keep = new Set(enabled);
	return Object.fromEntries(Object.entries(record).filter(([name]) => keep.has(name)));
}

function applyThinkingChoice(
	levels: Record<string, ThinkingLevel>,
	agentName: string,
	strength: ThinkingLevel,
): Record<string, ThinkingLevel> {
	const next = { ...levels };
	if (strength === roleThinkingLevel(agentName)) delete next[agentName];
	else next[agentName] = strength;
	return next;
}

async function introduceSetup(ctx: ExtensionCommandContext): Promise<boolean> {
	const lines = BUILTIN_AGENT_NAMES.map((name) => {
		const profile = AGENT_PROFILES[name];
		const required = (REQUIRED_ENABLED_AGENTS as readonly string[]).includes(name) ? " · always on" : "";
		return `${name} — ${profile.summary}${required}. ${profile.remark}`;
	});
	ctx.ui.notify(
		`pi-subagents: ${lines.join(" ")} Pick a model for each role next. Thinking defaults per role (scout low, artisan high, steward medium); change it on a role when you want.`,
		"info",
	);
	const choice = await ctx.ui.select("How to configure pi-subagents", [
		"Continue — pick a model for each role (thinking has a role default you can change later)",
	]);
	return choice !== undefined;
}

async function runFullSetup(ctx: ExtensionCommandContext, configPath: string, base: SubagentsConfig): Promise<boolean> {
	if (!(await introduceSetup(ctx))) return false;

	const enabled = await pickEnabledAgents(ctx, base.enabledAgents);
	if (enabled === undefined) return false;

	let agentModels = keepAgentEntries(base.agentModels, enabled);
	for (const agentName of enabled) {
		const profile = agentProfile(agentName);
		if (profile) ctx.ui.notify(`${agentName}: ${profile.remark}`, "info");
		const choice = await pickAgentModel(ctx, agentName, agentModels[agentName]);
		if (choice === undefined) return false;
		agentModels = applyAgentModelChoice(agentModels, agentName, choice);
	}

	const next: SubagentsConfig = {
		enabledAgents: enabled,
		knownAgents: [...BUILTIN_AGENT_NAMES],
		agentModels,
		agentThinkingLevels: keepAgentEntries(base.agentThinkingLevels, enabled),
		maxResultLines: base.maxResultLines,
		agentScope: base.agentScope,
		idleTimeoutSec: base.idleTimeoutSec,
	};
	await saveConfig(next, configPath);
	ctx.ui.notify(
		`pi-subagents saved to ${configPath}. Role thinking defaults apply; open Configure an agent to change one.`,
		"info",
	);
	return true;
}

async function runMenu(ctx: ExtensionCommandContext, configPath: string, config: SubagentsConfig): Promise<void> {
	while (true) {
		const choice = await ctx.ui.select("pi-subagents settings", [
			"Enable/disable agents — scout, artisan, and steward stay on",
			"Configure an agent — model and thinking, with its job on the row",
			"Full re-setup — walk through the team and pick models again",
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
			next.agentModels = keepAgentEntries(next.agentModels, enabled);
			next.agentThinkingLevels = keepAgentEntries(next.agentThinkingLevels, enabled);
		} else {
			let configuredAny = false;
			while (true) {
				const picked = await configureOneAgent(ctx, next);
				if (!picked) break;
				configuredAny = true;
				next.agentModels = applyAgentModelChoice(next.agentModels, picked.name, picked.model);
				next.agentThinkingLevels = applyThinkingChoice(next.agentThinkingLevels, picked.name, picked.strength);
			}
			if (!configuredAny) continue;
			await saveConfig(next, configPath);
			ctx.ui.notify(`pi-subagents updated. Saved to ${configPath}`, "info");
			config = next;
			continue;
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
