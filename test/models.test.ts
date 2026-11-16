import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_CONFIG } from "../src/configuration/config.ts";
import { loadBuiltinAgents } from "../src/delegation/agents.ts";
import { resolveDispatchModelRoute } from "../src/lifecycle/thread-shared.ts";
import {
	availableModelsInScope,
	buildModelPickerItems,
	CURRENT_MAIN_MODEL,
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
	it("routes each role independently and blocks only the unavailable assignment", () => {
		const main = model("test", "main");
		const research = model("test", "research");
		const worker = model("test", "worker");
		const ctx = { model: main, scopedModels: [], modelRegistry: { getAvailable: () => [main, research, worker] } } as unknown as ExtensionContext;
		const config = { ...DEFAULT_CONFIG, researcher: { model: "test/research", thinking: "low" as const }, worker: { model: "test/worker", thinking: "high" as const } };
		const [researcherAgent, workerAgent] = loadBuiltinAgents();
		assert.equal(resolveDispatchModelRoute(researcherAgent!, config, ctx).agent.model, "test/research");
		assert.equal(resolveDispatchModelRoute(researcherAgent!, config, ctx).thinkingLevel, "low");
		assert.equal(resolveDispatchModelRoute(workerAgent!, config, ctx).agent.model, "test/worker");
		assert.equal(resolveDispatchModelRoute(workerAgent!, config, ctx).thinkingLevel, "high");
		config.researcher.model = "test/unavailable";
		const blocked = resolveDispatchModelRoute(researcherAgent!, config, ctx);
		assert.equal(blocked.agent.model, undefined);
		assert.match(blocked.error!, /researcher model test\/unavailable/u);
		assert.equal(resolveDispatchModelRoute(workerAgent!, config, ctx).error, undefined);
	});
	const cases: Array<{ name: string; input: AgentModelRouteInput; expected: ResolvedAgentModelRoute }> = [
		{ name: "main only", input: { mainRef: "test/main", availableRefs: [] }, expected: { primaryRef: "test/main" } },
		{ name: "identical selection", input: { selectedRef: "test/main", mainRef: "test/main", availableRefs: ["test/main"] }, expected: { primaryRef: "test/main" } },
		{ name: "selection without main", input: { selectedRef: "test/worker", availableRefs: ["test/worker"] }, expected: { primaryRef: "test/worker" } },
		{ name: "configured worker", input: { selectedRef: " test/worker ", mainRef: " test/main ", availableRefs: ["test/worker"] }, expected: { primaryRef: "test/worker" } },
		{ name: "unavailable selection", input: { selectedRef: "test/missing", mainRef: "test/main", availableRefs: [] }, expected: { primaryRef: undefined, unavailableSelectedRef: "test/missing" } },
		{ name: "unavailable selection without main", input: { selectedRef: "test/missing", availableRefs: [] }, expected: { primaryRef: undefined, unavailableSelectedRef: "test/missing" } },
		{ name: "missing catalog", input: { selectedRef: "test/worker", mainRef: "test/main" }, expected: { primaryRef: "test/worker" } },
		{ name: "empty references", input: { selectedRef: " ", mainRef: " " }, expected: { primaryRef: undefined } },
	];
	for (const { name, input, expected } of cases) {
		it(name, () => assert.deepEqual(resolveAgentModelRoute(input), expected));
	}
});

describe("setup model catalog", () => {
	it("requires an exact provider reference without historical aliases", () => {
		const current = model("azure", "gpt-5.4");
		assert.equal(findModelByRef([current], "azure/gpt-5.4"), current);
		assert.equal(findModelByRef([current], "azure-openai-responses/gpt-5.4"), undefined);
		assert.deepEqual(resolveAgentModelRoute({ selectedRef: "azure-openai-responses/gpt-5.4", mainRef: "azure/gpt-5.4", availableRefs: ["azure/gpt-5.4"] }),
			{ primaryRef: undefined, unavailableSelectedRef: "azure-openai-responses/gpt-5.4" });
	});
	it("uses friendly names and providers, disambiguates duplicate names, and retains exact references", () => {
		const entries = [
			{ ...model("team-proxy", "deployment-a"), name: "Friendly Model", input: ["text", "image"] as ("text" | "image")[] },
			{ ...model("team-proxy", "deployment-b"), name: "Friendly Model" },
			{ ...model("other-provider", "deployment-a"), name: "Friendly Model" },
		];
		const items = buildModelPickerItems({ models: [...entries, entries[0]!], configuredRef: "team-proxy/deployment-b", mainRef: "team-proxy/deployment-a" });
		assert.equal(items.length, 4, "exact duplicates are removed");
		assert.equal(items[0]?.value, CURRENT_MAIN_MODEL);
		assert.equal(items[0]?.saved, false);
		assert.match(items[0]?.description ?? "", /including future changes.*team-proxy\/deployment-a/u);
		assert.equal(items[1]?.value, "team-proxy/deployment-b", "saved model sorts first after dynamic choice");
		assert.equal(items[1]?.saved, true);
		assert.equal(new Set(items.map((item) => item.label)).size, items.length);
		for (const entry of entries) {
			const item = items.find((item) => item.value === entry.provider + "/" + entry.id)!;
			assert.ok(item.label.includes(entry.name));
			assert.ok(item.label.includes(entry.provider));
			assert.ok(item.description?.includes(item.value));
			assert.match(item.description ?? "", /Pins this role/u);
		}
		assert.match(items.find((item) => item.value === "team-proxy/deployment-a")?.description ?? "", /vision.*thinking:/u);
		const dynamic = buildModelPickerItems({ models: entries, mainRef: "team-proxy/deployment-a" });
		assert.equal(dynamic[0]?.saved, true);
		assert.ok(dynamic.slice(1).every((item) => item.saved === false));
	});

	it("uses live availability and metadata within the session scope, preserving configured providers", () => {
		const live = model("configured-proxy", "one");
		const outside = model("test", "outside");
		const stale = model("configured-proxy", "removed");
		const modelRegistry = { getAvailable: () => [live, outside] };
		const context = { model: live, modelRegistry, scopedModels: [
			{ model: { ...live, name: "Stale snapshot" }, thinkingLevel: "low" },
			{ model: stale, thinkingLevel: "high" },
		] } as unknown as Parameters<typeof availableModelsInScope>[0];
		assert.deepEqual(availableModelsInScope(context), [live]);
		assert.equal(buildModelPickerItems({ models: availableModelsInScope(context) })[1]?.value, "configured-proxy/one");
		assert.deepEqual(availableModelsInScope({ ...context, scopedModels: [] }), [live, outside]);
	});
});
