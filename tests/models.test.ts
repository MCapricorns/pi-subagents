import { describe, expect, it } from "vitest";
import {
	CURRENT_MAIN_MODEL,
	applyAgentModelChoice,
	buildModelPickerItems,
	findModelByRef,
	resolveAgentModelRoute,
	resolveThinkingLevel,
	supportedThinkingLevels,
} from "../src/models.ts";

const models = [
	{
		provider: "anthropic",
		id: "claude-vision",
		name: "Claude Vision",
		input: ["text", "image"],
		reasoning: true,
		thinkingLevelMap: {
			minimal: null,
			low: "low",
			medium: null,
			high: "high",
			xhigh: null,
			max: "max",
		},
	},
	{
		provider: "openai",
		id: "gpt-fast",
		name: "gpt-fast",
		input: ["text"],
		reasoning: false,
	},
] as any[];

describe("resolveAgentModelRoute", () => {
	it("routes the selected model directly to current main", () => {
		expect(resolveAgentModelRoute({
			selectedRef: "anthropic/selected",
			mainRef: "openai/main",
		})).toEqual({
			primaryRef: "anthropic/selected",
			mainFallbackRef: "openai/main",
			candidateRefs: ["anthropic/selected", "openai/main"],
		});
	});

	it("skips a selected model that Pi no longer reports available", () => {
		expect(resolveAgentModelRoute({
			selectedRef: "removed/model",
			mainRef: "openai/main",
			availableRefs: ["openai/main"],
		})).toEqual({
			primaryRef: "openai/main",
			candidateRefs: ["openai/main"],
			unavailableSelectedRef: "removed/model",
		});
	});

	it("deduplicates a selection equal to main", () => {
		expect(resolveAgentModelRoute({
			selectedRef: "openai/main",
			mainRef: "openai/main",
		})).toEqual({
			primaryRef: "openai/main",
			candidateRefs: ["openai/main"],
		});
	});

	it("uses main without an override and declared default only without main", () => {
		expect(resolveAgentModelRoute({
			mainRef: "openai/main",
			declaredDefaultRef: "agent/default",
		}).candidateRefs).toEqual(["openai/main"]);
		expect(resolveAgentModelRoute({ declaredDefaultRef: "agent/default" }).candidateRefs).toEqual([
			"agent/default",
		]);
	});
});

describe("capability-aware thinking", () => {
	it("returns only the model's real supported levels", () => {
		expect(supportedThinkingLevels(models[0])).toEqual(["off", "low", "high", "max"]);
		expect(supportedThinkingLevels(models[1])).toEqual(["off"]);
	});

	it("clamps Auto/manual preferences to model capability", () => {
		expect(resolveThinkingLevel(models[0], "medium")).toBe("high");
		expect(resolveThinkingLevel(models[0], "xhigh")).toBe("max");
		expect(resolveThinkingLevel(models[1], "high")).toBe("off");
		expect(resolveThinkingLevel(undefined, "low")).toBe("low");
	});

	it("finds exact provider/model refs", () => {
		expect(findModelByRef(models, "anthropic/claude-vision")?.id).toBe("claude-vision");
		expect(findModelByRef(models, "missing/model")).toBeUndefined();
	});
});

describe("model setup helpers", () => {
	it("shows actual thinking levels and a dynamic-main choice", () => {
		const items = buildModelPickerItems({
			models,
			configuredRef: "anthropic/claude-vision",
			mainRef: "openai/gpt-fast",
		});
		expect(items[0]).toMatchObject({
			value: CURRENT_MAIN_MODEL,
			label: "Current main model (dynamic)",
		});
		expect(items.find((item) => item.value === "anthropic/claude-vision")?.description)
			.toContain("thinking: off/low/high/max");
		expect(items.find((item) => item.value === "openai/gpt-fast")?.description)
			.toContain("thinking: off");
	});

	it("labels image-capable models so a vision-capable agent model is visible", () => {
		const items = buildModelPickerItems({ models });
		expect(items.find((item) => item.value === "anthropic/claude-vision")?.description)
			.toContain("vision");
		expect(items.find((item) => item.value === "openai/gpt-fast")?.description)
			.toContain("text-only");
	});

	it("does not reinsert stale configured refs", () => {
		const items = buildModelPickerItems({
			models: [models[1]],
			configuredRef: "removed/stale",
		});
		expect(items.map((item) => item.value)).toEqual([CURRENT_MAIN_MODEL, "openai/gpt-fast"]);
	});

	it("applies or clears a single per-agent model override", () => {
		const initial = { worker: "anthropic/primary", reviewer: "openai/reviewer" };
		const cleared = applyAgentModelChoice(initial, "worker", CURRENT_MAIN_MODEL);
		expect(cleared).toEqual({ reviewer: "openai/reviewer" });
		expect(initial).toHaveProperty("worker", "anthropic/primary");
		expect(applyAgentModelChoice(cleared, "worker", "openai/new-primary")).toEqual({
			reviewer: "openai/reviewer",
			worker: "openai/new-primary",
		});
	});
});
