/** Searchable, width-safe model picker used inside /subagents-setup. */

import {
	fuzzyFilter,
	truncateToWidth,
	type Component,
	type Focusable,
	type KeybindingsManager,
	type SelectItem,
	type TUI,
} from "@earendil-works/pi-tui";

/** Rows shown at once; longer lists are reached with PageUp/PageDown. */
const PAGE_SIZE = 8;

interface PickerStyles {
	border: (text: string) => string;
	title: (text: string) => string;
	hint: (text: string) => string;
	cursorMark: (text: string) => string;
	selectedLabel: (text: string) => string;
	label: (text: string) => string;
	dim: (text: string) => string;
	filterEcho: (text: string) => string;
}

type PickerItem = SelectItem;

function pickerItemSearchText(item: PickerItem): string {
	return `${item.value} ${item.label} ${item.description ?? ""}`;
}

interface PickerCallbacks {
	onSelect: (value: string) => void;
	onCancel: () => void;
}

export class Picker implements Component, Focusable {
	private _focused = false;
	private query = "";
	private cursor = 0;
	private filtered: PickerItem[];

	constructor(
		private readonly items: PickerItem[],
		private readonly styles: PickerStyles,
		private readonly headerLines: string[],
		private readonly tui: TUI,
		private readonly keybindings: KeybindingsManager,
		private readonly callbacks: PickerCallbacks,
		initialValue?: string,
	) {
		this.filtered = items;
		const initialIndex = initialValue === undefined
			? -1
			: items.findIndex((item) => item.value === initialValue);
		if (initialIndex >= 0) this.cursor = initialIndex;
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
	}

	private recompute(): void {
		const query = this.query.trim();
		this.filtered = query ? fuzzyFilter(this.items, query, pickerItemSearchText) : this.items;
		this.cursor = Math.max(0, Math.min(this.cursor, this.filtered.length - 1));
	}

	render(width: number): string[] {
		const fit = (line: string): string => truncateToWidth(line, width, "");
		const border = fit(this.styles.border("─".repeat(Math.max(1, width))));
		const lines = [border, ...this.headerLines.map(fit)];
		lines.push(fit(this.query
			? this.styles.filterEcho(`filter: ${this.query}`)
			: this.styles.dim("filter: (type to narrow)")));
		lines.push(border);

		if (this.filtered.length === 0) {
			lines.push(fit(this.styles.dim("  (no matches)")));
		} else {
			const start = Math.max(
				0,
				Math.min(this.cursor - Math.floor(PAGE_SIZE / 2), this.filtered.length - PAGE_SIZE),
			);
			for (const [index, item] of this.filtered.slice(start, start + PAGE_SIZE).entries()) {
				const isCursor = start + index === this.cursor;
				const mark = isCursor ? this.styles.cursorMark("❯ ") : "  ";
				const label = isCursor ? this.styles.selectedLabel(item.label) : this.styles.label(item.label);
				const description = item.description ? this.styles.dim(` — ${item.description}`) : "";
				lines.push(fit(mark + label + description));
			}
			const paging = this.filtered.length > PAGE_SIZE ? "  ↑/↓ move • PgUp/PgDn page" : "";
			lines.push(fit(this.styles.dim(`  (${this.cursor + 1}/${this.filtered.length})${paging}`)));
		}

		lines.push(border);
		return lines;
	}

	handleInput(data: string): void {
		const keybindings = this.keybindings;
		if (keybindings.matches(data, "tui.select.up")) {
			if (this.filtered.length > 0) {
				this.cursor = this.cursor === 0 ? this.filtered.length - 1 : this.cursor - 1;
			}
		} else if (keybindings.matches(data, "tui.select.down")) {
			if (this.filtered.length > 0) {
				this.cursor = this.cursor === this.filtered.length - 1 ? 0 : this.cursor + 1;
			}
		} else if (keybindings.matches(data, "tui.select.pageUp")) {
			this.cursor = Math.max(0, this.cursor - PAGE_SIZE);
		} else if (keybindings.matches(data, "tui.select.pageDown")) {
			this.cursor = Math.min(Math.max(0, this.filtered.length - 1), this.cursor + PAGE_SIZE);
		} else if (keybindings.matches(data, "tui.select.confirm")) {
			const item = this.filtered[this.cursor];
			if (item) this.callbacks.onSelect(item.value);
			return;
		} else if (keybindings.matches(data, "tui.select.cancel")) {
			this.callbacks.onCancel();
			return;
		} else if (data === "\x7f" || data === "\b") {
			this.query = this.query.slice(0, -1);
			this.cursor = 0;
			this.recompute();
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
	return data.length > 0 && data.charCodeAt(0) >= 0x20;
}

/** Build picker styles from the pi theme. */
export function makePickerStyles(theme: {
	fg: (color: any, text: string) => string;
	bold: (text: string) => string;
}): PickerStyles {
	return {
		border: (text) => theme.fg("accent", text),
		title: (text) => theme.fg("accent", theme.bold(text)),
		hint: (text) => theme.fg("dim", text),
		cursorMark: (text) => theme.fg("accent", text),
		selectedLabel: (text) => theme.fg("accent", theme.bold(text)),
		label: (text) => text,
		dim: (text) => theme.fg("dim", text),
		filterEcho: (text) => theme.fg("accent", text),
	};
}
