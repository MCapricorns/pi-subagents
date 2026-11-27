/** Keep changing model assignments outside the stable orchestration contract. */

import { BUILTIN_AGENT_NAMES, type SubagentsConfig } from "../configuration/config.ts";
import {
	availableModelsInScope, currentModelRef, findModelByRef, modelRef, resolveAgentModelRoute, resolveThinkingLevel, type ModelContext,
} from "../configuration/models.ts";

export const ORCHESTRATION_SECTION = "subagent_orchestration";

export function buildOrchestrationSection(config: SubagentsConfig, ctx: ModelContext): string {
	const mainRef = currentModelRef(ctx);
	const models = availableModelsInScope(ctx);
	const availableRefs = models.map(modelRef);
	return [
		`Main model: ${mainRef ?? "Pi default"}`,
		...BUILTIN_AGENT_NAMES.map((role) => {
			const settings = config[role];
			const route = resolveAgentModelRoute({ selectedRef: settings.model, mainRef, availableRefs });
			if (route.unavailableSelectedRef) return `${role}: dispatch blocked while ${route.unavailableSelectedRef} is unavailable.`;
			const model = route.primaryRef === mainRef ? ctx.model : findModelByRef(models, route.primaryRef);
			const thinking = resolveThinkingLevel(model, settings.thinking);
			return `${role}: ${route.primaryRef ?? "Pi default"}${settings.model ? "" : " (follows main)"} · thinking ${thinking}`;
		}),
	].join("\n");
}
