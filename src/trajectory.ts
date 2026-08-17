/**
 * Append-only inspector backing stores for sub-agent threads.
 *
 * Two structures, both owned by a single thread record ({@link TrajectoryLog} or
 * {@link InspectRunState}):
 *
 * - {@link TrajectoryLog} — a typed, append-only event log covering
 *   orchestration (dispatch, model-candidate switches, retries, control actions
 *   steer/retarget/park/resume/stop) and live child activity (status transitions,
 *   tool starts/ends, usage). Events keep their generation and source timestamps
 *   forever: resume/restart clears the mutable summary fields but NEVER the
 *   event history, so the inspector can show the full story of a thread across
 *   generations. Fork and worktree events carry typed relationship/lifecycle
 *   payloads so retained source/child state remains inspectable.
 *
 * - {@link TranscriptBuffer} — a bounded rolling window of streamed assistant
 *   text/thinking for the CURRENT generation, dropped on restart and cleared on
 *   parent-session teardown. Render-performance aid only; it trends toward
 *   dropping old output while the trajectory log is the durable record.
 *
 * Aliveness back-compat: the widget's "thinking"/"responding" activity comes from
 * forwarded {@link SubagentLiveEvent}s, which carry no delta payload. The
 * trajectory needs the delta text itself. Rather than widening the live event
 * union (which would silently drop interpreter results from widget consumers),
 * the monitor fan-out handler extracts the delta text alongside forwarding and
 * appends it here — additive, zero churn for the widget path.
 *
 * Secret hygiene: tool arguments are summarized verbatim by key, but obvious
 * credential-bearing fields (token/password/authorization/apiKey/secret/...)
 * are redacted, and values are truncated to a compact length. Arbitrary deep
 * payloads never enter the transcript or the trajectory.
 */

import { stripVTControlCharacters } from "node:util";
import type { UsageStats } from "./rpc-run.ts";
import type { IsolationMode, WorktreeFinalizationStatus } from "./worktree.ts";

// ---------------------------------------------------------------------------
// Event types
// ---------------------------------------------------------------------------

export const TRAJECTORY_VERSION = 1;

/** Typed append-only trajectory events. */
export type TrajectoryEvent =
	| { v: number; runId: number; generation: number; at: number; kind: "dispatch"; agent: string; task: string; model?: string; thinking?: string; pool?: readonly string[]; vision?: boolean; resumed?: boolean; isolation?: IsolationMode; originalCwd?: string; isolationCwd?: string }
	| { v: number; runId: number; generation: number; at: number; kind: "status"; status: string; phase?: string }
	| { v: number; runId: number; generation: number; at: number; kind: "candidate"; model?: string; index?: number; total?: number; fallbackFrom?: string }
	| { v: number; runId: number; generation: number; at: number; kind: "retry"; reason: string; delayMs?: number }
	| { v: number; runId: number; generation: number; at: number; kind: "steer"; instruction: string }
	| { v: number; runId: number; generation: number; at: number; kind: "retarget"; objective: string }
	| { v: number; runId: number; generation: number; at: number; kind: "park" }
	| { v: number; runId: number; generation: number; at: number; kind: "resume"; objective?: string }
	| { v: number; runId: number; generation: number; at: number; kind: "fork"; sourceRunId: number; childRunId: number; objective?: string }
	| { v: number; runId: number; generation: number; at: number; kind: "stop"; reason?: string }
	| { v: number; runId: number; generation: number; at: number; kind: "worktree"; status: "created" | WorktreeFinalizationStatus; originalCwd: string; isolationCwd?: string; worktreePath?: string; patchPath?: string; integrated?: boolean; error?: string }
	| { v: number; runId: number; generation: number; at: number; kind: "settled"; status: "done" | "failed" | "stopped"; model?: string; isolation?: IsolationMode; integrationStatus?: WorktreeFinalizationStatus }
	| { v: number; runId: number; generation: number; at: number; kind: "tool_start"; tool: string; toolCallId?: string; summary: string }
	| { v: number; runId: number; generation: number; at: number; kind: "tool_end"; tool: string; toolCallId?: string; isError: boolean; error?: string }
	| { v: number; runId: number; generation: number; at: number; kind: "usage"; usage: UsageStats; model?: string };

export type TrajectoryEventKind = TrajectoryEvent["kind"];

/** Distributive Omit: per-variant event payload without the envelope fields
 * (v/runId/generation/at are stamped by TrajectoryLog.append). */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type NewTrajectoryEvent = DistributiveOmit<TrajectoryEvent, "v" | "runId" | "generation" | "at">;

// ---------------------------------------------------------------------------
// Tool-arg safety: concise summary + redaction
// ---------------------------------------------------------------------------

/** Truncation budget for one scalar argument value inside a summary. */
export const TOOL_ARG_VALUE_MAX = 48;
/** Total budget for a summarized tool-args blob. */
export const TOOL_ARG_SUMMARY_MAX = 160;

const SENSITIVE_KEY_RE = /token|password|authorization|api[-_]?key|apikey|secret|credential|cookie|bearer/i;
const REDACTED = "<redacted>";

function isSensitiveKey(key: string): boolean {
	return SENSITIVE_KEY_RE.test(key);
}

/** Redact credentials embedded inside otherwise ordinary scalar fields such as
 * `command`. Key-only filtering is insufficient for shell/header arguments. */
export function redactSensitiveText(value: string): string {
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
	text = text.replace(
		/\b(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{8,}|AKIA[A-Z0-9]{16})\b/gu,
		REDACTED,
	);
	return text;
}

function summarizeScalar(value: unknown): string | undefined {
	if (value === null || value === undefined || value === "") return undefined;
	let text: string;
	if (typeof value === "string") text = value;
	else if (typeof value === "number" || typeof value === "boolean") text = String(value);
	else return undefined; // arrays/objects are dropped from the summary
	const oneLine = value.toString() === "[object Object]" ? "" : redactSensitiveText(text).replace(/\s+/g, " ").trim();
	if (!oneLine) return undefined;
	const chars = [...oneLine];
	return chars.length > TOOL_ARG_VALUE_MAX ? `${chars.slice(0, TOOL_ARG_VALUE_MAX - 1).join("")}…` : oneLine;
}

/**
 * Concise, display-safe one-line summary of a tool-args payload. Only the first
 * few scalar fields are shown; sensitive-looking values are redacted; deep
 * structures are collapsed. Never throws. Output is width-agnostic plain text
 * (callers truncate to their display budget with truncateToWidth).
 */
export function summarizeToolArgs(args: unknown): string {
	if (args === null || args === undefined) return "";
	if (typeof args !== "object") {
		const s = summarizeScalar(args);
		return s ? truncateSummary(s) : "";
	}
	const record = args as Record<string, unknown>;
	const parts: string[] = [];
	for (const [key, value] of Object.entries(record)) {
		if (parts.length >= 5) {
			parts.push("…");
			break;
		}
		if (isSensitiveKey(key)) {
			parts.push(`${key}=${REDACTED}`);
			continue;
		}
		const scalar = summarizeScalar(value);
		if (scalar !== undefined) parts.push(`${key}=${scalar}`);
		else if (value !== undefined && value !== null) parts.push(`${key}={…}`);
	}
	return truncateSummary(parts.filter(Boolean).join(" "));
}

function truncateSummary(text: string): string {
	const chars = [...text];
	return chars.length > TOOL_ARG_SUMMARY_MAX ? `${chars.slice(0, TOOL_ARG_SUMMARY_MAX - 1).join("")}…` : text;
}

// ---------------------------------------------------------------------------
// Bounded transcript buffer (per-generation streaming output)
// ---------------------------------------------------------------------------

export interface TranscriptBudget {
	/** Max Unicode code points kept per section (not UTF-16 units/display cells). */
	maxTextChars: number;
	maxThinkingChars: number;
}

export const DEFAULT_TRANSCRIPT_BUDGET: TranscriptBudget = {
	maxTextChars: 8_000,
	maxThinkingChars: 2_000,
};

export class TranscriptBuffer {
	private text = "";
	private thinking = "";
	private textDropped = 0;
	private thinkingDropped = 0;

	constructor(private readonly budget: TranscriptBudget = DEFAULT_TRANSCRIPT_BUDGET) {}

	appendText(delta: string): void {
		if (!delta) return;
		const next = cap(
			(this.text + stripVTControlCharacters(delta)).replace(/\r\n?/g, "\n"),
			this.budget.maxTextChars,
		);
		this.text = next.value;
		this.textDropped += next.dropped;
	}

	appendThinking(delta: string): void {
		if (!delta) return;
		const next = cap(
			(this.thinking + stripVTControlCharacters(delta)).replace(/\r\n?/g, "\n"),
			this.budget.maxThinkingChars,
		);
		this.thinking = next.value;
		this.thinkingDropped += next.dropped;
	}

	/** Current-generation streams; structured so the renderer can flow-wrap. */
	snapshot(): { text: string; textTruncated: boolean; thinking: string; thinkingTruncated: boolean } {
		return {
			text: this.text,
			textTruncated: this.textDropped > 0,
			thinking: this.thinking,
			thinkingTruncated: this.thinkingDropped > 0,
		};
	}

	clear(): void {
		this.text = "";
		this.thinking = "";
		this.textDropped = 0;
		this.thinkingDropped = 0;
	}
}

function cap(value: string, max: number): { value: string; dropped: number } {
	const points = [...value];
	const limit = Math.max(0, max);
	if (points.length <= limit) return { value, dropped: 0 };
	const dropped = points.length - limit;
	return { value: points.slice(dropped).join(""), dropped };
}

// ---------------------------------------------------------------------------
// Trajectory log
// ---------------------------------------------------------------------------

export interface TrajectorySummaryRecord {
	model?: string;
	thinking?: string;
	modelFallbackFrom?: string;
	toolCount: number;
	currentTool?: string;
	activity?: string;
	lastAt?: number;
	endedAt?: number;
	isolation?: IsolationMode;
	integrationStatus?: WorktreeFinalizationStatus | "pending";
	originalCwd?: string;
	isolationCwd?: string;
	forkedFromRunId?: number;
	forkChildRunIds?: number[];
}

/**
 * Append-only event log for one thread id. `clearSummary()` retires the mutable
 * latest-state fields at the start of a new generation while the event history
 * stays. `clearAll()` (parent-session teardown only) drops everything.
 */
export class TrajectoryLog {
	private readonly events: TrajectoryEvent[] = [];
	/** Mutable latest-state summary; NOT append-only — reset per generation. */
	private summaryRecord: TrajectorySummaryRecord = { toolCount: 0 };

	constructor(
		readonly runId: number,
		private readonly notify: () => void,
	) {}

	get generation(): number {
		return this.summaryGeneration;
	}

	/** Internal counter also stored on each event; bumped by restart(). Starts
	 * at 1 to mirror the thread's generation numbering in the runtime. */
	private summaryGeneration = 1;

	append(event: NewTrajectoryEvent, now: number = Date.now()): void {
		const full = { v: TRAJECTORY_VERSION, runId: this.runId, generation: this.summaryGeneration, at: now, ...event } as TrajectoryEvent;
		this.events.push(full);
		this.applySummary(full);
		try {
			this.notify();
		} catch {
			/* observers must never break trajectory capture */
		}
	}

	/** All events in append order (oldest first). Generation ascends monotonically. */
	getEvents(): readonly TrajectoryEvent[] {
		return this.events;
	}

	/** Events of the latest generation only (oldest first). */
	getGenerationEvents(): readonly TrajectoryEvent[] {
		let start = this.events.length;
		for (let i = this.events.length - 1; i >= 0; i--) {
			if (this.events[i].generation === this.summaryGeneration) start = i;
			else break;
		}
		return this.events.slice(start);
	}

	summary(): Readonly<TrajectorySummaryRecord> {
		return this.summaryRecord;
	}

	/** Begin a new generation: same id, bumped generation, fresh mutable summary,
	 * untouched event history. Appends no event itself — dispatch appends the
	 * dispatch/resume event with the new-generation attributes. */
	restart(): number {
		this.summaryGeneration += 1;
		this.summaryRecord = { toolCount: 0 };
		return this.summaryGeneration;
	}

	private applySummary(event: TrajectoryEvent): void {
		const s = this.summaryRecord;
		s.lastAt = event.at;
		switch (event.kind) {
			case "dispatch":
				if (event.model !== undefined) s.model = event.model;
				if (event.isolation !== undefined) s.isolation = event.isolation;
				if (event.originalCwd !== undefined) s.originalCwd = event.originalCwd;
				if (event.isolationCwd !== undefined) s.isolationCwd = event.isolationCwd;
				if (event.isolation === "worktree") s.integrationStatus = "pending";
				if (event.thinking !== undefined) s.thinking = event.thinking;
				s.modelFallbackFrom = undefined;
				s.endedAt = undefined;
				s.currentTool = undefined;
				s.activity = undefined;
				break;
			case "candidate":
				if (event.model !== undefined) s.model = event.model;
				if (event.fallbackFrom !== undefined) s.modelFallbackFrom = event.fallbackFrom;
				break;
			case "tool_start":
				s.toolCount += 1;
				s.currentTool = event.tool;
				s.activity = event.summary ? `${event.tool} ${event.summary}` : event.tool;
				break;
			case "tool_end":
				if (s.currentTool === event.tool) s.currentTool = undefined;
				break;
			case "fork":
				if (event.runId === event.childRunId) s.forkedFromRunId = event.sourceRunId;
				if (event.runId === event.sourceRunId) {
					s.forkChildRunIds ??= [];
					if (!s.forkChildRunIds.includes(event.childRunId)) s.forkChildRunIds.push(event.childRunId);
				}
				break;
			case "worktree":
				s.isolation = "worktree";
				s.originalCwd = event.originalCwd;
				if (event.isolationCwd !== undefined) s.isolationCwd = event.isolationCwd;
				if (event.status !== "created") s.integrationStatus = event.status;
				break;
			case "settled":
				s.endedAt = event.at;
				s.currentTool = undefined;
				if (event.isolation !== undefined) s.isolation = event.isolation;
				if (event.integrationStatus !== undefined) s.integrationStatus = event.integrationStatus;
				break;
			case "status":
				s.activity = undefined;
				if (event.status === "parked" || event.status === "done" || event.status === "failed") s.endedAt ??= event.at;
				break;
		}
	}

	/** Parent-session teardown: wipe summary AND history. */
	clearAll(): void {
		this.events.length = 0;
		this.summaryGeneration = 1;
		this.summaryRecord = { toolCount: 0 };
	}
}

// ---------------------------------------------------------------------------
// Inspector run-state projection (trajectory + transcript + retained run info)
// ---------------------------------------------------------------------------

/**
 * Per-thread projection the inspector reads: live trajectory + bounded
 * transcript + retained snapshot for completed/failed/parked threads so the
 * detail pane survives monitor-row removal. Render code must treat this as
 * read-only.
 */
export class InspectRunState {
	readonly trajectory: TrajectoryLog;
	readonly transcript = new TranscriptBuffer();

	agent = "";
	task = "";
	label = "";
	model?: string;
	thinking?: string;
	status = "queued";
	startedAt?: number;
	endedAt?: number;

	/** Present for the monitor-row lifetime and beyond (via retained snapshot). */
	runInfo?: {
		usage?: UsageStats;
		toolCount?: number;
		activity?: string;
		currentTool?: string;
	};

	constructor(
		readonly runId: number,
		notify: () => void,
	) {
		this.trajectory = new TrajectoryLog(runId, notify);
	}

	get generation(): number {
		return this.trajectory.generation;
	}

	/** Preserve run metadata before the monitor row goes away (beginTurn sweep,
	 * finishRun removal). Only fillsAnnounce fields; the inspector's detail pane
	 * stays truthful even for finished, swept threads. */
	retainFrom(run: {
		agent: string;
		task: string;
		label?: string;
		model?: string;
		thinking?: string;
		status: string;
		startedAt?: number;
		endedAt?: number;
		usage?: UsageStats;
		toolCount?: number;
		activity?: string;
		currentTool?: string;
	}): void {
		this.agent = run.agent;
		this.task = run.task;
		this.label = run.label ?? "";
		this.model = run.model ?? this.model;
		this.thinking = run.thinking ?? this.thinking;
		this.status = run.status;
		this.startedAt = run.startedAt;
		this.endedAt = run.endedAt;
		this.runInfo = {
			usage: run.usage,
			toolCount: run.toolCount,
			activity: run.activity,
			currentTool: run.currentTool,
		};
	}
}

/**
 * Registry of inspector projections for the parent session. Survives monitor
 * row removal so completed/failed/parked threads stay inspectable.
 */
export class InspectorStore {
	private readonly states = new Map<number, InspectRunState>();
	private readonly listeners = new Set<() => void>();

	/** Get (creating on demand) the projection for a thread id. */
	get(runId: number): InspectRunState {
		let state = this.states.get(runId);
		if (!state) {
			state = new InspectRunState(runId, () => this.emit());
			this.states.set(runId, state);
		}
		return state;
	}

	find(runId: number): InspectRunState | undefined {
		return this.states.get(runId);
	}

	all(): InspectRunState[] {
		return [...this.states.values()].sort((a, b) => a.runId - b.runId);
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	private emit(): void {
		for (const listener of this.listeners) {
			try {
				listener();
			} catch {
				/* subscriber errors must not break the store */
			}
		}
	}

	/** Parent-session teardown only: drop every projection and its history. */
	clearAll(): void {
		for (const state of this.states.values()) {
			state.trajectory.clearAll();
			state.transcript.clear();
		}
		this.states.clear();
		this.emit();
	}
}

export const inspectorStore = new InspectorStore();
