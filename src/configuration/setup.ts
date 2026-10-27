/** Role-based settings. Each field saves independently; Esc always goes back. */

import { stat } from "node:fs/promises";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	BUILTIN_AGENT_NAMES,
	DEFAULT_CONFIG,
	agentProfile,
	errorMessage,
	getConfigPath,
	loadConfig,
	roleThinkingLevel,
	saveConfig,
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
	resolveThinkingLevel,
	supportedThinkingLevels,
} from "./models.ts";
import { promptSelectOne, promptSettings, type SettingsRow } from "./ui.ts";

const ROLE_DEFAULT = "__role_default__";
const THINKING_LEVEL_HINTS: Record<ThinkingLevel, string> = {
	off: "no reasoning tokens",
	minimal: "minimal reasoning",
	low: "light reasoning",
	medium: "balanced reasoning",
	high: "deep reasoning",
	xhigh: "extra-deep reasoning",
	max: "strongest reasoning",
};

async function configExists(configPath: string): Promise<boolean> {
	try {
		await stat(configPath);
		return true;
	} catch {
		return false;
	}
}

function roleModel(ctx: ExtensionContext, config: SubagentsConfig, name: string) {
	return findModelByRef(availableModelsInScope(ctx), config.agentModels[name]) ?? ctx.model;
}

function settingsRows(ctx: ExtensionContext, config: SubagentsConfig): SettingsRow[] {
	return BUILTIN_AGENT_NAMES.flatMap((name) => {
		const profile = agentProfile(name)!;
		const group = name + " · " + profile.summary;
		const selected = config.agentModels[name];
		const available = !selected || Boolean(findModelByRef(availableModelsInScope(ctx), selected));
		const preferred = config.agentThinkingLevels[name] ?? roleThinkingLevel(name);
		const effective = resolveThinkingLevel(roleModel(ctx, config, name), preferred);
		const source = config.agentThinkingLevels[name] ? "override" : "role default";
		return [
			{
				value: name + ".model", group, label: "Model",
				currentValue: selected ? selected + (available ? "" : " (unavailable)") : "Follow main",
				description: profile.remark + " " + (selected
					? (available ? "Falls back to main if the selected model fails." : "Unavailable selection; using main.")
					: "Uses the main model dynamically.") + " Main: " + (currentModelRef(ctx) ?? "Pi default"),
			},
			{
				value: name + ".thinking", group, label: "Thinking",
				currentValue: effective + " · " + source + (effective !== preferred ? " (" + preferred + " requested)" : ""),
				description: "Role default: " + roleThinkingLevel(name) + ". Levels follow the effective model's capabilities; unsupported preferences are clamped at runtime.",
			},
			{
				value: name + ".reset", group, label: "Reset role", currentValue: "",
				description: "Restore " + name + " to Follow main and role-default thinking (" + roleThinkingLevel(name) + "). Saves immediately.",
			},
		];
	});
}

async function editSetting(
	ctx: ExtensionContext,
	config: SubagentsConfig,
	name: string,
	field: string,
): Promise<SubagentsConfig | undefined> {
	const next: SubagentsConfig = {
		agentModels: { ...config.agentModels },
		agentThinkingLevels: { ...config.agentThinkingLevels },
	};
	if (field === "reset") {
		delete next.agentModels[name];
		delete next.agentThinkingLevels[name];
	} else if (field === "model") {
		const choice = await promptSelectOne(ctx, name + " · Model",
			"Search provider, model, or capability · Esc back without changes",
			buildModelPickerItems({ models: availableModelsInScope(ctx), configuredRef: config.agentModels[name], mainRef: currentModelRef(ctx) }),
			config.agentModels[name] ?? CURRENT_MAIN_MODEL);
		if (choice === undefined) return undefined;
		next.agentModels = applyAgentModelChoice(next.agentModels, name, choice);
	} else if (field === "thinking") {
		const model = roleModel(ctx, config, name);
		const preferredDefault = roleThinkingLevel(name);
		const effectiveDefault = resolveThinkingLevel(model, preferredDefault);
		const supported = supportedThinkingLevels(model);
		if (!supported.length) {
			ctx.ui.notify("Choose a model before changing thinking; its supported levels are not available yet.", "info");
			return undefined;
		}
		const options = [
			{ value: ROLE_DEFAULT, label: "Role default", description: preferredDefault + (effectiveDefault !== preferredDefault ? " → " + effectiveDefault + " on this model" : "") },
			...supported.map((level) => ({ value: level, label: level, description: THINKING_LEVEL_HINTS[level] })),
		];
		const current = config.agentThinkingLevels[name];
		const choice = await promptSelectOne(ctx, name + " · Thinking",
			"Choose reasoning effort · Role default follows model capabilities · Esc back",
			options, current && supported.includes(current) ? current : ROLE_DEFAULT);
		if (choice === undefined) return undefined;
		if (choice === ROLE_DEFAULT) delete next.agentThinkingLevels[name];
		else next.agentThinkingLevels[name] = choice as ThinkingLevel;
	} else {
		return undefined;
	}
	return next;
}

/** The same compact panel serves first install and later edits. */
export async function runSetup(ctx: ExtensionContext, configPath: string = getConfigPath()): Promise<void> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify("/subagents-setup requires Pi's interactive TUI.", "error");
		return;
	}
	try {
		let config = await loadConfig(configPath);
		let focus: string | undefined;
		let status = "Changes save immediately";
		while (true) {
			const choice = await promptSettings(ctx, settingsRows(ctx, config), focus, status);
			if (choice === undefined) return;
			focus = choice;
			const [name, field] = choice.split(".");
			if (!BUILTIN_AGENT_NAMES.some((role) => role === name)) continue;
			const next = await editSetting(ctx, config, name!, field!);
			if (!next) continue;
			await saveConfig(next, configPath);
			config = next;
			status = "Saved " + name + (field === "reset" ? " defaults" : " " + field);
		}
	} catch (error) {
		ctx.ui.notify("pi-subagents setup failed: " + errorMessage(error), "error");
	}
}

/** Write shipped defaults once so both roles work immediately. */
export async function ensureDefaultConfig(
	ctx: ExtensionContext,
	configPath: string = getConfigPath(),
): Promise<void> {
	if (await configExists(configPath)) return;
	await saveConfig(DEFAULT_CONFIG, configPath);
	ctx.ui.notify(
		"pi-subagents: wrote " + configPath + " with scout and artisan enabled; both follow the main model. Run /subagents-setup to pick a model and thinking level per role.",
		"info",
	);
}
