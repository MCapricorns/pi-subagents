/** Linear setup menus and searchable choices within Pi's input dock. */

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

export interface SetupItem extends SelectItem {
	/** Saved state is independent of the navigation cursor. */
	saved?: boolean;
}
interface PickerOptions {
	title: string;
	hint: string;
	initialValue?: string;
	searchable: boolean;
}

/** Input owns Unicode editing, paste, horizontal scrolling and the IME cursor.
 * The bounded list takes priority; Tab exposes complete, scrollable details. */
class Picker implements Component, Focusable {
	private _focused = false;
	private cursor = 0;
	private pageRows = 1;
	private details = false;
	private detailTop = 0;
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
		this.search.focused = value && this.options.searchable && !this.details;
	}

	private isSaved(item: SetupItem): boolean {
		return item.saved ?? (this.options.searchable && item.value === this.options.initialValue);
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
		const muted = (text: string) => theme.fg("muted", text);
		const height = setupHeight(this.tui);
		const compact = height < 6;
		const lines: string[] = [];
		// At three rows, retain search, a choice and controls instead of a title.
		if (!(height === 3 && this.options.searchable && !this.details)) {
			lines.push(theme.bold(this.options.title + (this.details ? " · Details" : "")));
		}
		if (!this.details && this.options.hint && height >= 10) lines.push(muted(this.options.hint));
		if (!this.details && this.options.searchable) lines.push(...this.search.render(width));
		const footer = compact
			? [muted(this.details ? "↑↓ scroll · Tab list · Esc" : "↑↓ Enter Esc · Tab details")]
			: this.details
				? [muted("↑/↓ scroll · Tab list · Esc back"), muted("PgUp/Dn page · Enter select")]
				: [muted("↑/↓ move · Enter select · Esc back"), muted(
					(this.filtered.length ? (this.cursor + 1) + "/" + this.filtered.length + " · " : "") + "PgUp/Dn · Tab details")];
		const budget = Math.max(1, height - lines.length - footer.length);
		if (this.details) {
			this.pageRows = budget;
			const details = this.detailLines(width);
			this.detailTop = Math.max(0, Math.min(this.detailTop, details.length - budget));
			lines.push(...details.slice(this.detailTop, this.detailTop + budget));
		} else {
			this.pageRows = Math.min(PAGE_SIZE, budget);
			const start = Math.max(0, Math.min(this.cursor - Math.floor(this.pageRows / 2), this.filtered.length - this.pageRows));
			const visible = this.filtered.slice(start, start + this.pageRows);
			if (!visible.length) lines.push(muted(this.search.getValue() ? "No matches. Clear or change the search." : "No choices available."));
			for (const [index, item] of visible.entries()) {
				const active = start + index === this.cursor;
				const suffix = this.isSaved(item) ? " [saved]" : "";
				const label = truncateToWidth(item.label, Math.max(0, width - 2 - visibleWidth(suffix)), "…") + suffix;
				lines.push(active ? theme.fg("accent", "› ") + theme.underline(theme.bold(label)) : "  " + label);
			}
			// Menus show the active role/setting's explanation. Choice lists only
			// use spare rows for context, never displacing another choice.
			const spare = Math.min(3, height - lines.length - footer.length);
			const item = this.filtered[this.cursor];
			if (spare > 0 && item?.description) {
				const wrapped = wrapTextWithAnsi(item.description, width);
				const preview = wrapped.slice(0, spare);
				if (wrapped.length > spare) preview[spare - 1] = truncateToWidth(preview[spare - 1]! + "…", width, "…");
				lines.push(...preview.map(muted));
			}
		}
		return [...lines, ...footer].map((line) => truncateToWidth(line, width, "…"));
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
		} else if (this.options.searchable) {
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

function prompt(ctx: PickerContext, items: SetupItem[], options: PickerOptions): Promise<string | undefined> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify("/subagents-setup requires Pi's interactive TUI.", "error");
		return Promise.resolve(undefined);
	}
	return ctx.ui.custom<string | undefined>((tui, theme, keybindings, done) =>
		new Picker(items, options, tui, theme, keybindings, done));
}

/** Searchable choices. Esc returns one level without saving the cursor. */
export function promptSelectOne(
	ctx: PickerContext, title: string, hint: string, items: SetupItem[], initialValue?: string,
): Promise<string | undefined> {
	return prompt(ctx, items, { title, hint, initialValue, searchable: true });
}

/** A familiar vertical menu. initialValue restores navigation, not saved state. */
export function promptMenu(
	ctx: PickerContext, title: string, hint: string, items: SetupItem[], initialValue?: string,
): Promise<string | undefined> {
	return prompt(ctx, items, { title, hint, initialValue, searchable: false });
}
