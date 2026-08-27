/**
 * Interactive configuration wizard for /subagents-setup.
 *
 * The wizard stays one level deep and exposes only what most users touch:
 * which agents run, the model each runs on, and the delegation directive
 * toggle. Everything else (per-agent thinking, agent scope, idle timeout,
 * result lines, notifications) is config-file-only; model failures hand
 * directly to the current main model, and thinking defaults to capability-
 * aware Auto.
 */

import { stat } from "node:fs/promises";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
	BUILTIN_AGENT_NAMES,
	DEFAULT_CONFIG,
	DEFAULT_ENABLED_AGENTS,
	type SubagentsConfig,
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
	modelRef,
} from "./models.ts";
import { promptSelectMany, promptSelectOne } from "./ui.ts";

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
}

/** Configure agents while preserving the UI back stack: model selection returns
 * to the agent picker on Esc; agent-picker Esc ends this configuration pass. */
async function configureOneAgent(
	ctx: ExtensionCommandContext,
	config: SubagentsConfig,
): Promise<ConfiguredAgentChoice | undefined> {
	while (true) {
		const name = await pickAgentToConfigure(ctx, config.enabledAgents);
		if (name === undefined) return undefined;
		const model = await pickAgentModel(
			ctx,
			name,
			config.agentModels[name],
			"returns to agent selection",
		);
		if (model === undefined) continue;
		return { name, model };
	}
}

async function pickInjection(ctx: ExtensionCommandContext, current: boolean): Promise<boolean | undefined> {
	const on = "On — inject the delegation directive (recommended)";
	const off = "Off — rely on tool descriptions only";
	const choice = await ctx.ui.select("Proactive dispatch injection?", [current ? `${on} (current)` : on, current ? off : `${off} (current)`]);
	if (choice === undefined) return undefined;
	return choice.startsWith("On");
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

	const next: SubagentsConfig = {
		enabledAgents: enabled,
		agentModels,
		// Full setup returns every agent to capability-aware Auto thinking.
		agentThinkingLevels: {},
		notifyOnReviewPass: base.notifyOnReviewPass,
		maxResultLines: base.maxResultLines,
		proactiveInjection: injection,
		agentScope: base.agentScope,
		idleTimeoutSec: base.idleTimeoutSec,
	};
	await saveConfig(next, configPath);
	ctx.ui.notify(`pi-subagents configured with Auto thinking. Saved to ${configPath}`, "info");
	return true;
}

async function runMenu(ctx: ExtensionCommandContext, configPath: string, config: SubagentsConfig): Promise<void> {
	while (true) {
		const choice = await ctx.ui.select("pi-subagents settings", [
			"Enable/disable agents",
			"Configure agent models",
			"Proactive injection",
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
			// Per-agent loop: model Esc returns to the agent picker; agent-picker
			// Esc saves completed choices and returns to this settings menu.
			let configuredAny = false;
			while (true) {
				const picked = await configureOneAgent(ctx, next);
				if (!picked) break;
				configuredAny = true;
				next.agentModels = applyAgentModelChoice(next.agentModels, picked.name, picked.model);
			}
			if (!configuredAny) continue;
			await saveConfig(next, configPath);
			ctx.ui.notify(`pi-subagents updated. Saved to ${configPath}`, "info");
			config = next;
			continue;
		} else {
			const injection = await pickInjection(ctx, next.proactiveInjection);
			if (injection === undefined) continue;
			next.proactiveInjection = injection;
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
