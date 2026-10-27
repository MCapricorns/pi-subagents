/** A compact task board: overview, workflow groups, then actionable run rows. */

import type { WorkflowRun, WorkflowNodeRun } from "../workflow/state.ts";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
	formatElapsed, formatDuration, formatTaskSummary, formatUsageCompact,
	isRunActiveStatus, monitor, statusIcon, type RunView,
} from "./monitor.ts";

const SUBAGENTS_WIDGET_ID = "pi-subagents";
const MAX_WIDGET_LINES = 10;
const SEPARATOR = " · ";

function waitWord(run: Pick<RunView, "waitReason">): string {
	return run.waitReason === "repository-lane" ? "repo lane" : run.waitReason === "starting" ? "starting" : "queued";
}

function worktreeBadge(run: RunView): string | undefined {
	if (run.isolation !== "worktree") return undefined;
	const state = run.integrationStatus;
	const suffix = state === "finalizing" ? "applying" : state === "integrated" ? "applied"
		: state === "no_changes" ? "clean" : state === "retained" ? "retained" : undefined;
	return "worktree:" + (run.worktreeId ?? "?") + (suffix ? " " + suffix : "");
}

/** Reserve the right edge for progress/time before truncating the task name. */
function splitLine(left: string, right: string, theme: Theme, width: number): string {
	if (!right) return truncateToWidth(left, width, "…");
	const budget = width - visibleWidth(right) - 2;
	if (budget < 1) return truncateToWidth(theme.fg("dim", right), width, "…");
	const clipped = truncateToWidth(left, budget, "…");
	return clipped + " ".repeat(width - visibleWidth(clipped) - visibleWidth(right)) + theme.fg("dim", right);
}

interface TaskRow {
	primary: string;
	detail?: string;
	/** Errors first, then active work, queue/dependency waits, then settled. */
	priority: number;
	state: string;
}
interface TaskGroup {
	header?: string;
	rows: TaskRow[];
	priority: number;
}

function metadata(run: RunView): string[] {
	return [run.model, run.thinking ? "think:" + run.thinking : undefined,
		formatUsageCompact(run.usage), worktreeBadge(run)].filter((part): part is string => Boolean(part));
}

function runRow(run: RunView, theme: Theme, width: number, now: number): TaskRow {
	const state = run.status === "queued" ? waitWord(run) : run.integrationStatus === "finalizing" ? "applying" : run.status;
	const label = run.label ?? formatTaskSummary(run.task, 48);
	const identity = statusIcon(run.status, theme) + " " + theme.fg("dim", "#" + run.id) + " " + theme.fg("accent", run.agent);
	const primary = splitLine(identity + "  " + label, [state, formatElapsed(run, now)].filter(Boolean).join(SEPARATOR), theme, width);
	const activity = run.activity ? truncateToWidth("↳ " + formatTaskSummary(run.activity, Math.max(8, width - 6)), Math.max(0, width - 4), "…") : "";
	const parts = metadata(run);
	// Keep current activity readable; reveal model, reasoning, usage and isolation
	// as space allows, rather than shrinking the task to make telemetry fit.
	const budget = width - 4 - visibleWidth(activity) - (activity ? visibleWidth(SEPARATOR) : 0);
	while (parts.length && visibleWidth(parts.join(SEPARATOR)) > budget) parts.pop();
	const detail = activity || parts.length ? "    " + [activity, ...parts].filter(Boolean).join(SEPARATOR) : undefined;
	return { primary, detail: detail ? theme.fg("dim", truncateToWidth(detail, width, "…")) : undefined,
		priority: run.status === "failed" ? 0 : run.status === "interrupting" ? 1 : run.status === "running" ? 2 : 3, state: run.status };
}

/** Budget task identities before optional detail lines, so a busy run cannot
 * hide a sibling. Error groups and error rows win when the board overflows. */
function renderBoard(groups: TaskGroup[], theme: Theme, width: number, overview?: string): string[] {
	if (width <= 0 || !groups.length) return [];
	const sorted = [...groups].sort((a, b) => a.priority - b.priority);
	const lines: string[] = overview ? [overview] : [];
	const allRows = sorted.flatMap((group) => group.rows);
	const headers = sorted.filter((group) => group.header).length;
	const needsOverflow = lines.length + headers + allRows.length > MAX_WIDGET_LINES;
	const capacity = MAX_WIDGET_LINES - lines.length - (needsOverflow ? 1 : 0);
	// Select across groups before rendering, reserving one header per visible graph.
	const selected = new Set<TaskRow>();
	const included = new Set<TaskGroup>();
	let used = 0;
	const candidates = sorted.flatMap((group) => [...group.rows].sort((a, b) => a.priority - b.priority)
		.map((row, index) => ({ group, row, index })));
	candidates.sort((a, b) => a.row.priority - b.row.priority || a.index - b.index);
	for (const { group, row } of candidates) {
		const cost = 1 + (!included.has(group) && group.header ? 1 : 0);
		if (used + cost > capacity) continue;
		included.add(group);
		selected.add(row);
		used += cost;
	}
	// Completed graphs still report their progress without listing every completed node.
	for (const group of sorted) {
		if (!group.rows.length && group.header && used < capacity) { included.add(group); used++; }
	}
	let detailBudget = capacity - used;
	for (const group of sorted) {
		if (!included.has(group)) continue;
		if (group.header) lines.push(group.header);
		for (const row of [...group.rows].sort((a, b) => a.priority - b.priority)) {
			if (!selected.has(row)) continue;
			lines.push(row.primary);
			if (row.detail && detailBudget > 0) { lines.push(row.detail); detailBudget--; }
		}
	}
	const hiddenTasks = allRows.length - selected.size;
	const hiddenGroups = sorted.filter((group) => !included.has(group)).length;
	if (hiddenTasks || hiddenGroups) lines.push(theme.fg("dim", "… +" + hiddenTasks + " tasks" + (hiddenGroups ? " · " + hiddenGroups + " groups hidden" : "")));
	return lines.slice(0, MAX_WIDGET_LINES).map((line) => truncateToWidth(line, width, "…"));
}

export function formatActiveRunLines(runs: readonly RunView[], theme: Theme, width: number, now = Date.now()): string[] {
	const rows = runs.filter((run) => isRunActiveStatus(run.status)).map((run) => runRow(run, theme, width, now));
	return rows.length ? renderBoard([{ rows, priority: 2 }], theme, width) : [];
}

function workflowGroup(graph: WorkflowRun, runs: readonly RunView[], theme: Theme, width: number, now: number): TaskGroup {
	const count = (state: WorkflowNodeRun["state"]) => graph.nodes.filter((node) => node.state === state).length;
	const completed = count("completed");
	const progress = completed + "/" + graph.nodes.length + " completed";
	const color = graph.state === "failed" ? "error" : graph.state === "completed" ? "success" : "accent";
	const name = theme.fg(color, theme.bold("Workflow #" + graph.id + " · " + graph.name));
	const parts = [progress, ...(["failed", "blocked", "pending"] as const).filter((state) => count(state))
		.map((state) => count(state) + " " + (state === "pending" ? "waiting" : state))];
	const tail = width >= 100 ? parts.join(SEPARATOR) : progress + SEPARATOR + graph.state;
	const rows = graph.nodes.filter((node) => node.state !== "completed" && node.state !== "stopped").map((node): TaskRow => {
		const live = runs.find((run) => run.id === node.runId);
		const waitingOn = node.dependsOn.filter((id) => graph.nodes.find((dependency) => dependency.id === id)?.state !== "completed");
		const state = node.state === "pending" ? "waiting" : node.state === "running" && live?.status === "queued" ? "queued" : node.state;
		const detail = node.state === "pending" ? waitingOn.length ? "waits for " + waitingOn.join(", ") : "ready"
			: node.error ? node.state + ": " + formatTaskSummary(node.error, 100, false)
			: live?.status === "queued" ? waitWord(live)
			: live?.integrationStatus === "finalizing" ? "integrating worktree"
			: live?.activity ?? node.state;
		const iconState = node.state === "pending" ? "queued" : node.state === "failed" || node.state === "blocked" ? "failed" : live?.status ?? "running";
		const identity = "  " + statusIcon(iconState, theme) + " " + theme.fg("accent", node.id) + theme.fg("dim", " · " + node.agent + (node.runId === undefined ? "" : " #" + node.runId));
		const elapsed = node.startedAt === undefined ? "" : formatDuration((node.endedAt ?? now) - node.startedAt);
		const primary = splitLine(identity + " · " + theme.fg(node.error ? "error" : "dim", detail), elapsed, theme, width);
		const meta = live ? metadata(live).join(SEPARATOR) : "";
		return { primary, detail: meta ? theme.fg("dim", "    " + meta) : undefined,
			priority: node.state === "failed" ? 0 : node.state === "blocked" ? 1 : node.state === "running" ? 2 : 3, state };
	});
	return { header: splitLine(name, tail, theme, width), rows, priority: rows.length ? Math.min(...rows.map((row) => row.priority)) : 4 };
}

export function formatSubagentWidgetLines(
	runs: readonly RunView[], workflows: readonly WorkflowRun[], theme: Theme, width: number, now = Date.now(),
): string[] {
	if (width <= 0) return [];
	const graphIds = new Set(workflows.map((graph) => graph.id));
	const standalone = runs.filter((run) => (!run.workflow || !graphIds.has(run.workflow.workflowId)) && (isRunActiveStatus(run.status) || run.status === "failed"));
	const groups = workflows.map((graph) => workflowGroup(graph, runs, theme, width, now));
	if (standalone.length) {
		const rows = standalone.map((run) => runRow(run, theme, width, now));
		groups.push({ rows, priority: Math.min(...rows.map((row) => row.priority)) });
	}
	if (!groups.length) return [];
	const states = groups.flatMap((group) => group.rows.map((row) => row.state));
	const counts = ["failed", "blocked", "interrupting", "running", "queued", "waiting"]
		.map((state) => ({ state, count: states.filter((value) => value === state).length }))
		.filter(({ count }) => count > 0).map(({ state, count }) => count + " " + state);
	if (workflows.length) counts.push(workflows.length + " workflow" + (workflows.length === 1 ? "" : "s"));
	const overview = theme.fg("accent", theme.bold("Subagents")) + theme.fg("dim", "  " + counts.join(SEPARATOR));
	return renderBoard(groups, theme, width, overview);
}

function hasActiveRun(): boolean {
	return monitor.getRuns().some((run) => isRunActiveStatus(run.status) && run.activeSince !== undefined);
}

/** Install the widget for one TUI session. Its timer exists only while at
 * least one active run is executing, and is disposed with the widget. */
export function installActiveRunsWidget(ctx: Pick<ExtensionContext, "mode" | "ui">): void {
	if (ctx.mode !== "tui") return;
	ctx.ui.setWidget(
		SUBAGENTS_WIDGET_ID,
		(tui, theme) => {
			let timer: ReturnType<typeof setInterval> | undefined;
			let disposed = false;

			const syncTimer = (): void => {
				if (disposed) return;
				if (hasActiveRun() || monitor.getWorkflows().some((graph) => graph.state === "running")) {
					if (timer) return;
					timer = setInterval(() => tui.requestRender(), 1_000);
					timer.unref?.();
					return;
				}
				if (timer) clearInterval(timer);
				timer = undefined;
			};

			const unsubscribe = monitor.subscribe(() => {
				syncTimer();
				tui.requestRender();
			});
			syncTimer();

			return {
				render: (width: number) => formatSubagentWidgetLines(monitor.getRuns(), monitor.getWorkflows(), theme, width, Date.now()),
				invalidate() {},
				dispose() {
					disposed = true;
					unsubscribe();
					if (timer) clearInterval(timer);
					timer = undefined;
				},
			};
		},
		{ placement: "aboveEditor" },
	);
}

export function clearActiveRunsWidget(ctx: Pick<ExtensionContext, "mode" | "ui">): void {
	if (ctx.mode === "tui") ctx.ui.setWidget(SUBAGENTS_WIDGET_ID, undefined);
}
