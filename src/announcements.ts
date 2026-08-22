/** Session-start recovery and one-time feature announcements. */

import { stat } from "node:fs/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadConfig, saveConfig } from "./config.ts";
import { announceRecoveryRecords } from "./recovery.ts";
import type { SubagentRuntime } from "./runtime.ts";
import { pruneResultArtifacts } from "./spawn.ts";
import { installActiveRunsWidget } from "./widget.ts";

const ANNOUNCEMENTS: Array<{
	key: string;
	condition: (config: Awaited<ReturnType<typeof loadConfig>>) => boolean;
	message: string;
}> = [
	{
		key: "cleanerAgent",
		condition: (config) => !config.enabledAgents.includes("cleaner"),
		message:
			"pi-subagents: new built-in cleaner agent is available for evidence-first code cleanup. Run /subagents-setup to enable it; your existing enabledAgents selection was left unchanged.",
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
		for (const announcement of pending) ctx.ui.notify(announcement.message, "info");
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
