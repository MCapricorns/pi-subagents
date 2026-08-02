/**
 * Sub-agent monitor: a module-level singleton store that tracks subagent runs
 * for the current turn, plus a drill-down overlay component for live inspection.
 *
 * The store notifies subscribers on every mutation so the persistent widget and
 * the overlay can re-render. The overlay shows a list of runs (↑/↓ + Enter) and
 * a detail view with the live transcript (auto-tailing, scrollable).
 */

import {
	matchesKey,
	truncateToWidth,
	type Component,
	type Focusable,
	type TUI,
} from "@earendil-works/pi-tui";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { UsageStats } from "./spawn.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RunStatus = "queued" | "running" | "done" | "failed";

export interface TranscriptLine {
	kind: "tool" | "text" | "status" | "error";
	text: string;
}

export interface RunView {
	id: number;
	agent: string;
	model?: string;
	status: RunStatus;
	usage: UsageStats;
	transcript: TranscriptLine[];
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function formatTokens(count: number): string {
	if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
	if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k`;
	return String(count);
}

export function formatUsageCompact(usage: UsageStats): string {
	const parts: string[] = [];
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	return parts.join(" ");
}

// ---------------------------------------------------------------------------
// MonitorStore
// ---------------------------------------------------------------------------

export class MonitorStore {
	private runs: RunView[] = [];
	private nextId = 1;
	private subscribers = new Set<() => void>();

	beginTurn(): void {
		// Clear finished runs from a previous turn, but keep any still-active
		// (queued/running) ones so a concurrent sub-agent call is not wiped.
		this.runs = this.runs.filter((r) => r.status === "queued" || r.status === "running");
		this.notify();
	}

	addRun(agent: string, model?: string): number {
		const id = this.nextId++;
		this.runs.push({
			id,
			agent,
			model,
			status: "queued",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
			transcript: [],
		});
		this.notify();
		return id;
	}

	setStatus(id: number, status: RunStatus): void {
		const run = this.find(id);
		if (!run) return;
		run.status = status;
		this.notify();
	}

	setUsage(id: number, usage: UsageStats, model?: string): void {
		const run = this.find(id);
		if (!run) return;
		run.usage = { ...usage };
		if (model) run.model = model;
		this.notify();
	}

	appendTranscript(id: number, line: TranscriptLine): void {
		const run = this.find(id);
		if (!run) return;
		run.transcript.push(line);
		this.notify();
	}

	/** Append streamed assistant text, merging consecutive deltas into coherent
	 * lines (split only on real newlines) instead of one line per token fragment. */
	appendTextDelta(id: number, delta: string): void {
		const run = this.find(id);
		if (!run || delta.length === 0) return;
		const segments = delta.split("\n");
		for (let i = 0; i < segments.length; i++) {
			const seg = segments[i];
			const last = run.transcript[run.transcript.length - 1];
			if (i === 0 && last && last.kind === "text") {
				last.text += seg;
			} else {
				run.transcript.push({ kind: "text", text: seg });
			}
		}
		this.notify();
	}

	getRuns(): RunView[] {
		return this.runs;
	}

	subscribe(cb: () => void): () => void {
		this.subscribers.add(cb);
		return () => {
			this.subscribers.delete(cb);
		};
	}

	summarize(run: RunView): string {
		const usage = formatUsageCompact(run.usage);
		const parts = [run.agent];
		if (run.model) parts.push(run.model);
		if (usage) parts.push(usage);
		parts.push(run.status);
		return parts.join(" · ");
	}

	private find(id: number): RunView | undefined {
		return this.runs.find((r) => r.id === id);
	}

	private notify(): void {
		for (const cb of this.subscribers) {
			try {
				cb();
			} catch {
				/* subscriber errors must not break the store */
			}
		}
	}
}

export const monitor = new MonitorStore();

// ---------------------------------------------------------------------------
// Status icons
// ---------------------------------------------------------------------------

export function statusIcon(status: RunStatus, theme: Theme): string {
	switch (status) {
		case "running":
			return theme.fg("accent", "●");
		case "done":
			return theme.fg("success", "✓");
		case "failed":
			return theme.fg("error", "✗");
		default:
			return theme.fg("dim", "○");
	}
}

// ---------------------------------------------------------------------------
// Overlay component
// ---------------------------------------------------------------------------

class SubagentOverlay implements Component, Focusable {
	private _focused = false;
	private mode: "list" | "detail" = "list";
	private cursor = 0;
	private scroll = 0;
	private cachedWidth = -1;
	private cachedLines: string[] = [];
	private closed = false;

	private readonly unsub: () => void;

	constructor(
		private readonly tui: TUI,
		private readonly theme: Theme,
		private readonly done: (result: void) => void,
	) {
		this.unsub = monitor.subscribe(() => {
			this.invalidate();
			this.tui.requestRender();
		});
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
	}

	invalidate(): void {
		this.cachedWidth = -1;
		this.cachedLines = [];
	}

	handleInput(data: string): void {
		if (this.mode === "list") {
			const runs = monitor.getRuns();
			if (matchesKey(data, "up")) {
				if (runs.length > 0) this.cursor = this.cursor === 0 ? runs.length - 1 : this.cursor - 1;
			} else if (matchesKey(data, "down")) {
				if (runs.length > 0) this.cursor = this.cursor === runs.length - 1 ? 0 : this.cursor + 1;
			} else if (matchesKey(data, "return")) {
				if (runs.length > 0) {
					this.mode = "detail";
					this.scrollToBottom();
				}
			} else if (matchesKey(data, "escape")) {
				this.close();
				return;
			}
		} else {
			if (matchesKey(data, "up")) {
				this.scroll = Math.max(0, this.scroll - 1);
			} else if (matchesKey(data, "down")) {
				this.scroll++;
			} else if (matchesKey(data, "escape")) {
				this.mode = "list";
			}
		}
		this.invalidate();
		this.tui.requestRender();
	}

	render(width: number): string[] {
		if (this.cachedWidth === width && this.cachedLines.length > 0) return this.cachedLines;

		const t = this.theme;
		const fit = (line: string): string => truncateToWidth(line, width, "");
		const border = fit(t.fg("border", "─".repeat(Math.max(1, width))));

		const lines: string[] = [];

		if (this.mode === "list") {
			lines.push(border);
			lines.push(fit(t.fg("accent", t.bold(" Sub-agents"))));
			lines.push(border);

			const runs = monitor.getRuns();
			if (runs.length === 0) {
				lines.push(fit(t.fg("dim", "  (no sub-agent runs this turn)")));
			} else {
				this.cursor = Math.max(0, Math.min(this.cursor, runs.length - 1));
				for (let i = 0; i < runs.length; i++) {
					const run = runs[i];
					const isCursor = i === this.cursor;
					const mark = isCursor ? t.fg("accent", "❯ ") : "  ";
					const icon = statusIcon(run.status, t);
					const usage = formatUsageCompact(run.usage);
					const parts = [run.agent];
					if (run.model) parts.push(run.model);
					if (usage) parts.push(usage);
					parts.push(run.status);
					const label = isCursor ? t.fg("accent", t.bold(parts.join(" · "))) : parts.join(" · ");
					lines.push(fit(`${mark}${icon} ${label}`));
				}
			}

			lines.push(border);
			lines.push(fit(t.fg("dim", " ↑↓ select · enter open · esc close")));
			lines.push(border);
		} else {
			const runs = monitor.getRuns();
			const run = runs[this.cursor];

			lines.push(border);
			if (run) {
				const headerParts = [run.agent];
				if (run.model) headerParts.push(run.model);
				lines.push(fit(t.fg("accent", t.bold(` ${headerParts.join(" · ")}`))));
				const usage = formatUsageCompact(run.usage);
				const statusLine = ` ${statusIcon(run.status, t)} ${run.status}${usage ? ` · ${usage}` : ""}`;
				lines.push(fit(statusLine));
			} else {
				lines.push(fit(t.fg("dim", " (no run selected)")));
			}
			lines.push(border);

			if (run) {
				// Available height for transcript: total minus header(4) + footer(2)
				const transcriptLines = run.transcript;
				const availHeight = Math.max(1, 40 - 6); // reasonable default; actual height varies
				this.scroll = Math.max(0, Math.min(this.scroll, Math.max(0, transcriptLines.length - availHeight)));

				// Auto-tail: if scroll is at the bottom, keep it there
				const maxScroll = Math.max(0, transcriptLines.length - availHeight);
				if (this.scroll >= maxScroll - 1) this.scroll = maxScroll;

				const visible = transcriptLines.slice(this.scroll, this.scroll + availHeight);
				for (const entry of visible) {
					const color =
						entry.kind === "tool"
							? "accent"
							: entry.kind === "error"
								? "error"
								: entry.kind === "status"
									? "dim"
									: "text";
					lines.push(fit(t.fg(color, ` ${entry.text}`)));
				}
				if (transcriptLines.length === 0) {
					lines.push(fit(t.fg("dim", " (waiting for output…)")));
				}
			}

			lines.push(border);
			lines.push(fit(t.fg("dim", " ↑↓ scroll · esc back")));
			lines.push(border);
		}

		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}

	dispose(): void {
		if (!this.closed) {
			this.closed = true;
			this.unsub();
		}
	}

	private scrollToBottom(): void {
		const runs = monitor.getRuns();
		const run = runs[this.cursor];
		if (run) this.scroll = Math.max(0, run.transcript.length);
	}

	private close(): void {
		this.closed = true;
		this.unsub();
		this.done();
	}
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export async function openSubagentOverlay(ctx: ExtensionContext): Promise<void> {
	await ctx.ui.custom<void>((tui, theme, _kb, done) => new SubagentOverlay(tui, theme, done), {
		overlay: true,
	});
}
