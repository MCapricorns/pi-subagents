/**
 * /subagents-inspect — a live overlay listing logical sub-agent threads and the
 * selected thread's real-time work: header facts (run id, agent, generation,
 * model chain, thinking, elapsed, usage/cost), the streaming transcript, recent
 * tools, and the append-only orchestration trajectory.
 *
 * Data comes from a read-only snapshot (buildInspectorSnapshot → monitor +
 * runtime threads + inspectorStore); the component itself never mutates
 * runtime state, except for the explicit park/resume keyboard shortcut which
 * delegates to the same thread control surface as subagent_control.
 *
 * Layout: a two-pane master/detail at wide widths, compact single-pane detail
 * when narrow. Every line is fitted with truncateToWidth — pi hard-crashes on
 * over-wide lines.
 */

import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { stripVTControlCharacters } from "node:util";
import {
	Key,
	matchesKey,
	truncateToWidth,
	visibleWidth,
	type Component,
	type TUI,
} from "@earendil-works/pi-tui";
import { buildInspectorSnapshot, formatTrajectoryEvent, type InspectorThreadView } from "./inspector.ts";
import { formatDuration, formatUsageCompact, isRunActiveStatus, monitor, statusIcon, type RunStatus } from "./monitor.ts";
import type { SubagentRuntime } from "./runtime.ts";
import { inspectorStore } from "./trajectory.ts";

/** Below this width the overlay falls back to the single-pane layout. */
const WIDE_MIN = 110;
const LEFT_PANE_WIDTH = 42;
const MAX_LIST_ROWS = 12;
const MAX_TRANSCRIPT_LINES = 9;
const TICK_MS = 1_000;

export interface InspectorOverlayOptions {
	runtime: Pick<SubagentRuntime, "threads">;
	tui: TUI;
	theme: Theme;
	done: () => void;
	notify?: (message: string) => void;
	tickMs?: number;
}

export class InspectorOverlay implements Component {
	private selectedId?: number;
	private closed = false;
	private readonly unsubscribeMonitor: () => void;
	private readonly unsubscribeInspector: () => void;
	private readonly timer: ReturnType<typeof setInterval>;

	constructor(private readonly options: InspectorOverlayOptions) {
		// Live updates: any monitor mutation or trajectory append rerenders.
		this.unsubscribeMonitor = monitor.subscribe(() => this.rerender());
		this.unsubscribeInspector = inspectorStore.subscribe(() => this.rerender());
		this.timer = setInterval(() => this.rerender(), options.tickMs ?? TICK_MS);
		if (typeof this.timer.unref === "function") this.timer.unref();
	}

	private rerender(): void {
		if (this.closed) return;
		try {
			this.options.tui.requestRender();
		} catch {
			/* a closed/failed TUI must not throw through store notifications */
		}
	}

	/** Escape path (and any external teardown) unsubscribes cleanly. */
	dispose(): void {
		if (this.closed) return;
		this.closed = true;
		this.unsubscribeMonitor();
		this.unsubscribeInspector();
		clearInterval(this.timer);
	}

	invalidate(): void {
		/* stateless render — nothing cached */
	}

	private move(items: readonly { id: number }[], delta: number): void {
		if (items.length === 0) return;
		const index = items.findIndex((item) => item.id === this.selectedId);
		const current = index === -1 ? items.length - 1 : index;
		const next = (current + delta + items.length) % items.length;
		this.selectedId = items[next].id;
	}

	/** Non-text quick action: park a live thread / resume a parked one. Text
	 * actions (steer/retarget with payloads) stay on subagent_control. */
	private togglePark(): void {
		const id = this.selectedId;
		if (id === undefined) return;
		const thread = this.options.runtime.threads.get(id);
		if (!thread) return;
		if (thread.state === "parked") {
			void thread
				.resume(undefined)
				.then((pending) => {
					if (pending.exitCode !== -1) this.options.notify?.(`Could not resume run #${id}: no candidate could start.`);
				})
				.catch((error) => this.options.notify?.(`Could not resume run #${id}: ${errorMessageText(error)}`));
			return;
		}
		const phase = thread.control.getPhase();
		if (phase === "queued" || phase === "starting" || phase === "running" || phase === "steering" || phase === "interrupting" || phase === "retrying" || phase === "settled") {
			void thread
				.park()
				.catch((error) => this.options.notify?.(`Could not park run #${id}: ${errorMessageText(error)}`));
		}
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape)) {
			this.dispose();
			this.options.done();
			return;
		}
		const { items } = buildInspectorSnapshot({ runtime: this.options.runtime });
		if (this.selectedId === undefined || !items.some((item) => item.id === this.selectedId)) {
			this.selectedId = items.length > 0 ? items[items.length - 1].id : undefined;
		}
		if (matchesKey(data, Key.up) || data === "k") this.move(items, -1);
		else if (matchesKey(data, Key.down) || data === "j" || matchesKey(data, Key.tab)) this.move(items, 1);
		else if (data === "p") this.togglePark();
		this.rerender();
	}

	render(width: number): string[] {
		const theme = this.options.theme;
		const fit = (line: string): string => truncateToWidth(line, width);
		const snapshot = buildInspectorSnapshot({ runtime: this.options.runtime, selectedId: this.selectedId });
		const { items } = snapshot;

		// Selection stability: keep the chosen id across updates; fall back to
		// the newest thread only when there is no valid selection.
		if (this.selectedId === undefined || !items.some((item) => item.id === this.selectedId)) {
			this.selectedId = items.length > 0 ? items[items.length - 1].id : undefined;
		}
		const detail =
			this.selectedId === undefined
				? undefined
				: (buildInspectorSnapshot({ runtime: this.options.runtime, selectedId: this.selectedId }).detail ??
					snapshot.detail);

		const border = fit(theme.fg("accent", "─".repeat(Math.max(1, width))));
		const activeCount = items.filter((item) => isRunActiveStatus(item.status)).length;
		const liveText = activeCount > 0 ? `${activeCount} active` : "no active runs";
		const header = fit(
			`${theme.fg("accent", theme.bold("sub-agents"))} ${theme.fg(activeCount > 0 ? "accent" : "dim", "●")} ${theme.fg("dim", `${liveText} · ${items.length} thread${items.length === 1 ? "" : "s"}`)}`,
		);
		const footer = fit(
			theme.fg(
				"dim",
				"↑/↓ select · p park/resume · subagent_control steer/retarget/park/resume/fork · subagent_stop destroys · Esc close",
			),
		);

		const lines: string[] = [border, header, border];
		if (items.length === 0) {
			lines.push(fit(theme.fg("dim", "No sub-agent threads yet — delegate work with the subagent tool; live progress appears here.")));
			lines.push(border, footer);
			return lines;
		}

		if (width >= WIDE_MIN && detail) {
			const paneLines = this.renderListPane(items, LEFT_PANE_WIDTH - 2);
			const detailLines = this.renderDetail(detail, width - LEFT_PANE_WIDTH - 3);
			const rows = Math.max(paneLines.length, detailLines.length);
			for (let i = 0; i < rows; i++) {
				const left = padRight(paneLines[i] ?? "", LEFT_PANE_WIDTH);
				const right = detailLines[i] ?? "";
				lines.push(fit(`${left} ${theme.fg("borderMuted", "│")} ${right}`));
			}
		} else {
			lines.push(...this.renderListPane(items, width));
			lines.push(fit(theme.fg("borderMuted", "─ ".repeat(Math.max(1, Math.floor(width / 2))))));
			if (detail) lines.push(...this.renderDetail(detail, width));
		}
		lines.push(border, footer);
		return lines;
	}

	private renderListPane(items: ReadonlyArray<{ id: number; agent: string; label: string; status: RunStatus; stateText: string; generation?: number; elapsedMs?: number }>, width: number): string[] {
		const theme = this.options.theme;
		const selIndex = Math.max(0, items.findIndex((item) => item.id === this.selectedId));
		const start = Math.max(0, Math.min(selIndex - Math.floor(MAX_LIST_ROWS / 2), items.length - MAX_LIST_ROWS));
		const visible = items.slice(start, start + MAX_LIST_ROWS);
		const lines: string[] = [];
		for (let i = 0; i < visible.length; i++) {
			const item = visible[i];
			const selected = start + i === selIndex;
			const cursor = selected ? theme.fg("accent", "❯ ") : "  ";
			const icon = statusIcon(item.status, theme);
			const safeAgent = safeText(item.agent);
			const safeLabel = safeText(item.label);
			const safeState = safeText(item.stateText);
			const name = selected ? theme.fg("accent", theme.bold(safeAgent)) : theme.fg("accent", safeAgent);
			const labelPart = safeLabel ? theme.fg("dim", ` · ${safeLabel}`) : "";
			const state = theme.fg("dim", ` ${item.elapsedMs !== undefined ? formatDuration(item.elapsedMs) + " " : ""}${safeState}`);
			lines.push(truncateToWidth(`${cursor}${icon} ${theme.fg("dim", `#${item.id}`)} ${name}${labelPart}${state}`, width));
		}
		if (items.length > MAX_LIST_ROWS) {
			lines.push(truncateToWidth(theme.fg("dim", `  ${selIndex + 1}/${items.length} · ↑/↓ for more`), width));
		}
		return lines;
	}

	private renderDetail(view: InspectorThreadView, width: number): string[] {
		const theme = this.options.theme;
		const fit = (line: string): string => truncateToWidth(line, width);
		const dim = (text: string): string => theme.fg("dim", text);
		const clean = safeText;
		const lines: string[] = [];

		// Identity + progress facts. Strip untrusted terminal controls BEFORE
		// applying theme ANSI so OSC/CSI payloads can never reach the terminal.
		const genPart = view.generation !== undefined ? ` · gen ${view.generation}` : "";
		const safeState = clean(view.stateText);
		const safePhase = clean(view.phase ?? "");
		const phasePart = safePhase && safePhase !== safeState ? ` (${safePhase})` : "";
		lines.push(fit(`${theme.fg("accent", theme.bold(`#${view.id} ${clean(view.agent)}`))}${dim(`${genPart} · ${safeState}${phasePart}`)}`));
		if (view.label) lines.push(fit(dim(`label: ${clean(view.label)}`)));
		lines.push(fit(dim(`task: ${oneLine(view.task)}`)));
		const relations = [
			view.forkedFromRunId !== undefined ? `forked from #${view.forkedFromRunId}` : undefined,
			view.forkChildRunIds.length > 0 ? `fork children ${view.forkChildRunIds.map((id) => `#${id}`).join(", ")}` : undefined,
		].filter(Boolean);
		if (relations.length > 0) lines.push(fit(dim(`relation: ${relations.join(" · ")}`)));
		if (view.isolation === "worktree") {
			lines.push(fit(dim(`isolation: worktree · ${view.integrationStatus ?? "active"}`)));
			if (view.originalCwd && view.isolationCwd) lines.push(fit(dim(`cwd: ${clean(view.originalCwd)} → ${clean(view.isolationCwd)}`)));
			if (view.integrationWorktreePath) lines.push(fit(theme.fg("warning", `retained worktree: ${clean(view.integrationWorktreePath)}`)));
			if (view.integrationPatchPath) lines.push(fit(theme.fg("warning", `retained patch: ${clean(view.integrationPatchPath)}`)));
			if (view.integrationError) lines.push(fit(theme.fg("error", `integration: ${clean(view.integrationError)}`)));
		}

		// Model & thinking.
		const chain = view.modelChain.length > 0 ? view.modelChain.map(clean).join(" → ") : "";
		const currentModel = clean(view.model ?? "");
		const modelLine = view.modelFallbackFrom
			? `${currentModel} (pool fallback from ${clean(view.modelFallbackFrom)})`
			: currentModel;
		const thinkingSuffix = view.thinking ? ` · thinking ${clean(view.thinking)}` : "";
		if (modelLine || chain) {
			lines.push(fit(`${theme.fg("text", modelLine)}${dim(`${chain ? ` · chain: ${chain}` : ""}${thinkingSuffix}`)}`));
		} else if (view.thinking) {
			lines.push(fit(dim(`thinking ${clean(view.thinking)}`)));
		}

		// Elapsed + usage/cost + current activity.
		const elapsed = view.elapsedMs !== undefined ? formatDuration(view.elapsedMs) : "—";
		const usage = formatUsageCompact(view.usage);
		const toolsText = view.toolCount > 0 ? ` · ${view.toolCount} tool${view.toolCount === 1 ? "" : "s"}` : "";
		lines.push(fit(dim(`elapsed ${elapsed} · ${usage || "no usage yet"}${toolsText}`)));
		const activity = view.activity ?? view.currentTool;
		if (activity) lines.push(fit(theme.fg("accent", `▸ ${clean(activity)}`)));

		// Streaming transcript: thinking first (dim), then output text.
		const { text, textTruncated, thinking, thinkingTruncated } = view.transcript;
		if (thinking) {
			const thinkingLines = tailLines(thinking, 3);
			if (thinkingTruncated) lines.push(fit(dim("thinking: … (older output dropped)")));
			else lines.push(fit(dim("thinking:")));
			for (const line of thinkingLines) lines.push(fit(dim(`  ${line}`)));
		}
		if (text) {
			const textLines = tailLines(text, MAX_TRANSCRIPT_LINES);
			if (textTruncated) lines.push(fit(dim("output: … (older output dropped)")));
			else lines.push(fit(dim("output:")));
			for (const line of textLines) lines.push(fit(line));
		} else if (isRunActiveStatus(view.status) && !thinking) {
			lines.push(fit(dim("(waiting for first output…)")));
		}

		// Recent tools.
		if (view.tools.length > 0) {
			lines.push(fit(dim("recent tools:")));
			for (const tool of view.tools) {
				const icon = tool.running ? theme.fg("accent", "●") : tool.isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
				const summary = tool.summary ? dim(` ${clean(tool.summary)}`) : "";
				lines.push(fit(`  ${icon} ${clean(tool.tool)}${summary}`));
			}
		}

		// Append-only trajectory (current generation, most recent last).
		if (view.trajectory.length > 0) {
			const genLabel = view.generation !== undefined ? `gen ${view.generation} ` : "";
			lines.push(fit(dim(`trajectory (${genLabel}latest ${view.trajectory.length} of ${view.trajectoryTotal}):`)));
			for (const event of view.trajectory) {
				lines.push(fit(`  ${dim(`${timeOf(event.at)} `)}${formatTrajectoryEvent(event)}`));
			}
		}
		return lines;
	}
}

function safeText(text: string): string {
	return stripVTControlCharacters(text);
}

function oneLine(text: string): string {
	return safeText(text).replace(/\s+/g, " ").trim();
}

/** Last `max` lines of a possibly multi-line, already collected stream. */
function tailLines(text: string, max: number): string[] {
	const lines = safeText(text).split("\n");
	const tail = lines.slice(-max).map((line) => line.replace(/\s+$/, ""));
	return tail;
}

function timeOf(at: number): string {
	try {
		const d = new Date(at);
		return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
	} catch {
		return "--:--:--";
	}
}

function padRight(line: string, width: number): string {
	const visible = visibleWidth(line);
	return visible >= width ? line : `${line}${" ".repeat(width - visible)}`;
}

function errorMessageText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function registerInspectorCommand(pi: ExtensionAPI, runtime: SubagentRuntime): void {
	pi.registerCommand("subagents-inspect", {
		description:
			"Open the live sub-agent inspector overlay: threads, streaming output, recent tools, and the append-only trajectory per run",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/subagents-inspect requires Pi's interactive TUI.", "error");
				return;
			}
			await ctx.ui.custom<undefined>(
				(tui, theme, _keybindings, done) =>
					new InspectorOverlay({
						runtime,
						tui,
						theme,
						done: () => done(undefined),
						notify: (message) => {
							try {
								ctx.ui.notify(message, "warning");
							} catch {
								/* notification failures are non-fatal */
							}
						},
					}),
				{ overlay: true, overlayOptions: { width: "92%", maxHeight: "88%" } },
			);
		},
	});
}
