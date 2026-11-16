/** Keep changing model assignments outside the stable orchestration contract. */

import type { SubagentsConfig } from "../configuration/config.ts";
import {
	availableModelsInScope, currentModelRef, modelRef, resolveAgentModelRoute, type ModelContext,
} from "../configuration/models.ts";

export const ORCHESTRATION_SECTION = "subagent_orchestration";

export function buildOrchestrationSection(config: SubagentsConfig, ctx: ModelContext): string {
	const mainRef = currentModelRef(ctx);
	const route = resolveAgentModelRoute({
		selectedRef: config.model, mainRef, availableRefs: availableModelsInScope(ctx).map(modelRef),
	});
	return [
		"Main judges difficulty, plans, handles complex work, and reviews: " + (mainRef ?? "Pi default"),
		"Workers execute: " + (route.unavailableSelectedRef ? "unavailable (" + route.unavailableSelectedRef + ")" : route.primaryRef ?? "Pi default") + " (thinking preference: " + config.thinking + "; clamped per model)",
		...(route.unavailableSelectedRef ? ["Dispatch is blocked. Restore worker availability or choose a model in /subagents-setup."] : []),
		"Worker failures return to main with evidence; never auto-upgrade a worker to main. No price or quality ordering is assumed.",
		...(!config.model ? ["Workers currently follow main; choose a cheaper model in /subagents-setup to reduce main-model spending."] : []),
	].join("\n");
}
