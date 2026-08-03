/**
 * Model availability helpers shared by setup and sub-agent execution.
 *
 * A configured override can outlive a provider login, a scoped-model change, or
 * a model rename. Keep the main session usable by replacing such overrides with
 * the model currently selected in the main window (or the first available model)
 * and let callers persist the repaired mapping.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export type ModelContext = Pick<ExtensionContext, "model" | "scopedModels" | "modelRegistry">;

export interface ModelOverrideRepair {
	agentModels: Record<string, string>;
	changed: boolean;
	replaced: number;
	removed: number;
	fallbackRef?: string;
}

export function modelRef(model: { provider: string; id: string }): string {
	return `${model.provider}/${model.id}`;
}

/**
 * Return model references usable by the current main window, with its current
 * model first so it is the deterministic fallback for stale configuration.
 */
export function availableModelRefs(ctx: ModelContext): string[] {
	const scoped = ctx.scopedModels.length > 0 ? ctx.scopedModels.map((entry) => entry.model) : undefined;
	const models = scoped ?? ctx.modelRegistry.getAvailable();
	const refs = [...new Set(models.map(modelRef))];
	const currentRef = ctx.model ? modelRef(ctx.model) : undefined;
	if (!currentRef) return refs;
	return [currentRef, ...refs.filter((ref) => ref !== currentRef)];
}

/** Replace unavailable persisted overrides with a model usable by the main session. */
export function repairUnavailableModelOverrides(
	ctx: ModelContext,
	agentModels: Record<string, string>,
): ModelOverrideRepair {
	const refs = availableModelRefs(ctx);
	const available = new Set(refs);
	const fallbackRef = refs[0];
	const repaired: Record<string, string> = {};
	let changed = false;
	let replaced = 0;
	let removed = 0;

	for (const [name, configuredRef] of Object.entries(agentModels)) {
		const ref = configuredRef.trim();
		if (available.has(ref)) {
			repaired[name] = ref;
			continue;
		}

		changed = true;
		if (fallbackRef) {
			repaired[name] = fallbackRef;
			replaced++;
		} else {
			removed++;
		}
	}

	return { agentModels: repaired, changed, replaced, removed, fallbackRef };
}
