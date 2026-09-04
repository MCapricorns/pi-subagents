/** Session-start recovery, stale-model cleanup, and progress-surface installation. */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { FIRST_RUN_SETUP_HINT, loadConfig, saveConfig } from "../configuration/config.ts";
import { availableModelsInScope, filterUnavailableModelOverrides } from "../configuration/models.ts";
import { announceRecoveryRecords, relocateRecoveryManifest } from "../isolation/recovery.ts";
import type { SubagentRuntime } from "../lifecycle/runtime.ts";
import { installActiveRunsStatus } from "./status.ts";
import { installActiveRunsWidget } from "./widget.ts";

/** Drop unavailable model overrides back to dynamic main-model routing. */
async function removeUnavailableAgentModels(
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
			`pi-subagents: removed stale agent model overrides that are no longer available (${list}). Those agents now use their role's default model route; run /subagents-setup to re-pick.`,
			"warning",
		);
	} catch {
		/* stale-model cleanup is non-fatal */
	}
}

export function registerAnnouncements(pi: ExtensionAPI, runtime: SubagentRuntime): void {
	pi.on("session_start", async (_event, ctx) => {
		if (!existsSync(runtime.configPath)) {
			ctx.ui.notify(`pi-subagents: ${FIRST_RUN_SETUP_HINT}`, "info");
		}
		await relocateRecoveryManifest(runtime.configPath);
		await announceRecoveryRecords(runtime.configPath, ctx);
		await removeUnavailableAgentModels(ctx, runtime);
		// Bootstrap also runs on session_start; wait so this notice sees restored
		// threads instead of racing an empty list.
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
