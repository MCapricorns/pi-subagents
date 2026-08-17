/**
 * Sub-agent monitor: a module-level singleton store that tracks subagent runs
 * for the current turn.
 *
 * The store notifies wait/status consumers on every mutation. Each run carries
 * timing information plus a concise activity string ("thinking",
 * "read src/index.ts", ...). Runs are removed after publication; tool results
 * and the finished-run registry are the durable user-facing records.
 */

import { stripVTControlCharacters } from "node:util";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { UsageStats } from "./spawn.ts";
import { redactSensitiveText } from "./trajectory.ts";
import type { IsolationMode, WorktreeFinalizationStatus } from "./worktree.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RunStatus = "queued" | "running" | "steering" | "interrupting" | "parked" | "done" | "failed";

export function isRunActiveStatus(status: RunStatus): boolean {
	return status === "queued" || status === "running" || status === "steering" || status === "interrupting";
}

export interface RunView {
	id: number;
	agent: string;
	task: string;
	/** Short content label derived from the task (paths/symbols), shown next to
	 * the agent name so concurrent same-agent runs are told apart by what they
	 * are doing, not just their run id. */
	label?: string;
	model?: string;
	/** Primary model ref when the run advanced to another candidate in its pool. */
	modelFallbackFrom?: string;
	/** Effective thinking strength this run was launched with (frontmatter/config/global). */
	thinking?: string;
	isolation?: IsolationMode;
	integrationStatus?: "pending" | WorktreeFinalizationStatus;
	forkedFromRunId?: number;
	forkChildRunIds?: number[];
	status: RunStatus;
	usage: UsageStats;
	/** Concise current activity ("thinking", "read src/index.ts"); last writer wins. */
	activity?: string;
	/** Total tool calls started by the run so far (a progress signal). */
	toolCount?: number;
	/** Tool currently executing (set on tool_start, cleared on tool_end). When set,
	 * the run is NOT idle for needs-attention purposes. */
	currentTool?: string;
	/** Epoch ms of the last live activity (tool, usage, status). Used to derive
	 * the needs-attention state: no tool running AND now - lastActivityAt > threshold. */
	lastActivityAt?: number;
	/** Epoch ms when the run started executing (set on first "running" status). */
	startedAt?: number;
	/** Epoch ms when the run finished (set on "done"/"failed"). */
	endedAt?: number;
	/** When set, this run belongs to an auto-fix chain (e.g. worker fixing a reviewer's findings). */
	groupId?: string;
	/** Human-readable role within a chain, e.g. "fix round 1" or "re-review round 1". */
	relationLabel?: string;
	/** Free-form orchestration note (e.g. "auto-fix chain running"). */
	annotation?: string;
	/** One-line outcome summary of a finished chain run: a reviewer reports its verdict
	 * plus key fragments of what it found ("fail · src/index.ts · render()"), a
	 * worker the fragments of what it changed. Unset for non-chain runs. */
	summary?: string;
	/** True when a finished run remains in monitor state (e.g. an auto-fix
	 * parent whose chain is still running). beginTurn preserves
	 * retained runs so they are not swept between turns. */
	retained?: boolean;
}

/** Optional chain metadata for runs spawned by an auto-fix loop. */
export interface RunChainMeta {
	groupId?: string;
	relationLabel?: string;
	isolation?: IsolationMode;
	forkedFromRunId?: number;
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

const TASK_SUMMARY_MAX = 80;
const TASK_SUMMARY_ELLIPSIS = "…";
/** Columns reserved at the END of a truncated summary so the distinguishing
 * keywords (paths, symbols, ...) survive; the head gets the rest. */
const TASK_SUMMARY_TAIL_MAX = 28;
/** Tail share of a non-default maxWidth (narrow summaries keep a usable tail). */
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

/** Max display width of a run's content label. */
export const RUN_LABEL_MAX = 32;

/**
 * Short content label for a run, derived from its task: the single most
 * distinguishing fragment (path, quoted phrase, symbol) so concurrent same-agent
 * runs are told apart by WHAT they do, not just their run id. A long path keeps
 * its tail (the filename is the recognisable part); a task with no recognizable
 * fragment falls back to a head slice of its prose. Grapheme-safe.
 */
export function runLabel(task: string): string {
	const fragment = extractKeyFragments(task)[0];
	const src = fragment ?? stripVTControlCharacters(task).replace(/\s+/g, " ").trim();
	if (visibleWidth(src) <= RUN_LABEL_MAX) return src;
	const chars = [...graphemeSegmenter.segment(src)].map((s) => s.segment);
	// A path/symbol fragment keeps its tail (filename/symbol is recognisable);
	// a prose fallback keeps its head.
	return fragment
		? `${TASK_SUMMARY_ELLIPSIS}${tailGraphemes(chars, RUN_LABEL_MAX - 1)}`
		: `${takeGraphemes(chars, RUN_LABEL_MAX - 1)}${TASK_SUMMARY_ELLIPSIS}`;
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
	if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
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
	// A retained row (e.g. an auto-fix chain parent whose chain is still running)
	// must keep ticking: its `endedAt` was stamped when the review itself
	// finished, but the work is ongoing, so show live elapsed until the chain
	// resolves and the row is removed. Without this, subagent_status would show a
	// frozen elapsed for a run the UI otherwise presents as still active.
	const end = run.retained ? now : (run.endedAt ?? now);
	return formatDuration(end - run.startedAt);
}

/** Max length of the argument target inside a formatted activity line. */
export const ACTIVITY_TARGET_MAX = 60;

/** Monitor activity is returned to the parent model and rendered in the terminal,
 * so treat every live string as untrusted before it reaches store state. */
function sanitizeActivityText(value: string): string {
	return redactSensitiveText(value).replace(/\s+/g, " ").trim();
}

function shortTarget(value: unknown): string {
	if (typeof value !== "string") return "";
	const oneLine = sanitizeActivityText(value);
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
	const safeToolName = sanitizeActivityText(toolName) || "tool";
	return target ? `${safeToolName} ${target}` : safeToolName;
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
		// Retained runs (e.g. an auto-fix chain parent whose chain is still
		// running) are also preserved — their status is "done" but they must
		// stay visible until the chain resolves.
		this.runs = this.runs.filter(
			(r) => isRunActiveStatus(r.status) || r.status === "parked" || r.retained,
		);
		this.notify();
	}

	addRun(agent: string, task: string, model?: string, thinking?: string, meta?: RunChainMeta): number {
		const id = this.nextId++;
		this.runs.push({
			id,
			agent,
			task,
			label: runLabel(task),
			model,
			thinking,
			status: "queued",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
			...(meta?.groupId ? { groupId: meta.groupId } : {}),
			...(meta?.relationLabel ? { relationLabel: meta.relationLabel } : {}),
			...(meta?.isolation ? { isolation: meta.isolation, integrationStatus: meta.isolation === "worktree" ? "pending" : undefined } : {}),
			...(meta?.forkedFromRunId !== undefined ? { forkedFromRunId: meta.forkedFromRunId } : {}),
		});
		this.notify();
		return id;
	}

	setStatus(id: number, status: RunStatus): void {
		const run = this.find(id);
		if (!run) return;
		run.status = status;
		if (status === "running" || status === "steering" || status === "interrupting") {
			if (run.startedAt === undefined) run.startedAt = Date.now();
			// A model-fallback retry or resumed generation restarts the clock; a
			// stale endedAt would freeze the elapsed display at the first attempt.
			if (run.endedAt !== undefined) run.endedAt = undefined;
			run.lastActivityAt = Date.now();
		} else if ((status === "parked" || status === "done" || status === "failed") && run.endedAt === undefined) {
			run.endedAt = Date.now();
		}
		this.notify();
	}
	setUsage(id: number, usage: UsageStats, model?: string): void {
		const run = this.find(id);
		if (!run) return;
		run.usage = { ...usage };
		if (model) run.model = model;
		run.lastActivityAt = Date.now();
		this.notify();
	}

	/** Record the final actual model and primary-to-backup transition. */
	setModel(id: number, model?: string, fallbackFrom?: string): void {
		const run = this.find(id);
		if (!run) return;
		if (model) run.model = model;
		run.modelFallbackFrom = fallbackFrom;
		this.notify();
	}

	/** Update the run's current one-line activity (what it is doing now). */
	setActivity(id: number, text: string): void {
		const run = this.find(id);
		if (!run) return;
		run.activity = sanitizeActivityText(text) || undefined;
		run.lastActivityAt = Date.now();
		this.notify();
	}

	/** Record a tool starting: counts it, marks it current, and updates activity.
	 * A running tool means the run is NOT idle, so needs-attention is suppressed
	 * while it stays current. */
	recordToolStart(id: number, toolName: string, activity: string): void {
		const run = this.find(id);
		if (!run) return;
		const safeToolName = sanitizeActivityText(toolName) || "tool";
		run.toolCount = (run.toolCount ?? 0) + 1;
		run.currentTool = safeToolName;
		run.activity = sanitizeActivityText(activity) || safeToolName;
		run.lastActivityAt = Date.now();
		this.notify();
	}

	/** Record a tool ending: clears the current-tool marker (so the run becomes
	 * eligible for needs-attention again) and notes the failure in activity. */
	recordToolEnd(id: number, toolName: string, isError: boolean): void {
		const run = this.find(id);
		if (!run) return;
		run.currentTool = undefined;
		run.lastActivityAt = Date.now();
		if (isError) run.activity = `✗ ${sanitizeActivityText(toolName) || "tool"} failed`;
		this.notify();
	}

	/** Set an orchestration note on the run (e.g. auto-fix chain running). */
	setAnnotation(id: number, text: string): void {
		const run = this.find(id);
		if (!run) return;
		run.annotation = text;
		this.notify();
	}

	/** Set the run's one-line outcome summary (what a finished chain round did). */
	setSummary(id: number, text: string | undefined): void {
		const run = this.find(id);
		if (!run) return;
		run.summary = text;
		this.notify();
	}

	/** Keep a finished chain step in status state until its group settles. */
	setRetained(id: number, retained: boolean): void {
		const run = this.find(id);
		if (!run) return;
		run.retained = retained;
		this.notify();
	}

	setIsolation(id: number, isolation: IsolationMode, integrationStatus?: "pending" | WorktreeFinalizationStatus): void {
		const run = this.find(id);
		if (!run) return;
		run.isolation = isolation;
		run.integrationStatus = integrationStatus;
		this.notify();
	}

	setForkRelation(sourceRunId: number, childRunId: number): void {
		const source = this.find(sourceRunId);
		if (source) {
			source.forkChildRunIds ??= [];
			if (!source.forkChildRunIds.includes(childRunId)) source.forkChildRunIds.push(childRunId);
		}
		const child = this.find(childRunId);
		if (child) child.forkedFromRunId = sourceRunId;
		this.notify();
	}

	/** Update the objective shown for a queued retarget or resumed generation. */
	setTask(id: number, task: string): void {
		const run = this.find(id);
		if (!run) return;
		run.task = task;
		run.label = runLabel(task);
		this.notify();
	}

	/** Reuse a stable logical run id for a resumed generation. */
	restartRun(id: number, agent: string, task: string, model?: string, thinking?: string, isolation?: IsolationMode): void {
		const run = this.find(id);
		if (!run) {
			this.runs.push({
				id,
				agent,
				task,
				label: runLabel(task),
				model,
				thinking,
				...(isolation ? { isolation, integrationStatus: isolation === "worktree" ? "pending" as const : undefined } : {}),
				status: "queued",
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
			});
			this.notify();
			return;
		}
		run.agent = agent;
		run.task = task;
		run.label = runLabel(task);
		run.model = model;
		run.thinking = thinking;
		if (isolation) run.isolation = isolation;
		run.integrationStatus = isolation === "worktree" ? "pending" : undefined;
		run.status = "queued";
		run.usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
		run.activity = undefined;
		run.toolCount = undefined;
		run.currentTool = undefined;
		run.lastActivityAt = undefined;
		run.startedAt = undefined;
		run.endedAt = undefined;
		run.annotation = undefined;
		run.summary = undefined;
		run.retained = undefined;
		this.notify();
	}

	/** Look up a run by id without removing it. */
	findRun(id: number): RunView | undefined {
		return this.find(id);
	}

	/** Remove all runs (used on session shutdown so stale state never leaks
	 * into the next session). Does not reset the id counter so in-flight
	 * finishRun calls from the old session remain safe no-ops. */
	clear(): void {
		this.runs = [];
		this.notify();
	}

	/** Remove a run after publication. Returns the removed run. */
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
		if (run.summary) parts.push(run.summary);
		if (run.model) parts.push(run.model);
		if (run.thinking) parts.push(`thinking ${run.thinking}`);
		if (run.isolation === "worktree") parts.push(`worktree ${run.integrationStatus ?? "active"}`);
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
		case "steering":
			return theme.fg("accent", "◆");
		case "interrupting":
			return theme.fg("warning", "◐");
		case "parked":
			return theme.fg("dim", "■");
		case "done":
			return theme.fg("success", "✓");
		case "failed":
			return theme.fg("error", "✗");
		default:
			return theme.fg("dim", "○");
	}
}

/** User-facing status label used by tool/status rendering. */
export function statusLabel(status: RunStatus): string {
	switch (status) {
		case "queued":
			return "ready";
		case "running":
			return "running";
		case "steering":
			return "steering";
		case "interrupting":
			return "interrupting";
		case "parked":
			return "parked";
		case "done":
			return "done";
		case "failed":
			return "stopped";
	}
}

/** Theme color matching the status label. */
export function statusColor(status: RunStatus): "accent" | "success" | "error" | "warning" | "dim" {
	switch (status) {
		case "running":
		case "steering":
			return "accent";
		case "interrupting":
			return "warning";
		case "done":
			return "success";
		case "failed":
			return "error";
		default:
			return "dim";
	}
}
