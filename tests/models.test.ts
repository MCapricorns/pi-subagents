import { describe, expect, it } from "vitest";
import { availableModelRefs, repairUnavailableModelOverrides, type ModelContext } from "../src/models.ts";

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

describe("repairUnavailableModelOverrides", () => {
	it("replaces stale overrides with the current main-window model", () => {
		const result = repairUnavailableModelOverrides(
			context("openai/current", ["openai/current"]),
			{ explore: "anthropic/removed", worker: "openai/current" },
		);
		expect(result.agentModels).toEqual({ explore: "openai/current", worker: "openai/current" });
		expect(result.changed).toBe(true);
		expect(result.replaced).toBe(1);
		expect(result.fallbackRef).toBe("openai/current");
	});

	it("uses the first available model when there is no current model", () => {
		const result = repairUnavailableModelOverrides(context(undefined, ["openai/available"]), {
			explore: "anthropic/removed",
		});
		expect(result.agentModels).toEqual({ explore: "openai/available" });
	});

	it("removes stale overrides when no model is available", () => {
		const result = repairUnavailableModelOverrides(context(), { explore: "anthropic/removed" });
		expect(result.agentModels).toEqual({});
		expect(result.removed).toBe(1);
	});
});
