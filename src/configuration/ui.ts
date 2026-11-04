/** Standalone modal panels for /subagents-setup role settings and model selection. */

import {
	Input, fuzzyFilter, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi,
	type Component, type Focusable, type Keybinding, type KeybindingsManager, type OverlayOptions, type SelectItem, type TUI,
} from "@earendil-works/pi-tui";
import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";

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
	const termRows = tui.terminal?.rows ?? 28;
	const maxRows = Math.floor(termRows * 0.88);
	return Math.max(6, Math.min(maxRows, termRows - 2));
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
	const titleBadge = truncateToWidth(" " + title + " ", topInner, "…");
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
		const key = this.keybindings.getKeys(action)[0];
		if (!key) return "unbound";
		const labels: Record<string, string> = { up: "↑", down: "↓", enter: "Enter", escape: "Esc", pageUp: "PgUp", pageDown: "PgDn", ctrl: "Ctrl", alt: "Alt", shift: "Shift" };
		return key.split("+").map((part) => labels[part] ?? part).join("+");
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

		if (!framed && height < 8) {
			this.pageRows = 1;
			const item = this.filtered[this.cursor];
			return [
				theme.bold(this.options.title + (this.details ? " · Details" : "")),
				...(this.details ? [] : this.search.render(innerWidth)),
				item ? theme.fg("accent", "› ") + theme.underline(item.label + (this.isSaved(item) ? " [saved]" : "")) : "No matches. Clear or change the search.",
			].map((line) => truncateToWidth(line, width, "…"));
		}

		const navigation = move + " move · " + confirm + " select · " + cancel + " back";
		const selectionHint = visibleWidth(navigation) <= innerWidth ? navigation : confirm + " select · " + cancel + " back · " + move;
		const footer = this.details
			? (innerWidth >= 56
				? [dim(move + " scroll · " + page + " page · Tab list · " + confirm + " select · " + cancel + " back")]
				: [dim(move + " scroll · Tab list · " + cancel + " back"), dim(page + " page · " + confirm + " select")])
			: (innerWidth >= 64
				? [dim(selectionHint + " · " + matchCount + " · " + page + " · Tab details")]
				: [dim(selectionHint), dim(matchCount + " · " + page + " · Tab details")]);

		const titleText = "Subagents · " + this.options.title + (this.details ? " · Details" : "");
		const subtitle = !this.details && this.options.hint ? this.options.hint : undefined;
		const chromeRows = framed ? (subtitle ? 4 : 3) + footer.length + 1 : 2 + footer.length;

		if (this.details) {
			const budget = Math.max(1, height - chromeRows);
			this.pageRows = budget;
			const details = this.detailLines(innerWidth);
			this.detailTop = Math.max(0, Math.min(this.detailTop, details.length - budget));
			const body = details.slice(this.detailTop, this.detailTop + budget);
			if (!framed) {
				return [theme.bold(titleText), ...body, ...footer].map((line) => truncateToWidth(line, width, "…"));
			}
			return framePanel(theme, width, titleText, subtitle, body, footer);
		}

		const searchLines = [...this.search.render(innerWidth), ""];
		const item = this.filtered[this.cursor];
		const previewLines = item?.description
			? ["", ...wrapTextWithAnsi(item.description, innerWidth).slice(0, 3).map((line, idx, arr) => {
				const allWrapped = wrapTextWithAnsi(item.description!, innerWidth);
				if (idx === arr.length - 1 && allWrapped.length > arr.length) {
					return muted(truncateToWidth(line + "…", innerWidth, "…"));
				}
				return muted(line);
			})]
			: [];

		const availAfterSearch = Math.max(1, height - chromeRows - searchLines.length);
		const minListRows = Math.min(Math.max(1, this.filtered.length), Math.min(6, availAfterSearch));
		const detailBudget = Math.max(0, Math.min(previewLines.length, availAfterSearch - minListRows));
		const visibleDetails = previewLines.slice(0, detailBudget);
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

		if (!framed) {
			return [
				theme.bold(titleText),
				...(subtitle && height >= 12 ? [muted(subtitle)] : []),
				...body,
				...footer,
			].map((line) => truncateToWidth(line, width, "…"));
		}
		return framePanel(theme, width, titleText, subtitle, body, footer);
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
		{ overlay: true, overlayOptions: SETUP_OVERLAY_OPTIONS },
	);
}

export interface RoleGridRow {
	role: string;
	purpose?: string;
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

/** Standalone modal panel with a role register beside the selected role's settings;
 * narrow terminals stack the same regions. Full effective values are never squeezed into grid cells. */
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
		const height = setupHeight(this.tui);
		const framed = width >= 20 && height >= 10;
		const innerWidth = framed ? Math.max(1, width - 4) : width;
		const wide = innerWidth >= 72;
		// The two panes close exactly: roleWidth + 3-column gutter + detailWidth = innerWidth.
		const roleWidth = wide ? Math.min(28, Math.max(20, Math.floor(innerWidth * 0.28))) : innerWidth;
		const roles: string[] = [];
		for (const [index, role] of this.rows.entries()) {
			const selected = index === this.row;
			const title = role.purpose && wide ? role.role + " · " + role.purpose : role.role;
			const clippedTitle = truncateToWidth(title, Math.max(1, roleWidth - 2), "…");
			const name = selected ? theme.bold(clippedTitle) : clippedTitle;
			roles.push((selected ? theme.fg("accent", "› ") : "  ") + name);
			if (wide) {
				const summary = role.model + " · " + role.thinking + (role.thinkingOverridden ? " *" : "");
				roles.push(dim("  " + truncateToWidth(summary, roleWidth - 2, "…")));
			}
		}
		const details = this.settings(wide ? innerWidth - roleWidth - 3 : innerWidth);
		const detailOffset = wide ? 0 : roles.length + 1;
		const body: string[] = [];
		const divider = dim(" │ ");
		if (wide) {
			for (let i = 0; i < Math.max(roles.length, details.lines.length); i++) {
				const left = truncateToWidth(roles[i] ?? "", roleWidth, "…");
				body.push(left + " ".repeat(Math.max(0, roleWidth - visibleWidth(left))) + divider + (details.lines[i] ?? ""));
			}
		} else {
			body.push(...roles, "", ...details.lines);
		}
		const footer = innerWidth >= 52
			? [dim("↑/↓ role · ←/→ field · Enter edit · Esc close")]
			: [dim("↑/↓ role · ←/→ field"), dim("Enter edit · Esc close")];

		const chromeRows = framed ? 4 + footer.length + 1 : 3 + footer.length + 1;
		if (body.length + chromeRows <= height) {
			this.scrollTop = 0;
			this.revealField = true;
			if (!framed) {
				return [theme.bold("Subagents · Roles"), dim(this.status), "", ...body, "", ...footer]
					.map((line) => truncateToWidth(line, width, "…"));
			}
			return framePanel(theme, width, "Subagents · Roles", this.status, body, footer);
		}

		// Pin the selected identity while scrolling the existing pane content.
		// The field's complete value and provenance remain reachable by paging.
		const compact = height < 10;
		const header = [details.lines[0]!];
		const controls = innerWidth >= 58
			? [dim("↑/↓ role · ←/→ field · PgUp/Dn scroll · Enter edit · Esc close")]
			: compact
				? [dim("PgUp/Dn scroll · Enter edit · Esc")]
				: [dim("↑/↓ role · ←/→ field"), dim("PgUp/Dn scroll · Enter edit · Esc")];
		const scrollChrome = framed ? 4 + header.length + controls.length + 1 : header.length + controls.length;
		this.pageRows = Math.max(1, height - scrollChrome);
		const viewport = innerWidth + ":" + this.pageRows;
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
		const visibleBody = [...header, ...body.slice(this.scrollTop, this.scrollTop + this.pageRows)];
		if (!framed) {
			return [...visibleBody, ...controls].map((line) => truncateToWidth(line, width, "…"));
		}
		return framePanel(theme, width, "Subagents · Roles", this.status, visibleBody, controls);
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

/** Role × setting modal panel. Esc closes without a change. */
export function promptRoleGrid(
	ctx: PickerContext, rows: RoleGridRow[], focus: RoleGridFocus = {}, status = "Changes save immediately",
): Promise<RoleGridChoice | undefined> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify("/subagents-setup requires Pi's interactive TUI.", "error");
		return Promise.resolve(undefined);
	}
	return ctx.ui.custom<RoleGridChoice | undefined>(
		(tui, theme, keybindings, done) => new RoleGrid(rows, status, focus, tui, theme, keybindings, done),
		{ overlay: true, overlayOptions: SETUP_OVERLAY_OPTIONS },
	);
}
