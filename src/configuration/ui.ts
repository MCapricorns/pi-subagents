/** Role settings and searchable model selection in a keyboard-driven overlay. */

import {
	Input, fuzzyFilter, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi,
	type Component, type Focusable, type Keybinding, type KeybindingsManager, type OverlayOptions, type SelectItem, type TUI,
} from "@earendil-works/pi-tui";
import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { BUILTIN_AGENT_NAMES, type AgentName } from "./config.ts";

type PickerContext = Pick<ExtensionCommandContext, "mode" | "ui">;
const PAGE_SIZE = 10;

export const SETUP_OVERLAY_OPTIONS: OverlayOptions = {
	anchor: "center",
	width: "86%",
	minWidth: 72,
	maxHeight: "88%",
	margin: { top: 1, bottom: 1, left: 2, right: 2 },
};

/** Modal height budget on the full terminal canvas instead of the input dock. */
function setupHeight(tui: TUI): number {
	const termRows = tui.terminal.rows;
	const maxRows = Math.floor(termRows * 0.88);
	return Math.max(1, Math.min(maxRows, termRows - 2));
}

function keyLabel(keys: KeybindingsManager, action: Keybinding): string {
	const key = keys.getKeys(action)[0];
	if (!key) return "unbound";
	const labels: Record<string, string> = { up: "↑", down: "↓", enter: "Enter", escape: "Esc", pageUp: "PgUp", pageDown: "PgDn", ctrl: "Ctrl", alt: "Alt", shift: "Shift" };
	return key.split("+").map((part) => labels[part] ?? part).join("+");
}

function padToWidth(text: string, width: number): string {
	const truncated = truncateToWidth(text, width, "…");
	return truncated + " ".repeat(Math.max(0, width - visibleWidth(truncated)));
}

function framePanel(theme: Theme, width: number, title: string, subtitle: string | undefined, body: string[], footer: string[]): string[] {
	if (width <= 0) return [];
	if (width < 20) {
		return [theme.bold(title), ...(subtitle ? [theme.fg("dim", subtitle)] : []), ...body, ...footer]
			.map((line) => truncateToWidth(line, width, "…"));
	}
	const border = (text: string) => theme.fg("border", text);
	const innerWidth = Math.max(1, width - 4);
	const topInner = Math.max(1, width - 2);
	const titleBadge = truncateToWidth(" " + title + " ", topInner - 1, "…");
	const titleWidth = visibleWidth(titleBadge);
	const topFill = Math.max(0, topInner - titleWidth - 1);
	const row = (line = "") => border("│") + " " + padToWidth(line, innerWidth) + " " + border("│");
	const divider = border("├" + "─".repeat(topInner) + "┤");

	const out: string[] = [
		border("╭─") + theme.fg("accent", theme.bold(titleBadge)) + border("─".repeat(topFill) + "╮"),
	];
	if (subtitle) out.push(row(theme.fg("muted", subtitle)));
	out.push(divider);
	for (const line of body) out.push(row(line));
	if (footer.length) {
		out.push(divider);
		for (const line of footer) out.push(row(line));
	}
	out.push(border("╰" + "─".repeat(topInner) + "╯"));
	return out;
}

export interface SetupItem extends SelectItem {
	/** Saved state is independent of the navigation cursor. */
	saved?: boolean;
}

interface PickerOptions {
	title: string;
	hint: string;
	initialValue?: string;
}

/** Input owns Unicode editing, paste, horizontal scrolling and the IME cursor.
 * Selection, paging, and Tab detail inspection run inside a standalone modal panel. */
class Picker implements Component, Focusable {
	private _focused = false;
	private cursor = 0;
	private pageRows = PAGE_SIZE;
	private details = false;
	private detailTop = 0;
	private filterFocus?: string;
	private filtered: SetupItem[];
	private readonly search = new Input({ prompt: "Search: ", placeholder: "name, provider or reference" });

	private readonly items: SetupItem[];
	private readonly options: PickerOptions;
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly keybindings: KeybindingsManager;
	private readonly done: (value: string | undefined) => void;

	constructor(
		items: SetupItem[], options: PickerOptions, tui: TUI, theme: Theme,
		keybindings: KeybindingsManager, done: (value: string | undefined) => void,
	) {
		this.items = items;
		this.options = options;
		this.tui = tui;
		this.theme = theme;
		this.keybindings = keybindings;
		this.done = done;
		this.filtered = items;
		const initial = items.findIndex((item) => item.value === options.initialValue);
		const saved = items.findIndex((item) => item.saved);
		this.cursor = Math.max(0, initial >= 0 ? initial : saved);
	}

	get focused(): boolean { return this._focused; }
	set focused(value: boolean) {
		this._focused = value;
		this.search.focused = value && !this.details;
	}

	private isSaved(item: SetupItem): boolean {
		return item.saved ?? item.value === this.options.initialValue;
	}

	private keyLabel(action: Keybinding): string {
		return keyLabel(this.keybindings, action);
	}

	private detailLines(width: number): string[] {
		const item = this.filtered[this.cursor];
		if (!item) return ["No matches. Clear or change the search."];
		return [item.label + (this.isSaved(item) ? " [saved]" : ""), item.description ?? item.value]
			.flatMap((text) => wrapTextWithAnsi(text, width));
	}

	render(width: number): string[] {
		if (width <= 0) return [];
		const theme = this.theme;
		const dim = (text: string) => theme.fg("dim", text);
		const muted = (text: string) => theme.fg("muted", text);
		const height = setupHeight(this.tui);
		const framed = width >= 20 && height >= 10;
		const innerWidth = framed ? Math.max(1, width - 4) : width;

		const move = this.keyLabel("tui.select.up") + "/" + this.keyLabel("tui.select.down");
		const confirm = this.keyLabel("tui.select.confirm");
		const cancel = this.keyLabel("tui.select.cancel");
		const pageKeys = this.keyLabel("tui.select.pageUp") + "/" + this.keyLabel("tui.select.pageDown");
		const page = pageKeys === "PgUp/PgDn" ? "PgUp/Dn" : pageKeys;
		const matchCount = this.filtered.length ? (this.cursor + 1) + "/" + this.filtered.length + " matches" : "0 results";
		const selectionKeys = `${confirm} select · ${cancel} back · Tab details`;
		const controls = this.details
			? [`Tab list · ${cancel} back · ${confirm} select`, `${move} scroll · ${page} page`]
			: [visibleWidth(selectionKeys) <= innerWidth ? selectionKeys : `Tab details · ${confirm}/${cancel}`,
				`${move} move · ${page} · ${matchCount}`];
		const joinedControls = controls.join(" · ");
		const footer = (visibleWidth(joinedControls) <= innerWidth ? [joinedControls] : controls)
			.slice(0, Math.max(0, height - (this.details ? 2 : 3))).map(dim);

		const titleText = (framed ? "Subagents · " : "") + this.options.title + (this.details ? " · Details" : "");
		const subtitle = framed && height >= 12 && !this.details && this.options.hint ? this.options.hint : undefined;
		const chromeRows = (framed ? (subtitle ? 4 : 3) + Number(footer.length > 0) : 1) + footer.length;
		const renderPanel = (body: string[]): string[] => framed ? framePanel(theme, width, titleText, subtitle, body, footer)
			: [theme.bold(titleText), ...body, ...footer].slice(0, height).map((line) => truncateToWidth(line, width, "…"));

		if (this.details) {
			const budget = Math.max(1, height - chromeRows);
			this.pageRows = budget;
			const details = this.detailLines(innerWidth);
			this.detailTop = Math.max(0, Math.min(this.detailTop, details.length - budget));
			return renderPanel(details.slice(this.detailTop, this.detailTop + budget));
		}

		const searchLines = this.search.render(innerWidth);
		if (framed && height >= 14) searchLines.push("");
		const item = this.filtered[this.cursor];
		const availAfterSearch = Math.max(1, height - chromeRows - searchLines.length);
		const minListRows = Math.min(Math.max(1, this.filtered.length), Math.min(6, availAfterSearch));
		const previewBudget = Math.max(0, Math.min(3, availAfterSearch - minListRows - 1));
		const wrappedPreview = item?.description && previewBudget ? wrapTextWithAnsi(item.description, innerWidth) : [];
		const visibleDetails = wrappedPreview.slice(0, previewBudget).map((line, index) =>
			muted(index === previewBudget - 1 && wrappedPreview.length > previewBudget ? truncateToWidth(line + "…", innerWidth, "…") : line));
		if (visibleDetails.length) visibleDetails.unshift("");
		this.pageRows = Math.max(1, Math.min(PAGE_SIZE, availAfterSearch - visibleDetails.length));
		const start = Math.max(0, Math.min(this.cursor - Math.floor(this.pageRows / 2), this.filtered.length - this.pageRows));
		const visible = this.filtered.slice(start, start + this.pageRows);

		const body: string[] = [...searchLines];
		if (!visible.length) {
			body.push(dim(this.search.getValue() ? "No matches. Clear or change the search." : "No choices available."));
		}
		for (const [index, choice] of visible.entries()) {
			const selected = start + index === this.cursor;
			const suffix = this.isSaved(choice) ? " [saved]" : "";
			const label = truncateToWidth(choice.label, Math.max(0, innerWidth - 2 - visibleWidth(suffix)), "…") + suffix;
			body.push(selected ? theme.fg("accent", "› ") + theme.underline(theme.bold(label)) : "  " + label);
		}
		body.push(...visibleDetails);
		return renderPanel(body);
	}

	handleInput(data: string): void {
		const kb = this.keybindings;
		const count = this.filtered.length;
		if (kb.matches(data, "tui.select.cancel")) {
			if (this.details) {
				this.details = false;
				this.detailTop = 0;
				this.focused = this._focused;
			} else {
				this.done(undefined);
				return;
			}
		} else if (kb.matches(data, "tui.select.confirm")) {
			const item = this.filtered[this.cursor];
			if (item) this.done(item.value);
			return;
		} else if (matchesKey(data, "tab")) {
			this.details = !this.details;
			this.detailTop = 0;
			this.focused = this._focused;
		} else if (this.details) {
			if (kb.matches(data, "tui.select.up")) this.detailTop--;
			else if (kb.matches(data, "tui.select.down")) this.detailTop++;
			else if (kb.matches(data, "tui.select.pageUp")) this.detailTop -= this.pageRows;
			else if (kb.matches(data, "tui.select.pageDown")) this.detailTop += this.pageRows;
		} else if (kb.matches(data, "tui.select.up")) {
			if (count) this.cursor = (this.cursor - 1 + count) % count;
		} else if (kb.matches(data, "tui.select.down")) {
			if (count) this.cursor = (this.cursor + 1) % count;
		} else if (kb.matches(data, "tui.select.pageUp")) {
			this.cursor = Math.max(0, this.cursor - this.pageRows);
		} else if (kb.matches(data, "tui.select.pageDown")) {
			this.cursor = Math.max(0, Math.min(count - 1, this.cursor + this.pageRows));
		} else {
			const before = this.search.getValue();
			this.search.handleInput(data);
			if (before !== this.search.getValue()) {
				this.filterFocus = this.filtered[this.cursor]?.value ?? this.filterFocus;
				const query = this.search.getValue().trim();
				this.filtered = query ? fuzzyFilter(this.items, query, (item) => [item.value, item.label, item.description].join(" ")) : this.items;
				// Preserve a direct name/reference match; a weak fuzzy match must
				// not keep the saved item ahead of a more relevant search result.
				this.cursor = Math.max(0, this.filtered.findIndex((item) => item.value === this.filterFocus &&
					(!query || [item.value, item.label].some((text) => text.toLowerCase().includes(query.toLowerCase())))));
			}
		}
		this.tui.requestRender();
	}

	invalidate(): void { this.search.invalidate(); }
}

/** Single-select modal panel with fuzzy search, [saved] badge, Tab details, and paging. Esc returns without a change. */
export function promptSelectOne(
	ctx: PickerContext, title: string, hint: string, items: SetupItem[], initialValue?: string,
): Promise<string | undefined> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify("/subagents-setup requires Pi's interactive TUI.", "error");
		return Promise.resolve(undefined);
	}
	return ctx.ui.custom<string | undefined>(
		(tui, theme, keybindings, done) => new Picker(items, { title, hint, initialValue }, tui, theme, keybindings, done),
		{ overlay: true, overlayOptions: SETUP_OVERLAY_OPTIONS, blocked: { kind: "question", message: title } },
	);
}

interface RoleSettingsView {
	role: AgentName;
	model: string;
	thinking: string;
	unavailable: boolean;
}

export interface SettingsView {
	main: string;
	roles: RoleSettingsView[];
	status: string;
	focus: SettingKey;
}

const SETTING_FIELDS = ["model", "thinking", "reset"] as const;
const SETTING_LABELS: Record<(typeof SETTING_FIELDS)[number], string> = { model: "Model", thinking: "Thinking", reset: "Reset" };
export type SettingKey = `${AgentName}.${(typeof SETTING_FIELDS)[number]}`;
const SETTING_KEYS = BUILTIN_AGENT_NAMES.flatMap((role) => SETTING_FIELDS.map((field): SettingKey => `${role}.${field}`));
const ROLE_LABELS: Record<AgentName, string> = { researcher: "Researcher", worker: "Worker" };
const ROLE_DESCRIPTIONS: Record<AgentName, string> = { researcher: "Read-only research", worker: "Implementation & checks" };

class RoleSettings implements Component {
	private cursor: number;
	private showDetails = false;
	private detailTop = 0;
	private detailPage = 1;
	private readonly view: SettingsView;
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly keys: KeybindingsManager;
	private readonly done: (value: SettingKey | undefined) => void;
	constructor(
		view: SettingsView, tui: TUI, theme: Theme,
		keys: KeybindingsManager, done: (value: SettingKey | undefined) => void,
	) {
		this.view = view;
		this.tui = tui;
		this.theme = theme;
		this.keys = keys;
		this.done = done;
		this.cursor = Math.max(0, SETTING_KEYS.findIndex((key) => key === view.focus));
	}

	render(width: number): string[] {
		if (width <= 0) return [];
		const height = setupHeight(this.tui);
		const framed = width >= 36 && height >= 20;
		const inner = Math.max(1, width - (framed ? 4 : 0));
		const theme = this.theme;
		const entries = BUILTIN_AGENT_NAMES.flatMap((role) => {
			const view = this.view.roles.find((entry) => entry.role === role)!;
			return SETTING_FIELDS.map((field) => ({ role, field, view }));
		});
		const active = entries[this.cursor]!;
		const label = ROLE_LABELS[active.role];
		const key = (action: Keybinding) => keyLabel(this.keys, action);
		const movement = key("tui.select.up") + "/" + key("tui.select.down");
		const pageKeys = key("tui.select.pageUp") + "/" + key("tui.select.pageDown");
		const cancel = key("tui.select.cancel");
		const confirm = key("tui.select.confirm");
		const warning = active.view.unavailable ? "Choose an available model to resume dispatch for this role." : "";
		const detail = active.field === "reset"
			? `Restore ${label} to Follow main and medium thinking.`
			: active.view[active.field];
		const detailText = [detail, warning].filter(Boolean).join(" · ");
		if (this.showDetails) {
			const footer = height >= 3 ? [theme.fg("dim", `Tab/${cancel} back · ${movement} scroll · ${pageKeys} page`)] : [];
			const heading = `${label} · ${SETTING_LABELS[active.field]}`;
			const lines = wrapTextWithAnsi(detailText, inner);
			this.detailPage = Math.max(1, height - (framed ? 4 : 1) - footer.length);
			this.detailTop = Math.max(0, Math.min(this.detailTop, lines.length - this.detailPage));
			const body = lines.slice(this.detailTop, this.detailTop + this.detailPage);
			if (framed) return framePanel(theme, width, heading, undefined, body, footer);
			return [theme.bold(heading), ...body, ...footer].slice(0, height).map((line) => truncateToWidth(line, width, "…"));
		}
		const navigation = `${confirm} edit · ${cancel} close · Tab details · ${movement} move`;
		const rows: string[] = [];
		for (const [index, { role, field, view }] of entries.entries()) {
			if (framed && field === "model") {
				if (index) rows.push("");
				rows.push(theme.bold(ROLE_LABELS[role]) + theme.fg("muted", " · " + ROLE_DESCRIPTIONS[role]));
			}
			const name = SETTING_LABELS[field];
			const value = field === "model" ? view.model : field === "thinking" ? view.thinking : "Follow main · medium";
			const prefix = framed ? name.padEnd(10) : ROLE_LABELS[role] + " " + name + "  ";
			const badge = field === "model" && view.unavailable ? " [unavailable]" : "";
			const line = truncateToWidth(prefix + value, Math.max(1, inner - 2 - visibleWidth(badge)), "…") + theme.fg("warning", badge);
			rows.push(index === this.cursor ? theme.fg("accent", "› " + theme.bold(line)) : "  " + line);
		}
		const details = wrapTextWithAnsi(detailText, inner);
		const footer = [this.view.status, visibleWidth(navigation) <= inner ? navigation : `Tab details · ${confirm}/${cancel} · ${movement}`];
		const header = [theme.fg("muted", truncateToWidth("Main · " + this.view.main, inner, "…"))];
		if (framed) header.push("");
		const chrome = framed ? 4 : 1;
		const rowBudget = Math.max(1, height - chrome - header.length - footer.length);
		const start = framed ? 0 : Math.max(0, Math.min(this.cursor - Math.floor(rowBudget / 2), rows.length - rowBudget));
		const visibleRows = rows.slice(start, start + rowBudget);
		const detailBudget = Math.max(0, height - chrome - header.length - visibleRows.length - footer.length - 1);
		this.detailPage = Math.max(1, detailBudget);
		this.detailTop = Math.max(0, Math.min(this.detailTop, details.length - this.detailPage));
		const body = [...header, ...visibleRows];
		if (detailBudget && (warning || details.length > 1)) {
			body.push("", ...details.slice(this.detailTop, this.detailTop + detailBudget).map((line) => theme.fg(active.view.unavailable ? "warning" : "muted", line)));
			if (details.length > detailBudget) footer[0] = pageKeys + " details · " + this.view.status;
		}
		if (framed) return framePanel(theme, width, "Subagents · Models & thinking", undefined, body, footer);
		if (height < 6) return [theme.bold(label), rows[this.cursor]!, `Tab details · ${confirm} edit · ${cancel} close`]
			.slice(0, height).map((line) => truncateToWidth(line, width, "…"));
		return [theme.bold("Subagents"), ...body, ...footer].map((line) => truncateToWidth(line, width, "…"));
	}

	handleInput(data: string): void {
		const cancel = this.keys.matches(data, "tui.select.cancel");
		if (matchesKey(data, "tab") || (cancel && this.showDetails)) { this.showDetails = !this.showDetails; this.detailTop = 0; }
		else if (cancel) { this.done(undefined); return; }
		else if (this.showDetails) {
			if (this.keys.matches(data, "tui.select.up")) this.detailTop--;
			else if (this.keys.matches(data, "tui.select.down")) this.detailTop++;
			else if (this.keys.matches(data, "tui.select.pageUp")) this.detailTop -= this.detailPage;
			else if (this.keys.matches(data, "tui.select.pageDown")) this.detailTop += this.detailPage;
		}
		else if (this.keys.matches(data, "tui.select.confirm")) { this.done(SETTING_KEYS[this.cursor]); return; }
		else if (this.keys.matches(data, "tui.select.up")) { this.cursor = (this.cursor + SETTING_KEYS.length - 1) % SETTING_KEYS.length; this.detailTop = 0; }
		else if (this.keys.matches(data, "tui.select.down")) { this.cursor = (this.cursor + 1) % SETTING_KEYS.length; this.detailTop = 0; }
		else if (this.keys.matches(data, "tui.select.pageUp")) this.detailTop -= this.detailPage;
		else if (this.keys.matches(data, "tui.select.pageDown")) this.detailTop += this.detailPage;
		this.tui.requestRender();
	}

	invalidate(): void {}
}

export function promptSettings(ctx: PickerContext, view: SettingsView): Promise<SettingKey | undefined> {
	return ctx.ui.custom<SettingKey | undefined>(
		(tui, theme, keys, done) => new RoleSettings(view, tui, theme, keys, done),
		{ overlay: true, overlayOptions: SETUP_OVERLAY_OPTIONS, blocked: { kind: "question", message: "Configure subagent models and thinking" } },
	);
}
