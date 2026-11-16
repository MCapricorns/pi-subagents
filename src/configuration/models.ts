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

export type ModelContext = Pick<ExtensionContext, "model" | "modelRegistry"> &
	Partial<Pick<ExtensionContext, "scopedModels">>;

export const CURRENT_MAIN_MODEL = "__current_main_model__";

export interface ModelPickerItem {
	value: string;
	label: string;
	description?: string;
	saved?: boolean;
}

export type ModelListEntry = Pick<
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

/**
 * Provider ids Pi renamed while keeping the model id. Pi 1.0.3 renamed
 * `azure-openai-responses` to `azure`. Custom registries can still expose
 * either id, so prefer the exact selection before trying its published alias.
 */
const RENAMED_PROVIDER_IDS: Readonly<Record<string, string>> = {
	"azure-openai-responses": "azure",
};

/** Stored ref plus the renamed provider id, when Pi published one. */
function modelRefAliases(ref: string): readonly string[] {
	const normalized = ref.trim();
	const slash = normalized.indexOf("/");
	if (slash <= 0 || slash >= normalized.length - 1) return [normalized];
	const renamed = RENAMED_PROVIDER_IDS[normalized.slice(0, slash)];
	if (!renamed) return [normalized];
	return [normalized, `${renamed}${normalized.slice(slash)}`];
}

/** Prefer the alias that the live catalog actually lists. */
function resolveLiveModelRef(ref: string, liveRefs: ReadonlySet<string> | undefined): string | undefined {
	const aliases = modelRefAliases(ref);
	if (!liveRefs) return aliases[0];
	return aliases.find((candidate) => liveRefs.has(candidate));
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
	if (!normalized) return undefined;
	const liveRef = resolveLiveModelRef(normalized, new Set(models.map(modelRef)));
	return models.find((model) => modelRef(model) === liveRef);
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
	const resolvedSelectedRef = selectedRef ? resolveLiveModelRef(selectedRef, available) : undefined;
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
	const liveConfiguredRef = configuredRef
		? resolveLiveModelRef(configuredRef, new Set(byRef.keys())) ?? configuredRef
		: undefined;

	const refs = [...byRef.keys()]
		.sort((left, right) => {
			const leftRank = left === liveConfiguredRef ? 0 : left === mainRef ? 1 : 2;
			const rightRank = right === liveConfiguredRef ? 0 : right === mainRef ? 1 : 2;
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
		const tags = [ref === liveConfiguredRef ? "configured" : "", ref === mainRef ? "current main" : ""]
			.filter(Boolean);
		const name = model.name.trim() || model.id;
		const duplicateName = [...byRef.values()].some((other) =>
			other.id !== model.id && other.provider === model.provider && (other.name.trim() || other.id) === name);
		items.push({
			value: ref,
			label: name + " · " + model.provider + (duplicateName ? " (" + model.id + ")" : ""),
			description: ["Reference: " + ref, "Pins this worker; failures return to main without changing models.", modelCapabilities(model), ...tags].join(" · "),
			saved: ref === liveConfiguredRef,
		});
	}
	return items;
}
