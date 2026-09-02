/** Session-start recovery, stale-config migration, and progress-surface installation. */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { FIRST_RUN_SETUP_HINT, loadConfig, saveConfig } from "./config.ts";
import { availableModelsInScope, filterUnavailableModelOverrides } from "./models.ts";
import { announceRecoveryRecords } from "./recovery.ts";
import type { SubagentRuntime } from "./runtime.ts";
import { installActiveRunsStatus } from "./status.ts";
import { installActiveRunsWidget } from "./widget.ts";

/**
 * One-time-per-stale-override migration: keep agent model selections Pi still
 * reports as available, drop the rest back to dynamic main-model routing, and
 * tell the user what was removed. Saving the cleaned config is what makes it
 * one-time — the dropped refs no longer exist to re-trigger the notice.
 */
async function migrateUnavailableAgentModels(
	ctx: { ui: { notify: (message: string, kind: "info" | "warning" | "error") => void } } & Parameters<typeof availableModelsInScope>[0],
	runtime: SubagentRuntime,
): Promise<void> {
	try {
		const config = await loadConfig(runtime.configPath);
		const overrides = Object.entries(config.agentModels);
		if (overrides.length === 0) return;
		const { kept, dropped } = filterUnavailableModelOverrides(config.agentModels, availableModelsInScope(ctx));
		if (dropped.length === 0) return;
		await saveConfig({ ...config, agentModels: kept }, runtime.configPath);
		const list = dropped.map(({ agent, ref }) => `${agent}: ${ref}`).join(", ");
		ctx.ui.notify(
			`pi-subagents: removed stale agent model overrides that are no longer available (${list}). Those agents now follow the current main model; run /subagents-setup to re-pick.`,
			"warning",
		);
	} catch {
		/* migration failures are non-fatal */
	}
}

export function registerAnnouncements(pi: ExtensionAPI, runtime: SubagentRuntime): void {
	pi.on("session_start", async (_event, ctx) => {
		if (!existsSync(runtime.configPath)) {
			ctx.ui.notify(`pi-subagents: ${FIRST_RUN_SETUP_HINT}`, "info");
		}
		await announceRecoveryRecords(runtime.configPath, ctx);
		await migrateUnavailableAgentModels(ctx, runtime);
		try {
			const config = await loadConfig(runtime.configPath);
			if (config.pendingSetupNotice) {
				ctx.ui.notify(`pi-subagents: ${config.pendingSetupNotice}`, "info");
				const { pendingSetupNotice: _cleared, ...rest } = config;
				await saveConfig(rest, runtime.configPath);
			}
		} catch {
			/* notice is non-fatal */
		}
		// Restore starts at extension load and session_start fires right behind
		// it, so without this the notice reports whatever the race left behind.
		await runtime.durableRestore;
		if (!runtime.restoredNotified && runtime.restoredRunIds.length > 0) {
			runtime.restoredNotified = true;
			const ids = runtime.restoredRunIds.map((id) => `#${id}`).join(", ");
			ctx.ui.notify(
				`pi-subagents: restored ${runtime.restoredRunIds.length} interrupted thread${runtime.restoredRunIds.length === 1 ? "" : "s"} (${ids}) with retained context. subagent_control resume continues one.`,
				"info",
			);
		}
		// The footer status works in every UI host (TUI and RPC); the widget is TUI-only.
		installActiveRunsStatus(ctx);
		if (ctx.mode !== "tui") return;
		installActiveRunsWidget(ctx);
	});

	// Compaction failures are otherwise silent in long orchestration sessions
	// where subagent results accumulate; aborted (user-cancelled) compactions
	// are deliberate and not worth a notice.
	pi.on("session_compact_failed", async (event, ctx) => {
		if (event.aborted && !event.errorMessage) return;
		const detail = event.errorMessage ? `: ${event.errorMessage}` : "";
		if (event.willRetry) {
			ctx.ui.notify(`pi-subagents: session compaction failed${detail} — retrying automatically.`, "warning");
			return;
		}
		ctx.ui.notify(
			`pi-subagents: session compaction failed${detail}. Long threads may hit context limits soon; run /compact to retry or trim old results.`,
			"error",
		);
	});
}
