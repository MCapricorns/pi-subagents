/** Keep changing model assignments outside the stable orchestration contract. */

import { BUILTIN_AGENT_NAMES, type SubagentsConfig } from "../configuration/config.ts";
import {
	availableModelsInScope, currentModelRef, modelRef, resolveAgentModelRoute, type ModelContext,
} from "../configuration/models.ts";

export const ORCHESTRATION_SECTION = "subagent_orchestration";

export function buildOrchestrationSection(config: SubagentsConfig, ctx: ModelContext): string {
	const mainRef = currentModelRef(ctx);
	const availableRefs = availableModelsInScope(ctx).map(modelRef);
	return [
		"Main judges difficulty, plans, handles complex work, and reviews: " + (mainRef ?? "Pi default"),
		...BUILTIN_AGENT_NAMES.flatMap((role) => {
			const settings = config[role];
			const route = resolveAgentModelRoute({ selectedRef: settings.model, mainRef, availableRefs });
			return [
				role + ": " + (route.unavailableSelectedRef ? "unavailable (" + route.unavailableSelectedRef + ")" : route.primaryRef ?? "Pi default") + " (thinking preference: " + settings.thinking + "; clamped per model)",
				...(route.unavailableSelectedRef ? [role + " dispatch is blocked. Restore availability or choose a model in /subagents-setup."] : []),
				...(!settings.model ? [role + " follows main's model; delegating still keeps main's context focused. Only the user can assign a cheaper model, with /subagents-setup."] : []),
			];
		}),
		"Worker failures return to main with evidence; never auto-upgrade a worker to main. No price or quality ordering is assumed.",
	].join("\n");
}
