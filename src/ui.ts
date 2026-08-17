/**
 * TUI pickers for /subagents-setup, built on @earendil-works/pi-tui.
 *
 * A single self-contained `Picker` component powers both selectors:
 *   - single-select (model picker): type to fuzzy-filter, arrows to move,
 *     PageUp/PageDown to page, Enter to choose, Esc to cancel.
 *   - multi-select (module picker): same navigation, Space toggles a checkbox,
 *     Enter confirms the selection set.
 *
 * pi-tui's built-in SelectList only handles up/down/confirm/cancel (no paging),
 * so we render the list ourselves and drive it with getKeybindings(). Every line
 * is passed through truncateToWidth() — pi hard-crashes if a rendered line is
 * wider than the terminal.
 */

import {
	fuzzyFilter,
	truncateToWidth,
	type Component,
	type Focusable,
	type KeybindingsManager,
	type SelectItem,
	type TUI,
} from "@earendil-works/pi-tui";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

/** The slice of the extension context the pickers need (mode + ui), so both
 * command handlers (ExtensionCommandContext) and tool execute handlers
 * (ExtensionContext) can use them. */
export type PickerContext = Pick<ExtensionCommandContext, "mode" | "ui">;

/** Rows shown at once; longer lists are reached with PageUp/PageDown. */
export const PAGE_SIZE = 8;

export interface PickerStyles {
	border: (t: string) => string;
	title: (t: string) => string;
	hint: (t: string) => string;
	cursorMark: (t: string) => string;
	selectedLabel: (t: string) => string;
	label: (t: string) => string;
	dim: (t: string) => string;
	checked: (t: string) => string;
	unchecked: (t: string) => string;
	filterEcho: (t: string) => string;
}

export interface PickerItem extends SelectItem {
	disabled?: boolean;
}

export function pickerItemSearchText(item: PickerItem): string {
	return `${item.value} ${item.label} ${item.description ?? ""}`;
}

interface PickerCallbacks {
	/** single-select: fired with the highlighted value on Enter. */
	onSelect?: (value: string) => void;
	/** multi-select: fired with the full chosen set on Enter. */
	onConfirm?: (values: string[]) => void;
	onCancel: () => void;
}

export class Picker implements Component, Focusable {
	private _focused = false;
	private query = "";
	private cursor = 0;
	private filtered: PickerItem[];

	constructor(
		private readonly items: PickerItem[],
		private readonly multi: boolean,
		private readonly selected: Set<string>,
		private readonly styles: PickerStyles,
		private readonly headerLines: string[],
		private readonly tui: TUI,
		private readonly keybindings: KeybindingsManager,
		private readonly cb: PickerCallbacks,
		initialValue?: string,
	) {
		this.filtered = items;
		const initialIndex = initialValue === undefined ? -1 : items.findIndex((item) => item.value === initialValue);
		if (initialIndex >= 0) this.cursor = initialIndex;
	}

	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
	}

	private recompute(): void {
		const q = this.query.trim();
		this.filtered = q ? fuzzyFilter(this.items, q, pickerItemSearchText) : this.items;
		this.cursor = Math.max(0, Math.min(this.cursor, this.filtered.length - 1));
	}

	render(width: number): string[] {
		const s = this.styles;
		const fit = (line: string): string => truncateToWidth(line, width, "");
		const border = fit(s.border("─".repeat(Math.max(1, width))));

		const lines: string[] = [border];
		for (const h of this.headerLines) lines.push(fit(h));
		lines.push(fit(this.query ? s.filterEcho(`filter: ${this.query}`) : s.dim("filter: (type to narrow)")));
		lines.push(border);

		if (this.filtered.length === 0) {
			lines.push(fit(s.dim("  (no matches)")));
		} else {
			const start = Math.max(
				0,
				Math.min(this.cursor - Math.floor(PAGE_SIZE / 2), this.filtered.length - PAGE_SIZE),
			);
			const visible = this.filtered.slice(start, start + PAGE_SIZE);
			for (let i = 0; i < visible.length; i++) {
				const item = visible[i];
				const isCursor = start + i === this.cursor;
				const mark = isCursor ? s.cursorMark("❯ ") : "  ";
				const label = item.disabled
					? s.dim(item.label)
					: isCursor ? s.selectedLabel(item.label) : s.label(item.label);
				const description = item.description ? s.dim(` — ${item.description}`) : "";
				const line = this.multi
					? mark + (this.selected.has(item.value) ? s.checked("[x] ") : s.unchecked("[ ] ")) + label + description
					: mark + label + description;
				lines.push(fit(line));
			}
			const more = this.filtered.length > PAGE_SIZE ? "  ↑/↓ move • PgUp/PgDn page" : "";
			lines.push(fit(s.dim(`  (${this.cursor + 1}/${this.filtered.length})${more}`)));
		}

		lines.push(border);
		return lines;
	}

	handleInput(data: string): void {
		const kb = this.keybindings;
		if (kb.matches(data, "tui.select.up")) {
			if (this.filtered.length > 0) this.cursor = this.cursor === 0 ? this.filtered.length - 1 : this.cursor - 1;
		} else if (kb.matches(data, "tui.select.down")) {
			if (this.filtered.length > 0) this.cursor = this.cursor === this.filtered.length - 1 ? 0 : this.cursor + 1;
		} else if (kb.matches(data, "tui.select.pageUp")) {
			this.cursor = Math.max(0, this.cursor - PAGE_SIZE);
		} else if (kb.matches(data, "tui.select.pageDown")) {
			this.cursor = Math.min(Math.max(0, this.filtered.length - 1), this.cursor + PAGE_SIZE);
		} else if (kb.matches(data, "tui.select.confirm")) {
			if (this.multi) this.cb.onConfirm?.([...this.selected]);
			else {
				const item = this.filtered[this.cursor];
				if (item && !item.disabled) this.cb.onSelect?.(item.value);
			}
			return;
		} else if (kb.matches(data, "tui.select.cancel")) {
			this.cb.onCancel();
			return;
		} else if (data === "\x7f" || data === "\b") {
			this.query = this.query.slice(0, -1);
			this.cursor = 0;
			this.recompute();
		} else if (data === " ") {
			if (this.multi) {
				const item = this.filtered[this.cursor];
				if (item) {
					if (this.selected.has(item.value)) this.selected.delete(item.value);
					else this.selected.add(item.value);
				}
			} else {
				this.query += data;
				this.cursor = 0;
				this.recompute();
			}
		} else if (isPrintable(data)) {
			this.query += data;
			this.cursor = 0;
			this.recompute();
		}
		this.tui.requestRender();
	}

	invalidate(): void {}
}

function isPrintable(data: string): boolean {
	if (data.length === 0) return false;
	// Reject ESC-led escape sequences and other control characters.
	return data.charCodeAt(0) >= 0x20;
}

/** Build style functions from the pi theme. `any` on the color param dodges a
 * strict contravariance error when assigning the theme's narrow color union. */
function makeStyles(theme: { fg: (color: any, text: string) => string; bold: (text: string) => string }): PickerStyles {
	return {
		border: (t) => theme.fg("accent", t),
		title: (t) => theme.fg("accent", theme.bold(t)),
		hint: (t) => theme.fg("dim", t),
		cursorMark: (t) => theme.fg("accent", t),
		selectedLabel: (t) => theme.fg("accent", theme.bold(t)),
		label: (t) => t,
		dim: (t) => theme.fg("dim", t),
		checked: (t) => theme.fg("accent", t),
		unchecked: (t) => theme.fg("dim", t),
		filterEcho: (t) => theme.fg("accent", t),
	};
}

function requireTui(ctx: PickerContext): boolean {
	if (ctx.mode !== "tui") {
		ctx.ui.notify("/subagents-setup requires Pi's interactive TUI.", "error");
		return false;
	}
	return true;
}

/** Single-select with fuzzy filter + paging. Resolves undefined on Esc. */
export function promptSelectOne(
	ctx: PickerContext,
	title: string,
	hint: string,
	items: PickerItem[],
	initialValue?: string,
): Promise<string | undefined> {
	if (!requireTui(ctx)) return Promise.resolve(undefined);
	return ctx.ui.custom<string | undefined>((tui, theme, keybindings, done) => {
		const styles = makeStyles(theme);
		const header = [styles.title(title), styles.hint(hint)];
		return new Picker(items, false, new Set<string>(), styles, header, tui, keybindings, {
			onSelect: (value) => done(value),
			onCancel: () => done(undefined),
		}, initialValue);
	});
}

/** Multi-select with fuzzy filter + paging. Resolves undefined on Esc. */
export function promptSelectMany(
	ctx: PickerContext,
	title: string,
	hint: string,
	items: PickerItem[],
	initialSelected: readonly string[],
): Promise<string[] | undefined> {
	if (!requireTui(ctx)) return Promise.resolve(undefined);
	return ctx.ui.custom<string[] | undefined>((tui, theme, keybindings, done) => {
		const styles = makeStyles(theme);
		const header = [styles.title(title), styles.hint(hint)];
		return new Picker(items, true, new Set<string>(initialSelected), styles, header, tui, keybindings, {
			onConfirm: (values) => done(values),
			onCancel: () => done(undefined),
		});
	});
}
