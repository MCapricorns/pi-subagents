/**
 * Persistent footer status line for sub-agent progress.
 *
 * The above-editor widget is the detailed surface, but it only pays off when
 * the user is looking at it: a parent turn that dispatches children and then
 * keeps streaming leaves no trace that anything is still running. The footer
 * is always visible, so one compact roll-up there answers "is anything still
 * working?" without opening the widget or querying runs.
 *
 * It stays deliberately count-only — no elapsed time, no per-run detail — so
 * it carries no time-varying field and needs no refresh timer: every monitor
 * transition already pushes an update. Queued runs keep their wait word
 * (`queued` for a process slot vs `repo lane` for write serialization) because
 * a capacity wait and a serialization wait call for different reactions.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isRunActiveStatus, monitor, statusLabel, type RunView } from "./monitor.ts";
import { waitWord } from "./widget.ts";

export const SUBAGENTS_STATUS_ID = "pi-subagents";

const SEPARATOR = " · ";

/** Display order of the count segments: live work first, settled last. */
const SEGMENT_ORDER = ["running", "interrupting", "starting", "queued", "repo lane", "done", "stopped"];

type StatusContext = Pick<ExtensionContext, "hasUI" | "ui">;

/** One-line roll-up of live runs plus anything that settled during this turn.
 * Returns undefined when nothing is still active — a done-only leftover must
 * not keep the footer up after the last sibling finishes. */
export function formatRunStatusLine(runs: readonly RunView[]): string | undefined {
	if (!runs.some((run) => isRunActiveStatus(run.status))) return undefined;
	const counts = new Map<string, number>();
	for (const run of runs) {
		const word = run.status === "queued"
			? waitWord(run)
			: isRunActiveStatus(run.status) || run.status === "done" || run.status === "failed"
				? statusLabel(run.status)
				: undefined;
		if (word) counts.set(word, (counts.get(word) ?? 0) + 1);
	}
	const segments = SEGMENT_ORDER.filter((word) => counts.has(word)).map((word) => `${counts.get(word)} ${word}`);
	return segments.length > 0 ? `subagents ${segments.join(SEPARATOR)}` : undefined;
}

/** Subscription of the currently installed status line; module-level because
 * the monitor it follows is itself a singleton. */
let unsubscribe: (() => void) | undefined;

/** Install the footer status line. Not installed without a UI host (print and
 * json modes), where setStatus has nowhere to render. */
export function installActiveRunsStatus(ctx: StatusContext): void {
	if (!ctx.hasUI) return;
	// A second install must not orphan the first subscription.
	clearActiveRunsStatus(ctx);
	const render = (): void => ctx.ui.setStatus(SUBAGENTS_STATUS_ID, formatRunStatusLine(monitor.getRuns()));
	unsubscribe = monitor.subscribe(render);
	render();
}

export function clearActiveRunsStatus(ctx: StatusContext): void {
	unsubscribe?.();
	unsubscribe = undefined;
	if (ctx.hasUI) ctx.ui.setStatus(SUBAGENTS_STATUS_ID, undefined);
}
