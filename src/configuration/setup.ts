/**
 * Interactive configuration wizard for /subagents-setup.
 *
 * The catalog is fixed: scout and artisan are always enabled. The menu lets the
 * user pick a model and thinking level for each role — that is the entire
 * configuration surface.
 */

import { stat } from "node:fs/promises";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	AGENT_PROFILES,
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
	modelRef,
	resolveThinkingLevel,
	supportedThinkingLevels,
} from "./models.ts";
import { promptSelectOne } from "./ui.ts";

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

async function pickConfiguredModel(
	ctx: ExtensionContext,
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
	ctx: ExtensionContext,
	agentName: string,
	agentModels: Readonly<Record<string, string>>,
	escNote = "returns to the role list",
): Promise<string | undefined> {
	const profile = agentProfile(agentName);
	const duty = profile ? ` — ${profile.summary}` : "";
	return pickConfiguredModel(
		ctx,
		`Model for ${agentName}${duty}?`,
		agentModels[agentName],
		escNote,
	);
}

function effectiveModelForChoice(
	ctx: ExtensionContext,
	agentName: string,
	choice: string,
	agentModels: Readonly<Record<string, string>>,
): Model<Api> | undefined {
	const selectedModels = applyAgentModelChoice({ ...agentModels }, agentName, choice);
	const ref = selectedModels[agentName];
	return findModelByRef(availableModelsInScope(ctx), ref) ?? ctx.model;
}

/** The role default is marked; picking it clears a stored override. */
async function pickAgentStrength(
	ctx: ExtensionContext,
	agentName: string,
	model: Model<Api> | undefined,
	current: ThinkingLevel | undefined,
	escNote = "returns to model selection",
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

function applyThinkingChoice(
	levels: Record<string, ThinkingLevel>,
	agentName: string,
	strength: ThinkingLevel,
	model: Model<Api> | undefined,
): Record<string, ThinkingLevel> {
	const next = { ...levels };
	const roleDefault = resolveThinkingLevel(model, roleThinkingLevel(agentName));
	if (strength === roleDefault) delete next[agentName];
	else next[agentName] = resolveThinkingLevel(model, strength);
	return next;
}

interface RoleChoice {
	model: string;
	strength: ThinkingLevel;
}

/** Model then thinking for one fixed role. Esc on the model picker backs out to
 * the menu; Esc on the thinking picker re-asks the model. */
async function configureOneRole(
	ctx: ExtensionContext,
	agentName: string,
	config: SubagentsConfig,
): Promise<RoleChoice | undefined> {
	const profile = agentProfile(agentName);
	if (profile) ctx.ui.notify(`${agentName}: ${profile.remark}`, "info");
	while (true) {
		const modelChoice = await pickAgentModel(ctx, agentName, config.agentModels);
		if (modelChoice === undefined) return undefined;
		const model = effectiveModelForChoice(ctx, agentName, modelChoice, config.agentModels);
		const strength = await pickAgentStrength(
			ctx,
			agentName,
			model,
			config.agentThinkingLevels[agentName],
		);
		if (strength === undefined) continue;
		return { model: modelChoice, strength };
	}
}

async function applyRoleChoice(
	ctx: ExtensionContext,
	configPath: string,
	config: SubagentsConfig,
	agentName: string,
	choice: RoleChoice,
): Promise<SubagentsConfig> {
	const agentModels = applyAgentModelChoice({ ...config.agentModels }, agentName, choice.model);
	const model = effectiveModelForChoice(ctx, agentName, choice.model, agentModels);
	const next: SubagentsConfig = {
		agentModels,
		agentThinkingLevels: applyThinkingChoice(
			{ ...config.agentThinkingLevels },
			agentName,
			choice.strength,
			model,
		),
	};
	await saveConfig(next, configPath);
	return next;
}

async function introduceSetup(ctx: ExtensionContext): Promise<boolean> {
	const lines = BUILTIN_AGENT_NAMES.map((name) => {
		const profile = AGENT_PROFILES[name];
		return `${name} — ${profile.summary}. ${profile.remark}`;
	});
	const defaults = BUILTIN_AGENT_NAMES.map((name) => `${name} ${roleThinkingLevel(name)}`).join(", ");
	ctx.ui.notify(
		`pi-subagents: ${lines.join(" ")} Pick a model and its thinking level for each role next. Thinking starts at the role default (${defaults}).`,
		"info",
	);
	const choice = await ctx.ui.select("How to configure pi-subagents", [
		"Continue — pick a model, then its thinking level, for each role",
	]);
	return choice !== undefined;
}

/** Walk both roles in order — model, then thinking — and save once at the end. */
async function runFullSetup(ctx: ExtensionContext, configPath: string, base: SubagentsConfig): Promise<boolean> {
	if (!(await introduceSetup(ctx))) return false;

	let agentModels = { ...base.agentModels };
	let agentThinkingLevels = { ...base.agentThinkingLevels };
	for (const agentName of BUILTIN_AGENT_NAMES) {
		const profile = agentProfile(agentName);
		if (profile) ctx.ui.notify(`${agentName}: ${profile.remark}`, "info");
		const choice = await pickAgentModel(ctx, agentName, agentModels);
		if (choice === undefined) return false;
		agentModels = applyAgentModelChoice(agentModels, agentName, choice);
		// Thinking follows the model immediately: the supported levels come from
		// the model just picked, so this is the only moment the choice is exact.
		const model = effectiveModelForChoice(ctx, agentName, choice, agentModels);
		const strength = await pickAgentStrength(ctx, agentName, model, agentThinkingLevels[agentName]);
		if (strength === undefined) return false;
		agentThinkingLevels = applyThinkingChoice(agentThinkingLevels, agentName, strength, model);
	}

	await saveConfig({ agentModels, agentThinkingLevels }, configPath);
	ctx.ui.notify(`pi-subagents saved to ${configPath}.`, "info");
	return true;
}

function roleRow(name: string, config: SubagentsConfig): string {
	const profile = AGENT_PROFILES[name as keyof typeof AGENT_PROFILES];
	const model = config.agentModels[name] ?? "current main model";
	const thinking = config.agentThinkingLevels[name] ?? roleThinkingLevel(name);
	return `${name} — ${profile.summary} · model: ${model} · thinking: ${thinking}`;
}

/** Menu: one row per fixed role showing its current route, plus a both-roles
 * walk. Esc exits; saving happens after each change so a later Esc loses
 * nothing. */
async function runMenu(ctx: ExtensionContext, configPath: string, config: SubagentsConfig): Promise<void> {
	while (true) {
		const rows = BUILTIN_AGENT_NAMES.map((name) => roleRow(name, config));
		const choice = await ctx.ui.select("pi-subagents settings", [
			...rows,
			"Both roles — walk model and thinking for each",
		]);
		if (choice === undefined) return;
		if (choice.startsWith("Both")) {
			if (await runFullSetup(ctx, configPath, config)) return;
			continue;
		}
		const agentName = BUILTIN_AGENT_NAMES.find((name) => choice.startsWith(name));
		if (!agentName) continue;
		const picked = await configureOneRole(ctx, agentName, config);
		if (!picked) continue;
		config = await applyRoleChoice(ctx, configPath, config, agentName, picked);
		ctx.ui.notify(`pi-subagents updated. Saved to ${configPath}`, "info");
	}
}

/** Entry point for the /subagents-setup command. */
export async function runSetup(ctx: ExtensionContext, configPath: string = getConfigPath()): Promise<void> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify("/subagents-setup requires Pi's interactive TUI.", "error");
		return;
	}
	try {
		const exists = await configExists(configPath);
		const config = await loadConfig(configPath);
		if (exists) await runMenu(ctx, configPath, config);
		else if (!(await runFullSetup(ctx, configPath, DEFAULT_CONFIG))) {
			ctx.ui.notify("pi-subagents setup cancelled.", "info");
		}
	} catch (error) {
		ctx.ui.notify(`pi-subagents setup failed: ${errorMessage(error)}`, "error");
	}
}

/**
 * First start: write the shipped defaults so both roles work immediately — no
 * model overrides means each child follows the main model — then announce the
 * command that customizes them. The file is the marker: once it exists, later
 * sessions stay silent.
 */
export async function ensureDefaultConfig(
	ctx: ExtensionContext,
	configPath: string = getConfigPath(),
): Promise<void> {
	if (await configExists(configPath)) return;
	await saveConfig(DEFAULT_CONFIG, configPath);
	ctx.ui.notify(
		`pi-subagents: wrote ${configPath} with scout and artisan enabled; both follow the main model. Run /subagents-setup to pick a model and thinking level per role.`,
		"info",
	);
}
