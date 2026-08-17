/** Lightweight active-run widget for interactive Pi sessions. */

import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
	formatElapsed,
	isRunActiveStatus,
	monitor,
	statusIcon,
	statusLabel,
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

/** One compact line per genuinely active run. Settled and parked threads never
 * appear, so elapsed time cannot keep ticking beside a terminal status. */
export function formatActiveRunLines(
	runs: readonly RunView[],
	theme: Theme,
	width: number,
	now: number = Date.now(),
): string[] {
	const dim = (text: string): string => theme.fg("dim", text);
	return runs
		.filter((run) => isRunActiveStatus(run.status))
		.map((run) => {
			const icon = statusIcon(run.status, theme);
			const name = theme.fg("accent", theme.bold(run.agent));
			const context = run.relationLabel ?? run.label;
			const activity = run.status === "running"
				? (run.activity ?? statusLabel(run.status))
				: statusLabel(run.status);
			const parts = [
				`${icon} ${dim(`#${run.id}`)} ${name}`,
				context ? dim(`· ${context}`) : undefined,
				activity ? dim(`· ${activity}`) : undefined,
			].filter((part): part is string => Boolean(part));
			const elapsed = formatElapsed(run, now);
			return compactLine(parts.join(" "), elapsed ? dim(elapsed) : "", width);
		});
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
