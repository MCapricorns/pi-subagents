/**
 * Compact, glanceable active-run widget for interactive Pi sessions.
 *
 * Layout contract:
 * - Aligned identity columns: `icon  #id  agent` pad to the widest displayed
 *   id and agent so every label starts at the same column; a resumed thread
 *   carries a dim `↻` inside the agent column.
 * - A live run owns two lines. Line 1 is what it is: identity, task label,
 *   then the telemetry flow (`provider/model`, token flow in the pi-footer
 *   vocabulary `↑in ↓out R/W cache`, cost, wait state, seconds-precision
 *   elapsed). Line 2 is what it is doing right now: the live activity, dim,
 *   indented under the label column behind a `↳` marker.
 * - Telemetry drops leftmost-first under width pressure (badge, wait, usage,
 *   model); the elapsed survives every width.
 * - Queued rows say what they actually wait for ("queued" for a process slot,
 *   "repo lane" for shared-writer serialization, "starting" while the child
 *   process launches) instead of one catch-all "queued".
 */

import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
	formatElapsed,
	formatTaskSummary,
	formatUsageTokens,
	isRunActiveStatus,
	monitor,
	shrinkRunLabel,
	statusIcon,
	type RunView,
} from "./monitor.ts";
import type { UsageStats } from "./rpc-run.ts";

export const SUBAGENTS_WIDGET_ID = "pi-subagents";

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
	/** Display width of the widest agent name (plus resume marker) among them. */
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
export function waitWord(run: Pick<RunView, "waitReason">): string {
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
 * through applying → applied (or retained) and a continuation worktree (new
 * identity) is distinguishable from the original one. */
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

/** Marker text that shares the agent column so alignment survives resumes. */
function agentColumnText(run: RunView): string {
	return run.continuationKind ? `${run.agent} ↻` : run.agent;
}

/** `icon  #id  agent` in fixed columns — never truncated. The id is
 * right-aligned and the agent column is padded so every label starts at the
 * same x; a resumed thread carries a dim `↻` inside the agent column. */
function identitySegment(run: RunView, theme: Theme, layout: ColumnLayout): string {
	const icon = statusIcon(run.status, theme);
	const id = `#${run.id}`.padStart(layout.idWidth);
	const name = theme.fg("accent", theme.bold(run.agent));
	const resumed = run.continuationKind ? ` ${theme.fg("dim", "↻")}` : "";
	const pad = " ".repeat(Math.max(0, layout.agentWidth - visibleWidth(agentColumnText(run))));
	return `${icon} ${theme.fg("dim", id)} ${name}${resumed}${pad}`;
}

/** One footer-style usage part: token flow plus accrued cost, dropped as a
 * unit before the model under width pressure. */
function usagePart(usage: UsageStats | undefined): string | undefined {
	return [formatUsageTokens(usage), usage?.cost ? `$${usage.cost.toFixed(4)}` : undefined].filter(Boolean).join(" ") || undefined;
}

/** Telemetry tail parts of a run row: badge and wait word first (dropped first
 * under pressure), then the usage part, the model, and the always-surviving
 * elapsed. */
function telemetryTailParts(run: RunView, now: number): Array<string | undefined> {
	// Queued rows omit the model (the route is re-resolved at actual start).
	// The full provider/model ref is kept — "which provider served this run" is
	// exactly what a multi-provider session needs to see.
	const modelPart = run.status === "queued" || !run.model ? undefined : run.model;
	const badge = run.isolation === "worktree" ? worktreeBadge(run) : undefined;
	const wait = run.status === "queued" ? waitWord(run) : undefined;
	// Drop order under pressure: badge, wait word, usage, model; elapsed
	// survives every width the identity leaves room for.
	return [badge, wait, usagePart(run.usage), modelPart, formatElapsed(run, now) || undefined];
}

/** Two lines for a live run. Line 1 is what the run is: identity, task label,
 * then the telemetry flow (worktree badge, token flow, cost, provider/model,
 * wait state, elapsed). Line 2 is what it is doing right now: the live
 * activity, dim, indented under the label column behind a `↳` marker. The
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
		agentWidth: Math.max(...active.map((run) => visibleWidth(agentColumnText(run))), 0),
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
				if (hasActiveRun()) {
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
				render: (width: number) => formatActiveRunLines(monitor.getRuns(), theme, width, Date.now()),
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
