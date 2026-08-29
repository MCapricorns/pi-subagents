/**
 * Compact, glanceable active-run widget for interactive Pi sessions.
 *
 * Layout contract (redesign):
 * - One line per simple run: `icon #id agent · label — live activity` with a
 *   right-aligned `worktree · model/thinking · elapsed` telemetry column, so
 *   every line scans the same way and times line up at the right edge.
 * - Two lines per managed workflow: the stable parent line plus its stage
 *   timeline; the live stage's activity/model/elapsed rides right-aligned on
 *   the timeline line. Internal child rows are not repeated as extra lines.
 * - Queued rows say what they actually wait for ("queued" for a process slot,
 *   "waiting on repo lane" for shared-writer serialization, "starting" while
 *   the child process launches) instead of one catch-all "queued".
 */

import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
	formatElapsed,
	formatTaskSummary,
	isRunActiveStatus,
	monitor,
	statusIcon,
	type RunView,
	type WorkflowStage,
} from "./monitor.ts";

export const SUBAGENTS_WIDGET_ID = "pi-subagents";

/** The TUI caps string-array widgets at this many lines; a factory widget owns
 * the same bound itself, or a wide parallel dispatch floods the editor area. */
const MAX_WIDGET_LINES = 10;

const SEPARATOR = " · ";
/** Splits "what this run is" from "what it is doing right now". */
const ACTIVITY_SEPARATOR = " — ";
/** Columns kept for left content before right-tail parts are dropped. */
const LEFT_MIN_CONTENT = 8;
/** Minimum useful width for a live-activity fragment. */
const ACTIVITY_MIN_WIDTH = 6;

/** Compose one widget line with a right-aligned telemetry column: the left
 * side truncates first, the right side stays put so elapsed times and badges
 * line up across rows. */
function layoutLine(left: string, right: string, width: number): string {
	if (width <= 0) return "";
	if (!right) return truncateToWidth(left, width, "…");
	const rightWidth = visibleWidth(right);
	if (rightWidth >= width) return truncateToWidth(right, width, "");
	const leftBudget = width - rightWidth - 1;
	const leftText = visibleWidth(left) > leftBudget ? truncateToWidth(left, leftBudget, "…") : left;
	return `${leftText}${" ".repeat(Math.max(1, width - visibleWidth(leftText) - rightWidth))}${right}`;
}

/** Short truthful wait word for a queued row. */
function waitWord(run: Pick<RunView, "waitReason">): string {
	switch (run.waitReason) {
		case "repository-lane":
			return "waiting on repo lane";
		case "starting":
			return "starting";
		default:
			return "queued";
	}
}

/** Worktree-group badge shown on the row that owns the isolated worktree: the
 * short group identity plus its integration state, so a workflow visibly moves
 * through applying → applied (or retained) and a continuation worktree (new
 * identity) is distinguishable from the original one. */
function worktreeBadge(run: RunView): string {
	const id = run.worktreeId ?? "?";
	switch (run.integrationStatus) {
		case "finalizing":
			return `wt:${id} applying`;
		case "integrated":
			return `wt:${id} applied`;
		case "no_changes":
			return `wt:${id} clean`;
		case "retained":
			return `wt:${id} retained`;
		default:
			return `wt:${id}`;
	}
}

/** Drop lower-priority tail parts (leftmost first) until the tail fits. */
function composeTail(parts: Array<string | undefined>, budget: number): string {
	const present = parts.filter((part): part is string => Boolean(part));
	while (present.length > 0 && visibleWidth(present.join(SEPARATOR)) > budget) present.shift();
	return present.join(SEPARATOR);
}

/** `icon #id agent` plus dim resume/wait markers — never truncated. */
function identitySegment(run: RunView, theme: Theme): string {
	const icon = run.managedWorkflow && run.status === "running"
		? theme.fg("accent", theme.bold("◆"))
		: statusIcon(run.status, theme);
	const name = theme.fg("accent", theme.bold(run.agent));
	const resumed = run.continuationKind ? ` ${theme.fg("dim", "↻ resumed")}` : "";
	const wait = run.status === "queued" ? ` ${theme.fg("dim", `· ${waitWord(run)}`)}` : "";
	return `${icon} #${run.id} ${name}${resumed}${wait}`;
}

/** One primary line per run. Left: identity · label — activity. Right: badge,
 * model/thinking, elapsed. The activity (live signal) outranks the label when
 * space runs out; the identity and elapsed survive every width. */
function primaryLine(run: RunView, theme: Theme, width: number, now: number): string {
	const dim = (text: string): string => theme.fg("dim", text);
	const identity = identitySegment(run, theme);
	const elapsed = formatElapsed(run, now);
	const modelId = run.model?.split("/").at(-1);
	// Queued rows omit the model (the route is re-resolved at actual start);
	// workflow parents omit it too (each stage owns its own model).
	const modelPart = run.status === "queued" || run.managedWorkflow || !modelId
		? undefined
		: `${modelId}${run.thinking ? `/${run.thinking}` : ""}`;
	const badge = run.isolation === "worktree" ? worktreeBadge(run) : undefined;
	const tailBudget = Math.max(0, width - visibleWidth(identity) - LEFT_MIN_CONTENT);
	const tail = composeTail([badge, modelPart, elapsed || undefined], tailBudget);

	// A chain child rendered at root level (its parent row is gone) keeps its
	// workflow relation; the templated brief itself would only repeat content.
	const label = run.parentRunId !== undefined
		? [run.relationLabel, run.label].filter((part): part is string => Boolean(part)).join(SEPARATOR)
		: run.label ?? formatTaskSummary(run.task, 48);
	// The parent's own activity is a placeholder while a managed workflow runs;
	// the timeline line below carries the live stage instead.
	const activity = !run.managedWorkflow && (run.status === "running" || run.status === "interrupting")
		? run.activity?.trim()
		: undefined;

	const contentBudget = width
		- visibleWidth(identity)
		- (tail ? visibleWidth(tail) + 1 : 0)
		- visibleWidth(SEPARATOR);
	let content = "";
	if (contentBudget > 0) {
		const labelBudget = activity
			? Math.min(visibleWidth(label), Math.max(12, Math.floor(contentBudget * 0.4)))
			: contentBudget;
		// The label is already fragment-extracted (runLabel); plain right
		// truncation avoids stacking a second head…tail ellipsis on top of it.
		const labelText = label
			? visibleWidth(label) > labelBudget ? truncateToWidth(label, labelBudget, "…") : label
			: "";
		if (activity) {
			const activityBudget = contentBudget
				- visibleWidth(labelText)
				- (labelText ? visibleWidth(ACTIVITY_SEPARATOR) : 0);
			content = activityBudget >= ACTIVITY_MIN_WIDTH
				? `${labelText ? `${labelText}${ACTIVITY_SEPARATOR}` : ""}${formatTaskSummary(activity, activityBudget)}`
				// Too narrow for both: the live activity is the stronger signal.
				: formatTaskSummary(activity, contentBudget);
		} else {
			content = labelText;
		}
	}

	const left = content ? `${identity}${SEPARATOR}${dim(content)}` : identity;
	return layoutLine(left, tail ? dim(tail) : "", width);
}

function workflowStageToken(stage: WorkflowStage, theme: Theme): string {
	const content = (icon: string): string => `${icon} ${stage.relation}`;
	switch (stage.status) {
		case "done":
			return theme.fg("success", content("✓"));
		case "active":
			return theme.fg("accent", theme.bold(content("●")));
		case "changes":
			return theme.fg("warning", content("!"));
		case "failed":
			return theme.fg("error", content("✗"));
		default:
			return theme.fg("dim", content("○"));
	}
}

/** Stage timeline, sliced from the active (or next actionable) stage when the
 * full sequence does not fit, so the current position always survives. */
function timelineSegment(stages: readonly WorkflowStage[], theme: Theme, width: number): string {
	const separator = theme.fg("dim", " ─ ");
	const render = (items: readonly WorkflowStage[]): string =>
		items.map((stage) => workflowStageToken(stage, theme)).join(separator);
	const full = render(stages);
	if (visibleWidth(full) <= width) return full;
	let focusIndex = stages.findIndex((stage) => stage.status === "active");
	if (focusIndex === -1) {
		focusIndex = stages.findLastIndex((stage) => stage.status === "changes" || stage.status === "failed");
	}
	if (focusIndex === -1) focusIndex = stages.findIndex((stage) => stage.status === "pending");
	if (focusIndex === -1) focusIndex = stages.length - 1;
	const omittedPrefix = focusIndex > 0 ? theme.fg("dim", "… ─ ") : "";
	return truncateToWidth(`${omittedPrefix}${render(stages.slice(focusIndex))}`, width, "…");
}

/** Timeline line under a managed workflow parent. The live stage's telemetry
 * (its activity or model, plus stage elapsed) rides right-aligned, so the two
 * workflow lines replace what used to be four (parent, timeline, child row,
 * child activity). */
function workflowTimelineLine(
	run: RunView,
	children: readonly RunView[],
	theme: Theme,
	width: number,
	now: number,
): string | undefined {
	const stages = run.workflowStages;
	const indent = "  ";
	const budget = width - visibleWidth(indent);
	if (!stages || stages.length === 0 || budget <= 0) return undefined;
	const child = children.find((candidate) => candidate.status === "running" || candidate.status === "interrupting")
		?? children.at(-1);
	const childDoing = child?.activity?.trim() || child?.model?.split("/").at(-1) || "";
	const childElapsed = child ? formatElapsed(child, now) : "";
	const timeline = timelineSegment(stages, theme, budget);
	const room = budget - visibleWidth(timeline) - 1;
	let tail = "";
	if (room >= ACTIVITY_MIN_WIDTH) {
		const doingBudget = room - (childElapsed ? visibleWidth(childElapsed) + (childDoing ? visibleWidth(SEPARATOR) : 0) : 0);
		const doingText = childDoing && doingBudget >= ACTIVITY_MIN_WIDTH
			? formatTaskSummary(childDoing, doingBudget)
			: "";
		const parts = [doingText, childElapsed].filter(Boolean);
		if (parts.length > 0) tail = theme.fg("dim", parts.join(SEPARATOR));
	}
	return `${indent}${layoutLine(timeline, tail, budget)}`;
}

/** Render active runs as compact per-run line groups: one line per simple run,
 * two per managed workflow. Internal stage children fold into their parent's
 * timeline instead of adding rows; ids for control remain available through
 * subagent_status. */
export function formatActiveRunLines(
	runs: readonly RunView[],
	theme: Theme,
	width: number,
	now: number = Date.now(),
): string[] {
	const active = runs.filter((run) => isRunActiveStatus(run.status));
	const activeIds = new Set(active.map((run) => run.id));
	const childrenOf = new Map<number, RunView[]>();
	const roots: RunView[] = [];
	for (const run of active) {
		if (run.parentRunId !== undefined && activeIds.has(run.parentRunId)) {
			const siblings = childrenOf.get(run.parentRunId);
			if (siblings) siblings.push(run);
			else childrenOf.set(run.parentRunId, [run]);
		} else {
			roots.push(run);
		}
	}
	const groups: string[][] = roots.map((root) => {
		const lines = [primaryLine(root, theme, width, now)];
		const timeline = root.managedWorkflow
			? workflowTimelineLine(root, childrenOf.get(root.id) ?? [], theme, width, now)
			: undefined;
		if (timeline) lines.push(timeline);
		return lines;
	});

	const lines: string[] = [];
	let shownRoots = 0;
	for (const group of groups) {
		const remaining = MAX_WIDGET_LINES - 1 - lines.length;
		if (remaining <= 0) break;
		// A group that no longer fits whole keeps its primary line only.
		lines.push(...(group.length <= remaining ? group : group.slice(0, remaining)));
		shownRoots++;
	}
	const hiddenRoots = roots.length - shownRoots;
	if (hiddenRoots > 0) {
		lines.push(theme.fg("dim", `… +${hiddenRoots} more (subagent_status)`));
	}
	return lines;
}

function hasTickingRun(): boolean {
	return monitor.getRuns().some(
		(run) => isRunActiveStatus(run.status) && run.activeSince !== undefined,
	);
}

/** Install the widget for one TUI session. Its timer exists only while at least
 * one active run has started and is disposed with the widget. */
export function installActiveRunsWidget(ctx: Pick<ExtensionContext, "mode" | "ui">): void {
	if (ctx.mode !== "tui") return;
	ctx.ui.setWidget(
		SUBAGENTS_WIDGET_ID,
		(tui, theme) => {
			let timer: ReturnType<typeof setInterval> | undefined;
			let disposed = false;

			const syncTimer = (): void => {
				if (disposed) return;
				if (hasTickingRun()) {
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
				render: (width: number) => formatActiveRunLines(monitor.getRuns(), theme, width),
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
