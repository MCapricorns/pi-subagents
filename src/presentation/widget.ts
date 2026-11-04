/** A bounded operations ledger: failures and live work. */

import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
	formatElapsed, formatTaskSummary, formatUsageCompact,
	isRunActiveStatus, monitor, statusIcon, type RunView,
} from "./monitor.ts";

const SUBAGENTS_WIDGET_ID = "pi-subagents";
const MAX_WIDGET_LINES = 10;
const SEPARATOR = " · ";

function worktreeBadge(run: RunView): string | undefined {
	if (run.isolation !== "worktree") return undefined;
	const state = run.integrationStatus;
	const suffix = state === "finalizing" ? "applying" : state === "integrated" ? "applied"
		: state === "no_changes" ? "clean" : state === "retained" ? "retained" : undefined;
	return "worktree:" + (run.worktreeId ?? "?") + (suffix ? " " + suffix : "");
}

/** Identity owns at least half the row. Drop telemetry before losing it. */
function splitLine(left: string, right: string, theme: Theme, width: number, preserveLeft = false): string {
	const budget = width - visibleWidth(right) - 2;
	if (!right || budget < Math.min(28, Math.ceil(width / 2)) || (preserveLeft && visibleWidth(left) > budget)) return truncateToWidth(left, width, "…");
	const clipped = truncateToWidth(left, budget, "…");
	return clipped + " ".repeat(width - visibleWidth(clipped) - visibleWidth(right)) + theme.fg("dim", right);
}

interface TaskRow {
	primary: string;
	detail?: string;
	/** A failure must carry its explanation when available. */
	requiredDetail?: boolean;
	priority: number;
	state: string;
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
	const state = run.status === "queued" ? "starting" : run.integrationStatus === "finalizing" ? "applying" : run.status;
	const label = run.label ?? formatTaskSummary(run.task, Math.max(1, width - 18));
	const narrowState = width < 60 && (run.status === "queued" || run.integrationStatus === "finalizing") ? " · " + state : "";
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

/** Select identities before optional details. Overflow describes only hidden work. */
function renderBoard(rows: TaskRow[], theme: Theme, width: number, overview: string): string[] {
	const totalCost = rows.reduce((cost, row) => cost + rowCost(row), 0);
	const lines = [overview];
	const capacity = MAX_WIDGET_LINES - lines.length - Number(totalCost + lines.length > MAX_WIDGET_LINES);
	const selected = new Set<TaskRow>();
	let used = 0;
	const candidates = rows.map((row, index) => ({ row, index })).sort((a, b) => a.row.priority - b.row.priority || a.index - b.index);
	for (const { row } of candidates) {
		const cost = rowCost(row);
		if (used + cost > capacity) continue;
		selected.add(row);
		used += cost;
	}
	let detailBudget = capacity - used;
	const ordered = rows.filter((row) => selected.has(row)).sort((a, b) => a.priority - b.priority);
	for (const row of ordered) {
		lines.push(row.primary);
		if (row.detail && (row.requiredDetail || detailBudget > 0)) {
			lines.push(row.detail);
			if (!row.requiredDetail) detailBudget--;
		}
	}
	const hiddenTasks = rows.length - selected.size;
	if (hiddenTasks > 0) {
		lines.push(theme.fg("dim", "… +" + hiddenTasks + " tasks"));
	}
	return lines.map((line) => truncateToWidth(line, width, "…"));
}

export function formatSubagentWidgetLines(
	runs: readonly RunView[], theme: Theme, width: number, now = Date.now(),
): string[] {
	if (width <= 0) return [];
	const visible = runs.filter((run) => isRunActiveStatus(run.status) || run.status === "failed");
	if (!visible.length) return [];
	const rows = visible.map((run) => runRow(run, theme, width, now));
	const states = new Map<string, number>();
	for (const row of rows) states.set(row.state, (states.get(row.state) ?? 0) + 1);
	const counts = ["failed", "interrupting", "running", "queued"]
		.filter((state) => states.has(state)).map((state) => states.get(state) + " " + (state === "queued" ? "starting" : state));
	const overview = theme.bold("Subagents") + theme.fg("dim", "  " + counts.join(SEPARATOR));
	return renderBoard(rows, theme, width, overview);
}

/** Tick only while a rendered elapsed value can change; queued processes have
 * no running clock. Monitor events render transitions. */
function hasTickingContent(): boolean {
	return monitor.getRuns().some((run) => isRunActiveStatus(run.status) && run.status !== "queued"
		&& (run.activeSince !== undefined || (run.startedAt !== undefined && run.endedAt === undefined)));
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
			render: (width: number) => formatSubagentWidgetLines(monitor.getRuns(), theme, width),
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
