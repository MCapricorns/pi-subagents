/** Session-start recovery and one-time feature announcements. */

import { stat } from "node:fs/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CLEANER_AUTO_ENABLED_FEATURE, CLEANER_INHERITED_FEATURE, loadConfig, saveConfig } from "./config.ts";
import { announceRecoveryRecords } from "./recovery.ts";
import type { SubagentRuntime } from "./runtime.ts";
import { pruneResultArtifacts } from "./spawn.ts";
import { installActiveRunsWidget } from "./widget.ts";

const ANNOUNCEMENTS: Array<{
	key: string;
	condition: (config: Awaited<ReturnType<typeof loadConfig>>) => boolean;
	message: (config: Awaited<ReturnType<typeof loadConfig>>) => string;
}> = [
	{
		// Fires once after the load-time upgrade injected cleaner into an older
		// config (the injection stamp only exists in that case). The extra
		// enabledAgents check keeps the notice silent when the user already
		// disabled cleaner (e.g. via full setup) before it could fire.
		key: "cleanerAutoEnabledNotice",
		condition: (config) =>
			config.announcedFeatures.includes(CLEANER_AUTO_ENABLED_FEATURE) &&
			config.enabledAgents.includes("cleaner"),
		// The inheritance clause matches reality: its stamp is only set when the
		// upgrade actually copied reviewer model/thinking settings.
		message: (config) =>
			config.announcedFeatures.includes(CLEANER_INHERITED_FEATURE)
				? "pi-subagents: the built-in cleaner agent was enabled by default and inherited your reviewer model/thinking settings. Run /subagents-setup to adjust or disable it."
				: "pi-subagents: the built-in cleaner agent was enabled by default. Run /subagents-setup to adjust or disable it.",
	},
];

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
				announcedFeatures: [...config.announcedFeatures, ...pending.map((announcement) => announcement.key)],
			},
			runtime.configPath,
		);
		for (const announcement of pending) ctx.ui.notify(announcement.message(config), "info");
	} catch {
		/* announcement failures are non-fatal */
	}
}

export function registerAnnouncements(pi: ExtensionAPI, runtime: SubagentRuntime): void {
	pi.on("session_start", async (_event, ctx) => {
		pruneResultArtifacts();
		await announceRecoveryRecords(runtime.configPath, ctx);
		if (ctx.mode !== "tui") return;
		installActiveRunsWidget(ctx);
		await announceNewFeatures(ctx, runtime);
	});
}
