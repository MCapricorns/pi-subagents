/**
 * Persistent cost footer: replaces pi's built-in consumption line with a
 * per-model tally of the main window's own spend, so models are never summed
 * into one number — each `provider/model` keeps its own token flow, cost,
 * context share, and live throughput. The current-project line stays first,
 * exactly where pi put it; extension statuses stay last.
 *
 * Sub-agent spend is intentionally absent: children report per-run usage with
 * their model ref when they settle, and injecting it here (or into the parent
 * session totals) is what mixed unrelated models' costs before.
 */

import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { costLedger, type ModelSpendRow } from "./cost-ledger.ts";
import { formatTokens, formatUsageTokens } from "./monitor.ts";
import type { UsageStats } from "../execution/rpc-control.ts";

/** Footer data as injected by pi's `setFooter` factory; only the read-only
 * surface exists in types, so keep the structural shape local. */
interface FooterData {
	getGitBranch(): string | null;
	getExtensionStatuses(): ReadonlyMap<string, string>;
	onBranchChange(callback: () => void): () => void;
}

/** Live context owned by the installed footer's session. */
type RenderContext = Partial<Pick<ExtensionContext, "sessionManager" | "getContextUsage" | "model" | "thinkingLevel">>;

/** Minimum gap between the stats left side and the right-aligned model. */
const MIN_PADDING = 2;
/** Settled-model rows shown after the current one; anything older collapses
 * into one overflow marker so the footer's height stays bounded no matter how
 * many models a session switched through. */
const MAX_SETTLED_MODEL_ROWS = 3;

/** Home-relative project path, matching the built-in footer's `~` form. */
function formatProjectPath(cwd: string, home: string | undefined): string {
	if (!home) return cwd;
	const resolvedCwd = resolve(cwd);
	const resolvedHome = resolve(home);
	const relativeToHome = relative(resolvedHome, resolvedCwd);
	const isInsideHome = relativeToHome === "" ||
		(relativeToHome !== ".." && !relativeToHome.startsWith(`..${sep}`) && !isAbsolute(relativeToHome));
	if (!isInsideHome) return cwd;
	return relativeToHome === "" ? "~" : `~${sep}${relativeToHome}`;
}

/** The `12%/200k` context share of the current model; colored by pressure
 * like the built-in footer did. */
function contextPart(theme: Theme, usage: { percent?: number | null; contextWindow?: number } | undefined): string {
	if (!usage || !usage.contextWindow || usage.contextWindow <= 0) return "";
	const percent = usage.percent === null || usage.percent === undefined
		? "?"
		: usage.percent.toFixed(1);
	const display = `${percent}%/${formatTokens(usage.contextWindow)}`;
	if (typeof usage.percent === "number" && usage.percent > 90) return theme.fg("error", display);
	if (typeof usage.percent === "number" && usage.percent > 70) return theme.fg("warning", display);
	return display;
}

function speedPart(speed: { tokensPerSecond: number; streaming: boolean } | undefined): string {
	if (!speed || speed.tokensPerSecond <= 0) return "";
	return `${speed.streaming ? "~" : ""}${speed.tokensPerSecond.toFixed(1)} tok/s`;
}

function spendUsage(spend: ModelSpendRow["spend"]): UsageStats {
	return { ...spend, contextTokens: 0, turns: 0 };
}

/** One `↑in ↓out R r W w $cost` flow for a model row; zero components drop
 * out, but a model with no spend at all still shows its bare `$0.0000` so the
 * row reads as a tally rather than an empty label. */
function spendPart(spend: ModelSpendRow["spend"]): string {
	return [formatUsageTokens(spendUsage(spend)), `$${spend.cost.toFixed(4)}`].filter(Boolean).join(" ");
}

/** Current-model row: stats left, model identity right-aligned — the built-in
 * footer's geometry, applied to the ledger row. */
function currentModelLine(
	row: ModelSpendRow,
	theme: Theme,
	width: number,
	ctx: RenderContext,
): string {
	const parts = [spendPart(row.spend)];
	const context = contextPart(theme, ctx.getContextUsage?.());
	if (context) parts.push(context);
	const speed = costLedger.speed();
	if (speed && speed.model === row.model) {
		const part = speedPart(speed);
		if (part) parts.push(part);
	}
	let left = parts.join(" ");
	if (visibleWidth(left) > width) left = truncateToWidth(left, width, "…");

	let right = row.model;
	if (ctx.model?.reasoning && ctx.thinkingLevel) {
		right = ctx.thinkingLevel === "off" ? `${right} • thinking off` : `${right} • ${ctx.thinkingLevel}`;
	}
	// The provider prefix duplicates the ref's own `provider/` half, so keep it
	// only for the bare-id shape a providerless ref produces.
	const leftWidth = visibleWidth(left);
	if (leftWidth + MIN_PADDING + visibleWidth(right) > width) {
		const available = width - leftWidth - MIN_PADDING;
		if (available <= 0) return theme.fg("dim", left);
		right = truncateToWidth(right, available, "");
	}
	const padding = " ".repeat(Math.max(MIN_PADDING, width - leftWidth - visibleWidth(right)));
	return theme.fg("dim", `${left}${padding}${right}`);
}

/** Settled-model row: the model ref leads because that is the line's whole
 * point — which model, what it cost. Under width pressure the token flow drops
 * first (the cost is the headline), then the line truncates. */
function settledModelLine(row: ModelSpendRow, theme: Theme, width: number): string {
	const full = `${row.model} ${spendPart(row.spend)}`;
	if (visibleWidth(full) <= width) return theme.fg("dim", full);
	const bare = `${row.model} $${row.spend.cost.toFixed(4)}`;
	if (visibleWidth(bare) <= width) return theme.fg("dim", bare);
	return truncateToWidth(theme.fg("dim", full), width, "…");
}

/** Render the replacement footer: project line first, one line per model the
 * main window spent on (current model with context + throughput), extension
 * statuses last — the same slots the built-in footer used. Settled models are
 * ranked by spend and capped, so a session that switched through many models
 * never grows the footer without bound. */
export function renderCostFooter(
	width: number,
	theme: Theme,
	footerData: FooterData | undefined,
	ctx: RenderContext,
): string[] {
	const sessionManager = ctx.sessionManager;
	const lines: string[] = [];

	let project = formatProjectPath(sessionManager?.getCwd() ?? "", process.env.HOME || process.env.USERPROFILE);
	const branch = footerData?.getGitBranch();
	if (branch) project = `${project} (${branch})`;
	const sessionName = sessionManager?.getSessionName();
	if (sessionName) project = `${project} • ${sessionName}`;
	lines.push(truncateToWidth(theme.fg("dim", project), width, theme.fg("dim", "…")));

	const rows = costLedger.snapshot();
	if (rows.length > 0) {
		const current = rows.find((row) => row.current);
		if (current) lines.push(currentModelLine(current, theme, width, ctx));
		const settled = rows
			.filter((row) => !row.current)
			.sort((left, right) => right.spend.cost - left.spend.cost);
		for (const row of settled.slice(0, MAX_SETTLED_MODEL_ROWS)) {
			lines.push(settledModelLine(row, theme, width));
		}
		const hidden = settled.length - MAX_SETTLED_MODEL_ROWS;
		if (hidden > 0) {
			lines.push(theme.fg("dim", `… +${hidden} more model${hidden === 1 ? "" : "s"}`));
		}
	}

	const statuses = footerData?.getExtensionStatuses();
	if (statuses && statuses.size > 0) {
		const statusLine = [...statuses.entries()]
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([, text]) => stripVTControlCharacters(text).replace(/[\r\n\t]+/g, " ").replace(/ +/g, " ").trim())
			.join(" ");
		lines.push(truncateToWidth(statusLine, width, theme.fg("dim", "…")));
	}
	return lines;
}

/**
 * Replace pi's built-in footer with the per-model cost footer. The factory
 * re-renders on ledger updates and git branch changes; context, model, and
 * thinking state use Pi's live getters for this session. Shutdown clears the
 * footer before Pi invalidates its context.
 */
export function installCostFooter(ctx: Pick<ExtensionContext, "mode" | "ui"> & RenderContext): void {
	if (ctx.mode !== "tui") return;
	ctx.ui.setFooter((tui, theme, footerData) => {
		const unsubscribe = [
			costLedger.subscribe(() => tui.requestRender()),
			footerData.onBranchChange(() => tui.requestRender()),
		];
		return {
			render: (width: number) => renderCostFooter(width, theme, footerData, ctx),
			invalidate() {},
			dispose() {
				for (const stop of unsubscribe) stop();
			},
		};
	});
}

/** Restore pi's built-in footer. */
export function clearCostFooter(ctx: Pick<ExtensionContext, "mode" | "ui">): void {
	if (ctx.mode === "tui") ctx.ui.setFooter(undefined);
}
