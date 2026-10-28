/** Searchable pickers and the /subagents-setup role grid. */

import {
	Input,
	fuzzyFilter,
	matchesKey,
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

interface PickerOptions {
	title: string;
	hint: string;
	initialValue?: string;
}

/** One keyboard path for settings and their nested pickers. Input supplies
 * paste, Unicode editing, horizontal scrolling, and IME cursor placement. */
class Picker implements Component, Focusable {
	private _focused = false;
	private cursor = 0;
	private filtered: SelectItem[];
	private readonly search = new Input({ prompt: "Search: ", placeholder: "type to filter" });

	private readonly items: SelectItem[];
	private readonly options: PickerOptions;
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly keybindings: KeybindingsManager;
	private readonly done: (value: string | undefined) => void;

	constructor(
		items: SelectItem[],
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
		this.search.focused = value;
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
		lines.push(...this.search.render(width));
		const pageSize = this.pageSize();
		const start = Math.max(0, Math.min(this.cursor - Math.floor(pageSize / 2), this.filtered.length - pageSize));
		const visible = this.filtered.slice(start, start + pageSize);
		if (!visible.length) lines.push("", theme.fg("warning", "  No matches. Change or clear the search."));
		for (const [index, item] of visible.entries()) {
			const selected = start + index === this.cursor;
			const prefix = selected ? theme.fg("accent", "› ") : "  ";
			const label = selected ? theme.fg("accent", theme.bold(item.label)) : item.label;
			lines.push(prefix + label);
		}
		const item = this.filtered[this.cursor];
		lines.push("", border);
		if (item) {
			// Details have their own lines, so long model ids cannot hide capabilities.
			const detail = item.description ?? "";
			lines.push(...wrapTextWithAnsi(detail, Math.max(1, width)).slice(0, 3).map(dim));
			lines.push(dim(
				(this.cursor + 1) + "/" + this.filtered.length + " matches · ↑/↓ move · PgUp/PgDn page",
			));
		}
		lines.push(dim("Enter select · Esc back"));
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
		} else {
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

function openPicker(ctx: PickerContext, items: SelectItem[], options: PickerOptions): Promise<string | undefined> {
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
	return openPicker(ctx, items, { title, hint, initialValue });
}

/** One role per row, with Model, Thinking and Reset side by side: the whole
 * configuration is visible at once, so a model choice and its clamped thinking
 * level are compared in place instead of through nested screens. */
export interface RoleGridRow {
	role: string;
	model: string;
	thinking: string;
	/** Whether the thinking level is a user override (shown with a marker). */
	thinkingOverridden?: boolean;
	/** Why this row matters; shown for the focused row only. */
	description: string;
}

export interface RoleGridFocus {
	row?: number;
	column?: number;
}

const GRID_COLUMNS = ["model", "thinking", "reset"] as const;
export type RoleGridColumn = (typeof GRID_COLUMNS)[number];

export interface RoleGridChoice {
	row: number;
	column: number;
	role: string;
	field: RoleGridColumn;
}

class RoleGrid implements Component {
	private row: number;
	private column: number;
	private readonly rows: RoleGridRow[];
	private readonly status: string;
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly keybindings: KeybindingsManager;
	private readonly done: (choice: RoleGridChoice | undefined) => void;

	constructor(
		rows: RoleGridRow[],
		status: string,
		focus: RoleGridFocus,
		tui: TUI,
		theme: Theme,
		keybindings: KeybindingsManager,
		done: (choice: RoleGridChoice | undefined) => void,
	) {
		this.rows = rows;
		this.status = status;
		this.tui = tui;
		this.theme = theme;
		this.keybindings = keybindings;
		this.done = done;
		this.row = Math.min(Math.max(0, focus.row ?? 0), Math.max(0, rows.length - 1));
		this.column = Math.min(Math.max(0, focus.column ?? 0), GRID_COLUMNS.length - 1);
	}

	/** Column budget: the role name and the action stay readable, the two
	 * measured values share what is left. */
	private widths(width: number): number[] {
		const role = Math.min(12, Math.max(4, Math.floor(width * 0.16)));
		const reset = 6;
		const gap = 2;
		// The row prefix ("› ") and the three gaps also spend columns.
		const available = Math.max(0, width - 2 - role - reset - gap * 3);
		const model = Math.max(0, Math.floor(available * 0.55));
		const thinking = Math.max(0, available - model);
		return [role, model, thinking, reset];
	}

	render(width: number): string[] {
		if (width <= 0) return [""];
		const theme = this.theme;
		const dim = (text: string) => theme.fg("dim", text);
		const [roleWidth, modelWidth, thinkingWidth, resetWidth] = this.widths(width);
		const cell = (text: string, size: number, active: boolean): string => {
			const fitted = truncateToWidth(text, size, "…");
			const pad = " ".repeat(Math.max(0, size - visibleWidth(fitted)));
			return active ? theme.bg("selectedBg", theme.fg("accent", theme.bold(fitted + pad))) : fitted + pad;
		};
		const lines = [theme.fg("border", "─".repeat(width)), theme.fg("accent", theme.bold("Subagents · Roles")), dim("Model · Thinking · Reset per role · " + this.status), ""];
		const header = ["Role", "Model", "Thinking", ""]
			.map((title, index) => cell(title, [roleWidth, modelWidth, thinkingWidth, resetWidth][index]!, false))
			.join("  ");
		lines.push("  " + dim(header));
		for (const [index, row] of this.rows.entries()) {
			const selected = index === this.row;
			const cells = [row.role, row.model, row.thinking + (row.thinkingOverridden ? "*" : ""), "reset"]
				.map((text, column) => cell(text, [roleWidth, modelWidth, thinkingWidth, resetWidth][column]!, selected && this.column === column - 1));
			lines.push((selected ? theme.fg("accent", "› ") : "  ") + cells.join("  "));
		}
		const focused = this.rows[this.row];
		lines.push("", theme.fg("border", "─".repeat(width)));
		if (focused) {
			const field = GRID_COLUMNS[this.column]!;
			const label = field === "model" ? "Model" : field === "thinking" ? "Thinking (reasoning effort)" : "Reset";
			lines.push(theme.fg("accent", `${focused.role} · ${label} · Enter ${field === "reset" ? "restore defaults" : "edit"}`));
			lines.push(...wrapTextWithAnsi(focused.description, Math.max(1, width)).slice(0, 3).map(dim));
		}
		lines.push(dim("↑/↓ role · ←/→ column · Enter edit · Esc close"));
		return lines.map((line) => truncateToWidth(line, width, "…"));
	}

	handleInput(data: string): void {
		const kb = this.keybindings;
		const rows = this.rows.length;
		if (kb.matches(data, "tui.select.up")) {
			if (rows) this.row = (this.row - 1 + rows) % rows;
		} else if (kb.matches(data, "tui.select.down")) {
			if (rows) this.row = (this.row + 1) % rows;
		} else if (matchesKey(data, "left") || kb.matches(data, "tui.editor.cursorLeft")) {
			this.column = (this.column - 1 + GRID_COLUMNS.length) % GRID_COLUMNS.length;
		} else if (matchesKey(data, "right") || kb.matches(data, "tui.editor.cursorRight")) {
			this.column = (this.column + 1) % GRID_COLUMNS.length;
		} else if (kb.matches(data, "tui.select.confirm")) {
			const focused = this.rows[this.row];
			if (focused) {
				this.done({ row: this.row, column: this.column, role: focused.role, field: GRID_COLUMNS[this.column]! });
				return;
			}
		} else if (kb.matches(data, "tui.select.cancel")) {
			this.done(undefined);
			return;
		} else {
			return;
		}
		this.tui.requestRender();
	}

	invalidate(): void {}
}

/** Role × setting grid. Esc closes without a change. */
export function promptRoleGrid(
	ctx: PickerContext,
	rows: RoleGridRow[],
	focus: RoleGridFocus = {},
	status = "Changes save immediately",
): Promise<RoleGridChoice | undefined> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify("/subagents-setup requires Pi's interactive TUI.", "error");
		return Promise.resolve(undefined);
	}
	return ctx.ui.custom<RoleGridChoice | undefined>((tui, theme, keybindings, done) =>
		new RoleGrid(rows, status, focus, tui, theme, keybindings, done));
}
