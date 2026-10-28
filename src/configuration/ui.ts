/** Searchable pickers and the /subagents-setup role register. */

import {
	Input, fuzzyFilter, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi,
	type Component, type Focusable, type KeybindingsManager, type SelectItem, type TUI,
} from "@earendil-works/pi-tui";
import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";

type PickerContext = Pick<ExtensionCommandContext, "mode" | "ui">;
const PAGE_SIZE = 8;

/** Leave room for the ten-line widget, its leading spacer, the two-line
 * host footer and one transcript row. Tiny terminals retain an input slot. */
function setupHeight(tui: TUI): number {
	return Math.max(3, (tui.terminal?.rows ?? 28) - 14);
}

interface PickerOptions {
	title: string;
	hint: string;
	initialValue?: string;
}

/** Input owns Unicode editing, paste, horizontal scrolling and the IME cursor.
 * Selection and paging use the host's configurable keybindings. */
class Picker implements Component, Focusable {
	private _focused = false;
	private cursor = 0;
	private pageRows = PAGE_SIZE;
	private filtered: SelectItem[];
	private readonly search = new Input({ prompt: "Search: ", placeholder: "type to filter" });

	private readonly items: SelectItem[];
	private readonly options: PickerOptions;
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly keybindings: KeybindingsManager;
	private readonly done: (value: string | undefined) => void;

	constructor(
		items: SelectItem[], options: PickerOptions, tui: TUI, theme: Theme,
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
		if (initial >= 0) this.cursor = initial;
	}

	get focused(): boolean { return this._focused; }
	set focused(value: boolean) { this._focused = value; this.search.focused = value; }

	render(width: number): string[] {
		if (width <= 0) return [];
		const theme = this.theme;
		const dim = (text: string) => theme.fg("dim", text);
		const height = setupHeight(this.tui);
		if (height < 8) {
			this.pageRows = 1;
			const item = this.filtered[this.cursor];
			return [theme.bold(this.options.title), ...this.search.render(width),
				item ? theme.fg("accent", "› ") + theme.underline(item.label) : "No matches. Clear or change the search."]
				.map((line) => truncateToWidth(line, width, "…"));
		}
		const lines = [theme.bold("Subagents · " + this.options.title)];
		if (this.options.hint && height >= 16) lines.push(...wrapTextWithAnsi(this.options.hint, width).slice(0, 2).map(dim));
		lines.push(...this.search.render(width), "");
		const footer = [dim("↑/↓ move · PgUp/PgDn page"), dim("Enter select · Esc back")];
		const item = this.filtered[this.cursor];
		// The complete selected identity lives beside its capabilities, even when
		// a long provider/model id was truncated in the list above.
		const details = item ? ["", ...wrapTextWithAnsi(item.label, width).slice(0, 2),
			...wrapTextWithAnsi(item.description ?? "", width).slice(0, 3).map(dim)] : [];
		const detailBudget = Math.max(0, Math.min(details.length, height - lines.length - footer.length - 2));
		const visibleDetails = details.slice(0, detailBudget);
		this.pageRows = Math.max(1, Math.min(PAGE_SIZE, height - lines.length - footer.length - visibleDetails.length - 1));
		const start = Math.max(0, Math.min(this.cursor - Math.floor(this.pageRows / 2), this.filtered.length - this.pageRows));
		const visible = this.filtered.slice(start, start + this.pageRows);
		if (!visible.length) lines.push(dim(this.search.getValue() ? "No matches. Clear or change the search." : "No choices available."));
		for (const [index, choice] of visible.entries()) {
			const selected = start + index === this.cursor;
			const label = truncateToWidth(choice.label, Math.max(0, width - 2), "…");
			lines.push(selected ? theme.fg("accent", "› ") + theme.underline(theme.bold(label)) : "  " + label);
		}
		if (item) lines.push(dim((this.cursor + 1) + "/" + this.filtered.length + " matches"));
		lines.push(...visibleDetails, ...footer);
		return lines.map((line) => truncateToWidth(line, width, "…"));
	}

	handleInput(data: string): void {
		const kb = this.keybindings;
		const count = this.filtered.length;
		if (kb.matches(data, "tui.select.up")) {
			if (count) this.cursor = (this.cursor - 1 + count) % count;
		} else if (kb.matches(data, "tui.select.down")) {
			if (count) this.cursor = (this.cursor + 1) % count;
		} else if (kb.matches(data, "tui.select.pageUp")) {
			this.cursor = Math.max(0, this.cursor - this.pageRows);
		} else if (kb.matches(data, "tui.select.pageDown")) {
			this.cursor = Math.max(0, Math.min(count - 1, this.cursor + this.pageRows));
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
				this.filtered = query ? fuzzyFilter(this.items, query, (item) => [item.value, item.label, item.description].join(" ")) : this.items;
				this.cursor = 0;
			}
		}
		this.tui.requestRender();
	}

	invalidate(): void { this.search.invalidate(); }
}

/** Single-select with fuzzy search and paging. Esc returns without a change. */
export function promptSelectOne(
	ctx: PickerContext, title: string, hint: string, items: SelectItem[], initialValue?: string,
): Promise<string | undefined> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify("/subagents-setup requires Pi's interactive TUI.", "error");
		return Promise.resolve(undefined);
	}
	return ctx.ui.custom<string | undefined>((tui, theme, keybindings, done) =>
		new Picker(items, { title, hint, initialValue }, tui, theme, keybindings, done));
}

export interface RoleGridRow {
	role: string;
	model: string;
	/** Effective level, optionally followed by the requested level when clamped. */
	thinking: string;
	thinkingOverridden?: boolean;
	description: string;
}
export interface RoleGridFocus { row?: number; column?: number; }
const GRID_COLUMNS = ["model", "thinking", "reset"] as const;
export type RoleGridColumn = (typeof GRID_COLUMNS)[number];
export interface RoleGridChoice { row: number; column: number; role: string; field: RoleGridColumn; }

/** A role register beside the selected role's settings; narrow terminals stack
 * the same regions. Full effective values are never squeezed into grid cells. */
class RoleGrid implements Component {
	private row: number;
	private column: number;
	private scrollTop = 0;
	private pageRows = 1;
	private viewport = "";
	private revealField = true;

	private readonly rows: RoleGridRow[];
	private readonly status: string;
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly keybindings: KeybindingsManager;
	private readonly done: (choice: RoleGridChoice | undefined) => void;

	constructor(
		rows: RoleGridRow[], status: string, focus: RoleGridFocus, tui: TUI, theme: Theme,
		keybindings: KeybindingsManager, done: (choice: RoleGridChoice | undefined) => void,
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

	private settings(width: number): { lines: string[]; start: number; end: number } {
		const focused = this.rows[this.row];
		if (!focused) return { lines: [this.theme.fg("dim", "No roles configured.")], start: 0, end: 1 };
		const theme = this.theme;
		const dim = (text: string) => theme.fg("dim", text);
		const field = GRID_COLUMNS[this.column]!;
		const label = field === "thinking" ? "Thinking (reasoning effort)" : field === "reset" ? "Reset" : "Model";
		const lines = [theme.bold(focused.role + " · " + label), ""];
		const starts: number[] = [];
		const setting = (column: number, name: string, hint: string): void => {
			starts.push(lines.length);
			const active = this.column === column;
			lines.push((active ? theme.fg("accent", "› ") : "  ") + (active ? theme.underline(theme.bold(name)) : name) + dim(" · " + hint));
		};
		const value = (text: string): void => {
			lines.push(...wrapTextWithAnsi(text, Math.max(1, width - 2)).map((line) => "  " + line));
		};
		setting(0, "Model", "Enter edit");
		value(focused.model);
		setting(1, "Thinking", "effective");
		value(focused.thinking);
		lines.push(dim("  Source: " + (focused.thinkingOverridden ? "override *" : "role default")));
		setting(2, "Reset", "Enter restore defaults");
		const end = lines.length;
		lines.push("", ...wrapTextWithAnsi(focused.description, width).map(dim));
		return { lines, start: starts[this.column]!, end: starts[this.column + 1] ?? end };
	}

	render(width: number): string[] {
		if (width <= 0) return [];
		const theme = this.theme;
		const dim = (text: string) => theme.fg("dim", text);
		const lines = [theme.bold("Subagents · Roles"), dim(this.status), ""];
		const height = setupHeight(this.tui);
		const wide = width >= 88;
		// The two panes close exactly: roleWidth + 3-column gutter + detailWidth = width.
		const roleWidth = wide ? Math.min(24, Math.floor(width * 0.24)) : width;
		const roles: string[] = [];
		for (const [index, role] of this.rows.entries()) {
			const selected = index === this.row;
			const name = selected ? theme.bold(role.role) : role.role;
			roles.push((selected ? "› " : "  ") + name);
			if (wide) roles.push(dim("  " + truncateToWidth(role.model, roleWidth - 2, "…")));
		}
		const details = this.settings(wide ? width - roleWidth - 3 : width);
		const detailOffset = wide ? 0 : roles.length + 1;
		const body: string[] = [];
		if (wide) {
			for (let i = 0; i < Math.max(roles.length, details.lines.length); i++) {
				const left = truncateToWidth(roles[i] ?? "", roleWidth, "…");
				body.push(left + " ".repeat(roleWidth - visibleWidth(left) + 3) + (details.lines[i] ?? ""));
			}
		} else {
			body.push(...roles, "", ...details.lines);
		}
		const footer = [dim("↑/↓ role · ←/→ field"), dim("Enter edit · Esc close")];
		if (lines.length + body.length + footer.length + 1 <= height) {
			this.scrollTop = 0;
			this.revealField = true;
			return [...lines, ...body, "", ...footer].map((line) => truncateToWidth(line, width, "…"));
		}
		// Pin the selected identity while scrolling the existing pane content.
		// The field's complete value and provenance remain reachable by paging.
		const compact = height < 8;
		const header = compact ? [details.lines[0]!] : [...lines.slice(0, 2), details.lines[0]!];
		const controls = compact ? [dim("PgUp/Dn scroll · Enter edit · Esc")]
			: [footer[0]!, dim("PgUp/Dn scroll · Enter edit · Esc")];
		this.pageRows = Math.max(1, height - header.length - controls.length);
		const viewport = width + ":" + this.pageRows;
		if (this.revealField || this.viewport !== viewport) {
			const start = detailOffset + details.start;
			const end = detailOffset + details.end;
			// One-line viewports show the value rather than repeating its label.
			this.scrollTop = end - start > this.pageRows ? start + Number(this.pageRows === 1 && end > start + 1)
				: Math.max(0, end - this.pageRows);
		}
		this.viewport = viewport;
		this.revealField = false;
		this.scrollTop = Math.max(0, Math.min(this.scrollTop, body.length - this.pageRows));
		return [...header, ...body.slice(this.scrollTop, this.scrollTop + this.pageRows), ...controls]
			.map((line) => truncateToWidth(line, width, "…"));
	}

	handleInput(data: string): void {
		const kb = this.keybindings;
		const rows = this.rows.length;
		const previousRow = this.row;
		const previousColumn = this.column;
		if (kb.matches(data, "tui.select.pageUp")) {
			this.scrollTop -= this.pageRows;
		} else if (kb.matches(data, "tui.select.pageDown")) {
			this.scrollTop += this.pageRows;
		} else if (kb.matches(data, "tui.select.up")) {
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
		} else return;
		if (this.row !== previousRow || this.column !== previousColumn) this.revealField = true;
		this.tui.requestRender();
	}

	invalidate(): void {}
}

/** Role × setting navigation. Esc closes without a change. */
export function promptRoleGrid(
	ctx: PickerContext, rows: RoleGridRow[], focus: RoleGridFocus = {}, status = "Changes save immediately",
): Promise<RoleGridChoice | undefined> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify("/subagents-setup requires Pi's interactive TUI.", "error");
		return Promise.resolve(undefined);
	}
	return ctx.ui.custom<RoleGridChoice | undefined>((tui, theme, keybindings, done) =>
		new RoleGrid(rows, status, focus, tui, theme, keybindings, done));
}
