/**
 * Pure view-model builder for the /subagents-inspect overlay.
 *
 * Joins three read-only sources into one snapshot:
 *   - monitor (live widget rows: status/usage/activity),
 *   - runtime.threads (thread state + control phase), and
 *   - inspectorStore (append-only trajectory + bounded transcript + retained
 *     snapshots for finished/parked threads whose monitor rows are gone).
 *
 * The overlay component renders this snapshot directly and never mutates
 * runtime state; building it must therefore be side-effect free.
 */

import { stripVTControlCharacters } from "node:util";
import { formatUsageCompact, monitor, type RunStatus } from "./monitor.ts";
import { emptyUsage, type UsageStats } from "./rpc-run.ts";
import type { SubagentRuntime, ThreadState } from "./runtime.ts";
import { inspectorStore, type TrajectoryEvent } from "./trajectory.ts";

export interface InspectorRunItem {
	id: number;
	agent: string;
	label: string;
	status: RunStatus;
	/** Thread state text ("running", "parked", "completed", ...) or the monitor
	 * status label for threads without a control record (chain internals). */
	stateText: string;
	generation?: number;
	elapsedMs?: number;
}

export interface InspectorToolEntry {
	tool: string;
	summary?: string;
	isError?: boolean;
	running?: boolean;
	at: number;
}

export interface InspectorThreadView {
	id: number;
	agent: string;
	label: string;
	task: string;
	status: RunStatus;
	stateText: string;
	/** Control phase of the current attempt (queued/starting/running/...). */
	phase?: string;
	generation?: number;
	elapsedMs?: number;
	startedAt?: number;
	endedAt?: number;
	model?: string;
	/** Ordered candidate refs from the dispatch record (primary first). */
	modelChain: string[];
	modelFallbackFrom?: string;
	thinking?: string;
	isolation?: "shared" | "worktree";
	integrationStatus?: string;
	integrationApplied?: boolean;
	originalCwd?: string;
	isolationCwd?: string;
	integrationWorktreePath?: string;
	integrationPatchPath?: string;
	integrationError?: string;
	forkedFromRunId?: number;
	forkChildRunIds: number[];
	usage: UsageStats;
	toolCount: number;
	activity?: string;
	currentTool?: string;
	tools: InspectorToolEntry[];
	trajectory: readonly TrajectoryEvent[];
	trajectoryTotal: number;
	transcript: { text: string; textTruncated: boolean; thinking: string; thinkingTruncated: boolean };
}

export interface InspectorSnapshot {
	now: number;
	items: InspectorRunItem[];
	detail?: InspectorThreadView;
}

const TOOL_LIMIT = 6;
const TRAJECTORY_LIMIT = 10;

function monitorRunsSafe(): ReturnType<typeof monitor.getRuns> {
	try {
		return monitor.getRuns();
	} catch {
		return [];
	}
}

function threadStatusToRunStatus(state: ThreadState): RunStatus {
	switch (state) {
		case "queued":
		case "resuming":
			return "queued";
		case "running":
			return "running";
		case "steering":
			return "steering";
		case "interrupting":
			return "interrupting";
		case "parked":
			return "parked";
		case "completed":
			return "done";
		case "failed":
		case "stopped":
			return "failed";
	}
}

export function buildInspectorSnapshot(options: {
	runtime: Pick<SubagentRuntime, "threads">;
	selectedId?: number;
	now?: number;
	toolLimit?: number;
	trajectoryLimit?: number;
}): InspectorSnapshot {
	const now = options.now ?? Date.now();
	const toolLimit = options.toolLimit ?? TOOL_LIMIT;
	const trajectoryLimit = options.trajectoryLimit ?? TRAJECTORY_LIMIT;
	const monitorRuns = monitorRunsSafe();

	// Union of the three sources keyed by id.
	const ids = new Set<number>();
	for (const id of options.runtime.threads.keys()) ids.add(id);
	for (const state of inspectorStore.all()) ids.add(state.runId);
	for (const run of monitorRuns) ids.add(run.id);

	const items: InspectorRunItem[] = [];
	let detail: InspectorThreadView | undefined;

	for (const id of [...ids].sort((a, b) => a - b)) {
		const monitorRun = monitorRuns.find((r) => r.id === id);
		const thread = options.runtime.threads.get(id);
		const inspect = inspectorStore.find(id);

		const latestSettled = [...(inspect?.trajectory.getGenerationEvents() ?? [])]
			.reverse()
			.find((event): event is Extract<TrajectoryEvent, { kind: "settled" }> => event.kind === "settled");
		const trajectoryStatus = latestSettled
			? latestSettled.status === "done" ? "done" : "failed"
			: undefined;
		const agent = monitorRun?.agent ?? thread?.agentName ?? inspect?.agent ?? "?";
		const label = monitorRun?.label ?? inspect?.label ?? "";
		const task = monitorRun?.task ?? thread?.task ?? inspect?.task ?? "";
		const status: RunStatus = monitorRun?.status ?? (thread
			? threadStatusToRunStatus(thread.state)
			: trajectoryStatus ?? statusFromText(inspect?.status));
		const stateText = thread?.state ?? monitorRun?.status ?? latestSettled?.status ?? inspect?.status ?? "queued";
		const startedAt = monitorRun?.startedAt ?? inspect?.startedAt;
		const endedAt = monitorRun?.endedAt ?? inspect?.endedAt ?? inspect?.trajectory.summary().endedAt;
		const elapsedMs = startedAt === undefined ? undefined : Math.max(0, (endedAt ?? now) - startedAt);

		items.push({ id, agent, label, status, stateText, generation: thread?.generation ?? inspect?.generation, elapsedMs });

		if (options.selectedId === id) {
			detail = buildDetail({
				id,
				agent,
				label,
				task,
				status,
				stateText,
				startedAt,
				endedAt,
				elapsedMs,
				monitorRun,
				thread,
				inspect,
				toolLimit,
				trajectoryLimit,
			});
		}
	}

	return { now, items, detail };
}

function statusFromText(text: string | undefined): RunStatus {
	switch (text) {
		case "done":
		case "completed":
			return "done";
		case "failed":
		case "stopped":
			return "failed";
		case "running":
			return "running";
		case "steering":
			return "steering";
		case "interrupting":
			return "interrupting";
		case "parked":
			return "parked";
		default:
			return "queued";
	}
}

function buildDetail(input: {
	id: number;
	agent: string;
	label: string;
	task: string;
	status: RunStatus;
	stateText: string;
	startedAt?: number;
	endedAt?: number;
	elapsedMs?: number;
	monitorRun?: ReturnType<typeof monitor.getRuns>[number];
	thread?: {
		state: ThreadState;
		generation: number;
		control: { getPhase(): string };
		isolation: "shared" | "worktree";
		cwd: string;
		executionCwd: string;
		worktree?: { worktreePath: string; patchPath: string; state: string };
		forkedFromRunId?: number;
		forkChildRunIds: number[];
	};
	inspect?: ReturnType<typeof inspectorStore.find>;
	toolLimit: number;
	trajectoryLimit: number;
}): InspectorThreadView {
	const { monitorRun, thread, inspect } = input;
	const genEvents = inspect?.trajectory.getGenerationEvents() ?? [];
	const allEvents = inspect?.trajectory.getEvents() ?? [];

	// Model chain: primary first, then the recorded pool fallbacks. The actual
	// model currently running is the trajectory summary's latest, or the live
	// monitor model. modelFallbackFrom marks a pool advancement.
	const dispatchEvent = [...genEvents].reverse().find((e): e is Extract<TrajectoryEvent, { kind: "dispatch" }> => e.kind === "dispatch");
	const chain: string[] = [];
	if (dispatchEvent?.model) chain.push(dispatchEvent.model);
	for (const ref of dispatchEvent?.pool ?? []) if (ref && !chain.includes(ref)) chain.push(ref);
	const model = monitorRun?.model ?? inspect?.trajectory.summary().model ?? inspect?.model;
	const fallbackFrom = monitorRun?.modelFallbackFrom ?? inspect?.trajectory.summary().modelFallbackFrom;
	if (model && !chain.includes(model)) chain.push(model);

	// Recent tool entries from the current-generation trajectory.
	const tools: InspectorToolEntry[] = [];
	for (let i = genEvents.length - 1; i >= 0 && tools.length < input.toolLimit; i--) {
		const e = genEvents[i];
		if (e.kind === "tool_start") {
			// Correlate parallel calls by Pi's stable toolCallId. Name matching is
			// retained only for legacy events that predate id capture.
			const ended = genEvents.slice(i + 1).find((later) =>
				later.kind === "tool_end" &&
				(e.toolCallId
					? later.toolCallId === e.toolCallId
					: later.toolCallId === undefined && later.tool === e.tool),
			);
			tools.unshift({
				tool: e.tool,
				summary: e.summary || undefined,
				isError: ended && ended.kind === "tool_end" ? ended.isError : undefined,
				running: ended === undefined,
				at: e.at,
			});
		}
	}

	const trajectory = genEvents.slice(-input.trajectoryLimit);
	const usage = monitorRun?.usage ?? inspect?.runInfo?.usage ?? emptyUsage();
	const toolCount = monitorRun?.toolCount ?? inspect?.runInfo?.toolCount ?? inspect?.trajectory.summary().toolCount ?? 0;
	const trajectorySummary = inspect?.trajectory.summary();
	const lastWorktreeEvent = [...allEvents]
		.reverse()
		.find((event): event is Extract<TrajectoryEvent, { kind: "worktree" }> => event.kind === "worktree");
	const isolation = thread?.isolation ?? monitorRun?.isolation ?? trajectorySummary?.isolation;

	return {
		id: input.id,
		agent: input.agent,
		label: input.label,
		task: input.task,
		status: input.status,
		stateText: input.stateText,
		phase: thread?.control.getPhase(),
		generation: thread?.generation ?? (genEvents.length > 0 ? inspect?.generation : undefined),
		elapsedMs: input.elapsedMs,
		startedAt: input.startedAt,
		endedAt: input.endedAt,
		model: model ?? undefined,
		modelChain: chain,
		modelFallbackFrom: fallbackFrom,
		thinking: monitorRun?.thinking ?? trajectorySummary?.thinking ?? inspect?.thinking,
		isolation,
		integrationStatus: monitorRun?.integrationStatus ?? trajectorySummary?.integrationStatus ?? thread?.worktree?.state,
		integrationApplied: lastWorktreeEvent?.integrated,
		originalCwd: thread?.cwd ?? trajectorySummary?.originalCwd,
		isolationCwd: thread?.executionCwd ?? trajectorySummary?.isolationCwd,
		integrationWorktreePath: lastWorktreeEvent?.worktreePath ?? (thread?.worktree?.state === "retained" ? thread.worktree.worktreePath : undefined),
		integrationPatchPath: lastWorktreeEvent?.patchPath ?? (thread?.worktree?.state === "retained" ? thread.worktree.patchPath : undefined),
		integrationError: lastWorktreeEvent?.error,
		forkedFromRunId: thread?.forkedFromRunId ?? trajectorySummary?.forkedFromRunId,
		forkChildRunIds: [...(thread?.forkChildRunIds ?? trajectorySummary?.forkChildRunIds ?? [])],
		usage,
		toolCount,
		activity: monitorRun?.activity ?? inspect?.runInfo?.activity ?? inspect?.trajectory.summary().activity,
		currentTool: monitorRun?.currentTool ?? inspect?.runInfo?.currentTool ?? inspect?.trajectory.summary().currentTool,
		tools,
		trajectory,
		trajectoryTotal: allEvents.length,
		transcript: inspect?.transcript.snapshot() ?? { text: "", textTruncated: false, thinking: "", thinkingTruncated: false },
	};
}

/** One-line event text for the trajectory pane (plain, pre-theme). */
export function formatTrajectoryEvent(event: TrajectoryEvent): string {
	return stripVTControlCharacters(formatTrajectoryEventUnsafe(event));
}

function formatTrajectoryEventUnsafe(event: TrajectoryEvent): string {
	switch (event.kind) {
		case "dispatch":
			return `dispatch ${event.agent}${event.resumed ? " (resumed)" : ""}${event.model ? ` · ${event.model}` : ""}`;
		case "status":
			return `status: ${event.status}`;
		case "candidate":
			return event.fallbackFrom ? `model: ${event.model ?? "?"} (pool fallback from ${event.fallbackFrom})` : `model: ${event.model ?? "?"}`;
		case "retry":
			return `retry${event.reason ? `: ${event.reason}` : ""}`;
		case "steer":
			return `steer: ${compactOne(event.instruction, 60)}`;
		case "retarget":
			return `retarget: ${compactOne(event.objective, 60)}`;
		case "park":
			return "parked at checkpoint";
		case "resume":
			return event.objective ? `resume: ${compactOne(event.objective, 60)}` : "resume from retained context";
		case "fork":
			return event.runId === event.sourceRunId
				? `forked child #${event.childRunId}${event.objective ? `: ${compactOne(event.objective, 48)}` : ""}`
				: `forked from #${event.sourceRunId}${event.objective ? `: ${compactOne(event.objective, 48)}` : ""}`;
		case "stop":
			return event.reason ? `stop: ${compactOne(event.reason, 60)}` : "stopped";
		case "worktree":
			return event.status === "created"
				? `worktree created${event.isolationCwd ? ` · ${compactOne(event.isolationCwd, 48)}` : ""}`
				: event.status === "retained" && event.integrated
					? `worktree cleanup failed after apply${event.error ? `: ${compactOne(event.error, 48)}` : ""}`
					: `worktree ${event.status}${event.error ? `: ${compactOne(event.error, 48)}` : ""}`;
		case "settled":
			return `settled: ${event.status}${event.model ? ` · ${event.model}` : ""}${event.integrationStatus ? ` · worktree ${event.integrationStatus}` : ""}`;
		case "tool_start":
			return `→ ${event.tool}${event.summary ? ` ${compactOne(event.summary, 48)}` : ""}`;
		case "tool_end":
			return `${e2(event)}${event.tool}`;
		case "usage":
			return `usage: ${formatUsageCompact(event.usage) || "—"}`;
	}
}

function e2(event: Extract<TrajectoryEvent, { kind: "tool_end" }>): string {
	return event.isError ? "✗ " : "✓ ";
}

function compactOne(text: string, max: number): string {
	const oneLine = stripVTControlCharacters(text).replace(/\s+/g, " ").trim();
	const chars = [...oneLine];
	return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : oneLine;
}
