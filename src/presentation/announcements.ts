/** Session-start recovery, worker availability, and progress-surface installation. */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { BUILTIN_AGENT_NAMES, errorMessage, loadConfig } from "../configuration/config.ts";
import { availableModelsInScope, findModelByRef } from "../configuration/models.ts";
import { ensureDefaultConfig } from "../configuration/setup.ts";
import { announceRecoveryRecords } from "../isolation/recovery.ts";
import type { SubagentRuntime } from "../lifecycle/runtime.ts";
import { installActiveRunsWidget } from "./widget.ts";

/** Preserve the worker choice during outages instead of spending main-model quota. */
async function checkWorkerModel(
	ctx: Pick<ExtensionContext, "ui" | "modelRegistry"> & Partial<Pick<ExtensionContext, "model" | "scopedModels">>,
	runtime: SubagentRuntime,
): Promise<void> {
	let config;
	try {
		config = await loadConfig(runtime.configPath);
	} catch (error) {
		ctx.ui.notify(
			`pi-subagents: ${errorMessage(error)} Dispatch is paused until the settings file is repaired.`,
			"warning",
		);
		return;
	}
	try {
		const models = availableModelsInScope({
			model: ctx.model,
			modelRegistry: ctx.modelRegistry,
			scopedModels: ctx.scopedModels ?? [],
		});
		for (const role of BUILTIN_AGENT_NAMES) {
			const ref = config[role].model;
			if (!ref || findModelByRef(models, ref)) continue;
			ctx.ui.notify(
				`pi-subagents: ${role} model ${ref} is unavailable. Its setting is preserved and dispatch is paused for this role. Restore availability or run /subagents-setup to choose another.`,
				"warning",
			);
		}
	} catch {
		/* availability notices are non-fatal */
	}
}

export function registerAnnouncements(pi: ExtensionAPI, runtime: SubagentRuntime): void {
	pi.on("session_start", async (_event, ctx) => {
		await ensureDefaultConfig(ctx, runtime.configPath);
		try {
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
