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
import { promptMenu, promptSelectOne, type SetupItem } from "./ui.ts";

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

const ROLE_PURPOSE: Record<string, string> = {
	scout: "Research with citations",
	artisan: "Implement and verify",
	sentinel: "Review implementation",
	skeptic: "Challenge a named claim",
};

function roleSettings(ctx: ExtensionContext, config: SubagentsConfig, name: string): SetupItem[] {
	const selected = config.agentModels[name];
	const model = findModelByRef(availableModelsInScope(ctx), selected);
	const modelLabel = selected
		? model ? model.name + " · " + model.provider : selected + " (unavailable)"
		: "Follow main (dynamic)";
	const preferred = config.agentThinkingLevels[name] ?? roleThinkingLevel(name);
	const effective = resolveThinkingLevel(model ?? ctx.model, preferred);
	const source = config.agentThinkingLevels[name] ? "override" : "role default";
	const thinking = effective + (effective !== preferred ? " (" + preferred + " requested)" : "") + " · " + source;
	return [
		{ value: "model", label: "Model: " + modelLabel, description: selected
			? "Pinned reference: " + selected + (model ? ". Falls back to main if it fails." : ". Unavailable; using main.")
			: "Follows the main window's model, including future changes. Now: " + (currentModelRef(ctx) ?? "Pi default") + ". Choose a specific model to pin it." },
		{ value: "thinking", label: "Thinking: " + thinking,
			description: "Reasoning effort: " + thinking + ". Role default: " + roleThinkingLevel(name) + ". Model capabilities limit the effective level; your saved preference is kept when changing models." },
		{ value: "reset", label: "Reset defaults", description: "Restore only " + name + " to Follow main and role-default thinking (" + roleThinkingLevel(name) + "). Saves immediately." },
	];
}

function roleItems(ctx: ExtensionContext, config: SubagentsConfig): SetupItem[] {
	return BUILTIN_AGENT_NAMES.map((name) => {
		const settings = roleSettings(ctx, config, name);
		return { value: name, label: name + " · " + ROLE_PURPOSE[name],
			description: settings[0]!.label + "\n" + settings[1]!.label + "\n" + agentProfile(name)!.remark };
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
			"Follow main = dynamic · Others = pinned",
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
		if (current && !supported.includes(current)) {
			options.push({ value: current, label: current + " (runs as " + resolveThinkingLevel(model, current) + ")",
				description: "Saved preference; this model clamps it. Keep it for other models, or choose a supported level." });
		}
		const choice = await promptSelectOne(ctx, name + " · Thinking",
			"Reasoning effort · saved preferences survive model changes",
			options, current ?? ROLE_DEFAULT);
		if (choice === undefined) return undefined;
		if (choice === ROLE_DEFAULT) delete next.agentThinkingLevels[name];
		else next.agentThinkingLevels[name] = choice as ThinkingLevel;
	} else {
		return undefined;
	}
	return next;
}


/** The same role overview serves first install and later edits. */
export async function runSetup(ctx: ExtensionContext, configPath: string = getConfigPath()): Promise<void> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify("/subagents-setup requires Pi's interactive TUI.", "error");
		return;
	}
	try {
		let config = await loadConfig(configPath);
		let roleFocus: string | undefined;
		const settingFocus: Record<string, string> = {};
		let status = "Changes save immediately";
		while (true) {
			const name = await promptMenu(ctx, "Subagents · Roles", status === "Changes save immediately" ? "Choose a role · " + status : status, roleItems(ctx, config), roleFocus);
			if (name === undefined) return;
			roleFocus = name;
			while (true) {
				const field = await promptMenu(ctx, name + " · Settings", status === "Changes save immediately" ? "Choose a setting · " + status : status, roleSettings(ctx, config, name), settingFocus[name]);
				if (field === undefined) break;
				settingFocus[name] = field;
				const next = await editSetting(ctx, config, name, field);
				if (!next) continue;
				await saveConfig(next, configPath);
				config = next;
				status = "Saved " + name + (field === "reset" ? " defaults" : " " + field);
			}
		}
	} catch (error) {
		ctx.ui.notify("pi-subagents setup failed: " + errorMessage(error), "error");
	}
}

/** Write shipped defaults once so every role works immediately. */
export async function ensureDefaultConfig(
	ctx: ExtensionContext,
	configPath: string = getConfigPath(),
): Promise<void> {
	if (await configExists(configPath)) return;
	await saveConfig(DEFAULT_CONFIG, configPath);
	ctx.ui.notify(
		"pi-subagents: wrote " + configPath + " with all roles enabled; each follows the main model. Run /subagents-setup to pick a model and thinking level per role.",
		"info",
	);
}
