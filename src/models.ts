/*
 * Model routing, capability-aware thinking, and setup-picker helpers.
 *
 * Runtime has one explicit fallback only: a configured agent model hands
 * off directly to the current main-window model. Setup lists only currently
 * available models and derives thinking choices from Pi's model metadata.
 */

import {
	clampThinkingLevel,
	getSupportedThinkingLevels,
	type Api,
	type Model,
} from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_THINKING_LEVEL, type ThinkingLevel } from "./config.ts";

export type ModelContext = Pick<ExtensionContext, "model" | "modelRegistry"> &
	Partial<Pick<ExtensionContext, "scopedModels">>;

export const CURRENT_MAIN_MODEL = "__current_main_model__";

export interface ModelPickerItem {
	value: string;
	label: string;
	description?: string;
}

export type ModelListEntry = Pick<
	Model<Api>,
	"provider" | "id" | "name" | "input" | "reasoning" | "thinkingLevelMap"
>;

export interface ResolvedAgentModelRoute {
	/** Effective first candidate. Undefined means let Pi use its normal default. */
	primaryRef?: string;
	/** Current main-window model when it differs from the selection. */
	mainFallbackRef?: string;
	/** Runtime order, useful for status/tests. */
	candidateRefs: string[];
	/** Configured ref skipped because Pi does not currently report it available. */
	unavailableSelectedRef?: string;
}

export interface AgentModelRouteInput {
	selectedRef?: string;
	mainRef?: string;
	declaredDefaultRef?: string;
	/** When supplied, a configured selection outside this live set is skipped. */
	availableRefs?: readonly string[];
}

function cleanModelRef(ref: string | undefined): string | undefined {
	const trimmed = ref?.trim();
	return trimmed || undefined;
}

export function modelRef(model: { provider: string; id: string }): string {
	return `${model.provider}/${model.id}`;
}

export function currentModelRef(ctx: Pick<ModelContext, "model">): string | undefined {
	return ctx.model ? modelRef(ctx.model) : undefined;
}

/**
 * Current authenticated registry models narrowed by the session scope. Scope
 * entries are a session snapshot, so they act only as a whitelist; the live
 * registry remains the source of truth for availability and model metadata.
 */
export function availableModelsInScope(ctx: ModelContext): readonly Model<Api>[] {
	const models = ctx.modelRegistry.getAvailable();
	// scopedModels was added after the original Pi minimum. Treat a missing field
	// exactly like an empty scope and use the full live registry.
	const scopedModels = ctx.scopedModels ?? [];
	if (scopedModels.length === 0) return models;
	const scopedRefs = new Set(scopedModels.map((entry) => modelRef(entry.model)));
	return models.filter((model) => scopedRefs.has(modelRef(model)));
}

export function findModelByRef(
	models: readonly Model<Api>[],
	ref: string | undefined,
): Model<Api> | undefined {
	const normalized = cleanModelRef(ref);
	return normalized ? models.find((model) => modelRef(model) === normalized) : undefined;
}

/** Split persisted agent model overrides into the ones Pi still reports as
 * available and the stale ones. Stale refs are dropped at session start (with
 * a user notice) so the config never carries models that can no longer run. */
export function filterUnavailableModelOverrides(
	agentModels: Record<string, string>,
	models: readonly Model<Api>[],
): { kept: Record<string, string>; dropped: Array<{ agent: string; ref: string }> } {
	const kept: Record<string, string> = {};
	const dropped: Array<{ agent: string; ref: string }> = [];
	for (const [agent, ref] of Object.entries(agentModels)) {
		if (findModelByRef(models, ref)) kept[agent] = ref;
		else dropped.push({ agent, ref });
	}
	return { kept, dropped };
}

/**
 * Resolve one agent's runtime route:
 *
 * configured selection -> current main-window model
 *
 * Without an override, current main is primary; the agent-declared default is
 * used only when no main model exists. A configured selection that Pi no longer
 * reports as available is skipped immediately instead of spawning a doomed child.
 */
export function resolveAgentModelRoute(input: AgentModelRouteInput): ResolvedAgentModelRoute {
	const selectedRef = cleanModelRef(input.selectedRef);
	const mainRef = cleanModelRef(input.mainRef);
	const declaredDefaultRef = cleanModelRef(input.declaredDefaultRef);
	const available = input.availableRefs
		? new Set(input.availableRefs.map((ref) => ref.trim()).filter(Boolean))
		: undefined;
	const selectedAvailable = !selectedRef || !available || available.has(selectedRef);
	const usableSelectedRef = selectedAvailable ? selectedRef : undefined;
	const primaryRef = usableSelectedRef ?? mainRef ?? declaredDefaultRef;
	const ordered = [primaryRef, usableSelectedRef && usableSelectedRef !== mainRef ? mainRef : undefined];
	const candidateRefs = [...new Set(ordered.filter((ref): ref is string => Boolean(ref)))];
	return {
		primaryRef,
		...(candidateRefs[1] ? { mainFallbackRef: candidateRefs[1] } : {}),
		candidateRefs,
		...(!selectedAvailable && selectedRef ? { unavailableSelectedRef: selectedRef } : {}),
	};
}

/** The exact levels Pi exposes for this model, including `off` when supported. */
export function supportedThinkingLevels(model: Model<Api> | undefined): ThinkingLevel[] {
	return model ? (getSupportedThinkingLevels(model) as ThinkingLevel[]) : [];
}

/** Clamp an agent preference to the effective model's actual capability map. */
export function resolveThinkingLevel(
	model: Model<Api> | undefined,
	preferred: ThinkingLevel = DEFAULT_THINKING_LEVEL,
): ThinkingLevel {
	return model ? (clampThinkingLevel(model, preferred) as ThinkingLevel) : preferred;
}

function modelCapabilities(model: ModelListEntry): string {
	const input = model.input.includes("image") ? "vision" : "text-only";
	const thinking = getSupportedThinkingLevels(model as Model<Api>).join("/");
	return `${input} · thinking: ${thinking}`;
}

/** Build one searchable list for agent model selection. Only models Pi
 * currently reports as available are supplied by setup. */
export function buildModelPickerItems(options: {
	models: readonly ModelListEntry[];
	configuredRef?: string;
	mainRef?: string;
}): ModelPickerItem[] {
	const configuredRef = cleanModelRef(options.configuredRef);
	const mainRef = cleanModelRef(options.mainRef);
	const byRef = new Map<string, ModelListEntry>();
	for (const model of options.models) {
		const ref = modelRef(model);
		if (!byRef.has(ref)) byRef.set(ref, model);
	}

	const refs = [...byRef.keys()]
		.sort((left, right) => {
			const leftRank = left === configuredRef ? 0 : left === mainRef ? 1 : 2;
			const rightRank = right === configuredRef ? 0 : right === mainRef ? 1 : 2;
			return leftRank - rightRank || left.localeCompare(right);
		});

	const dynamic: ModelPickerItem = {
		value: CURRENT_MAIN_MODEL,
		label: "Current main model (dynamic)",
		description: "Clear agent override; use the current main model dynamically",
	};
	const items: ModelPickerItem[] = [dynamic];
	for (const ref of refs) {
		const model = byRef.get(ref)!;
		const tags = [ref === configuredRef ? "configured" : "", ref === mainRef ? "current main" : ""]
			.filter(Boolean);
		const name = model.name.trim() && model.name !== model.id ? model.name.trim() : undefined;
		items.push({
			value: ref,
			label: ref,
			description: [name, modelCapabilities(model), ...tags].filter(Boolean).join(" · "),
		});
	}
	return items;
}

/** The dynamic choice removes the persisted per-agent override. */
export function applyAgentModelChoice(
	current: Record<string, string>,
	agentName: string,
	choice: string,
): Record<string, string> {
	const next = { ...current };
	if (choice === CURRENT_MAIN_MODEL) delete next[agentName];
	else next[agentName] = choice.trim();
	return next;
}
