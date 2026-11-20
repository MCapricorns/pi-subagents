/*
 * Model routing, capability-aware thinking, and setup-picker helpers.
 *
 * A configured worker never escalates to the main model automatically.
 * Setup lists only currently
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

export type ModelContext = Pick<ExtensionContext, "model" | "modelRegistry" | "scopedModels">;

export const CURRENT_MAIN_MODEL = "__current_main_model__";

interface ModelPickerItem {
	value: string;
	label: string;
	description?: string;
	saved?: boolean;
}

type ModelListEntry = Pick<
	Model<Api>,
	"provider" | "id" | "name" | "input" | "reasoning" | "thinkingLevelMap"
>;

export interface ResolvedAgentModelRoute {
	/** Effective first candidate. Undefined means let Pi use its normal default. */
	primaryRef?: string;
	/** Configured ref that blocks dispatch until it is available or changed. */
	unavailableSelectedRef?: string;
}

export interface AgentModelRouteInput {
	selectedRef?: string;
	mainRef?: string;
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
	const scopedModels = ctx.scopedModels;
	if (scopedModels.length === 0) return models;
	const scopedRefs = new Set(scopedModels.map((entry) => modelRef(entry.model)));
	return models.filter((model) => scopedRefs.has(modelRef(model)));
}

export function findModelByRef(
	models: readonly Model<Api>[],
	ref: string | undefined,
): Model<Api> | undefined {
	const normalized = cleanModelRef(ref);
	if (!normalized) return undefined;
	return models.find((model) => modelRef(model) === normalized);
}

/**
 * Resolve one agent's runtime route:
 *
 * Without an override the current main model is primary. An unavailable
 * configured selection blocks dispatch instead of spending main-model quota.
 */
export function resolveAgentModelRoute(input: AgentModelRouteInput): ResolvedAgentModelRoute {
	const selectedRef = cleanModelRef(input.selectedRef);
	const mainRef = cleanModelRef(input.mainRef);
	const available = input.availableRefs
		? new Set(input.availableRefs.map((ref) => ref.trim()).filter(Boolean))
		: undefined;
	const resolvedSelectedRef = selectedRef && (!available || available.has(selectedRef)) ? selectedRef : undefined;
	return {
		primaryRef: selectedRef ? resolvedSelectedRef : mainRef,
		...(selectedRef && !resolvedSelectedRef ? { unavailableSelectedRef: selectedRef } : {}),
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
	const mainRef = cleanModelRef(options.mainRef);
	const byRef = new Map<string, ModelListEntry>();
	for (const model of options.models) {
		const ref = modelRef(model);
		if (!byRef.has(ref)) byRef.set(ref, model);
	}
	const configuredRef = cleanModelRef(options.configuredRef);

	const refs = [...byRef.keys()]
		.sort((left, right) => {
			const leftRank = left === configuredRef ? 0 : left === mainRef ? 1 : 2;
			const rightRank = right === configuredRef ? 0 : right === mainRef ? 1 : 2;
			return leftRank - rightRank || left.localeCompare(right);
		});

	const dynamic: ModelPickerItem = {
		value: CURRENT_MAIN_MODEL,
		label: "Follow main (dynamic)",
		description: "Uses the main window's model, including future changes. Now: " + (mainRef ?? "Pi default") + ". No model is pinned.",
		saved: !configuredRef,
	};
	const items: ModelPickerItem[] = [dynamic];
	for (const ref of refs) {
		const model = byRef.get(ref)!;
		const tags = [ref === configuredRef ? "configured" : "", ref === mainRef ? "current main" : ""]
			.filter(Boolean);
		const name = model.name.trim() || model.id;
		const duplicateName = [...byRef.values()].some((other) =>
			other.id !== model.id && other.provider === model.provider && (other.name.trim() || other.id) === name);
		items.push({
			value: ref,
			label: name + " · " + model.provider + (duplicateName ? " (" + model.id + ")" : ""),
			description: ["Reference: " + ref, "Pins this role; failures return to main without changing models.", modelCapabilities(model), ...tags].join(" · "),
			saved: ref === configuredRef,
		});
	}
	return items;
}
