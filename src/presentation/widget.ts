/**
 * Compact, glanceable active-run widget for interactive Pi sessions.
 *
 * Layout contract:
 * - Aligned identity columns: `icon  #id  agent` pad to the widest displayed
 *   id and agent so every label starts at the same column.
 * - A live run owns two lines. Line 1 is what it is: identity, task label,
 *   then the telemetry flow (worktree, wait state, token flow in the pi-footer
 *   vocabulary `↑in ↓out R/W cache`, cost, `provider/model`, effective
 *   `think:<level>`, seconds-precision elapsed). Line 2 is the current activity,
 *   dim and indented under the label column behind a `↳` marker.
 * - Telemetry drops leftmost-first under width pressure (badge, wait, usage,
 *   model, thinking); the elapsed survives every width.
 * - Queued rows say what they actually wait for ("queued" for a process slot,
 *   "repo lane" for shared-writer serialization, "starting" while the child
 *   process launches) instead of one catch-all "queued".
 */

import type { WorkflowRun, WorkflowNodeRun } from "../workflow/state.ts";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
	formatElapsed,
	formatDuration,
	formatTaskSummary,
	formatUsageCompact,
	isRunActiveStatus,
	monitor,
	shrinkRunLabel,
	statusIcon,
	type RunView,
} from "./monitor.ts";

const SUBAGENTS_WIDGET_ID = "pi-subagents";

/** The TUI caps string-array widgets at this many lines; a factory widget owns
 * the same bound itself, or a wide parallel dispatch floods the editor area. */
const MAX_WIDGET_LINES = 10;

const SEPARATOR = " · ";
/** Column gap between the identity block and the run's label. */
const IDENTITY_GAP = "  ";
/** Marker introducing the live-activity second line of a running row. */
const ACTIVITY_MARKER = "↳ ";
/** Columns kept for left content before right-tail parts are dropped. */
const LEFT_MIN_CONTENT = 8;
/** Minimum useful width for a live-activity fragment. */
const ACTIVITY_MIN_WIDTH = 6;

/** Shared column widths so every visible row lines up. */
interface ColumnLayout {
	/** Display width of the widest `#id` among rendered roots. */
	idWidth: number;
	/** Display width of the widest agent name among rendered runs. */
	agentWidth: number;
}

/** Join left content and telemetry inline — `left · telemetry` — so a
 * multi-line chain reads as one flowing sentence instead of leaving blank
 * padding across the width; the whole line truncates as a last resort. */
function composeLine(left: string, tail: string, theme: Theme, width: number): string {
	if (!tail) return truncateToWidth(left, width, "…");
	const line = `${left}${theme.fg("dim", SEPARATOR)}${theme.fg("dim", tail)}`;
	return visibleWidth(line) <= width ? line : truncateToWidth(line, width, "…");
}

/** Short truthful wait word for a queued row — shown in the widget telemetry
 * column and aggregated into the footer status line, so both surfaces name a
 * wait the same way. */
function waitWord(run: Pick<RunView, "waitReason">): string {
	switch (run.waitReason) {
		case "repository-lane":
			return "repo lane";
		case "starting":
			return "starting";
		default:
			return "queued";
	}
}

/** Worktree-group badge shown on the row that owns the isolated worktree: the
 * short group identity plus its integration state, so a run visibly moves
 * through applying → applied (or retained). */
function worktreeBadge(run: RunView): string {
	const id = run.worktreeId ?? "?";
	switch (run.integrationStatus) {
		case "finalizing":
			return `worktree:${id} applying`;
		case "integrated":
			return `worktree:${id} applied`;
		case "no_changes":
			return `worktree:${id} clean`;
		case "retained":
			return `worktree:${id} retained`;
		default:
			return `worktree:${id}`;
	}
}

/** Drop lower-priority tail parts (leftmost first) until the tail fits. */
function composeTail(parts: Array<string | undefined>, budget: number): string {
	const present = parts.filter((part): part is string => Boolean(part));
	while (present.length > 0 && visibleWidth(present.join(SEPARATOR)) > budget) present.shift();
	return present.join(SEPARATOR);
}

/** Fixed identity columns; labels begin at the same display column. */
function identitySegment(run: RunView, theme: Theme, layout: ColumnLayout): string {
	const icon = statusIcon(run.status, theme);
	const id = `#${run.id}`.padStart(layout.idWidth);
	const name = theme.fg("accent", theme.bold(run.agent));
	const pad = " ".repeat(Math.max(0, layout.agentWidth - visibleWidth(run.agent)));
	return `${icon} ${theme.fg("dim", id)} ${name}${pad}`;
}

/** Telemetry tail parts of a run row: badge and wait word first (dropped first
 * under pressure), then usage, model, effective thinking strength, and the
 * always-surviving elapsed time. */
function telemetryTailParts(run: RunView, now: number): Array<string | undefined> {
	// Queued rows omit model and thinking because the route is re-resolved at actual start.
	// The full provider/model ref is kept — "which provider served this run" is
	// exactly what a multi-provider session needs to see.
	const modelPart = run.status === "queued" || !run.model ? undefined : run.model;
	const thinkingPart = run.status === "queued" || !run.thinking ? undefined : `think:${run.thinking}`;
	const badge = run.isolation === "worktree" ? worktreeBadge(run) : undefined;
	const wait = run.status === "queued" ? waitWord(run) : undefined;
	// Drop order under pressure: badge, wait word, usage, model, thinking; elapsed
	// survives every width the identity leaves room for.
	// Token flow plus accrued cost drop as one unit before the model.
	return [badge, wait, formatUsageCompact(run.usage) || undefined, modelPart, thinkingPart, formatElapsed(run, now) || undefined];
}

/** Two lines for a live run. Line 1 is what the run is: identity, task label,
 * then telemetry (worktree badge, wait state, token flow, cost, provider/model,
 * effective thinking, elapsed). Line 2 is the current activity, dim and indented
 * under the label column behind a `↳` marker. The
 * label takes the full content budget on line 1; the identity and the elapsed
 * survive every width. */
function primaryLine(
	run: RunView,
	theme: Theme,
	width: number,
	now: number,
	layout: ColumnLayout,
): string[] {
	const identity = identitySegment(run, theme, layout);
	const tailBudget = Math.max(0, width - visibleWidth(identity) - LEFT_MIN_CONTENT);
	const tail = composeTail(telemetryTailParts(run, now), tailBudget);
	const label = run.label ?? formatTaskSummary(run.task, 48);
	const contentBudget = width
		- visibleWidth(identity)
		- (tail ? visibleWidth(tail) + visibleWidth(SEPARATOR) : 0)
		- visibleWidth(IDENTITY_GAP);
	// The label is already fragment-extracted (runLabel); narrowing it keeps
	// its tail so a second squeeze never trades away the recognisable
	// filename, and no second head…tail ellipsis stacks on top of it.
	const content = label && contentBudget > 0 ? shrinkRunLabel(label, contentBudget) : "";
	const left = content ? `${identity}${IDENTITY_GAP}${content}` : identity;
	const lines = [composeLine(left, tail, theme, width)];

	const activity = run.status === "running" || run.status === "interrupting"
		? run.activity?.trim()
		: undefined;
	if (activity) {
		const indent = visibleWidth(identity) + visibleWidth(IDENTITY_GAP);
		const activityBudget = width - indent - visibleWidth(ACTIVITY_MARKER);
		if (activityBudget >= ACTIVITY_MIN_WIDTH) {
			lines.push(
				`${" ".repeat(indent)}${theme.fg("dim", `${ACTIVITY_MARKER}${formatTaskSummary(activity, activityBudget)}`)}`,
			);
		}
	}
	return lines;
}

/** Render active runs as compact per-run line groups: one two-line group per
 * run. All rows share one column layout. */
export function formatActiveRunLines(
	runs: readonly RunView[],
	theme: Theme,
	width: number,
	now: number = Date.now(),
): string[] {
	const active = runs.filter((run) => isRunActiveStatus(run.status));
	const layout: ColumnLayout = {
		idWidth: Math.max(...active.map((run) => visibleWidth(`#${run.id}`)), 0),
		agentWidth: Math.max(...active.map((run) => visibleWidth(run.agent)), 0),
	};
	const lines: string[] = [];
	let shown = 0;
	for (const run of active) {
		// Reserve one line so a cut is always announced by the overflow marker.
		const remaining = MAX_WIDGET_LINES - 1 - lines.length;
		if (remaining <= 0) break;
		const group = primaryLine(run, theme, width, now, layout);
		lines.push(...group.slice(0, remaining));
		shown++;
	}
	const hidden = active.length - shown;
	if (hidden > 0) {
		lines.push(theme.fg("dim", `… +${hidden} more`));
	}
	return lines;
}

/** Workflow headers expose graph progress even before a node has a run id. */
export function formatSubagentWidgetLines(
	runs: readonly RunView[],
	workflows: readonly WorkflowRun[],
	theme: Theme,
	width: number,
	now: number = Date.now(),
): string[] {
	if (width <= 0) return [];
	const rows: string[] = [];
	const graphIds = new Set(workflows.map((graph) => graph.id));
	for (const graph of workflows) {
		const count = (state: WorkflowNodeRun["state"]) => graph.nodes.filter((node) => node.state === state).length;
		const progress = [
			count("completed") + "/" + graph.nodes.length + " completed",
			...(["running", "pending", "failed", "blocked", "stopped"] as const)
				.filter((state) => count(state) > 0)
				.map((state) => count(state) + " " + (state === "pending" ? "waiting" : state)),
		].join(SEPARATOR);
		const color = graph.state === "failed" ? "error" : graph.state === "completed" ? "success" : "accent";
		rows.push(theme.fg(color, theme.bold("workflow #" + graph.id + " " + graph.name)) + theme.fg("dim", SEPARATOR + graph.state + SEPARATOR + progress));
		for (const node of graph.nodes) {
			const live = runs.find((run) => run.id === node.runId);
			const status = node.state === "pending" ? "queued" : node.state === "completed" ? "done" : node.state === "failed" || node.state === "blocked" ? "failed" : node.state === "stopped" ? "parked" : live?.status ?? "running";
			const detail = node.state === "pending"
				? node.dependsOn.length === 0 ? "starting" : "waits for " + node.dependsOn.filter((id) => graph.nodes.find((dependency) => dependency.id === id)?.state !== "completed").join(", ")
				: node.error ? node.state + ": " + formatTaskSummary(node.error, 100, false)
				: live?.status === "queued" ? waitWord(live)
				: live?.integrationStatus === "finalizing" ? "integrating worktree"
				: live?.activity ?? node.state;
			const elapsed = node.startedAt === undefined ? "" : SEPARATOR + formatDuration((node.endedAt ?? now) - node.startedAt);
			rows.push("  " + statusIcon(status, theme) + " " + theme.fg("accent", node.id) + theme.fg("dim", " (" + node.agent + ")" + (node.runId === undefined ? "" : " #" + node.runId) + SEPARATOR + detail + elapsed));
		}
	}
	rows.push(...formatActiveRunLines(runs.filter((run) => !run.workflow || !graphIds.has(run.workflow.workflowId)), theme, width, now));
	const shown = rows.length > MAX_WIDGET_LINES ? rows.slice(0, MAX_WIDGET_LINES - 1) : rows;
	if (rows.length > MAX_WIDGET_LINES) shown.push(theme.fg("dim", "… +" + (rows.length - shown.length) + " rows · subagent_status for all"));
	return shown.map((line) => truncateToWidth(line, width, "…"));
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
