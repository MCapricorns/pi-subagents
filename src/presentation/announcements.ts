/** Session-start recovery, stale-model cleanup, and progress-surface installation. */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadConfig, saveConfig } from "../configuration/config.ts";
import { filterUnavailableModelOverrides } from "../configuration/models.ts";
import { ensureDefaultConfig } from "../configuration/setup.ts";
import { announceRecoveryRecords, relocateRecoveryManifest } from "../isolation/recovery.ts";
import type { SubagentRuntime } from "../lifecycle/runtime.ts";
import { installActiveRunsWidget } from "./widget.ts";

/** Drop overrides that no authenticated model serves back to dynamic
 * main-model routing. A session model scope only narrows this session's
 * routing, so it never deletes a persisted override. */
async function removeUnavailableAgentModels(
	ctx: Pick<ExtensionContext, "ui" | "modelRegistry">,
	runtime: SubagentRuntime,
): Promise<void> {
	try {
		const config = await loadConfig(runtime.configPath);
		const overrides = Object.entries(config.agentModels);
		if (overrides.length === 0) return;
		const { kept, dropped } = filterUnavailableModelOverrides(config.agentModels, ctx.modelRegistry.getAvailable());
		const rewritten = JSON.stringify(kept) !== JSON.stringify(config.agentModels);
		if (!rewritten && dropped.length === 0) return;
		await saveConfig({ ...config, agentModels: kept }, runtime.configPath);
		if (dropped.length === 0) return;
		const list = dropped.map(({ agent, ref }) => `${agent}: ${ref}`).join(", ");
		ctx.ui.notify(
			`pi-subagents: removed model overrides that are no longer available (${list}). Those roles now follow the main model; run /subagents-setup to choose another.`,
			"warning",
		);
	} catch {
		/* stale-model cleanup is non-fatal */
	}
}

export function registerAnnouncements(pi: ExtensionAPI, runtime: SubagentRuntime): void {
	pi.on("session_start", async (_event, ctx) => {
		await ensureDefaultConfig(ctx, runtime.configPath);
		try {
			await relocateRecoveryManifest(runtime.configPath);
			await announceRecoveryRecords(runtime.configPath, ctx);
		} catch (error) {
			// Recovery readers must fail closed for cleanup, but a failed notice
			// must not prevent the rest of the session UI from being installed.
			ctx.ui.notify(`pi-subagents: recovery inspection failed; continuing startup: ${error instanceof Error ? error.message : String(error)}`, "warning");
		}
		await removeUnavailableAgentModels(ctx, runtime);
		// Bootstrap also runs on session_start; wait so this notice sees restored
		// threads instead of racing an empty list.
		await runtime.durableRestore;
		if (!runtime.restoredNotified && runtime.restoredRunIds.length > 0) {
			runtime.restoredNotified = true;
			const ids = runtime.restoredRunIds.map((id) => `#${id}`).join(", ");
			ctx.ui.notify(
				`pi-subagents: restored ${runtime.restoredRunIds.length} interrupted run${runtime.restoredRunIds.length === 1 ? "" : "s"} (${ids}) for manual recovery. Inspect with subagent_status; main finishes the work.`,
				"info",
			);
		}
		// The active-run widget is TUI-only.
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
