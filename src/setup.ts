/**
 * Interactive configuration wizard for /subagents-setup.
 *
 * Everything is selection-driven (no free-text answers). Enabled agents share a
 * compact primary/backup model-pool editor backed by one searchable model list;
 * the remaining settings use small selection menus. Config is written to
 * <agentDir>/pi-subagents.json.
 */

import { stat } from "node:fs/promises";
import type { ExtensionCommandContext, KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, type Component, type TUI } from "@earendil-works/pi-tui";
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
import {
	CURRENT_MAIN_MODEL,
	applyModelPoolChoice,
	availableModelsInScope,
	buildAgentModelPoolRows,
	buildModelPickerItems,
	currentModelRef,
	modelRef,
	type AgentModelPoolMaps,
	type ModelPickerSlot,
	type ModelPoolSlot,
} from "./models.ts";
import { promptSelectMany, promptSelectOne } from "./ui.ts";
import { loadBuiltinAgents } from "./agents.ts";

const INHERIT = "__inherit__";
const MODEL_POOL_WIDE_MIN = 96;

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
	cleaner: "evidence-first cleanup: audit or verified cuts (full tools)",
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

type ModelPoolEditorResult =
	| { action: "edit"; agentName: string; slot: ModelPoolSlot }
	| { action: "save" };

interface ModelPoolEditorStyles {
	border(text: string): string;
	title(text: string): string;
	dim(text: string): string;
	accent(text: string): string;
	selected(text: string): string;
}

/** Compact overview: every enabled agent shows Primary and Backup on one row. */
class ModelPoolEditor implements Component {
	private row = 0;
	private slot: ModelPoolSlot = "primary";

	constructor(
		private readonly agentNames: readonly string[],
		private readonly pools: AgentModelPoolMaps,
		private readonly styles: ModelPoolEditorStyles,
		private readonly tui: TUI,
		private readonly keybindings: KeybindingsManager,
		private readonly done: (result: ModelPoolEditorResult | undefined) => void,
		initialCell?: { agentName: string; slot: ModelPoolSlot },
	) {
		const initialRow = initialCell ? agentNames.indexOf(initialCell.agentName) : -1;
		if (initialCell && initialRow >= 0) {
			this.row = initialRow;
			this.slot = initialCell.slot;
		}
	}

	render(width: number): string[] {
		const fit = (line: string): string => truncateToWidth(line, width, "");
		const border = this.styles.border("─".repeat(Math.max(1, width)));
		const rows = buildAgentModelPoolRows(this.agentNames, this.pools);
		const lines = [
			fit(border),
			fit(this.styles.title("Agent model pools")),
			fit(this.styles.dim("↑/↓ agent • ←/→ Primary/Backup • Enter edit/save • Esc cancel")),
			fit(border),
		];
		for (let index = 0; index < rows.length; index++) {
			const pool = rows[index];
			const active = this.row === index;
			const mark = active ? this.styles.accent("❯ ") : "  ";
			const primary = active && this.slot === "primary"
				? this.styles.selected(`[Primary: ${pool.primary}]`)
				: `Primary: ${pool.primary}`;
			const backup = active && this.slot === "backup"
				? this.styles.selected(`[Backup: ${pool.backup}]`)
				: `Backup: ${pool.backup}`;
			if (width >= MODEL_POOL_WIDE_MIN) {
				lines.push(fit(`${mark}${this.styles.accent(pool.name)} · ${primary} · ${backup}`));
			} else {
				// Keep both cells visible on narrow terminals; a long primary can no
				// longer push Backup (including its selected state) off-screen.
				lines.push(fit(`${mark}${this.styles.accent(pool.name)}`));
				lines.push(fit(`    ${primary}`));
				lines.push(fit(`    ${backup}`));
			}
		}
		const saveActive = this.row === rows.length;
		lines.push(fit(`${saveActive ? this.styles.accent("❯ ") : "  "}${saveActive ? this.styles.selected("Save model pools and continue") : "Save model pools and continue"}`));
		lines.push(fit(border));
		return lines;
	}

	handleInput(data: string): void {
		const lastRow = this.agentNames.length;
		if (this.keybindings.matches(data, "tui.select.up")) {
			this.row = this.row === 0 ? lastRow : this.row - 1;
		} else if (this.keybindings.matches(data, "tui.select.down")) {
			this.row = this.row === lastRow ? 0 : this.row + 1;
		} else if (
			this.row < lastRow &&
			(this.keybindings.matches(data, "tui.editor.cursorLeft") ||
				this.keybindings.matches(data, "tui.editor.cursorRight"))
		) {
			this.slot = this.slot === "primary" ? "backup" : "primary";
		} else if (this.keybindings.matches(data, "tui.select.confirm")) {
			if (this.row === lastRow) this.done({ action: "save" });
			else this.done({ action: "edit", agentName: this.agentNames[this.row], slot: this.slot });
			return;
		} else if (this.keybindings.matches(data, "tui.select.cancel")) {
			this.done(undefined);
			return;
		}
		this.tui.requestRender();
	}

	invalidate(): void {}
}

async function promptModelPoolOverview(
	ctx: ExtensionCommandContext,
	agentNames: readonly string[],
	pools: AgentModelPoolMaps,
	initialCell?: { agentName: string; slot: ModelPoolSlot },
): Promise<ModelPoolEditorResult | undefined> {
	return ctx.ui.custom<ModelPoolEditorResult | undefined>((tui, theme, keybindings, done) =>
		new ModelPoolEditor(
			agentNames,
			pools,
			{
				border: (text) => theme.fg("accent", text),
				title: (text) => theme.fg("accent", theme.bold(text)),
				dim: (text) => theme.fg("dim", text),
				accent: (text) => theme.fg("accent", text),
				selected: (text) => theme.fg("accent", theme.bold(text)),
			},
			tui,
			keybindings,
			done,
			initialCell,
		),
	);
}

async function pickConfiguredModel(
	ctx: ExtensionCommandContext,
	title: string,
	slot: ModelPickerSlot,
	configuredRef: string | undefined,
	escNote: string,
): Promise<string | undefined> {
	const models = availableModelsInScope(ctx);
	const items = buildModelPickerItems({
		models,
		availableRefs: models.map(modelRef),
		slot,
		configuredRef,
		mainRef: currentModelRef(ctx),
	});
	return promptSelectOne(
		ctx,
		title,
		`Type to filter by provider, model, capability, or availability • ↑/↓ • Enter selects • Esc ${escNote}`,
		items,
		configuredRef ?? CURRENT_MAIN_MODEL,
	);
}

/** Shared by full setup and configure-one-agent. Esc in a model list returns to
 * the overview; Esc in the overview cancels the whole pool edit. */
async function editModelPools(
	ctx: ExtensionCommandContext,
	agentNames: readonly string[],
	initial: AgentModelPoolMaps,
): Promise<AgentModelPoolMaps | undefined> {
	let pools: AgentModelPoolMaps = {
		agentModels: { ...initial.agentModels },
		agentBackupModels: { ...initial.agentBackupModels },
	};
	let activeCell: { agentName: string; slot: ModelPoolSlot } | undefined;
	while (true) {
		const action = await promptModelPoolOverview(ctx, agentNames, pools, activeCell);
		if (action === undefined) return undefined;
		if (action.action === "save") return pools;
		activeCell = { agentName: action.agentName, slot: action.slot };
		const current = action.slot === "primary"
			? pools.agentModels[action.agentName]
			: pools.agentBackupModels[action.agentName];
		const choice = await pickConfiguredModel(
			ctx,
			`${action.slot === "primary" ? "Primary" : "Backup"} model for "${action.agentName}"`,
			action.slot,
			current,
			"returns to model pools",
		);
		if (choice !== undefined) pools = applyModelPoolChoice(pools, action.agentName, action.slot, choice);
	}
}

async function pickVisionModel(
	ctx: ExtensionCommandContext,
	currentRef: string | undefined,
): Promise<string | undefined> {
	return pickConfiguredModel(
		ctx,
		"Vision primary for image tasks (then agent backup → current main model)",
		"vision",
		currentRef,
		"cancels setup",
	);
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

/** Configure one selected agent with the same pool overview/picker used by
 * full setup, then retain the existing focused thinking-strength picker. */
async function configureOneAgent(
	ctx: ExtensionCommandContext,
	enabledAgents: readonly string[],
	currentPools: AgentModelPoolMaps,
	currentStrengths: Record<string, ThinkingLevel>,
	defaultLevel: ThinkingLevel,
	defaults: ReadonlyMap<string, ThinkingLevel>,
): Promise<
	| {
			name: string;
			pools: AgentModelPoolMaps;
			strength: ThinkingLevel | typeof INHERIT;
	  }
	| undefined
> {
	const name = await pickAgentToConfigure(ctx, enabledAgents);
	if (name === undefined) return undefined;
	const pools = await editModelPools(ctx, [name], currentPools);
	if (pools === undefined) return undefined;
	const strength = await pickAgentStrength(
		ctx,
		name,
		currentStrengths[name],
		defaultLevel,
		defaults,
		"stops — earlier agent changes are kept",
	);
	if (strength === undefined) return undefined;
	return { name, pools, strength };
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

function keepAgentEntries<T>(record: Record<string, T>, enabled: readonly string[]): Record<string, T> {
	const keep = new Set(enabled);
	return Object.fromEntries(Object.entries(record).filter(([name]) => keep.has(name)));
}

async function runFullSetup(ctx: ExtensionCommandContext, configPath: string, base: SubagentsConfig): Promise<void> {
	const enabled = await pickEnabledAgents(ctx, base.enabledAgents);
	if (enabled === undefined) return notifyCancelled(ctx);

	const thinkingLevel = await pickThinkingLevel(ctx, base.thinkingLevel);
	if (thinkingLevel === undefined) return notifyCancelled(ctx);

	const pools = await editModelPools(ctx, enabled, {
		agentModels: base.agentModels,
		agentBackupModels: base.agentBackupModels,
	});
	if (pools === undefined) return notifyCancelled(ctx);

	const defaults = builtinThinkingDefaults();
	const agentThinkingLevels = keepAgentEntries({ ...base.agentThinkingLevels }, enabled);
	for (const agentName of enabled) {
		const strength = await pickAgentStrength(
			ctx,
			agentName,
			agentThinkingLevels[agentName],
			thinkingLevel,
			defaults,
		);
		if (strength === undefined) return notifyCancelled(ctx);
		if (strength === INHERIT) delete agentThinkingLevels[agentName];
		else agentThinkingLevels[agentName] = strength;
	}

	const visionModel = await pickVisionModel(ctx, base.visionModel);
	if (visionModel === undefined) return notifyCancelled(ctx);

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
		agentModels: keepAgentEntries(pools.agentModels, enabled),
		agentBackupModels: keepAgentEntries(pools.agentBackupModels, enabled),
		agentThinkingLevels,
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
	if (visionModel !== CURRENT_MAIN_MODEL) next.visionModel = visionModel;
	await saveConfig(next, configPath);
	ctx.ui.notify(`pi-subagents configured. Saved to ${configPath}`, "info");
}

async function runMenu(ctx: ExtensionCommandContext, configPath: string, config: SubagentsConfig): Promise<void> {
	const choice = await ctx.ui.select("pi-subagents is already configured. What would you like to change?", [
		"Enable/disable agents",
		"Configure an agent (model pool + thinking)",
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

	let next: SubagentsConfig = {
		...config,
		agentModels: { ...config.agentModels },
		agentBackupModels: { ...config.agentBackupModels },
	};

	if (choice.startsWith("Enable")) {
		const enabled = await pickEnabledAgents(ctx, config.enabledAgents);
		if (enabled === undefined) return notifyCancelled(ctx);
		next.enabledAgents = enabled;
	} else if (choice.startsWith("Configure an agent")) {
		// Per-agent loop: pick one agent, edit Primary + Backup together, then its
		// thinking strength. Esc ends the loop; earlier saved agent changes remain.
		const defaults = builtinThinkingDefaults();
		let configuredAny = false;
		next.agentThinkingLevels = { ...config.agentThinkingLevels };
		while (true) {
			const picked = await configureOneAgent(
				ctx,
				next.enabledAgents,
				{
					agentModels: next.agentModels,
					agentBackupModels: next.agentBackupModels,
				},
				next.agentThinkingLevels,
				next.thinkingLevel,
				defaults,
			);
			if (picked === undefined) break;
			configuredAny = true;
			next.agentModels = picked.pools.agentModels;
			next.agentBackupModels = picked.pools.agentBackupModels;
			if (picked.strength === INHERIT) delete next.agentThinkingLevels[picked.name];
			else next.agentThinkingLevels[picked.name] = picked.strength;
		}
		if (!configuredAny) return notifyCancelled(ctx);
	} else if (choice.startsWith("Toggle")) {
		const injection = await pickInjection(ctx, config.proactiveInjection);
		if (injection === undefined) return notifyCancelled(ctx);
		next.proactiveInjection = injection;
	} else if (choice.startsWith("Change vision")) {
		const visionModel = await pickVisionModel(ctx, config.visionModel);
		if (visionModel === undefined) return notifyCancelled(ctx);
		if (visionModel === CURRENT_MAIN_MODEL) delete next.visionModel;
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
		const config = await loadConfig(configPath);
		if (exists) await runMenu(ctx, configPath, config);
		else await runFullSetup(ctx, configPath, { ...DEFAULT_CONFIG, enabledAgents: [...DEFAULT_ENABLED_AGENTS] });
	} catch (error) {
		ctx.ui.notify(`pi-subagents setup failed: ${errorMessage(error)}`, "error");
	}
}
