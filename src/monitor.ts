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
import { emptyUsage, type UsageStats } from "./rpc-run.ts";
import type { IsolationMode, WorktreeFinalizationStatus } from "./worktree.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RunStatus = "queued" | "running" | "interrupting" | "parked" | "done" | "failed";
export type ContinuationKind = "resume-retained" | "resume-appended";
export type WorkflowStageStatus = "done" | "active" | "pending" | "changes" | "failed";

/** Why a queued run has produced no output yet. Three genuinely different
 * situations used to be reported as one "queued": waiting for a free process
 * slot (real pool pacing), serialized behind the shared-checkout repository
 * write lane (a slot is free — the wait is write serialization), and already
 * starting its child process (a slot is held; output is seconds away).
 * Conflating them taught the parent model that the pool was exhausted when it
 * was not, so it stopped dispatching. Meaningful only while status is
 * "queued"; cleared on every transition out of it. */
export type RunWaitReason = "process-slot" | "repository-lane" | "starting";

/** Ephemeral projection of one real or currently planned managed stage. It is
 * live monitor state only; durable results remain the per-run chain records. */
export interface WorkflowStage {
	agent: string;
	relation: string;
	status: WorkflowStageStatus;
	/** Telemetry snapshot frozen when the stage settled (the live child row
	 * leaves the monitor at that moment); the active stage reads its live child. */
	model?: string;
	usage?: UsageStats;
	elapsedMs?: number;
}

export function isRunActiveStatus(status: RunStatus): boolean {
	return status === "queued" || status === "running" || status === "interrupting";
}

/** Durable integration projection of a worktree-isolated run: pending before
 * settlement, finalizing while the patch is applied/cleaned up, then the
 * terminal WorktreeFinalizationStatus. */
export type RunIntegrationStatus = "pending" | "finalizing" | WorktreeFinalizationStatus;

export interface RunView {
	id: number;
	agent: string;
	task: string;
	/** Short content label derived from the task (paths/symbols), shown next to
	 * the agent name so concurrent same-agent runs are told apart by what they
	 * are doing, not just by their run id. */
	label?: string;
	model?: string;
	/** Selected model ref when the run handed off to current main. */
	modelFallbackFrom?: string;
	/** Effective thinking strength this run was launched with (frontmatter/config/global). */
	thinking?: string;
	isolation?: IsolationMode;
	integrationStatus?: RunIntegrationStatus;
	/** Short worktree-group identity (mkdtemp suffix) shared by every run inside
	 * one isolated worktree; changes when a continuation worktree is created. */
	worktreeId?: string;
	status: RunStatus;
	/** What a queued run is actually waiting for; see RunWaitReason. */
	waitReason?: RunWaitReason;
	usage: UsageStats;
	/** Concise current activity ("thinking", "read src/index.ts"); last writer wins. */
	activity?: string;
	/** Epoch ms when this logical run first started executing. */
	startedAt?: number;
	/** Epoch ms when the current active segment started. */
	activeSince?: number;
	/** Cumulative active execution time from closed segments; parked time is excluded. */
	elapsedMs: number;
	/** Epoch ms when the latest active segment stopped. */
	endedAt?: number;
	/** Why this generation reused retained context, shown in the widget/status. */
	continuationKind?: ContinuationKind;
	/** When set, this is an internal managed-workflow step. */
	groupId?: string;
	/** Human-readable role within a workflow, e.g. "final review" or "final documentation sync". */
	relationLabel?: string;
	/** Stable owning run whose row represents the whole managed workflow. */
	parentRunId?: number;
	/** This stable top-level row currently owns a multi-stage managed workflow.
	 * Its elapsed time is workflow-wide; active child rows own stage telemetry. */
	managedWorkflow?: boolean;
	/** Live-only stage timeline retained on the parent while completed internal
	 * child rows leave the monitor. */
	workflowStages?: WorkflowStage[];
}

/** Optional metadata for documenter/reviewer/fix children of a stable parent run. */
export interface RunChainMeta {
	groupId?: string;
	relationLabel?: string;
	parentRunId?: number;
	isolation?: IsolationMode;
	worktreeId?: string;
	continuationKind?: ContinuationKind;
	/** Initial wait reason; defaults to "process-slot" (a fresh dispatch enters
	 * the process queue). Workflow-internal children pass "starting" because
	 * they spawn immediately and never wait for a slot. */
	waitReason?: RunWaitReason;
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
 * task line, so templated prose ("explorer: trace how ...") adds nothing.
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
 * distinguishing fragment so concurrent same-agent runs are told apart by WHAT
 * they do, not just their run id. A file/directory path outranks other
 * fragment kinds (a kebab-case word like "edge-case" never beats
 * "tests/config.test.ts"); a long path keeps its tail (the filename is the
 * recognisable part); a task with no recognizable fragment falls back to a
 * head slice of its prose. Grapheme-safe.
 */
export function runLabel(task: string): string {
	const fragments = extractKeyFragments(task);
	const fragment = fragments.find((candidate) => /[\\/]|\.[A-Za-z0-9]{1,5}$/.test(candidate)) ?? fragments[0];
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

/** Token flow in the pi-footer vocabulary: ↑input ↓output, R cache-read,
 * W cache-write; zero components are omitted. No cost — callers place it as
 * its own droppable part. */
export function formatUsageTokens(usage: UsageStats | undefined): string | undefined {
	if (!usage) return undefined;
	const parts: string[] = [];
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
	return parts.length > 0 ? parts.join(" ") : undefined;
}

export function formatUsageCompact(usage: UsageStats): string {
	return [formatUsageTokens(usage), usageCostPart(usage)].filter(Boolean).join(" ");
}

/** Cost as its own droppable part: `$0.0421`, undefined when nothing accrued. */
export function usageCostPart(usage: UsageStats | undefined): string | undefined {
	return usage?.cost ? `$${usage.cost.toFixed(4)}` : undefined;
}

/** Aggregate usage across several runs (chain steps or a completion group). */
export function sumUsage(parts: readonly UsageStats[]): UsageStats {
	const total: UsageStats = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
	for (const part of parts) {
		total.input += part.input;
		total.output += part.output;
		total.cacheRead += part.cacheRead;
		total.cacheWrite += part.cacheWrite;
		total.cost += part.cost;
		total.contextTokens += part.contextTokens;
		total.turns += part.turns;
	}
	return total;
}

export function formatDuration(ms: number): string {
	const totalSeconds = Math.max(0, Math.floor(ms / 1000));
	if (totalSeconds < 60) return `${totalSeconds}s`;
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	// Seconds stay visible at every magnitude: a long-running chain is judged
	// by whether it is still moving, and "5s ago" is exactly that signal.
	if (minutes < 60) return `${minutes}m${String(seconds).padStart(2, "0")}s`;
	const hours = Math.floor(minutes / 60);
	return `${hours}h${String(minutes % 60).padStart(2, "0")}m${String(seconds).padStart(2, "0")}s`;
}

/** Cumulative active time across generations; parked gaps never count. */
export function elapsedMilliseconds(run: RunView, now: number = Date.now()): number {
	let elapsed = run.elapsedMs ?? 0;
	if (run.activeSince !== undefined) elapsed += Math.max(0, now - run.activeSince);
	// Keep formatting tolerant of older/synthetic RunView values that predate
	// segmented timing and carry only startedAt/endedAt.
	if (elapsed === 0 && run.startedAt !== undefined && run.activeSince === undefined) {
		elapsed = Math.max(0, (run.endedAt ?? now) - run.startedAt);
	}
	return elapsed;
}

export function formatElapsed(run: RunView, now: number = Date.now()): string {
	if (run.startedAt === undefined && run.elapsedMs <= 0) return "";
	return formatDuration(elapsedMilliseconds(run, now));
}

export function continuationLabel(kind: ContinuationKind | undefined): string | undefined {
	switch (kind) {
		case "resume-retained": return "resume: current objective";
		case "resume-appended": return "resume: appended objective";
		default: return undefined;
	}
}

/** Max length of the argument target inside a formatted activity line. */
export const ACTIVITY_TARGET_MAX = 60;

const REDACTED = "<redacted>";

/** Remove credentials embedded in otherwise ordinary activity strings such as
 * shell commands and HTTP headers. */
function redactSensitiveText(value: string): string {
	let text = stripVTControlCharacters(value);
	text = text.replace(
		/(\bauthorization\s*:\s*(?:bearer|basic)\s+)([^\s'"`;,]+)/giu,
		`$1${REDACTED}`,
	);
	text = text.replace(
		/(\bbearer\s+)([A-Za-z0-9._~+/=-]{6,})/giu,
		`$1${REDACTED}`,
	);
	text = text.replace(
		/(\b(?:api[-_]?key|apikey|access[-_]?token|refresh[-_]?token|token|password|passwd|secret|credential|cookie)\b\s*(?:=|:)\s*)(?:"[^"]*"|'[^']*'|[^\s;&,]+)/giu,
		`$1${REDACTED}`,
	);
	text = text.replace(
		/((?:--?(?:api[-_]?key|access[-_]?token|token|password|secret|credential))\s+)(?:"[^"]*"|'[^']*'|\S+)/giu,
		`$1${REDACTED}`,
	);
	return text.replace(
		/\b(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{8,}|AKIA[A-Z0-9]{16})\b/gu,
		REDACTED,
	);
}

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
		// Pi ships one shell tool per platform flavor, all with a `command`
		// parameter: a Windows parent that swapped bash for powershell must still
		// show the command it is running, not a bare tool name.
		case "bash":
		case "powershell":
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
		// Clear finished runs from a previous turn, but keep active and parked
		// threads so concurrent work is not wiped between parent turns.
		this.runs = this.runs.filter(
			(r) => isRunActiveStatus(r.status) || r.status === "parked",
		);
		this.notify();
	}

	/** Reserve a stable id for a durable result that must remain independently
	 * addressable without appearing as a live monitor row. */
	reserveRunId(): number {
		return this.nextId++;
	}

	/** Keep newly allocated ids above a restored id so reload-restored threads
	 * never collide with runs started in the current process. */
	ensureNextIdAbove(id: number): void {
		if (id >= this.nextId) this.nextId = id + 1;
	}

	/** Re-register a durable thread restored from a previous process. The row
	 * keeps its stable id and historical elapsed time. */
	restoreRun(view: Pick<RunView, "id" | "agent" | "task" | "status"> & Partial<RunView>): void {
		if (this.find(view.id)) return;
		this.runs.push({
			label: runLabel(view.task),
			usage: emptyUsage(),
			elapsedMs: 0,
			...view,
		});
		this.ensureNextIdAbove(view.id);
		this.notify();
	}

	addRun(agent: string, task: string, model?: string, thinking?: string, meta?: RunChainMeta): number {
		const id = this.reserveRunId();
		this.runs.push({
			id,
			agent,
			task,
			label: runLabel(task),
			model,
			thinking,
			status: "queued",
			waitReason: meta?.waitReason ?? "process-slot",
			usage: emptyUsage(),
			elapsedMs: 0,
			...(meta?.groupId ? { groupId: meta.groupId } : {}),
			...(meta?.relationLabel ? { relationLabel: meta.relationLabel } : {}),
			...(meta?.parentRunId !== undefined ? { parentRunId: meta.parentRunId } : {}),
			...(meta?.isolation ? { isolation: meta.isolation, integrationStatus: meta.isolation === "worktree" ? "pending" : undefined, ...(meta.worktreeId ? { worktreeId: meta.worktreeId } : {}) } : {}),
			...(meta?.continuationKind ? { continuationKind: meta.continuationKind } : {}),
		});
		this.notify();
		return id;
	}

	setStatus(id: number, status: RunStatus): void {
		const run = this.find(id);
		if (!run) return;
		const previousStatus = run.status;
		const wasExecuting = previousStatus === "running" || previousStatus === "interrupting";
		const isExecuting = status === "running" || status === "interrupting";
		const now = Date.now();
		run.status = status;
		if (status !== "queued") run.waitReason = undefined;
		if (isExecuting && !wasExecuting) {
			run.startedAt ??= now;
			run.activeSince = now;
			run.endedAt = undefined;
		} else if (!isExecuting && wasExecuting && run.activeSince !== undefined) {
			run.elapsedMs += Math.max(0, now - run.activeSince);
			run.activeSince = undefined;
		}
		if ((status === "parked" || status === "done" || status === "failed") && run.endedAt === undefined) {
			run.endedAt = now;
		}
		this.notify();
	}
	/** Record what a still-queued run is actually waiting for, at the exact
	 * transition owned by the caller (lane wait begins, child process starts). */
	setWaitReason(id: number, waitReason: RunWaitReason): void {
		const run = this.find(id);
		if (!run || run.status !== "queued" || run.waitReason === waitReason) return;
		run.waitReason = waitReason;
		this.notify();
	}

	/** Switch a stable top-level row from one model run to workflow ownership.
	 * The original role remains for identity; child rows show stage telemetry. */
	setManagedWorkflow(id: number, active: boolean): void {
		const run = this.find(id);
		if (!run) return;
		run.managedWorkflow = active || undefined;
		if (!active) run.workflowStages = undefined;
		this.notify();
	}

	/** Replace the live workflow projection atomically so renderers never observe
	 * a half-updated fix/re-review plan. */
	setWorkflowStages(id: number, stages: readonly WorkflowStage[]): void {
		const run = this.find(id);
		if (!run) return;
		run.workflowStages = stages.length > 0
			? stages.map((stage) => ({ ...stage }))
			: undefined;
		this.notify();
	}

	setUsage(id: number, usage: UsageStats, model?: string): void {
		const run = this.find(id);
		if (!run) return;
		run.usage = { ...usage };
		if (model) run.model = model;
		this.notify();
	}

	/** Record the final actual model and selected-to-main transition. */
	setModel(id: number, model?: string, fallbackFrom?: string): void {
		const run = this.find(id);
		if (!run) return;
		if (model) run.model = model;
		run.modelFallbackFrom = fallbackFrom;
		this.notify();
	}

	/** Record the capability-clamped thinking level for the active model. */
	setThinking(id: number, thinking?: string): void {
		const run = this.find(id);
		if (!run || !thinking) return;
		run.thinking = thinking;
		this.notify();
	}

	/** Update the run's current one-line activity (what it is doing now). */
	setActivity(id: number, text: string): void {
		const run = this.find(id);
		if (!run) return;
		run.activity = sanitizeActivityText(text) || undefined;
		this.notify();
	}

	/** Record a tool starting and update the run's visible activity. */
	recordToolStart(id: number, toolName: string, activity: string): void {
		const run = this.find(id);
		if (!run) return;
		const safeToolName = sanitizeActivityText(toolName) || "tool";
		run.activity = sanitizeActivityText(activity) || safeToolName;
		this.notify();
	}

	/** Record a failed tool; successful completions keep their last activity
	 * until the next model event supplies a more useful description. */
	recordToolEnd(id: number, toolName: string, isError: boolean): void {
		const run = this.find(id);
		if (!run) return;
		if (isError) run.activity = `✗ ${sanitizeActivityText(toolName) || "tool"} failed`;
		this.notify();
	}

	setIsolation(
		id: number,
		isolation: IsolationMode,
		integrationStatus?: RunIntegrationStatus,
		worktreeId?: string,
	): void {
		const run = this.find(id);
		if (!run) return;
		run.isolation = isolation;
		run.integrationStatus = integrationStatus;
		if (worktreeId) run.worktreeId = worktreeId;
		this.notify();
	}


	/** Update the objective shown for a resumed generation. */
	setTask(id: number, task: string): void {
		const run = this.find(id);
		if (!run) return;
		run.task = task;
		run.label = runLabel(task);
		this.notify();
	}

	setContinuationKind(id: number, kind: ContinuationKind): void {
		const run = this.find(id);
		if (!run) return;
		run.continuationKind = kind;
		this.notify();
	}

	getElapsedMs(id: number, now: number = Date.now()): number | undefined {
		const run = this.find(id);
		return run ? elapsedMilliseconds(run, now) : undefined;
	}

	/** Reuse a stable logical run id for a resumed generation without discarding
	 * active time accumulated by earlier generations. */
	restartRun(
		id: number,
		agent: string,
		task: string,
		model?: string,
		thinking?: string,
		isolation?: IsolationMode,
		meta?: { elapsedMs?: number; continuationKind?: ContinuationKind; worktreeId?: string },
	): void {
		const run = this.find(id);
		if (!run) {
			this.runs.push({
				id,
				agent,
				task,
				label: runLabel(task),
				model,
				thinking,
				...(isolation
					? {
						isolation,
						integrationStatus: isolation === "worktree" ? "pending" as const : undefined,
						...(isolation === "worktree" && meta?.worktreeId ? { worktreeId: meta.worktreeId } : {}),
					}
					: {}),
				status: "queued",
				waitReason: "process-slot",
				usage: emptyUsage(),
				elapsedMs: meta?.elapsedMs ?? 0,
				continuationKind: meta?.continuationKind,
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
		if (isolation === "worktree" && meta?.worktreeId) run.worktreeId = meta.worktreeId;
		else if (isolation !== "worktree") run.worktreeId = undefined;
		run.status = "queued";
		run.waitReason = "process-slot";
		run.usage = emptyUsage();
		run.activity = undefined;
		run.managedWorkflow = undefined;
		run.workflowStages = undefined;
		run.activeSince = undefined;
		run.endedAt = undefined;
		run.elapsedMs = Math.max(run.elapsedMs, meta?.elapsedMs ?? 0);
		run.continuationKind = meta?.continuationKind;
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
		const parts = [run.managedWorkflow ? `${run.agent} workflow` : run.agent];
		const continuation = continuationLabel(run.continuationKind);
		if (continuation) parts.push(continuation);
		if (run.relationLabel) parts.push(run.relationLabel);
		if (!run.managedWorkflow && run.model) parts.push(run.model);
		if (!run.managedWorkflow && run.thinking) parts.push(`thinking ${run.thinking}`);
		if (run.isolation === "worktree") parts.push(`worktree ${run.integrationStatus ?? "active"}`);
		if (!run.managedWorkflow && usage) parts.push(usage);
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

/** User-facing status label used by tool/status rendering. Queued runs say
 * so: anything vaguer ("ready") reads like an unexplained cap and made models
 * stop dispatching while slots were merely pacing. */
export function statusLabel(status: RunStatus): string {
	switch (status) {
		case "queued":
			return "queued";
		case "running":
			return "running";
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

/** Truthful description of why a queued run has produced no output yet, so a
 * repository-lane wait or a starting child is never mistaken for an exhausted
 * process pool. Undefined for runs that are not queued. */
export function runWaitLabel(run: Pick<RunView, "status" | "waitReason">): string | undefined {
	if (run.status !== "queued") return undefined;
	switch (run.waitReason) {
		case "repository-lane":
			return "waiting for the repository write lane";
		case "starting":
			return "starting";
		default:
			return "queued for a free process slot";
	}
}
