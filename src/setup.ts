/** Single-overlay editor for the UI-configurable pi-subagents settings. */

import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import {
	truncateToWidth,
	type Component,
	type Focusable,
	type KeybindingsManager,
	type TUI,
} from "@earendil-works/pi-tui";
import {
	BUILTIN_AGENT_NAMES,
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
	findModelByRef,
	resolveThinkingLevel,
	supportedThinkingLevels,
} from "./models.ts";
import { makePickerStyles, Picker } from "./ui.ts";

const FIELD_COUNT = 3;
const WIDE_LAYOUT_MIN_WIDTH = 112;

type SetupResult = SubagentsConfig | undefined;

export interface SetupOverlayOptions {
	config: SubagentsConfig;
	models: readonly Model<Api>[];
	mainModel: Model<Api> | undefined;
	theme: Theme;
	tui: TUI;
	keybindings: KeybindingsManager;
	onDone: (result: SetupResult) => void;
}

function cloneConfig(config: SubagentsConfig): SubagentsConfig {
	return {
		...config,
		enabledAgents: [...config.enabledAgents],
		knownAgents: [...config.knownAgents],
		agentModels: { ...config.agentModels },
		agentThinkingLevels: { ...config.agentThinkingLevels },
	};
}

function setupAgentNames(config: SubagentsConfig): string[] {
	return [
		...new Set([
			...BUILTIN_AGENT_NAMES,
			...config.knownAgents,
			...config.enabledAgents,
			...Object.keys(config.agentModels),
			...Object.keys(config.agentThinkingLevels),
		]),
	];
}

/**
 * Transactional settings component. It mutates only its private draft and
 * returns that draft exclusively from the explicit Save & Exit row.
 */
export class SetupOverlay implements Component, Focusable {
	private _focused = false;
	private readonly state: SubagentsConfig;
	private readonly agents: string[];
	private row = 0;
	private field = 0;
	private modelPicker: Picker | undefined;

	constructor(private readonly options: SetupOverlayOptions) {
		this.state = cloneConfig(options.config);
		this.agents = setupAgentNames(this.state);
		this.state.knownAgents = [...new Set([...this.state.knownAgents, ...this.agents])];
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		if (this.modelPicker) this.modelPicker.focused = value;
	}

	render(width: number): string[] {
		if (this.modelPicker) return this.modelPicker.render(width);

		const { theme } = this.options;
		const safeWidth = Math.max(0, width);
		const fit = (line: string): string => truncateToWidth(line, safeWidth, "", true);
		const border = theme.fg("border", "─".repeat(Math.max(1, safeWidth)));
		const lines = [
			border,
			theme.fg("accent", theme.bold("pi-subagents setup")),
			theme.fg("dim", "↑/↓ agent or action • ←/→ field • Enter/Space edit • Esc cancels without saving"),
			border,
		];

		const maxVisibleAgents = safeWidth >= WIDE_LAYOUT_MIN_WIDTH ? 8 : 3;
		const activeAgentRow = Math.min(this.row, this.agents.length - 1);
		const start = Math.max(
			0,
			Math.min(activeAgentRow - Math.floor(maxVisibleAgents / 2), this.agents.length - maxVisibleAgents),
		);
		const end = Math.min(start + maxVisibleAgents, this.agents.length);
		for (let index = start; index < end; index++) {
			const name = this.agents[index]!;
			const active = index === this.row;
			const cursor = active ? theme.fg("accent", "❯ ") : "  ";
			const enabled = this.state.enabledAgents.includes(name);
			const enabledText = this.cell(enabled ? "[x]" : "[ ]", active && this.field === 0);
			const profile = agentProfile(name);
			const nameText = profile ? `${name} — ${profile.summary}` : `${name} (custom)`;
			const modelText = this.cell(`model: ${this.modelDisplay(name)}`, active && this.field === 1);
			const thinkingText = this.cell(`thinking: ${this.thinkingDisplay(name)}`, active && this.field === 2);

			if (safeWidth >= WIDE_LAYOUT_MIN_WIDTH) {
				lines.push(`${cursor}${enabledText} ${nameText} │ ${modelText} │ ${thinkingText}`);
			} else {
				lines.push(`${cursor}${enabledText} ${nameText}`);
				lines.push(`    ${modelText}`);
				lines.push(`    ${thinkingText}`);
			}
		}
		const range = start > 0 || end < this.agents.length
			? `agents ${start + 1}-${end} of ${this.agents.length}`
			: undefined;
		const selectedName = this.agents[this.row];
		const selectedProfile = selectedName ? agentProfile(selectedName) : undefined;
		const context = [range, selectedProfile?.remark].filter(Boolean).join(" · ");
		if (context) lines.push(theme.fg("dim", `  ${context}`));
		lines.push(border);
		lines.push(this.actionLine(this.agents.length, "Save & Exit", "persist all changes"));
		lines.push(this.actionLine(this.agents.length + 1, "Cancel", "discard this session"));
		lines.push(border);
		return lines.map(fit);
	}

	handleInput(data: string): void {
		if (this.modelPicker) {
			this.modelPicker.handleInput(data);
			return;
		}

		const { keybindings } = this.options;
		const rowCount = this.agents.length + 2;
		if (keybindings.matches(data, "tui.select.cancel")) {
			this.options.onDone(undefined);
			return;
		}
		if (keybindings.matches(data, "tui.select.up")) {
			this.row = (this.row - 1 + rowCount) % rowCount;
		} else if (keybindings.matches(data, "tui.select.down")) {
			this.row = (this.row + 1) % rowCount;
		} else if (this.row < this.agents.length && keybindings.matches(data, "tui.editor.cursorLeft")) {
			this.field = (this.field - 1 + FIELD_COUNT) % FIELD_COUNT;
		} else if (this.row < this.agents.length && keybindings.matches(data, "tui.editor.cursorRight")) {
			this.field = (this.field + 1) % FIELD_COUNT;
		} else if (keybindings.matches(data, "tui.select.confirm") || data === " ") {
			this.activateCurrent();
		}
		this.options.tui.requestRender();
	}

	invalidate(): void {
		this.modelPicker?.invalidate();
	}

	private cell(text: string, selected: boolean): string {
		if (!selected) return text;
		return this.options.theme.bg("selectedBg", this.options.theme.fg("accent", text));
	}

	private actionLine(row: number, label: string, description: string): string {
		const active = this.row === row;
		const cursor = active ? this.options.theme.fg("accent", "❯ ") : "  ";
		const text = active ? this.cell(label, true) : label;
		return `${cursor}${text} ${this.options.theme.fg("dim", `— ${description}`)}`;
	}

	private activateCurrent(): void {
		if (this.row === this.agents.length) {
			this.options.onDone(cloneConfig(this.state));
			return;
		}
		if (this.row === this.agents.length + 1) {
			this.options.onDone(undefined);
			return;
		}

		const name = this.agents[this.row];
		if (!name) return;
		if (this.field === 0) this.toggleEnabled(name);
		else if (this.field === 1) this.openModelPicker(name);
		else this.cycleThinking(name);
	}

	private toggleEnabled(name: string): void {
		if (this.state.enabledAgents.includes(name)) {
			this.state.enabledAgents = this.state.enabledAgents.filter((candidate) => candidate !== name);
		} else {
			this.state.enabledAgents = [...this.state.enabledAgents, name];
		}
	}

	private openModelPicker(name: string): void {
		const explicitRef = this.state.agentModels[name];
		const items = buildModelPickerItems({
			models: this.options.models,
			configuredRef: explicitRef,
			mainRef: this.options.mainModel ? `${this.options.mainModel.provider}/${this.options.mainModel.id}` : undefined,
		});
		if (name === "sentinel") {
			const inherited = this.state.agentModels.artisan ?? "current main model";
			items[0] = {
				value: CURRENT_MAIN_MODEL,
				label: "Follow artisan (role default)",
				description: `Clear the sentinel override; currently follows ${inherited}`,
			};
		}

		const styles = makePickerStyles(this.options.theme);
		this.modelPicker = new Picker(
			items,
			styles,
			[
				styles.title(`Model for ${name}`),
				styles.hint("Type to filter • ↑/↓ move • Enter select • Esc return to table"),
			],
			this.options.tui,
			this.options.keybindings,
			{
				onSelect: (choice) => {
					this.state.agentModels = applyAgentModelChoice(this.state.agentModels, name, choice);
					this.clampThinkingOverride(name);
					if (name === "artisan" && this.state.agentModels.sentinel === undefined) {
						this.clampThinkingOverride("sentinel");
					}
					this.closeModelPicker();
				},
				onCancel: () => this.closeModelPicker(),
			},
			explicitRef ?? CURRENT_MAIN_MODEL,
		);
		this.modelPicker.focused = this.focused;
	}

	private closeModelPicker(): void {
		this.modelPicker = undefined;
		this.options.tui.requestRender();
	}

	private effectiveModel(name: string): Model<Api> | undefined {
		const explicitRef = this.state.agentModels[name];
		const inheritedRef = name === "sentinel" && explicitRef === undefined ? this.state.agentModels.artisan : undefined;
		return findModelByRef(this.options.models, explicitRef ?? inheritedRef) ?? this.options.mainModel;
	}

	private clampThinkingOverride(name: string): void {
		const current = this.state.agentThinkingLevels[name];
		if (current === undefined) return;
		this.state.agentThinkingLevels[name] = resolveThinkingLevel(this.effectiveModel(name), current);
	}

	private cycleThinking(name: string): void {
		const model = this.effectiveModel(name);
		const roleDefault = resolveThinkingLevel(model, roleThinkingLevel(name));
		const overrides = supportedThinkingLevels(model).filter((level) => level !== roleDefault);
		const current = this.state.agentThinkingLevels[name];
		let next: ThinkingLevel | undefined;
		if (current === undefined) {
			next = overrides[0];
		} else {
			const index = overrides.indexOf(current);
			next = index < 0 || index === overrides.length - 1 ? undefined : overrides[index + 1];
		}
		if (next === undefined) delete this.state.agentThinkingLevels[name];
		else this.state.agentThinkingLevels[name] = next;
	}

	private modelDisplay(name: string): string {
		const explicitRef = this.state.agentModels[name];
		if (explicitRef) return explicitRef;
		if (name === "sentinel") return `follow artisan → ${this.state.agentModels.artisan ?? "current main"}`;
		return "current main (dynamic)";
	}

	private thinkingDisplay(name: string): string {
		const override = this.state.agentThinkingLevels[name];
		if (override !== undefined) return `${resolveThinkingLevel(this.effectiveModel(name), override)} (override)`;
		const roleDefault = resolveThinkingLevel(this.effectiveModel(name), roleThinkingLevel(name));
		return `${roleDefault} (role default)`;
	}
}

/** Entry point for the /subagents-setup command. */
export async function runSetup(ctx: ExtensionCommandContext, configPath: string = getConfigPath()): Promise<void> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify("/subagents-setup requires Pi's interactive TUI.", "error");
		return;
	}

	try {
		const config = await loadConfig(configPath, { persistNormalization: false });
		const models = availableModelsInScope(ctx);
		const result = await ctx.ui.custom<SetupResult>(
			(tui, theme, keybindings, done) =>
				new SetupOverlay({
					config,
					models,
					mainModel: ctx.model,
					theme,
					tui,
					keybindings,
					onDone: done,
				}),
			{
				overlay: true,
				overlayOptions: { anchor: "center", width: "90%", minWidth: 36, maxHeight: "90%", margin: 1 },
			},
		);
		if (result === undefined) {
			ctx.ui.notify("pi-subagents setup cancelled; no changes saved.", "info");
			return;
		}
		await saveConfig(result, configPath);
		ctx.ui.notify(`pi-subagents updated. Saved to ${configPath}`, "info");
	} catch (error) {
		ctx.ui.notify(`pi-subagents setup failed: ${errorMessage(error)}`, "error");
	}
}
