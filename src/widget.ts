/**
 * Compact, glanceable active-run widget for interactive Pi sessions.
 *
 * Layout contract (redesign):
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
 * - First line of the widget is the parent pi session itself: what the current
 *   model is doing right now while its agent loop runs (model/thinking, live
 *   activity, loop elapsed), fed by the session's own extension events.
 * - A managed workflow renders as a tree chain under its parent line: one
 *   `├`/`└`-connected row per stage, each carrying its own model, token flow,
 *   and elapsed — settled stages from the snapshot frozen at settlement, the
 *   live stage from its child row. An oversized chain keeps a window anchored
 *   on the live stage.
 * - Queued rows say what they actually wait for ("queued" for a process slot,
 *   "repo lane" for shared-writer serialization, "starting" while the child
 *   process launches) instead of one catch-all "queued".
 */

import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
	formatDuration,
	formatElapsed,
	formatTaskSummary,
	formatUsageTokens,
	isRunActiveStatus,
	monitor,
	shrinkRunLabel,
	statusIcon,
	sumUsage,
	usageCostPart,
	type MainActivity,
	type RunView,
	type WorkflowStage,
	type WorkflowStageStatus,
} from "./monitor.ts";
import type { UsageStats } from "./rpc-run.ts";

export const SUBAGENTS_WIDGET_ID = "pi-subagents";

/** The TUI caps string-array widgets at this many lines; a factory widget owns
 * the same bound itself, or a wide parallel dispatch floods the editor area. */
const MAX_WIDGET_LINES = 10;

const SEPARATOR = " · ";
/** Column gap between the identity block and the run's label. */
const IDENTITY_GAP = "  ";
/** Splits "what this run is" from "what it is doing right now" on a stage row. */
const ACTIVITY_SEPARATOR = " — ";
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

/** Short truthful wait word for a queued row, shown in the telemetry column. */
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

/** Marker text that shares the agent column so alignment survives resumes. */
function agentColumnText(run: RunView): string {
	return run.continuationKind ? `${run.agent} ↻` : run.agent;
}

/** `icon  #id  agent` in fixed columns — never truncated. The id is
 * right-aligned and the agent column is padded so every label starts at the
 * same x; a resumed thread carries a dim `↻` inside the agent column. */
function identitySegment(run: RunView, theme: Theme, layout: ColumnLayout): string {
	const icon = run.managedWorkflow && run.status === "running"
		? theme.fg("accent", theme.bold("◆"))
		: statusIcon(run.status, theme);
	const id = `#${run.id}`.padStart(layout.idWidth);
	const name = theme.fg("accent", theme.bold(run.agent));
	const resumed = run.continuationKind ? ` ${theme.fg("dim", "↻")}` : "";
	const pad = " ".repeat(Math.max(0, layout.agentWidth - visibleWidth(agentColumnText(run))));
	return `${icon} ${theme.fg("dim", id)} ${name}${resumed}${pad}`;
}

/** One footer-style usage part: token flow plus accrued cost, dropped as a
 * unit before the model under width pressure. */
function usagePart(usage: UsageStats | undefined): string | undefined {
	return [formatUsageTokens(usage), usageCostPart(usage)].filter(Boolean).join(" ") || undefined;
}

/** Telemetry tail parts shared by primary and stage rows: badge and wait word
 * first (dropped first under pressure), then the usage part, the model, and
 * the always-surviving elapsed. `usage` defaults to the run's own; the managed
 * workflow parent overrides it with the workflow-wide aggregate. */
function telemetryTailParts(run: RunView, now: number, usage: UsageStats = run.usage): Array<string | undefined> {
	// Queued rows omit the model (the route is re-resolved at actual start);
	// workflow parents omit it too (each stage row owns its own model). The
	// full provider/model ref is kept — "which provider served this run" is
	// exactly what a multi-provider session needs to see.
	const modelPart = run.status === "queued" || run.managedWorkflow || !run.model
		? undefined
		: run.model;
	const badge = run.isolation === "worktree" ? worktreeBadge(run) : undefined;
	const wait = run.status === "queued" ? waitWord(run) : undefined;
	// Drop order under pressure: badge, wait word, usage, model; elapsed
	// survives every width the identity leaves room for.
	return [badge, wait, usagePart(usage), modelPart, formatElapsed(run, now) || undefined];
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
	usage: UsageStats = run.usage,
): string[] {
	const identity = identitySegment(run, theme, layout);
	const tailBudget = Math.max(0, width - visibleWidth(identity) - LEFT_MIN_CONTENT);
	const tail = composeTail(telemetryTailParts(run, now, usage), tailBudget);

	// A chain child rendered at root level (its parent row is gone) keeps its
	// workflow relation; the templated brief itself would only repeat content.
	const label = run.parentRunId !== undefined
		? [run.relationLabel, run.label].filter((part): part is string => Boolean(part)).join(SEPARATOR)
		: run.label ?? formatTaskSummary(run.task, 48);
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

	// The parent's own activity is a placeholder while a managed workflow runs;
	// the timeline chain below carries the live stage instead.
	const activity = !run.managedWorkflow && (run.status === "running" || run.status === "interrupting")
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

function stageIcon(status: WorkflowStageStatus, theme: Theme): string {
	switch (status) {
		case "done":
			return theme.fg("success", "✓");
		case "active":
			return theme.fg("accent", theme.bold("●"));
		case "changes":
			return theme.fg("warning", "!");
		case "failed":
			return theme.fg("error", "✗");
		default:
			return theme.fg("dim", "○");
	}
}

/** Stage telemetry source: the live child while the stage runs, the frozen
 * snapshot once it has settled. */
interface StageTelemetry {
	model?: string;
	thinking?: string;
	usage?: UsageStats;
	elapsed: string;
	activity?: string;
}

function stageTelemetry(
	stage: WorkflowStage,
	live: RunView | undefined,
	now: number,
): StageTelemetry {
	if (live) {
		return {
			model: live.model,
			thinking: live.thinking,
			usage: live.usage,
			elapsed: formatElapsed(live, now),
			activity: live.activity?.trim() || undefined,
		};
	}
	return { model: stage.model, usage: stage.usage, elapsed: stage.elapsedMs !== undefined ? formatDuration(stage.elapsedMs) : "" };
}

/** The parent pi session's own line — what the current model is doing right
 * now while its agent loop runs: full model/thinking ref, live activity, loop
 * elapsed. Not a run, so it owns no `#id`; it joins the identity layout so its
 * label column lines up with the run rows. */
function mainLine(main: MainActivity, theme: Theme, width: number, now: number, layout: ColumnLayout): string {
	const dim = (text: string): string => theme.fg("dim", text);
	const icon = theme.fg("accent", "●");
	const name = theme.fg("accent", theme.bold("pi"));
	const pad = " ".repeat(Math.max(0, layout.agentWidth - visibleWidth("pi")));
	const identity = `${icon} ${" ".repeat(layout.idWidth + 1)}${name}${pad}`;
	const modelPart = main.model ? `${main.model}${main.thinking ? `/${main.thinking}` : ""}` : undefined;
	const elapsed = formatDuration(Math.max(0, now - main.activeSince));
	const tail = composeTail([modelPart, elapsed], Math.max(0, width - visibleWidth(identity) - LEFT_MIN_CONTENT));
	const contentBudget = width
		- visibleWidth(identity)
		- (tail ? visibleWidth(tail) + visibleWidth(SEPARATOR) : 0)
		- visibleWidth(IDENTITY_GAP);
	let left = identity;
	if (main.activity?.trim() && contentBudget >= ACTIVITY_MIN_WIDTH) {
		left = `${identity}${IDENTITY_GAP}${dim(formatTaskSummary(main.activity.trim(), contentBudget))}`;
	}
	return composeLine(left, tail, theme, width);
}

/** One `├`/`└`-connected row per managed-workflow stage: status icon,
 * relation, live activity for the running stage, and its own model/token/
 * cost/elapsed telemetry flowing inline. The chain hangs off the parent line,
 * so who dispatched what stays visible while the auto-fix workflow progresses. */
function workflowStageLines(
	stages: readonly WorkflowStage[],
	children: readonly RunView[],
	theme: Theme,
	width: number,
	now: number,
): { lines: string[]; activeIndex: number } {
	const live = children.find((candidate) => candidate.status === "running" || candidate.status === "interrupting")
		?? children.at(-1);
	const activeIndex = stages.findIndex((stage) => stage.status === "active");
	const lines: string[] = [];
	for (const [index, stage] of stages.entries()) {
		const telemetry = stageTelemetry(stage, index === activeIndex ? live : undefined, now);
		const connector = theme.fg("dim", index === stages.length - 1 ? "└" : "├");
		const indent = `  ${connector} `;
		const budget = width - visibleWidth(indent);
		if (budget <= 0) break;
		const icon = stageIcon(stage.status, theme);
		const label = `${icon} ${stage.relation}`;
		const modelPart = telemetry.model
			? `${telemetry.model}${telemetry.thinking ? `/${telemetry.thinking}` : ""}`
			: undefined;
		const parts = [
			usagePart(telemetry.usage),
			modelPart,
			telemetry.elapsed || undefined,
		];
		const tailBudget = Math.max(0, budget - visibleWidth(label) - ACTIVITY_MIN_WIDTH);
		const tail = composeTail(parts, tailBudget);
		const contentBudget = budget - (tail ? visibleWidth(tail) + visibleWidth(SEPARATOR) : 0);
		let left = label;
		if (telemetry.activity && contentBudget - visibleWidth(label) - visibleWidth(ACTIVITY_SEPARATOR) >= ACTIVITY_MIN_WIDTH) {
			const activityBudget = contentBudget - visibleWidth(label) - visibleWidth(ACTIVITY_SEPARATOR);
			left = `${label}${theme.fg("dim", ACTIVITY_SEPARATOR)}${theme.fg("dim", formatTaskSummary(telemetry.activity, activityBudget))}`;
		}
		lines.push(`${indent}${composeLine(left, tail, theme, budget)}`);
	}
	return { lines, activeIndex };
}

/** Fit one workflow group into the remaining line budget: the primary lines
 * (identity line plus the live-activity line) always survive, and the stage
 * window anchors on the live stage — settled stages above the window collapse
 * into one `… +N` marker, never the live stage itself. */
function fitGroupLines(
	primary: readonly string[],
	stages: readonly string[],
	activeIndex: number,
	remaining: number,
	theme: Theme,
): string[] {
	if (primary.length > remaining) return primary.slice(0, Math.max(1, remaining));
	if (stages.length === 0 || stages.length + primary.length <= remaining) return [...primary, ...stages];
	const slots = remaining - primary.length;
	// Reserve one line for an overflow marker so a cut is always announced.
	const room = Math.max(1, slots - 1);
	const anchor = activeIndex >= 0 ? activeIndex : 0;
	const start = Math.max(0, Math.min(anchor, stages.length - room));
	const window = stages.slice(start, start + room);
	const parts = [
		...(start > 0 ? [theme.fg("dim", `… +${start}`)] : []),
		...window,
		...(start + room < stages.length ? [theme.fg("dim", `… +${stages.length - start - room}`)] : []),
	];
	while (parts.length > slots) parts.pop();
	return [...primary, ...parts];
}

/** Render active runs as compact per-run line groups: the parent model's own
 * line first, then one two-line group per simple run, a tree chain per managed
 * workflow (parent line + one row per stage). All rows share one column layout. */
export function formatActiveRunLines(
	runs: readonly RunView[],
	theme: Theme,
	width: number,
	now: number = Date.now(),
	main?: MainActivity,
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
	const layout: ColumnLayout = {
		idWidth: Math.max(...roots.map((root) => visibleWidth(`#${root.id}`)), 0),
		agentWidth: Math.max(...roots.map((root) => visibleWidth(agentColumnText(root))), main ? visibleWidth("pi") : 0),
	};
	const groups: Array<{ primary: readonly string[]; stages: readonly string[]; activeIndex: number }> = roots.map((root) => {
		const children = childrenOf.get(root.id) ?? [];
		// Workflow-wide tokens/cost on the parent line: every stage snapshot plus
		// the live child (whose snapshot is frozen only at settlement). Without
		// a stage projection the parent's own usage stands in.
		let usage = root.usage;
		if (root.managedWorkflow && root.workflowStages) {
			const settled = root.workflowStages.map((stage) => stage.usage).filter((u): u is UsageStats => Boolean(u));
			const live = children.find((candidate) => candidate.usage.input || candidate.usage.output || candidate.usage.cost);
			usage = sumUsage([...(settled.length > 0 ? settled : [root.usage]), ...(live ? [live.usage] : [])]);
		}
		const primary = primaryLine(root, theme, width, now, layout, usage);
		let activeIndex = -1;
		let stages: readonly string[] = [];
		if (root.managedWorkflow && root.workflowStages && root.workflowStages.length > 0) {
			const rendered = workflowStageLines(root.workflowStages, children, theme, width, now);
			stages = rendered.lines;
			activeIndex = rendered.activeIndex;
		}
		return { primary, stages, activeIndex };
	});

	const lines: string[] = [];
	if (main && MAX_WIDGET_LINES > 1) {
		lines.push(mainLine(main, theme, width, now, layout));
	}
	let shownRoots = 0;
	for (const group of groups) {
		const remaining = MAX_WIDGET_LINES - 1 - lines.length;
		if (remaining <= 0) break;
		lines.push(...fitGroupLines(group.primary, group.stages, group.activeIndex, remaining, theme));
		shownRoots++;
	}
	const hiddenRoots = roots.length - shownRoots;
	if (hiddenRoots > 0) {
		lines.push(theme.fg("dim", `… +${hiddenRoots} more`));
	}
	return lines;
}

function hasTickingRun(): boolean {
	return monitor.isMainAgentActive()
		|| monitor.getRuns().some((run) => isRunActiveStatus(run.status) && run.activeSince !== undefined);
}

/** Install the widget for one TUI session. Its timer exists only while at
 * least one active run has started or the parent agent loop is running, and
 * is disposed with the widget. */
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
				render: (width: number) => formatActiveRunLines(monitor.getRuns(), theme, width, Date.now(), monitor.getMainActivity()),
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
