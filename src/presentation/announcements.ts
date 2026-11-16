/** Session-start recovery, worker availability, and progress-surface installation. */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadConfig, saveConfig } from "../configuration/config.ts";
import { findModelByRef, modelRef } from "../configuration/models.ts";
import { ensureDefaultConfig } from "../configuration/setup.ts";
import { announceRecoveryRecords, relocateRecoveryManifest } from "../isolation/recovery.ts";
import type { SubagentRuntime } from "../lifecycle/runtime.ts";
import { installActiveRunsWidget } from "./widget.ts";

/** Preserve the worker choice during outages instead of spending main-model quota. */
async function checkWorkerModel(
	ctx: Pick<ExtensionContext, "ui" | "modelRegistry">,
	runtime: SubagentRuntime,
): Promise<void> {
	try {
		const config = await loadConfig(runtime.configPath);
		if (!config.model) return;
		const selected = findModelByRef(ctx.modelRegistry.getAvailable(), config.model);
		const liveRef = selected ? modelRef(selected) : undefined;
		if (liveRef === config.model) return;
		if (liveRef) {
			await saveConfig({ ...config, model: liveRef }, runtime.configPath);
			return;
		}
		ctx.ui.notify(
			`pi-subagents: worker model ${config.model} is unavailable. Its setting is preserved and dispatch is paused. Restore availability or run /subagents-setup to choose another.`,
			"warning",
		);
	} catch {
		/* availability notices are non-fatal */
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
		await checkWorkerModel(ctx, runtime);
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
