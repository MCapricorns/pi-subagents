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
import { promptRoleGrid, promptSelectOne, type RoleGridFocus, type RoleGridRow } from "./ui.ts";

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

/** One row per role: every model and thinking choice stays visible together. */
function roleRows(ctx: ExtensionContext, config: SubagentsConfig): RoleGridRow[] {
	const mainRef = currentModelRef(ctx) ?? "Pi default";
	const models = availableModelsInScope(ctx);
	return BUILTIN_AGENT_NAMES.map((name) => {
		const profile = agentProfile(name)!;
		const selected = config.agentModels[name];
		const model = findModelByRef(models, selected);
		const available = !selected || Boolean(model);
		const preferred = config.agentThinkingLevels[name] ?? roleThinkingLevel(name);
		const effective = resolveThinkingLevel(model ?? ctx.model, preferred);
		const clamped = effective !== preferred ? " (" + preferred + " requested)" : "";
		const overridden = Boolean(config.agentThinkingLevels[name]);
		return {
			role: name,
			thinkingOverridden: overridden,
			model: selected ? selected + (available ? "" : " (unavailable)") : "Follow main",
			thinking: effective + clamped,
			description: profile.remark + " Model: " + (selected
				? (available ? "falls back to main if it fails." : "unavailable; using main.")
				: "follows main (" + mainRef + ") dynamically.")
				+ " Thinking: role default " + roleThinkingLevel(name) + ", clamped to the model-supported levels. Reset restores " + name + " to Follow main and that default. * marks an override.",
		};
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


/** The same role overview serves first install and later edits. */
export async function runSetup(ctx: ExtensionContext, configPath: string = getConfigPath()): Promise<void> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify("/subagents-setup requires Pi's interactive TUI.", "error");
		return;
	}
	try {
		let config = await loadConfig(configPath);
		let focus: RoleGridFocus = {};
		let status = "Changes save immediately";
		while (true) {
			const choice = await promptRoleGrid(ctx, roleRows(ctx, config), focus, status);
			if (choice === undefined) return;
			focus = { row: choice.row, column: choice.column };
			const next = await editSetting(ctx, config, choice.role, choice.field);
			if (!next) continue;
			await saveConfig(next, configPath);
			config = next;
			status = "Saved " + choice.role + (choice.field === "reset" ? " defaults" : " " + choice.field);
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
