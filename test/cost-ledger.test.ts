import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	CostLedger,
	costLedger,
	messageModelRef,
	registerMainCostTracking,
	seedCostLedgerFromSession,
} from "../src/presentation/cost-ledger.ts";

describe("messageModelRef", () => {
	it("composes provider/model", () => {
		assert.equal(messageModelRef({ provider: "anthropic", model: "claude-sonnet-4" }), "anthropic/claude-sonnet-4");
	});

	it("keeps a bare id when the provider is missing", () => {
		assert.equal(messageModelRef({ model: "glm-4.7" }), "glm-4.7");
		assert.equal(messageModelRef({}), undefined);
	});
});

describe("CostLedger", () => {
	it("keeps one tally per model and never merges them", () => {
		const ledger = new CostLedger();
		ledger.record("anthropic/claude-sonnet-4", { input: 100, output: 50, cost: 0.5 });
		ledger.record("anthropic/claude-sonnet-4", { input: 10, output: 5, cost: 0.05 });
		ledger.record("zhipu/glm-4.7", { input: 200, cost: 0.2 });
		const rows = ledger.snapshot();
		assert.equal(rows.length, 2);
		const sonnet = rows.find((row) => row.model === "anthropic/claude-sonnet-4");
		const glm = rows.find((row) => row.model === "zhipu/glm-4.7");
		assert.equal(sonnet?.spend.input, 110);
		assert.equal(sonnet?.spend.cost, 0.55);
		assert.equal(glm?.spend.input, 200);
		assert.equal(glm?.spend.cost, 0.2);
	});

	it("lists the current model first and keeps first-seen order after it", () => {
		const ledger = new CostLedger();
		ledger.record("openai/gpt-5", { cost: 1 });
		ledger.record("zhipu/glm-4.7", { cost: 2 });
		ledger.markCurrentModel("zhipu/glm-4.7");
		assert.deepEqual(ledger.snapshot().map((row) => [row.model, row.current]), [
			["zhipu/glm-4.7", true],
			["openai/gpt-5", false],
		]);
	});

	it("shows a zero row for a current model with no spend yet", () => {
		const ledger = new CostLedger();
		ledger.markCurrentModel("openai/gpt-5");
		const rows = ledger.snapshot();
		assert.equal(rows.length, 1);
		assert.equal(rows[0]?.spend.cost, 0);
		assert.equal(rows[0]?.current, true);
	});

	it("tracks live estimate and the exact final rate", () => {
		const ledger = new CostLedger();
		ledger.noteStreamStart("openai/gpt-5");
		ledger.noteStreamDelta(400);
		const live = ledger.speed();
		assert.equal(live?.streaming, true);
		assert.ok((live?.tokensPerSecond ?? 0) > 0);
		ledger.noteStreamEnd("openai/gpt-5", 120);
		const exact = ledger.speed();
		assert.equal(exact?.streaming, false);
		assert.ok((exact?.tokensPerSecond ?? 0) > 0);
		assert.ok(!ledger.isStreaming());
	});

	it("reset clears spend and stream state", () => {
		const ledger = new CostLedger();
		ledger.record("openai/gpt-5", { cost: 1 });
		ledger.noteStreamStart("openai/gpt-5");
		ledger.reset();
		assert.equal(ledger.snapshot().length, 0);
		assert.equal(ledger.speed(), undefined);
	});
});

describe("seedCostLedgerFromSession", () => {
	it("replays assistant messages per model and compaction onto the current model", () => {
		costLedger.reset();
		seedCostLedgerFromSession({
			model: { provider: "zhipu", id: "glm-4.7" },
			sessionManager: {
				getEntries: () => [
					{ type: "message", message: { role: "user", content: [] } },
					{
						type: "message",
						message: { role: "assistant", provider: "anthropic", model: "claude-sonnet-4", usage: { input: 10, output: 2, cost: { total: 0.3 } } },
					},
					{
						type: "message",
						message: { role: "assistant", provider: "zhipu", model: "glm-4.7", usage: { input: 5, output: 1, cost: { total: 0.1 } } },
					},
					{ type: "compaction", usage: { input: 50, cost: { total: 0.02 } } },
				],
			},
		});
		const rows = costLedger.snapshot();
		assert.deepEqual(rows.map((row) => [row.model, row.current]), [
			["zhipu/glm-4.7", true],
			["anthropic/claude-sonnet-4", false],
		]);
		assert.ok(Math.abs((rows[0]?.spend.cost ?? 0) - 0.12) < 1e-9);
		assert.equal(rows[0]?.spend.input, 55);
		assert.ok(Math.abs((rows[1]?.spend.cost ?? 0) - 0.3) < 1e-9);
		costLedger.reset();
	});
});

describe("registerMainCostTracking", () => {
	const makePi = (): { pi: ExtensionAPI; handlers: Map<string, (event: unknown, ctx: unknown) => Promise<void>> } => {
		const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<void>>();
		const pi = {
			on: (event: string, handler: (event: unknown, ctx: unknown) => Promise<void>) => {
				handlers.set(event, handler);
			},
		} as unknown as ExtensionAPI;
		return { pi, handlers };
	};
	const ctx = {} as ExtensionContext;

	beforeEach(() => {
		costLedger.reset();
	});

	it("records assistant messages under their serving model", async () => {
		const { pi, handlers } = makePi();
		registerMainCostTracking(pi);
		await handlers.get("model_select")!({ model: { provider: "zhipu", id: "glm-4.7" } }, ctx);
		await handlers.get("message_end")!(
			{ message: { role: "assistant", provider: "zhipu", model: "glm-4.7", usage: { input: 7, output: 3, cost: { total: 0.04 } } } },
			ctx,
		);
		const rows = costLedger.snapshot();
		assert.equal(rows.length, 1);
		assert.equal(rows[0]?.model, "zhipu/glm-4.7");
		assert.equal(rows[0]?.spend.cost, 0.04);
		assert.equal(rows[0]?.current, true);
	});

	it("ignores non-assistant messages and starts the stream lazily on the first delta", async () => {
		const { pi, handlers } = makePi();
		registerMainCostTracking(pi);
		await handlers.get("message_start")!({ message: { role: "user", content: [] } }, ctx);
		assert.ok(!costLedger.isStreaming());
		await handlers.get("message_update")!(
			{
				message: { role: "assistant", provider: "zhipu", model: "glm-4.7" },
				assistantMessageEvent: { type: "text_delta", delta: "hello world" },
			},
			ctx,
		);
		assert.ok(costLedger.isStreaming());
		const live = costLedger.speed();
		assert.equal(live?.model, "zhipu/glm-4.7");
		assert.equal(live?.streaming, true);
	});

	it("attributes compaction usage to the current model", async () => {
		const { pi, handlers } = makePi();
		registerMainCostTracking(pi);
		await handlers.get("model_select")!({ model: { provider: "zhipu", id: "glm-4.7" } }, ctx);
		await handlers.get("session_compact")!({ compactionEntry: { usage: { input: 9, cost: { total: 0.01 } } } }, ctx);
		const rows = costLedger.snapshot();
		assert.equal(rows[0]?.model, "zhipu/glm-4.7");
		assert.equal(rows[0]?.spend.input, 9);
	});

	it("uses the compaction event's model when no current model is tracked", async () => {
		const { pi, handlers } = makePi();
		registerMainCostTracking(pi);
		await handlers.get("session_compact")!(
			{ compactionEntry: { usage: { input: 9, cost: { total: 0.01 } } } },
			{ model: { provider: "test", id: "compactor" } },
		);
		const rows = costLedger.snapshot();
		assert.equal(rows.length, 1);
		assert.equal(rows[0]?.model, "test/compactor");
		assert.equal(rows[0]?.spend.cost, 0.01);
	});
});
