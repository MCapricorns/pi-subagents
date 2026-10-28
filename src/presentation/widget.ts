/** A bounded operations ledger: failures, live work, then dependency waits. */

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

function isAcceptance(node: WorkflowNodeRun): boolean {
	return "kind" in node && node.kind === "acceptance";
}

function waitWord(run: Pick<RunView, "waitReason">): string {
	return run.waitReason === "starting" ? "starting" : "queued";
}

function worktreeBadge(run: RunView): string | undefined {
	if (run.isolation !== "worktree") return undefined;
	const state = run.integrationStatus;
	const suffix = state === "finalizing" ? "applying" : state === "integrated" ? "applied"
		: state === "no_changes" ? "clean" : state === "retained" ? "retained" : undefined;
	return "worktree:" + (run.worktreeId ?? "?") + (suffix ? " " + suffix : "");
}

/** Identity owns at least half the row. Drop telemetry before losing it. */
function splitLine(left: string, right: string, theme: Theme, width: number): string {
	const budget = width - visibleWidth(right) - 2;
	if (!right || budget < Math.min(28, Math.ceil(width / 2))) return truncateToWidth(left, width, "…");
	const clipped = truncateToWidth(left, budget, "…");
	return clipped + " ".repeat(width - visibleWidth(clipped) - visibleWidth(right)) + theme.fg("dim", right);
}

interface TaskRow {
	primary: string;
	detail?: string;
	/** A failure or an acceptance wait must carry its explanation. */
	requiredDetail?: boolean;
	priority: number;
	state: string;
}
interface TaskGroup {
	header?: string;
	rows: TaskRow[];
	acceptance?: TaskRow;
	priority: number;
}

function metadata(run: RunView): string[] {
	return [run.model, run.thinking ? "think:" + run.thinking : undefined,
		formatUsageCompact(run.usage), worktreeBadge(run)].filter((part): part is string => Boolean(part));
}

function detailLine(activity: string | undefined, run: RunView | undefined, theme: Theme, width: number): string | undefined {
	const parts = activity ? ["↳ " + formatTaskSummary(activity, Math.max(1, width - 6), false)] : [];
	for (const part of run ? metadata(run) : []) {
		if (visibleWidth([...parts, part].join(SEPARATOR)) > width - 4) break;
		parts.push(part);
	}
	return parts.length ? theme.fg("dim", "    " + parts.join(SEPARATOR)) : undefined;
}

function runRow(run: RunView, theme: Theme, width: number, now: number): TaskRow {
	const state = run.status === "queued" ? waitWord(run) : run.integrationStatus === "finalizing" ? "applying" : run.status;
	const label = run.label ?? formatTaskSummary(run.task, Math.max(1, width - 18));
	const narrowState = width < 60 && run.status === "queued" ? " · " + state : "";
	const identity = statusIcon(run.status, theme) + " " + theme.fg("dim", "#" + run.id) + " " + run.agent + narrowState + " · " + label;
	const elapsed = formatElapsed(run, now);
	const primary = splitLine(identity, width >= 60 ? [state, elapsed].filter(Boolean).join(SEPARATOR) : elapsed, theme, width);
	return {
		primary, detail: detailLine(run.activity, run, theme, width),
		requiredDetail: run.status === "failed" && Boolean(run.activity),
		priority: run.status === "failed" ? 0 : run.status === "interrupting" ? 1 : run.status === "running" ? 2 : 3,
		state: run.status,
	};
}

function rowCost(row: TaskRow): number { return 1 + Number(Boolean(row.requiredDetail && row.detail)); }

/** Select identities before optional details, including the cost of each graph's
 * heading and required acceptance status. Overflow describes only hidden work. */
function renderBoard(groups: TaskGroup[], theme: Theme, width: number, overview?: string): string[] {
	if (width <= 0 || !groups.length) return [];
	const sorted = [...groups].sort((a, b) => a.priority - b.priority);
	const totalCost = sorted.reduce((sum, group) => sum + Number(Boolean(group.header))
		+ (group.acceptance ? rowCost(group.acceptance) : 0) + group.rows.reduce((cost, row) => cost + rowCost(row), 0), 0);
	const lines = overview ? [overview] : [];
	const capacity = MAX_WIDGET_LINES - lines.length - Number(totalCost + lines.length > MAX_WIDGET_LINES);
	const selected = new Set<TaskRow>();
	const included = new Set<TaskGroup>();
	let used = 0;
	const candidates: { group: TaskGroup; row?: TaskRow; index: number; priority: number }[] = sorted.flatMap((group) => [
		...group.rows.map((row, index) => ({ group, row, index, priority: row.priority })),
		...(group.acceptance || !group.rows.length ? [{ group, index: 0, priority: group.acceptance?.priority ?? group.priority }] : []),
	]);
	candidates.sort((a, b) => a.priority - b.priority || a.index - b.index);
	for (const { group, row } of candidates) {
		const overhead = included.has(group) ? 0 : Number(Boolean(group.header)) + (group.acceptance ? rowCost(group.acceptance) : 0);
		const cost = overhead + (row ? rowCost(row) : 0);
		if (used + cost > capacity) continue;
		included.add(group);
		if (row) selected.add(row);
		used += cost;
	}
	let detailBudget = capacity - used;
	for (const group of sorted) {
		if (!included.has(group)) continue;
		if (group.header) lines.push(group.header);
		const rows = [...group.rows.filter((row) => selected.has(row)), ...(group.acceptance ? [group.acceptance] : [])]
			.sort((a, b) => a.priority - b.priority);
		for (const row of rows) {
			lines.push(row.primary);
			if (row.detail && (row.requiredDetail || detailBudget > 0)) {
				lines.push(row.detail);
				if (!row.requiredDetail) detailBudget--;
			}
		}
	}
	const hiddenTasks = sorted.reduce((sum, group) => sum + group.rows.length, 0) - selected.size;
	const hiddenGraphs = sorted.filter((group) => group.header && !included.has(group)).length;
	if (hiddenTasks || hiddenGraphs) {
		const parts = [hiddenTasks ? "+" + hiddenTasks + " tasks" : "", hiddenGraphs ? hiddenGraphs + " workflows hidden" : ""].filter(Boolean);
		lines.push(theme.fg("dim", "… " + parts.join(SEPARATOR)));
	}
	return lines.map((line) => truncateToWidth(line, width, "…"));
}

export function formatActiveRunLines(runs: readonly RunView[], theme: Theme, width: number, now = Date.now()): string[] {
	const rows = runs.filter((run) => isRunActiveStatus(run.status)).map((run) => runRow(run, theme, width, now));
	return rows.length ? renderBoard([{ rows, priority: 2 }], theme, width) : [];
}

function workflowGroup(graph: WorkflowRun, runs: ReadonlyMap<number, RunView>, theme: Theme, width: number, now: number): TaskGroup {
	const work = graph.nodes.filter((node) => !isAcceptance(node));
	const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
	const completed = work.filter((node) => node.state === "completed").length;
	const unsettled = work.filter((node) => node.state === "running" || node.state === "pending").length;
	const heading = theme.bold((width < 60 ? "#" : "Workflow #") + graph.id + " · " + formatTaskSummary(graph.name, width, false));
	const header = splitLine(heading, completed + "/" + work.length + (width < 60 ? " work done" : " work passed"), theme, width);
	const rows: TaskRow[] = [];
	let acceptance: TaskRow | undefined;
	for (const node of graph.nodes) {
		const required = isAcceptance(node);
		if (!required && (node.state === "completed" || node.state === "stopped")) continue;
		const live = node.runId === undefined ? undefined : runs.get(node.runId);
		const state = node.state === "pending" ? "waiting" : node.state === "running" && live?.status === "queued" ? "queued" : node.state;
		const iconState = node.state === "completed" ? "done" : node.state === "pending" ? "queued"
			: node.state === "failed" ? "failed" : node.state === "blocked" ? "interrupting" : live?.status ?? "running";
		const elapsed = live ? formatElapsed(live, now) : node.startedAt !== undefined && (node.state === "running" || node.endedAt !== undefined)
			? formatDuration((node.endedAt ?? now) - node.startedAt) : "";
		let row: TaskRow;
		if (required) {
			const verdict = node.state === "completed" ? "PASS" : node.state === "failed" ? "FAIL"
				: node.state === "pending" ? "pending" : live?.status === "queued" ? waitWord(live) : node.state;
			const reason = node.error ?? (node.state === "pending"
				? unsettled ? "after " + unsettled + " work " + (unsettled === 1 ? "node settles" : "nodes settle") : "ready · all work settled"
				: [node.agent + (node.runId === undefined ? "" : " #" + node.runId), live?.activity].filter(Boolean).join(SEPARATOR));
			row = {
				primary: splitLine("  " + statusIcon(iconState, theme) + " " + theme.bold("Acceptance required") + " · " + verdict, elapsed, theme, width),
				detail: theme.fg("dim", "    " + formatTaskSummary(reason, Math.max(1, width - 4), false)),
				requiredDetail: node.state === "pending" || Boolean(node.error),
				priority: node.state === "failed" ? 0 : node.state === "running" ? 2 : node.state === "pending" ? 3 : 4,
				state: verdict,
			};
			acceptance = row;
			continue;
		}
		const waitingOn = node.state === "pending" ? node.dependsOn.filter((id) => nodes.get(id)?.state !== "completed") : [];
		const reason = node.error ?? (node.state === "pending" ? waitingOn.length ? "waits for " + waitingOn.join(", ") : "ready"
			: live?.status === "queued" ? waitWord(live) : live?.integrationStatus === "finalizing" ? "integrating worktree" : live?.activity ?? node.task);
		const role = width < 60 && node.state === "pending" ? "" : " · " + node.agent + (node.runId === undefined ? "" : " #" + node.runId);
		const identity = "  " + statusIcon(iconState, theme) + " " + node.id + theme.fg("dim", role);
		// A waiting row carries its dependency inline. Failures own a separate
		// cause line so even a 40-column terminal can explain the blocker.
		const inline = node.state === "pending" ? " · " + reason : "";
		row = {
			primary: splitLine(identity + inline, [state === "queued" && live ? waitWord(live) : state, elapsed].filter(Boolean).join(SEPARATOR), theme, width),
			detail: node.state === "pending" ? undefined : detailLine(reason, live, theme, width),
			requiredDetail: node.state === "failed" || node.state === "blocked",
			priority: node.state === "failed" ? 0 : node.state === "blocked" ? 1 : node.state === "running" ? 2 : 3,
			state,
		};
		rows.push(row);
	}
	return { header, rows, acceptance, priority: Math.min(4, ...rows.map((row) => row.priority), acceptance?.priority ?? 4) };
}

export function formatSubagentWidgetLines(
	runs: readonly RunView[], workflows: readonly WorkflowRun[], theme: Theme, width: number, now = Date.now(),
): string[] {
	if (width <= 0) return [];
	const graphIds = new Set(workflows.map((graph) => graph.id));
	const visibleWorkflows = workflows.filter((graph) => graph.state !== "stopped" && graph.state !== "completed");
	const runMap = new Map(runs.map((run) => [run.id, run]));
	const standalone = runs.filter((run) => (!run.workflow || !graphIds.has(run.workflow.workflowId)) && (isRunActiveStatus(run.status) || run.status === "failed"));
	const groups = visibleWorkflows.map((graph) => workflowGroup(graph, runMap, theme, width, now));
	if (standalone.length) {
		const rows = standalone.map((run) => runRow(run, theme, width, now));
		groups.push({ rows, priority: Math.min(...rows.map((row) => row.priority)) });
	}
	if (!groups.length) return [];
	const states = new Map<string, number>();
	for (const group of groups) for (const row of group.rows) states.set(row.state, (states.get(row.state) ?? 0) + 1);
	const counts = ["failed", "blocked", "interrupting", "running", "queued", "waiting"]
		.filter((state) => states.has(state)).map((state) => states.get(state) + " " + state);
	if (visibleWorkflows.length) counts.push(visibleWorkflows.length + " workflow" + (visibleWorkflows.length === 1 ? "" : "s"));
	const overview = theme.bold("Subagents") + theme.fg("dim", "  " + counts.join(SEPARATOR));
	return renderBoard(groups, theme, width, overview);
}

/** Tick only while a rendered elapsed value can change; pending graphs and
 * queued processes have no running clock. Monitor events render transitions. */
function hasTickingContent(): boolean {
	const graphs = monitor.getWorkflows();
	const hiddenGraphs = new Set(graphs.filter((graph) => graph.state === "completed" || graph.state === "stopped").map((graph) => graph.id));
	const runs = monitor.getRuns().filter((run) => !run.workflow || !hiddenGraphs.has(run.workflow.workflowId));
	if (runs.some((run) => isRunActiveStatus(run.status) && run.status !== "queued"
		&& (run.activeSince !== undefined || (run.startedAt !== undefined && run.endedAt === undefined)))) return true;
	const byId = new Map(runs.map((run) => [run.id, run]));
	return graphs.some((graph) => graph.state === "running" && graph.nodes.some((node) =>
		node.state === "running" && node.startedAt !== undefined && node.endedAt === undefined
		&& (node.runId === undefined || !byId.has(node.runId))));
}

export function installActiveRunsWidget(ctx: Pick<ExtensionContext, "mode" | "ui">): void {
	if (ctx.mode !== "tui") return;
	ctx.ui.setWidget(SUBAGENTS_WIDGET_ID, (tui, theme) => {
		let timer: ReturnType<typeof setInterval> | undefined;
		let disposed = false;
		const syncTimer = (): void => {
			if (disposed) return;
			if (hasTickingContent()) {
				if (timer) return;
				timer = setInterval(() => tui.requestRender(), 1_000);
				timer.unref?.();
			} else {
				if (timer) clearInterval(timer);
				timer = undefined;
			}
		};
		const unsubscribe = monitor.subscribe(() => { syncTimer(); tui.requestRender(); });
		syncTimer();
		return {
			render: (width: number) => formatSubagentWidgetLines(monitor.getRuns(), monitor.getWorkflows(), theme, width),
			invalidate() {},
			dispose() {
				disposed = true;
				unsubscribe();
				if (timer) clearInterval(timer);
				timer = undefined;
			},
		};
	}, { placement: "aboveEditor" });
}

export function clearActiveRunsWidget(ctx: Pick<ExtensionContext, "mode" | "ui">): void {
	if (ctx.mode === "tui") ctx.ui.setWidget(SUBAGENTS_WIDGET_ID, undefined);
}
