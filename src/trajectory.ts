/**
 * Append-only lifecycle trajectories for logical sub-agent threads.
 *
 * Events cover dispatch, model candidates, retries, controls, tool activity,
 * usage, worktrees, forks, and settlement. Each event keeps its generation and
 * timestamp across resume/restart; mutable summary fields reset per generation.
 * Tool arguments are reduced to a short terminal-safe summary with obvious
 * credential fields and embedded secrets redacted.
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

export class ThreadTrajectoryState {
	readonly trajectory: TrajectoryLog;

	constructor(readonly runId: number) {
		this.trajectory = new TrajectoryLog(runId, () => {});
	}

	get generation(): number {
		return this.trajectory.generation;
	}
}

/** Session-scoped registry of logical-thread trajectories. */
export class TrajectoryStore {
	private readonly states = new Map<number, ThreadTrajectoryState>();

	get(runId: number): ThreadTrajectoryState {
		let state = this.states.get(runId);
		if (!state) {
			state = new ThreadTrajectoryState(runId);
			this.states.set(runId, state);
		}
		return state;
	}

	clearAll(): void {
		for (const state of this.states.values()) state.trajectory.clearAll();
		this.states.clear();
	}
}

export const trajectoryStore = new TrajectoryStore();
