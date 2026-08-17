import { describe, expect, it } from "vitest";
import {
	CURRENT_MAIN_MODEL,
	applyModelPoolChoice,
	availableModelRefs,
	buildAgentModelPoolRows,
	buildModelPickerItems,
	resolveAgentModelPool,
	type ModelContext,
} from "../src/models.ts";

function context(current?: string, available: string[] = []): ModelContext {
	const model = current ? (toModel(current) as unknown as ModelContext["model"]) : undefined;
	return {
		model,
		scopedModels: [],
		modelRegistry: {
			getAvailable: () => available.map(toModel),
		} as ModelContext["modelRegistry"],
	};
}

function toModel(ref: string): { provider: string; id: string } {
	const slash = ref.indexOf("/");
	return { provider: ref.slice(0, slash), id: ref.slice(slash + 1) };
}

describe("availableModelRefs", () => {
	it("puts the current main-window model first", () => {
		expect(availableModelRefs(context("openai/current", ["anthropic/other", "openai/current"]))).toEqual([
			"openai/current",
			"anthropic/other",
		]);
	});

	it("uses scoped models instead of the full registry", () => {
		const ctx = context(undefined, ["openai/registry"]);
		ctx.scopedModels = [{ model: toModel("anthropic/scoped") }] as unknown as ModelContext["scopedModels"];
		expect(availableModelRefs(ctx)).toEqual(["anthropic/scoped"]);
	});
});

describe("resolveAgentModelPool", () => {
	it("uses the current main model as the implicit backup", () => {
		expect(resolveAgentModelPool({ primaryRef: "anthropic/primary", mainRef: "openai/main" })).toEqual({
			primaryRef: "anthropic/primary",
			fallbackModelRefs: ["openai/main"],
			candidateRefs: ["anthropic/primary", "openai/main"],
		});
	});

	it("orders configured backup before the current main model", () => {
		expect(resolveAgentModelPool({
			primaryRef: "anthropic/primary",
			backupRef: "google/backup",
			mainRef: "openai/main",
		}).candidateRefs).toEqual(["anthropic/primary", "google/backup", "openai/main"]);
	});

	it("deduplicates equal refs without changing order", () => {
		expect(resolveAgentModelPool({
			primaryRef: "openai/main",
			backupRef: "openai/main",
			mainRef: "openai/main",
		}).candidateRefs).toEqual(["openai/main"]);
		expect(resolveAgentModelPool({
			primaryRef: "anthropic/primary",
			backupRef: "openai/main",
			mainRef: "openai/main",
		}).fallbackModelRefs).toEqual(["openai/main"]);
	});

	it("keeps stale or unavailable configured refs in the chain", () => {
		expect(resolveAgentModelPool({
			primaryRef: "removed/primary",
			backupRef: "logged-out/backup",
			mainRef: "openai/main",
		}).candidateRefs).toEqual(["removed/primary", "logged-out/backup", "openai/main"]);
	});

	it("uses the main model when primary is unset, then the declared default only without a main model", () => {
		expect(resolveAgentModelPool({ backupRef: "google/backup", mainRef: "openai/main", declaredDefaultRef: "agent/default" })).toEqual({
			primaryRef: "openai/main",
			fallbackModelRefs: ["google/backup"],
			candidateRefs: ["openai/main", "google/backup"],
		});
		expect(resolveAgentModelPool({ declaredDefaultRef: "agent/default" }).candidateRefs).toEqual(["agent/default"]);
	});
});

describe("model-pool setup helpers", () => {
	const models = [
		{
			provider: "anthropic",
			id: "claude-vision",
			name: "Claude Vision",
			input: ["text", "image"] as ("text" | "image")[],
			reasoning: true,
		},
		{
			provider: "openai",
			id: "gpt-fast",
			name: "gpt-fast",
			input: ["text"] as ("text" | "image")[],
			reasoning: false,
		},
	];

	it("builds one searchable list with dynamic/default choices and concise refs", () => {
		const primary = buildModelPickerItems({
			models,
			availableRefs: ["openai/gpt-fast"],
			slot: "primary",
			mainRef: "openai/gpt-fast",
		});
		expect(primary[0]).toMatchObject({ value: CURRENT_MAIN_MODEL, label: "Current main model (dynamic)" });
		expect(primary.map((item) => item.label)).toContain("anthropic/claude-vision");
		expect(primary.find((item) => item.value === "anthropic/claude-vision")?.description).toContain("vision + reasoning");
		expect(primary.find((item) => item.value === "anthropic/claude-vision")?.description).toContain("unavailable");
		expect(primary.find((item) => item.value === "openai/gpt-fast")?.description).toContain("available");

		const backup = buildModelPickerItems({ models, availableRefs: [], slot: "backup" });
		expect(backup[0].label).toBe("Current main model (default)");
	});

	it("offers only image-capable vision models and marks incompatible saved refs", () => {
		const selectable = buildModelPickerItems({
			models,
			availableRefs: ["anthropic/claude-vision", "openai/gpt-fast"],
			slot: "vision",
		});
		expect(selectable.map((item) => item.value)).toContain("anthropic/claude-vision");
		expect(selectable.map((item) => item.value)).not.toContain("openai/gpt-fast");

		const configuredTextOnly = buildModelPickerItems({
			models,
			availableRefs: ["anthropic/claude-vision", "openai/gpt-fast"],
			slot: "vision",
			configuredRef: "openai/gpt-fast",
		});
		expect(configuredTextOnly.find((item) => item.value === "openai/gpt-fast"))
			.toMatchObject({ disabled: true });
		expect(configuredTextOnly.find((item) => item.value === "openai/gpt-fast")?.description)
			.toContain("incompatible with vision");

		const stale = buildModelPickerItems({
			models,
			availableRefs: [],
			slot: "vision",
			configuredRef: "removed/stale-vision",
		});
		expect(stale.find((item) => item.value === "removed/stale-vision"))
			.toMatchObject({ disabled: true });
		expect(stale.find((item) => item.value === "removed/stale-vision")?.description)
			.toContain("incompatible with vision (capability unknown)");
	});

	it("keeps a configured stale ref visible instead of repairing it", () => {
		const items = buildModelPickerItems({
			models,
			availableRefs: ["openai/gpt-fast"],
			slot: "primary",
			configuredRef: "removed/stale",
		});
		expect(items[1]).toEqual({
			value: "removed/stale",
			label: "removed/stale",
			description: "unavailable · configured · saved model reference",
		});
	});

	it("applies primary and backup choices without persisting a dynamic placeholder", () => {
		const initial = {
			agentModels: { worker: "anthropic/primary", reviewer: "openai/reviewer" },
			agentBackupModels: { worker: "google/backup" },
		};
		const cleared = applyModelPoolChoice(initial, "worker", "backup", CURRENT_MAIN_MODEL);
		expect(cleared.agentBackupModels).toEqual({});
		expect(initial.agentBackupModels).toEqual({ worker: "google/backup" });
		const changed = applyModelPoolChoice(cleared, "worker", "primary", "openai/new-primary");
		expect(changed.agentModels).toEqual({ worker: "openai/new-primary", reviewer: "openai/reviewer" });
	});

	it("builds overview rows with primary and backup values together", () => {
		expect(buildAgentModelPoolRows(["explore", "worker"], {
			agentModels: { explore: "anthropic/primary" },
			agentBackupModels: { explore: "openai/backup" },
		})).toEqual([
			{ name: "explore", primary: "anthropic/primary", backup: "openai/backup" },
			{
				name: "worker",
				primary: "Main (dynamic)",
				backup: "Main (default)",
			},
		]);
	});
});
