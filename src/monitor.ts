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
	/** Effective thinking strength this run was launched with (frontmatter/config/global). */
	thinking?: string;
	status: RunStatus;
	usage: UsageStats;
	/** Concise current activity ("thinking", "read src/index.ts"); last writer wins. */
	activity?: string;
	/** Epoch ms when the run started executing (set on first "running" status). */
	startedAt?: number;
	/** Epoch ms when the run finished (set on "done"/"failed"). */
	endedAt?: number;
	/** When set, this run belongs to an auto-fix chain (e.g. worker fixing a reviewer's findings). */
	groupId?: string;
	/** Human-readable role within a chain, e.g. "fix round 1" or "re-review round 1". */
	relationLabel?: string;
	/** Free-form note shown in the widget next to the status label (e.g. "auto-fix chain running"). */
	annotation?: string;
}

/** Optional chain metadata for runs spawned by an auto-fix loop. */
export interface RunChainMeta {
	groupId?: string;
	relationLabel?: string;
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

const TASK_SUMMARY_MAX = 80;
const TASK_SUMMARY_ELLIPSIS = "…";
/** Columns reserved at the END of a truncated summary so the distinguishing
 * keywords (paths, symbols, ...) survive; the head gets the rest. */
const TASK_SUMMARY_TAIL_MAX = 28;
/** Tail share of a non-default maxWidth (narrow widgets keep a usable tail). */
const TASK_SUMMARY_TAIL_SHARE = 0.35;
const TASK_SUMMARY_TAIL_MIN = 8;
const TASK_SUMMARY_KEY_SEP = " · ";
/** kebab/snake words that are task boilerplate, never distinguishing signal. */
const KEY_FRAGMENT_STOPWORDS = new Set([
	"self-contained",
	"read-only",
	"write-only",
	"auto-fix",
	"re-review",
	"one-line",
	"pre-commit",
]);
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

interface KeyFragment {
	text: string;
	index: number;
}

/**
 * Pull the most distinguishing fragments out of a task: file paths, quoted
 * phrases, camelCase/PascalCase symbols and kebab/snake compounds. Sorted by
 * first occurrence and deduped (a path covers its own sub-fragments). These
 * are what make parallel tasks of the same agent look different.
 */
export function extractKeyFragments(text: string): string[] {
	const fragments: KeyFragment[] = [];
	const add = (re: RegExp, group = 0): void => {
		for (const m of text.matchAll(re)) {
			const g = m[group];
			if (g === undefined) continue;
			fragments.push({ text: g, index: m.index ?? 0 });
		}
	};
	// Quoted phrases first (highest signal).
	add(/["'`]([^"'`]{4,60})["'`]/g, 1);
	// Paths with a known extension (src/index.ts, build/out.js.map).
	add(/(?<![A-Za-z0-9_.-])[A-Za-z0-9_.-]+\.[A-Za-z0-9]{1,5}(?![A-Za-z0-9_.-])/g);
	// Paths with a slash but no extension (src/components, .github/workflows).
	add(/(?<![A-Za-z0-9_.-])[A-Za-z0-9_.-]+(?:[\\/][A-Za-z0-9_.-]+)+(?![\\/])/g);
	// camelCase / PascalCase identifiers (function or type names).
	add(/\b[a-z][a-zA-Z0-9]*[A-Z][a-zA-Z0-9]*\b/g);
	// snake_case / kebab-case compound words.
	add(/\b[a-z][a-z0-9]+[-_][a-z0-9][a-z0-9_-]*\b/g);

	fragments.sort((a, b) => a.index - b.index);
	const seen = new Set<string>();
	const out: string[] = [];
	for (const f of fragments) {
		const t = f.text.trim();
		if (t.length < 4 || KEY_FRAGMENT_STOPWORDS.has(t)) continue;
		if (seen.has(t)) continue;
		// A longer fragment (the full path) covers its own sub-fragments.
		if (out.some((o) => o.includes(t) || t.includes(o))) continue;
		seen.add(t);
		out.push(t);
	}
	return out;
}

function takeGraphemes(segments: string[], maxWidth: number): string {
	let width = 0;
	const out: string[] = [];
	for (const segment of segments) {
		const segmentWidth = visibleWidth(segment);
		if (width + segmentWidth > maxWidth) break;
		out.push(segment);
		width += segmentWidth;
	}
	return out.join("");
}

function tailGraphemes(segments: string[], maxWidth: number): string {
	let width = 0;
	const tail: string[] = [];
	for (let i = segments.length - 1; i >= 0; i--) {
		const segmentWidth = visibleWidth(segments[i]);
		if (width + segmentWidth > maxWidth) break;
		tail.unshift(segments[i]);
		width += segmentWidth;
	}
	return tail.join("");
}

/**
 * One-line task preview, capped by `maxWidth` display columns (default 80).
 * `keysOnly` (default): extracted key fragments (paths, quoted phrases,
 * symbols) are shown bare — the agent name is already displayed next to the
 * task line, so templated prose ("explore: trace how ...") adds nothing.
 * `keysOnly: false` keeps the prose as `head…tail` (used for completion
 * messages, where the Task line is the reader's only context).
 * Grapheme-safe — CJK, ZWJ emoji and combining sequences are never split.
 */
export function formatTaskSummary(task: string, maxWidth: number = TASK_SUMMARY_MAX, keysOnly = true): string {
	const oneLine = stripVTControlCharacters(task).replace(/\s+/g, " ").trim();
	if (maxWidth <= 0 || visibleWidth(oneLine) <= maxWidth) return oneLine;

	const segments = [...graphemeSegmenter.segment(oneLine)].map((s) => s.segment);
	const ellipsisWidth = visibleWidth(TASK_SUMMARY_ELLIPSIS);

	if (keysOnly) {
		const fragments = extractKeyFragments(oneLine);
		if (fragments.length > 0) {
			const keyMax = maxWidth - 1;
			let keys = "";
			for (const fragment of fragments) {
				const piece = keys ? `${TASK_SUMMARY_KEY_SEP}${fragment}` : fragment;
				const total = keys + piece;
				if (visibleWidth(total) > keyMax) {
					// Budget exhausted: keep what fits, unless nothing fits yet.
					if (!keys) {
						// A single over-long fragment keeps its tail
						// (extension/symbol) and is prefixed with the ellipsis.
						const fragmentSegments = [...graphemeSegmenter.segment(piece)].map((s) => s.segment);
						keys = `${TASK_SUMMARY_ELLIPSIS}${tailGraphemes(fragmentSegments, keyMax - ellipsisWidth)}`;
					}
					break;
				}
				keys = total;
			}
			return keys;
		}
	}

	// No distinctive fragments (or prose mode): fall back to head…tail.
	const tailMax = Math.max(
		TASK_SUMMARY_TAIL_MIN,
		Math.min(TASK_SUMMARY_TAIL_MAX, Math.round(maxWidth * TASK_SUMMARY_TAIL_SHARE)),
	);
	const headMax = maxWidth - ellipsisWidth - tailMax;
	if (headMax <= 0) {
		return `${TASK_SUMMARY_ELLIPSIS}${tailGraphemes(segments, maxWidth - ellipsisWidth)}`;
	}
	return `${takeGraphemes(segments, headMax)}${TASK_SUMMARY_ELLIPSIS}${tailGraphemes(segments, tailMax)}`;
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

	addRun(agent: string, task: string, model?: string, thinking?: string, meta?: RunChainMeta): number {
		const id = this.nextId++;
		this.runs.push({
			id,
			agent,
			task,
			model,
			thinking,
			status: "queued",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
			...(meta?.groupId ? { groupId: meta.groupId } : {}),
			...(meta?.relationLabel ? { relationLabel: meta.relationLabel } : {}),
		});
		this.notify();
		return id;
	}

	setStatus(id: number, status: RunStatus): void {
		const run = this.find(id);
		if (!run) return;
		run.status = status;
		if (status === "running") {
			if (run.startedAt === undefined) run.startedAt = Date.now();
			// A model-fallback retry after a failed attempt restarts the clock; a
			// stale endedAt would freeze the elapsed display at the first attempt.
			if (run.endedAt !== undefined) run.endedAt = undefined;
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

	/** Set a widget note on the run (e.g. that its auto-fix chain is still running). */
	setAnnotation(id: number, text: string): void {
		const run = this.find(id);
		if (!run) return;
		run.annotation = text;
		this.notify();
	}

	/** Look up a run by id without removing it. */
	findRun(id: number): RunView | undefined {
		return this.find(id);
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
		if (run.relationLabel) parts.push(run.relationLabel);
		if (run.model) parts.push(run.model);
		if (run.thinking) parts.push(`thinking ${run.thinking}`);
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
