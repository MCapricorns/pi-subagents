/**
 * Sub-agent monitor: a module-level singleton store that tracks subagent runs
 * for the current turn.
 *
 * The store notifies subscribers on every mutation so the persistent widget
 * above the editor can re-render. Each run carries timing information
 * (started/ended) and a transcript whose most recent entry is surfaced as the
 * run's current activity.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
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
	/** Epoch ms when the run started executing (set on first "running" status). */
	startedAt?: number;
	/** Epoch ms when the run finished (set on "done"/"failed"). */
	endedAt?: number;
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

export function formatDuration(ms: number): string {
	const totalSeconds = Math.max(0, Math.floor(ms / 1000));
	if (totalSeconds < 60) return `${totalSeconds}s`;
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	if (minutes < 60) return `${minutes}m${String(seconds).padStart(2, "0")}s`;
	const hours = Math.floor(minutes / 60);
	return `${hours}h${String(minutes % 60).padStart(2, "0")}m`;
}

/** Elapsed wall time of a run: live while running, final once finished. */
export function formatElapsed(run: RunView, now: number = Date.now()): string {
	if (run.startedAt === undefined) return "";
	const end = run.endedAt ?? now;
	return formatDuration(end - run.startedAt);
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
		if (status === "running" && run.startedAt === undefined) {
			run.startedAt = Date.now();
		} else if ((status === "done" || status === "failed") && run.endedAt === undefined) {
			run.endedAt = Date.now();
		}
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
		const elapsed = formatElapsed(run);
		if (elapsed) parts.push(elapsed);
		return parts.join(" · ");
	}

	/** Text of the most recent transcript entry (what the run is doing now). */
	lastActivity(run: RunView): string | undefined {
		for (let i = run.transcript.length - 1; i >= 0; i--) {
			const text = run.transcript[i].text.trim();
			if (text.length > 0) return text;
		}
		return undefined;
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

/** User-facing status label shown in the widget. */
export function statusLabel(status: RunStatus): string {
	switch (status) {
		case "queued":
			return "ready";
		case "running":
			return "running";
		case "done":
			return "done";
		case "failed":
			return "stopped";
	}
}

/** Theme color matching the status label. */
export function statusColor(status: RunStatus): "accent" | "success" | "error" | "dim" {
	switch (status) {
		case "running":
			return "accent";
		case "done":
			return "success";
		case "failed":
			return "error";
		default:
			return "dim";
	}
}
