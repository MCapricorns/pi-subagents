/** Independent model and thinking preferences for each built-in role. */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	BUILTIN_AGENT_NAMES, DEFAULT_AGENT_SETTINGS, DEFAULT_THINKING_LEVEL, errorMessage, getConfigPath,
	initializeConfig, loadConfig, updateConfig, type ThinkingLevel,
} from "./config.ts";
import {
	CURRENT_MAIN_MODEL, availableModelsInScope, buildModelPickerItems, currentModelRef,
	findModelByRef, resolveThinkingLevel, supportedThinkingLevels,
} from "./models.ts";
import { promptSelectOne, promptSettings, type SetupItem, type SettingKey } from "./ui.ts";

const THINKING_HINTS: Record<ThinkingLevel, string> = {
	off: "No reasoning tokens", minimal: "Minimal reasoning", low: "Light reasoning",
	medium: "Balanced reasoning", high: "Deep reasoning", xhigh: "Extra-deep reasoning", max: "Strongest reasoning",
};

export async function runSetup(ctx: ExtensionContext, configPath: string = getConfigPath()): Promise<void> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify("/subagents-setup requires Pi's interactive TUI.", "error");
		return;
	}
	try {
		// Setup is the explicit recovery path for a file startup kept untouched.
		await ensureDefaultConfig(ctx, configPath, { repair: true });
		let focus: SettingKey = "researcher.model";
		let status = "Changes save immediately";
		while (true) {
			const config = await loadConfig(configPath);
			const models = availableModelsInScope(ctx);
			const choice = await promptSettings(ctx, {
				main: currentModelRef(ctx) ?? "Pi default",
				roles: BUILTIN_AGENT_NAMES.map((role) => {
					const settings = config[role];
					const selected = findModelByRef(models, settings.model);
					const unavailable = !!settings.model && !selected;
					const effective = resolveThinkingLevel(selected ?? ctx.model, settings.thinking);
					return {
						role, model: settings.model ?? "Follow main",
						thinking: unavailable ? settings.thinking : effective + (effective !== settings.thinking ? " (" + settings.thinking + " requested)" : ""),
						unavailable,
					};
				}),
				status, focus,
			});
			if (!choice) return;
			focus = choice;
			const role = BUILTIN_AGENT_NAMES.find((name) => choice.startsWith(name + "."))!;
			const title = role === "researcher" ? "Researcher" : "Worker";
			const settings = config[role];
			const selected = findModelByRef(models, settings.model);
			const model = settings.model ? selected : ctx.model;
			const effective = resolveThinkingLevel(model, settings.thinking);
			if (choice === role + ".model") {
				const hint = settings.model && !selected ? "Saved model unavailable. Choose an available model to resume this role."
					: "Models available in this session";
				const picked = await promptSelectOne(ctx, title + " model", hint,
					buildModelPickerItems({ models, configuredRef: settings.model, mainRef: currentModelRef(ctx) }),
					settings.model ?? CURRENT_MAIN_MODEL);
				if (picked === undefined) continue;
				await updateConfig(configPath, (next) => {
					if (picked === CURRENT_MAIN_MODEL) delete next[role].model;
					else next[role].model = picked;
				});
				status = title + " model saved";
			} else if (choice === role + ".thinking") {
				const levels = supportedThinkingLevels(model);
				if (!levels.length) {
					ctx.ui.notify("Choose a model before changing thinking; its supported levels are not available yet.", "info");
					continue;
				}
				const items: SetupItem[] = levels.map((level) => ({
					value: level, label: level + (level === DEFAULT_THINKING_LEVEL ? " (default)" : ""),
					description: THINKING_HINTS[level], saved: level === settings.thinking,
				}));
				if (!levels.includes(settings.thinking)) items.push({
					value: settings.thinking, label: settings.thinking + " (runs as " + effective + ")",
					description: "Saved preference; the current model clamps it.", saved: true,
				});
				const picked = await promptSelectOne(ctx, title + " thinking", "Reasoning effort for the selected model", items, settings.thinking);
				if (picked === undefined) continue;
				await updateConfig(configPath, (next) => { next[role].thinking = picked as ThinkingLevel; });
				status = title + " thinking saved";
			} else if (choice === role + ".reset") {
				await updateConfig(configPath, (next) => { next[role] = { ...DEFAULT_AGENT_SETTINGS }; });
				status = title + " defaults restored";
			}
		}
	} catch (error) {
		ctx.ui.notify("pi-subagents setup failed: " + errorMessage(error), "error");
	}
}

export async function ensureDefaultConfig(
	ctx: ExtensionContext,
	configPath: string = getConfigPath(),
	options: { repair?: boolean } = {},
): Promise<void> {
	try {
		const result = await initializeConfig(configPath, options);
		if (!result) return;
		const action = result === "reset" ? "overwrote the old config with independent role settings at "
			: result === "replaced-unreadable" ? "replaced the unreadable config with default role settings at "
			: result === "repaired" ? "repaired invalid role settings at "
					: "initialized role settings at ";
		ctx.ui.notify(
			"pi-subagents: " + action + configPath
			+ ". Run /subagents-setup to choose a model and thinking level for Researcher and Worker."
			+ (result === "repaired" ? "" : " Both default to Follow main with medium thinking."),
			"info",
		);
	} catch (error) {
		ctx.ui.notify("pi-subagents could not initialize settings: " + errorMessage(error) + ". Fix the config path and run /subagents-setup.", "warning");
	}
}
