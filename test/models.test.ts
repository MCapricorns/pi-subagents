import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
	buildModelPickerItems,
	filterUnavailableModelOverrides,
	findModelByRef,
	resolveAgentModelRoute,
	type AgentModelRouteInput,
	type ResolvedAgentModelRoute,
} from "../src/configuration/models.ts";

function model(provider: string, id: string): Model<Api> {
	return {
		id,
		name: id,
		api: "azure-openai-responses",
		provider,
		baseUrl: "https://example.test",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 8_192,
	};
}

describe("agent model route boundaries", () => {
	const cases: Array<{ name: string; input: AgentModelRouteInput; expected: ResolvedAgentModelRoute }> = [
		{ name: "main only", input: { mainRef: "test/main", availableRefs: [] }, expected: { primaryRef: "test/main" } },
		{ name: "identical selection", input: { selectedRef: "test/main", mainRef: "test/main", availableRefs: ["test/main"] }, expected: { primaryRef: "test/main" } },
		{ name: "selection without main", input: { selectedRef: "test/worker", availableRefs: ["test/worker"] }, expected: { primaryRef: "test/worker" } },
		{ name: "distinct fallback", input: { selectedRef: " test/worker ", mainRef: " test/main ", availableRefs: ["test/worker"] }, expected: { primaryRef: "test/worker", mainFallbackRef: "test/main" } },
		{ name: "unavailable selection", input: { selectedRef: "test/missing", mainRef: "test/main", availableRefs: [] }, expected: { primaryRef: "test/main", unavailableSelectedRef: "test/missing" } },
		{ name: "unavailable selection without main", input: { selectedRef: "test/missing", availableRefs: [] }, expected: { primaryRef: undefined, unavailableSelectedRef: "test/missing" } },
		{ name: "missing catalog", input: { selectedRef: "test/worker", mainRef: "test/main" }, expected: { primaryRef: "test/worker", mainFallbackRef: "test/main" } },
		{ name: "empty references", input: { selectedRef: " ", mainRef: " " }, expected: { primaryRef: undefined } },
		{ name: "alias resolves to main", input: { selectedRef: "azure-openai-responses/gpt-5.4", mainRef: "azure/gpt-5.4", availableRefs: ["azure/gpt-5.4"] }, expected: { primaryRef: "azure/gpt-5.4" } },
	];
	for (const { name, input, expected } of cases) {
		it(name, () => assert.deepEqual(resolveAgentModelRoute(input), expected));
	}
});

describe("Pi 1.0.3 provider id rename", () => {
	const azure = model("azure", "gpt-5.4");
	const legacy = model("azure-openai-responses", "gpt-5.4");

	it("follows a stored azure-openai-responses override onto the live azure id", () => {
		const found = findModelByRef([azure], "azure-openai-responses/gpt-5.4");
		assert.equal(found?.provider, "azure");

		const route = resolveAgentModelRoute({
			selectedRef: "azure-openai-responses/gpt-5.4",
			mainRef: "openai/gpt-5.5",
			availableRefs: ["azure/gpt-5.4", "openai/gpt-5.5"],
		});
		assert.equal(route.primaryRef, "azure/gpt-5.4");
		assert.equal(route.unavailableSelectedRef, undefined);

		const { kept, dropped } = filterUnavailableModelOverrides(
			{ artisan: "azure-openai-responses/gpt-5.4" },
			[azure],
		);
		assert.deepEqual(kept, { artisan: "azure/gpt-5.4" });
		assert.deepEqual(dropped, []);

		const items = buildModelPickerItems({
			models: [azure],
			configuredRef: "azure-openai-responses/gpt-5.4",
		});
		assert.equal(items[1]?.label, "azure/gpt-5.4");
		assert.match(items[1]?.description ?? "", /configured/);
	});

	it("keeps the old provider id while that catalog entry is still live", () => {
		const found = findModelByRef([legacy], "azure-openai-responses/gpt-5.4");
		assert.equal(found?.provider, "azure-openai-responses");

		const route = resolveAgentModelRoute({
			selectedRef: "azure-openai-responses/gpt-5.4",
			availableRefs: ["azure-openai-responses/gpt-5.4"],
		});
		assert.equal(route.primaryRef, "azure-openai-responses/gpt-5.4");

		const { kept, dropped } = filterUnavailableModelOverrides(
			{ artisan: "azure-openai-responses/gpt-5.4" },
			[legacy],
		);
		assert.deepEqual(kept, { artisan: "azure-openai-responses/gpt-5.4" });
		assert.deepEqual(dropped, []);
	});

	it("still drops an override when neither provider id is available", () => {
		const { kept, dropped } = filterUnavailableModelOverrides(
			{ artisan: "azure-openai-responses/gpt-5.4" },
			[model("openai", "gpt-5.5")],
		);
		assert.deepEqual(kept, {});
		assert.deepEqual(dropped, [{ agent: "artisan", ref: "azure-openai-responses/gpt-5.4" }]);

		const route = resolveAgentModelRoute({
			selectedRef: "azure-openai-responses/gpt-5.4",
			mainRef: "openai/gpt-5.5",
			availableRefs: ["openai/gpt-5.5"],
		});
		assert.equal(route.primaryRef, "openai/gpt-5.5");
		assert.equal(route.unavailableSelectedRef, "azure-openai-responses/gpt-5.4");
	});
});
