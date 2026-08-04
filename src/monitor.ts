/**
 * Sub-agent monitor: a module-level singleton store that tracks subagent runs
 * for the current turn.
 *
 * The store notifies subscribers on every mutation so the persistent widget
 * above the editor can re-render. Each run carries timing information
 * (started/ended) plus a concise activity string describing what the run is
 * doing right now ("thinking", "read src/index.ts", ...). Runs are removed
 * as soon as they finish: the tool result is the durable record in the main
 * conversation, so a stale "done" row must not linger in the widget.
 */

import { stripVTControlCharacters } from "node:util";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { UsageStats } from "./spawn.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RunStatus = "queued" | "running" | "done" | "failed";

export interface RunView {
	id: number;
	agent: string;
	task: string;
	model?: string;
	status: RunStatus;
	usage: UsageStats;
	/** Concise current activity ("thinking", "read src/index.ts"); last writer wins. */
	activity?: string;
	/** Epoch ms when the run started executing (set on first "running" status). */
	startedAt?: number;
	/** Epoch ms when the run finished (set on "done"/"failed"). */
	endedAt?: number;
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

const TASK_SUMMARY_MAX = 80;
const TASK_SUMMARY_ELLIPSIS = "…";
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** One-line task preview, capped by terminal display columns (including the ellipsis). */
export function formatTaskSummary(task: string): string {
	const oneLine = stripVTControlCharacters(task).replace(/\s+/g, " ").trim();
	if (visibleWidth(oneLine) <= TASK_SUMMARY_MAX) return oneLine;

	const prefixMax = TASK_SUMMARY_MAX - visibleWidth(TASK_SUMMARY_ELLIPSIS);
	let prefix = "";
	let prefixWidth = 0;
	for (const { segment } of graphemeSegmenter.segment(oneLine)) {
		const segmentWidth = visibleWidth(segment);
		if (prefixWidth + segmentWidth > prefixMax) break;
		prefix += segment;
		prefixWidth += segmentWidth;
	}
	return `${prefix}${TASK_SUMMARY_ELLIPSIS}`;
}

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

/** Max length of the argument target inside a formatted activity line. */
export const ACTIVITY_TARGET_MAX = 60;

function shortTarget(value: unknown): string {
	if (typeof value !== "string") return "";
	const oneLine = value.replace(/\s+/g, " ").trim();
	// Slice by code point so emoji / CJK-ext never leave a lone surrogate.
	const chars = [...oneLine];
	return chars.length > ACTIVITY_TARGET_MAX ? `${chars.slice(0, ACTIVITY_TARGET_MAX - 1).join("")}…` : oneLine;
}

/** Concise "what is it doing" text for a tool call: the tool name plus its single
 * most telling argument (path, command, pattern, ...) — never a raw JSON blob. */
export function formatToolActivity(toolName: string, args: unknown): string {
	const a = (typeof args === "object" && args !== null ? args : {}) as Record<string, unknown>;
	const pick = (...keys: string[]): string => {
		for (const key of keys) {
			const s = shortTarget(a[key]);
			if (s) return s;
		}
		return "";
	};
	let target: string;
	switch (toolName) {
		case "bash":
		case "shell":
			target = pick("command");
			break;
		case "read":
		case "edit":
		case "write":
		case "ls":
			target = pick("path", "file", "filePath");
			break;
		case "grep":
		case "find":
		case "glob":
			target = pick("pattern", "query", "path");
			break;
		case "web_search":
		case "search":
			target = pick("query");
			break;
		case "fetch":
		case "web_fetch":
		case "fetch_content":
			target = pick("url");
			break;
		case "subagent":
			target = pick("agent", "task");
			break;
		default:
			target = pick("path", "command", "query", "pattern", "url", "file", "task");
	}
	return target ? `${toolName} ${target}` : toolName;
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

	addRun(agent: string, task: string, model?: string): number {
		const id = this.nextId++;
		this.runs.push({
			id,
			agent,
			task,
			model,
			status: "queued",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
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

	/** Update the run's current one-line activity (what it is doing now). */
	setActivity(id: number, text: string): void {
		const run = this.find(id);
		if (!run) return;
		run.activity = text;
		this.notify();
	}

	/** Remove a run (finished runs leave the widget). Returns the removed run. */
	removeRun(id: number): RunView | undefined {
		const index = this.runs.findIndex((r) => r.id === id);
		if (index === -1) return undefined;
		const [run] = this.runs.splice(index, 1);
		this.notify();
		return run;
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
