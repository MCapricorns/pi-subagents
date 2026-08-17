/**
 * session_start wiring: the persistent status widget above the editor, plus
 * one-time feature announcements (a new configurable option is surfaced to the
 * user once after an update; the marker persists in `announcedFeatures`).
 */

import { stat } from "node:fs/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { loadConfig, saveConfig } from "./config.ts";
import {
	activityStateLabel,
	compactLine,
	deriveActivityState,
	formatElapsed,
	formatUsageCompact,
	isRunActiveStatus,
	monitor,
	statusIcon,
	statusLabel,
} from "./monitor.ts";
import { announceRecoveryRecords } from "./recovery.ts";
import type { SubagentRuntime } from "./runtime.ts";

/** Features whose one-time announcement is still pending (keyed by config
 * `announcedFeatures` entry). When the feature's precondition is unmet and the
 * marker is absent, the user is told about it exactly once. */
const ANNOUNCEMENTS: Array<{
	key: string;
	condition: (config: Awaited<ReturnType<typeof loadConfig>>) => boolean;
	message: string;
}> = [
	{
		key: "visionModel",
		condition: (config) => config.visionModel === undefined,
		message:
			"pi-subagents: new — a vision-capable model can now handle image tasks (screenshots, mockups, designs). Run /subagents-setup to configure it; until set, vision tasks use the main session's current model.",
	},
];

/**
 * One-time feature announcements: when an update introduces a new configurable
 * feature, tell the user once (the marker persists in announcedFeatures) so they
 * know it exists — e.g. the vision model, which is unset by default. Only runs
 * when a config file already exists: on a fresh install there is nothing to
 * announce (and writing the file here would make /subagents-setup skip its
 * first-time wizard). A failed announcement must never break session startup.
 */
async function announceNewFeatures(
	ctx: { ui: { notify: (message: string, kind: "info" | "warning" | "error") => void } },
	runtime: SubagentRuntime,
): Promise<void> {
	try {
		let configExists = true;
		try {
			await stat(runtime.configPath);
		} catch {
			configExists = false;
		}
		if (!configExists) return;

		const config = await loadConfig(runtime.configPath);
		const pending = ANNOUNCEMENTS.filter(
			(announcement) =>
				announcement.condition(config) && !config.announcedFeatures.includes(announcement.key),
		);
		if (pending.length === 0) return;
		await saveConfig(
			{
				...config,
				announcedFeatures: [...config.announcedFeatures, ...pending.map((a) => a.key)],
			},
			runtime.configPath,
		);
		for (const announcement of pending) {
			ctx.ui.notify(announcement.message, "info");
		}
	} catch {
		/* announcement failures are non-fatal */
	}
}

export function registerWidget(pi: ExtensionAPI, runtime: SubagentRuntime): void {
	pi.on("session_start", async (_e, ctx) => {
		// Recovery paths survive the old runtime and are shown again in the next
		// UI-capable session before any transient widget state is rebuilt.
		await announceRecoveryRecords(runtime.configPath, ctx);
		if (ctx.mode !== "tui") return;
		await announceNewFeatures(ctx, runtime);

		ctx.ui.setWidget(
			"pi-subagents",
			(tui, theme) => {
				const unsub = monitor.subscribe(() => tui.requestRender());
				// Tick once a second so elapsed time stays live while runs are active.
				const timer = setInterval(() => {
					if (monitor.getRuns().some((r) => isRunActiveStatus(r.status))) {
						tui.requestRender();
					}
				}, 1000);
				return {
					render(width: number): string[] {
						const runs = monitor.getRuns();
						if (runs.length === 0) return [];
						const now = Date.now();
						const lines: string[] = [];
						// Tree layout: each top-level agent is a root whose title/activity hang
						// off it as branches; auto-fix chain runs (groupId) become child nodes
						// under their parent root, with a "│" continuation while more siblings
						// follow. Blank lines separate agent blocks so parallel runs don't blur
						// into one wall of text.
						const dim = (t: string): string => theme.fg("dim", t);
						for (let idx = 0; idx < runs.length; idx++) {
							const r = runs[idx];
							const isChain = Boolean(r.groupId);
							const chainContinues = isChain && runs[idx + 1]?.groupId === r.groupId;
							const activity =
								r.activity && isRunActiveStatus(r.status) ? r.activity : undefined;
							const hasActivity = activity !== undefined;
							const icon = statusIcon(r.status, theme);
							// Chain-internal runs (auto-fix worker/reviewer) are child nodes under
							// their parent reviewer. Their relationLabel ("fix round 1") is more
							// distinguishing than the repeated worker/reviewer name.
							const name = isChain ? (r.relationLabel ?? r.agent) : r.agent;
							// Two lines per run: the header row (icon, run id, agent name) and the
							// live activity branch below. The task summary is deliberately not
							// shown — the task lives in the tool result, and the agent name plus
							// what it is doing right now is enough to tell runs apart. The header
							// stays exactly as it was (accent name, dim stats), matching the
							// referenced sub-agent widgets (tintinweb): the running indicator
							// uses the accent color, everything else is quiet.
							if (!isChain && lines.length > 0) lines.push("");
							const nodeBranch = isChain ? (chainContinues ? "├─ " : "└─ ") : "";
							// Content label (task-derived) trails the agent name so concurrent
							// same-agent runs read as what they do, not just their run id. Chain
							// nodes already carry a distinguishing relationLabel.
							const labelPart = !isChain && r.label ? ` ${dim(`· ${r.label}`)}` : "";
							const left = `${dim(nodeBranch)}${icon} ${dim(`#${r.id}`)} ${isChain ? name : theme.fg("accent", theme.bold(name))}${labelPart}`;

							// Right side: full model ref (provider/model), token usage (in/out +
							// cache read/write), tool count, elapsed, and the soft activity-state
							// annotation (idle / long-running). Trailing the header with a single
							// " · " chain keeps the row compact (no center gap); compactLine
							// clips on overflow, never the right side on its own.
							const model = r.modelFallbackFrom
								? `${r.model ?? "?"} (pool fallback from ${r.modelFallbackFrom})`
								: (r.model ?? "?");
							const usage = formatUsageCompact(r.usage);
							const tools = r.toolCount ? `${r.toolCount} tool${r.toolCount === 1 ? "" : "s"}` : "";
							const elapsed = formatElapsed(r, now);
							// The round outcome summary leads the metadata so a finished chain
							// row reads as what it did ("fail · src/index.ts · render()",
							// "pass", "src/index.ts · tests/monitor.test.ts").
							const isolation = r.isolation === "worktree" ? `worktree ${r.integrationStatus ?? "active"}` : undefined;
							const relation = r.forkedFromRunId !== undefined
								? `fork of #${r.forkedFromRunId}`
								: (r.forkChildRunIds?.length ?? 0) > 0
									? `forks ${r.forkChildRunIds!.map((id) => `#${id}`).join(",")}`
									: undefined;
							const metaParts = [r.summary, relation, isolation, model, usage, tools, elapsed].filter(Boolean);
							// Running is conveyed by the icon + elapsed; spell out the label only for
							// the other states (ready / done / stopped) so they are unambiguous.
							if (r.status !== "running") metaParts.push(statusLabel(r.status));
							const state = deriveActivityState(r, now);
							if (state) metaParts.push(activityStateLabel(state));
							if (r.annotation) metaParts.push(r.annotation);
							// Metadata trails the header in dim — quiet, never competing with the
							// accent agent name (the same restraint the referenced widgets use).
							// Trailing with a single " · " chain keeps the row compact (no center
							// gap); compactLine clips on overflow, never the right side on its own.
							const right = metaParts.length ? dim(` · ${metaParts.join(" · ")}`) : "";
							lines.push(compactLine(left, right, width));

							// Current activity ("read src/index.ts", "bash npm test") is the only
							// branch: gray, so it never competes with the agent name or pi's own
							// UI. Chain nodes that still have siblings carry a "│" continuation
							// down to the last one.
							if (hasActivity) {
								const continuation = isChain ? (chainContinues ? "│  " : "   ") : "";
								lines.push(truncateToWidth(`${continuation}${dim("└─ ")}${dim(activity)}`, width));
							}
						}
						return lines;
					},
					invalidate() {},
					dispose() {
						unsub();
						clearInterval(timer);
					},
				};
			},
			{ placement: "aboveEditor" },
		);
	});
}
