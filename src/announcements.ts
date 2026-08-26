/** Session-start recovery, stale-config migration, and widget installation. */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadConfig, saveConfig } from "./config.ts";
import { availableModelsInScope, filterUnavailableModelOverrides } from "./models.ts";
import { announceRecoveryRecords } from "./recovery.ts";
import type { SubagentRuntime } from "./runtime.ts";
import { pruneResultArtifacts } from "./spawn.ts";
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
		pruneResultArtifacts();
		await announceRecoveryRecords(runtime.configPath, ctx);
		await migrateUnavailableAgentModels(ctx, runtime);
		if (ctx.mode !== "tui") return;
		installActiveRunsWidget(ctx);
	});
}
