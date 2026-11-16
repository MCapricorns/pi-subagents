/** One worker, two settings. Main keeps Pi's model; workers share their own selection. */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_CONFIG, DEFAULT_THINKING_LEVEL, errorMessage, getConfigPath,
	initializeConfig, loadConfig, saveConfig, type ThinkingLevel,
} from "./config.ts";
import {
	CURRENT_MAIN_MODEL, availableModelsInScope, buildModelPickerItems, currentModelRef,
	findModelByRef, resolveThinkingLevel, supportedThinkingLevels,
} from "./models.ts";
import { promptSelectOne, promptSettings, type SetupItem } from "./ui.ts";

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
		await ensureDefaultConfig(ctx, configPath);
		let focus = "model";
		let status = "Changes save immediately";
		while (true) {
			const config = await loadConfig(configPath);
			const models = availableModelsInScope(ctx);
			const selected = findModelByRef(models, config.model);
			const model = selected ?? ctx.model;
			const effective = resolveThinkingLevel(model, config.thinking);
			const choice = await promptSettings(ctx, {
				main: currentModelRef(ctx) ?? "Pi default",
				model: config.model ?? "Follow main",
				thinking: config.model && !selected ? config.thinking : effective + (effective !== config.thinking ? " (" + config.thinking + " requested)" : ""),
				note: config.model && !selected ? "Worker unavailable; dispatch paused. Select an available model." : !config.model ? "Choose a cheaper worker to reduce main-model spending." : "",
				status, focus,
			});
			if (!choice) return;
			focus = choice;
			if (choice === "model") {
				const picked = await promptSelectOne(ctx, "Worker model", "Choose a cost-effective model · Esc back",
					buildModelPickerItems({ models, configuredRef: config.model, mainRef: currentModelRef(ctx) }),
					config.model ?? CURRENT_MAIN_MODEL);
				if (picked === undefined) continue;
				const next = await loadConfig(configPath);
				if (picked === CURRENT_MAIN_MODEL) delete next.model;
				else next.model = picked;
				await saveConfig(next, configPath);
				status = "Model saved";
			} else if (choice === "thinking") {
				const levels = supportedThinkingLevels(config.model && !selected ? undefined : model);
				if (!levels.length) {
					ctx.ui.notify("Choose a model before changing thinking; its supported levels are not available yet.", "info");
					continue;
				}
				const items: SetupItem[] = levels.map((level) => ({
					value: level, label: level + (level === DEFAULT_THINKING_LEVEL ? " (default)" : ""),
					description: THINKING_HINTS[level], saved: level === config.thinking,
				}));
				if (!levels.includes(config.thinking)) items.push({
					value: config.thinking, label: config.thinking + " (runs as " + effective + ")",
					description: "Saved preference; the current model clamps it.", saved: true,
				});
				const picked = await promptSelectOne(ctx, "Worker thinking", "Reasoning effort · Esc back", items, config.thinking);
				if (picked === undefined) continue;
				await saveConfig({ ...await loadConfig(configPath), thinking: picked as ThinkingLevel }, configPath);
				status = "Thinking saved";
			} else if (choice === "reset") {
				await saveConfig({ ...DEFAULT_CONFIG }, configPath);
				status = "Defaults restored";
			}
		}
	} catch (error) {
		ctx.ui.notify("pi-subagents setup failed: " + errorMessage(error), "error");
	}
}

export async function ensureDefaultConfig(ctx: ExtensionContext, configPath: string = getConfigPath()): Promise<void> {
	try {
		const result = await initializeConfig(configPath);
		if (!result) return;
		ctx.ui.notify(
			"pi-subagents: " + (result === "reset" ? "deleted the old config and initialized new worker settings at " : "initialized worker settings at ")
			+ configPath + ". Main plans and reviews; workers execute. Run /subagents-setup to choose a cost-effective worker model and thinking level. Defaults follow main with medium thinking.",
			"info",
		);
	} catch (error) {
		ctx.ui.notify("pi-subagents could not initialize settings: " + errorMessage(error) + ". Fix the config path and run /subagents-setup.", "warning");
	}
}
