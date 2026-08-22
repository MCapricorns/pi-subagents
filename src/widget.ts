/** Lightweight active-run widget for interactive Pi sessions. */

import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
	formatElapsed,
	formatTaskSummary,
	isRunActiveStatus,
	monitor,
	statusIcon,
	type RunView,
} from "./monitor.ts";

export const SUBAGENTS_WIDGET_ID = "pi-subagents";

/** Keep the elapsed tail visible while clipping the descriptive left side. */
function compactLine(left: string, right: string, width: number): string {
	if (width <= 0) return "";
	if (!right) return truncateToWidth(left, width, "");
	const separator = " ";
	const rightWidth = visibleWidth(right);
	if (rightWidth >= width) return truncateToWidth(right, width, "");
	const leftWidth = width - rightWidth - visibleWidth(separator);
	if (leftWidth <= 0) return truncateToWidth(right, width, "");
	return `${truncateToWidth(left, leftWidth, "…")}${separator}${right}`;
}

/** One compact primary line per genuinely active run, plus an optional indented
 * activity line. The primary line reserves effective model/thinking and elapsed
 * width before truncating the task. Settled and parked threads never appear, so
 * elapsed time cannot keep ticking beside a terminal status. */
function runPrimaryLine(
	run: RunView,
	theme: Theme,
	width: number,
	now: number,
	prefix: string,
): string {
	const dim = (text: string): string => theme.fg("dim", text);
	const icon = statusIcon(run.status, theme);
	const name = theme.fg("accent", theme.bold(run.agent));
	const identity = `${prefix}${icon} ${name}`;
	const elapsed = formatElapsed(run, now);
	// Render only the resolved model id plus thinking level. Provider auth and
	// other configuration never enter monitor state or this line.
	const modelId = run.model?.split("/").at(-1);
	const modelSource = formatTaskSummary(
		modelId ? `${modelId}${run.thinking ? `/${run.thinking}` : ""}` : run.thinking ? `thinking:${run.thinking}` : "",
		64,
		false,
	);
	// A chain child shows its role in the chain plus a task-derived label; the
	// templated fix brief itself would only repeat the parent review's content.
	const taskSource = run.parentRunId !== undefined
		? [run.relationLabel, run.label].filter((part): part is string => Boolean(part)).join(" · ")
		: formatTaskSummary(run.task, 64);
	const primaryPartCount = 2 + (modelSource ? 1 : 0) + (elapsed ? 1 : 0);
	const contentWidth = Math.max(
		0,
		width -
			visibleWidth(identity) -
			visibleWidth(elapsed) -
			(primaryPartCount - 1) * visibleWidth(" · "),
	);
	const modelDesired = visibleWidth(modelSource);
	const modelFloor = Math.min(modelDesired, Math.min(12, contentWidth));
	let modelWidth = modelSource
		? Math.min(modelDesired, Math.max(modelFloor, contentWidth - 8))
		: 0;
	let taskWidth = contentWidth - modelWidth;
	if (visibleWidth(taskSource) < taskWidth) {
		modelWidth = Math.min(modelDesired, modelWidth + taskWidth - visibleWidth(taskSource));
		taskWidth = contentWidth - modelWidth;
	}
	const task = taskWidth > 0 ? formatTaskSummary(taskSource, taskWidth, run.parentRunId === undefined) : "";
	const modelThinking = modelWidth > 0 ? formatTaskSummary(modelSource, modelWidth, false) : "";
	const primaryLeft = [
		identity,
		task ? dim(task) : undefined,
		modelThinking ? dim(modelThinking) : undefined,
	].filter((part): part is string => Boolean(part)).join(" · ");
	return compactLine(primaryLeft, elapsed ? dim(`· ${elapsed}`) : "", width);
}

function runActivityLine(run: RunView, theme: Theme, width: number, indent: string): string[] {
	const dim = (text: string): string => theme.fg("dim", text);
	const activity = run.activity?.trim();
	if (!activity) return [];
	const activityWidth = width - visibleWidth(indent);
	if (activityWidth <= 0) return [];
	const activitySummary = formatTaskSummary(activity, activityWidth);
	if (!activitySummary) return [];
	return [truncateToWidth(`${indent}${dim(activitySummary)}`, width, "")];
}

/** Render active runs as a tree: main-agent dispatches are roots, auto-fix chain
 * rounds nest under the triggering reviewer row that owns the chain. No run ids
 * appear here — the tree and the task label say what each row is, and ids stay
 * available through subagent_status when a thread must be controlled. */
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
	const lines: string[] = [];
	for (const root of roots) {
		const children = childrenOf.get(root.id) ?? [];
		lines.push(runPrimaryLine(root, theme, width, now, ""));
		// The parent's "auto-fix chain running" placeholder is redundant while its
		// child rows show live progress; keep it only between rounds.
		if (children.length === 0) lines.push(...runActivityLine(root, theme, width, "  "));
		children.forEach((child, index) => {
			const connector = index === children.length - 1 ? "└ " : "├ ";
			lines.push(runPrimaryLine(child, theme, width, now, theme.fg("dim", `  ${connector}`)));
			lines.push(...runActivityLine(child, theme, width, "      "));
		});
	}
	return lines;
}

function hasTickingRun(): boolean {
	return monitor.getRuns().some(
		(run) => isRunActiveStatus(run.status) && run.startedAt !== undefined,
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
