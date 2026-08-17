/*
 * Model-pool resolution and setup-picker helpers.
 *
 * Runtime pools deliberately do not filter configured references by current
 * availability: a stale primary/backup is attempted and normal provider/model
 * failure handling advances to the next candidate. Setup uses the same catalog
 * only for honest availability labels; it never rewrites persisted choices.
 */

import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export type ModelContext = Pick<ExtensionContext, "model" | "modelRegistry"> &
	Partial<Pick<ExtensionContext, "scopedModels">>;

export const CURRENT_MAIN_MODEL = "__current_main_model__";

export type ModelPoolSlot = "primary" | "backup";
export type ModelPickerSlot = ModelPoolSlot | "vision";

export interface ModelPickerItem {
	value: string;
	label: string;
	description?: string;
}

export type ModelListEntry = Pick<
	Model<Api>,
	"provider" | "id" | "name" | "input" | "reasoning"
>;

export interface ResolvedAgentModelPool {
	/** Effective first candidate. Undefined means let pi use its normal default. */
	primaryRef?: string;
	/** Ordered candidates after the primary, already deduplicated. */
	fallbackModelRefs: string[];
	/** All known references in runtime order, useful for tests/inspection. */
	candidateRefs: string[];
}

export interface AgentModelPoolInput {
	primaryRef?: string;
	backupRef?: string;
	mainRef?: string;
	declaredDefaultRef?: string;
}

export interface AgentModelPoolMaps {
	agentModels: Record<string, string>;
	agentBackupModels: Record<string, string>;
}

export interface AgentModelPoolRow {
	name: string;
	primary: string;
	backup: string;
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
	// scopedModels was added after the declared Pi 0.80.6 minimum. Treat a
	// missing field exactly like an empty scope and use the full live registry.
	const scopedModels = ctx.scopedModels ?? [];
	if (scopedModels.length === 0) return models;
	const scopedRefs = new Set(scopedModels.map((entry) => modelRef(entry.model)));
	return models.filter((model) => scopedRefs.has(modelRef(model)));
}

/**
 * Resolve one agent's ordered runtime pool:
 *
 * configured primary -> configured backup -> current main-window model
 *
 * Without a primary override, the current main model remains the primary; an
 * agent-declared default is used only when no main model exists. Equal refs are
 * removed without consulting availability, so stale refs stay in the chain and
 * fail normally at runtime instead of being silently repaired.
 */
export function resolveAgentModelPool(input: AgentModelPoolInput): ResolvedAgentModelPool {
	const mainRef = cleanModelRef(input.mainRef);
	const primaryRef = cleanModelRef(input.primaryRef) ?? mainRef ?? cleanModelRef(input.declaredDefaultRef);
	const ordered = [primaryRef, cleanModelRef(input.backupRef), mainRef];
	const seen = new Set<string>();
	const candidateRefs: string[] = [];
	for (const ref of ordered) {
		if (!ref || seen.has(ref)) continue;
		seen.add(ref);
		candidateRefs.push(ref);
	}
	const fallbackModelRefs = candidateRefs.filter((ref) => ref !== primaryRef);
	return { primaryRef, fallbackModelRefs, candidateRefs };
}

function modelCapabilities(model: ModelListEntry): string {
	const capabilities = [model.input.includes("image") ? "vision" : "text-only"];
	if (model.reasoning) capabilities.push("reasoning");
	return capabilities.join(" + ");
}

/** Build the single searchable model list shared by primary/backup/vision picks.
 * Only refs Pi currently reports as available are shown, which means providers
 * without a configured API key/OAuth session never flood the setup picker. */
export function buildModelPickerItems(options: {
	models: readonly ModelListEntry[];
	availableRefs: readonly string[];
	slot: ModelPickerSlot;
	configuredRef?: string;
	mainRef?: string;
}): ModelPickerItem[] {
	const configuredRef = cleanModelRef(options.configuredRef);
	const mainRef = cleanModelRef(options.mainRef);
	const available = new Set(options.availableRefs.map((ref) => ref.trim()));
	const byRef = new Map<string, ModelListEntry>();
	for (const model of options.models) {
		const ref = modelRef(model);
		if (available.has(ref) && !byRef.has(ref)) byRef.set(ref, model);
	}

	const refs = [...byRef.keys()]
		.filter((ref) => options.slot !== "vision" || byRef.get(ref)?.input.includes("image") === true)
		.sort((left, right) => {
			const leftRank = left === configuredRef ? 0 : left === mainRef ? 1 : 2;
			const rightRank = right === configuredRef ? 0 : right === mainRef ? 1 : 2;
			return leftRank - rightRank || left.localeCompare(right);
		});

	const dynamic = options.slot === "backup"
		? {
			value: CURRENT_MAIN_MODEL,
			label: "Current main model (default)",
			description: "Clear configured backup; use the main-window model dynamically",
		}
		: {
			value: CURRENT_MAIN_MODEL,
			label: "Current main model (dynamic)",
			description: options.slot === "vision"
				? "Clear vision override; use the main-window model for vision tasks"
				: "Clear primary override; use the main-window model dynamically",
		};

	const items: ModelPickerItem[] = [dynamic];
	for (const ref of refs) {
		const model = byRef.get(ref)!;
		const tags = ["available"];
		if (ref === configuredRef) tags.push("configured");
		if (ref === mainRef) tags.push("current main");
		const name = model.name.trim() && model.name !== model.id ? model.name.trim() : undefined;
		items.push({
			value: ref,
			label: ref,
			description: [name, modelCapabilities(model), ...tags].filter(Boolean).join(" · "),
		});
	}
	return items;
}

/** Pure pool update: the dynamic/default choice removes the persisted override. */
export function applyModelPoolChoice(
	current: AgentModelPoolMaps,
	agentName: string,
	slot: ModelPoolSlot,
	choice: string,
): AgentModelPoolMaps {
	const next: AgentModelPoolMaps = {
		agentModels: { ...current.agentModels },
		agentBackupModels: { ...current.agentBackupModels },
	};
	const target = slot === "primary" ? next.agentModels : next.agentBackupModels;
	if (choice === CURRENT_MAIN_MODEL) delete target[agentName];
	else target[agentName] = choice.trim();
	return next;
}

/** Pure rows used by the overview component and focused helper tests. */
export function buildAgentModelPoolRows(
	agentNames: readonly string[],
	pools: AgentModelPoolMaps,
): AgentModelPoolRow[] {
	return agentNames.map((name) => ({
		name,
		primary: pools.agentModels[name] ?? "Main (dynamic)",
		backup: pools.agentBackupModels[name] ?? "Main (default)",
	}));
}
