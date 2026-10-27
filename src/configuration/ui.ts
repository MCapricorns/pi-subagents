/** Searchable pickers and the grouped /subagents-setup settings panel. */

import {
	Input,
	fuzzyFilter,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
	type Component,
	type Focusable,
	type KeybindingsManager,
	type SelectItem,
	type TUI,
} from "@earendil-works/pi-tui";
import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";

type PickerContext = Pick<ExtensionCommandContext, "mode" | "ui">;
const PAGE_SIZE = 8;

interface PickerItem extends SelectItem {
	group?: string;
	currentValue?: string;
}

export interface SettingsRow extends PickerItem {
	group: string;
	currentValue: string;
}

interface PickerOptions {
	title: string;
	hint: string;
	searchable: boolean;
	initialValue?: string;
	footer?: string;
}

/** One keyboard path for settings and their nested pickers. Input supplies
 * paste, Unicode editing, horizontal scrolling, and IME cursor placement. */
class Picker implements Component, Focusable {
	private _focused = false;
	private cursor = 0;
	private filtered: PickerItem[];
	private readonly search = new Input({ prompt: "Search: ", placeholder: "type to filter" });

	private readonly items: PickerItem[];
	private readonly options: PickerOptions;
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly keybindings: KeybindingsManager;
	private readonly done: (value: string | undefined) => void;

	constructor(
		items: PickerItem[],
		options: PickerOptions,
		tui: TUI,
		theme: Theme,
		keybindings: KeybindingsManager,
		done: (value: string | undefined) => void,
	) {
		this.items = items;
		this.options = options;
		this.tui = tui;
		this.theme = theme;
		this.keybindings = keybindings;
		this.done = done;
		this.filtered = items;
		const initial = items.findIndex((item) => item.value === options.initialValue);
		if (initial >= 0) this.cursor = initial;
	}

	get focused(): boolean { return this._focused; }
	set focused(value: boolean) {
		this._focused = value;
		this.search.focused = value && this.options.searchable;
	}

	private pageSize(): number {
		// Leave room for headings, help, and the selected item's details.
		return Math.max(1, Math.min(PAGE_SIZE, (this.tui.terminal?.rows ?? 28) - 13));
	}

	render(width: number): string[] {
		if (width <= 0) return [""];
		const theme = this.theme;
		const dim = (text: string) => theme.fg("dim", text);
		const fit = (text: string) => truncateToWidth(text, width, "");
		const border = theme.fg("border", "─".repeat(width));
		const lines = [border, theme.fg("accent", theme.bold(this.options.title)), dim(this.options.hint)];
		if (this.options.searchable) lines.push(...this.search.render(width));
		const pageSize = this.pageSize();
		const start = Math.max(0, Math.min(this.cursor - Math.floor(pageSize / 2), this.filtered.length - pageSize));
		const visible = this.filtered.slice(start, start + pageSize);
		let lastGroup: string | undefined;
		if (!visible.length) lines.push("", theme.fg("warning", "  No matches. Change or clear the search."));
		for (const [index, item] of visible.entries()) {
			if (item.group && item.group !== lastGroup) {
				lines.push("", theme.bold("  " + item.group));
				lastGroup = item.group;
			}
			const selected = start + index === this.cursor;
			const prefix = selected ? theme.fg("accent", "› ") : "  ";
			const label = selected ? theme.fg("accent", theme.bold(item.label)) : item.label;
			const value = item.currentValue === undefined ? "" : " ".repeat(Math.max(2, 12 - visibleWidth(item.label))) + item.currentValue;
			lines.push(prefix + label + (selected ? value : dim(value)));
		}
		const item = this.filtered[this.cursor];
		lines.push("", border);
		if (item) {
			// Details have their own lines, so long model ids cannot hide capabilities.
			const detail = [item.currentValue, item.description].filter(Boolean).join(" · ");
			lines.push(...wrapTextWithAnsi(detail, Math.max(1, width)).slice(0, 3).map(dim));
			if (this.options.searchable) lines.push(dim(
				(this.cursor + 1) + "/" + this.filtered.length + " matches · ↑/↓ move · PgUp/PgDn page",
			));
		}
		lines.push(dim(this.options.footer ?? "Enter select · Esc back"));
		return lines.map(fit);
	}

	handleInput(data: string): void {
		const kb = this.keybindings;
		const count = this.filtered.length;
		if (kb.matches(data, "tui.select.up")) {
			if (count) this.cursor = (this.cursor - 1 + count) % count;
		} else if (kb.matches(data, "tui.select.down")) {
			if (count) this.cursor = (this.cursor + 1) % count;
		} else if (kb.matches(data, "tui.select.pageUp")) {
			this.cursor = Math.max(0, this.cursor - this.pageSize());
		} else if (kb.matches(data, "tui.select.pageDown")) {
			this.cursor = Math.max(0, Math.min(count - 1, this.cursor + this.pageSize()));
		} else if (kb.matches(data, "tui.select.confirm")) {
			const item = this.filtered[this.cursor];
			if (item) this.done(item.value);
			return;
		} else if (kb.matches(data, "tui.select.cancel")) {
			this.done(undefined);
			return;
		} else if (this.options.searchable) {
			const before = this.search.getValue();
			this.search.handleInput(data);
			if (before !== this.search.getValue()) {
				const query = this.search.getValue().trim();
				this.filtered = query ? fuzzyFilter(this.items, query,
					(item) => [item.value, item.label, item.description].join(" ")) : this.items;
				this.cursor = 0;
			}
		}
		this.tui.requestRender();
	}

	invalidate(): void { this.search.invalidate(); }
}

function openPicker(ctx: PickerContext, items: PickerItem[], options: PickerOptions): Promise<string | undefined> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify("/subagents-setup requires Pi's interactive TUI.", "error");
		return Promise.resolve(undefined);
	}
	return ctx.ui.custom<string | undefined>((tui, theme, keybindings, done) =>
		new Picker(items, options, tui, theme, keybindings, done));
}

/** Single-select with fuzzy search and paging. Esc returns without a change. */
export function promptSelectOne(
	ctx: PickerContext,
	title: string,
	hint: string,
	items: SelectItem[],
	initialValue?: string,
): Promise<string | undefined> {
	return openPicker(ctx, items, { title, hint, searchable: true, initialValue });
}

export function promptSettings(
	ctx: PickerContext,
	items: SettingsRow[],
	initialValue?: string,
	status = "Changes save immediately",
): Promise<string | undefined> {
	return openPicker(ctx, items, {
		title: "Subagents · Settings",
		hint: "Model and thinking per role · " + status,
		searchable: false,
		initialValue,
		footer: "↑/↓ move · Enter edit · Esc close",
	});
}
