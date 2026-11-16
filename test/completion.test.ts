import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatCompletionMessage, perModelTotals, type CompletionMessageItem } from "../src/lifecycle/completion.ts";
import { emptyUsage } from "../src/execution/run-control.ts";

function item(agent: string, model?: string, cost = 0, output = 0): CompletionMessageItem {
	const usage = emptyUsage();
	usage.cost = cost;
	usage.output = output;
	return { agent, block: `${agent} done`, ...(model ? { model } : {}), usage };
}

describe("formatCompletionMessage group totals", () => {
	it("returns the single block unchanged", () => {
		assert.equal(formatCompletionMessage([item("researcher")]), "researcher done");
	});

	it("splits totals per model instead of summing across models", () => {
		const message = formatCompletionMessage([
			item("researcher", "zhipu/glm-4.7", 0.02, 100),
			item("worker", "anthropic/claude-sonnet-4", 1.5, 4_000),
			item("steward", "zhipu/glm-4.7", 0.03, 200),
		]);
		assert.match(message, /^### Subagents completed \(3\): researcher, worker, steward\n\n/u);
		const totals = message.split("Totals: ")[1]!;
		assert.match(totals, /zhipu\/glm-4\.7: ↓300 \$0\.0500/u);
		assert.match(totals, /anthropic\/claude-sonnet-4: ↓4\.0k \$1\.5000/u);
		assert.ok(!totals.includes("$1.55"), "models must not be summed into one cost");
	});

	it("merges runs that share one model", () => {
		const totals = perModelTotals([item("researcher", "zhipu/glm-4.7", 0.02), item("worker", "zhipu/glm-4.7", 0.03)]);
		assert.equal(totals, "zhipu/glm-4.7: $0.0500");
	});

	it("labels runs without a model ref and skips usage-free items", () => {
		assert.equal(
			perModelTotals([item("researcher"), { agent: "worker", block: "x" }]),
			"unknown model: $0.0000",
		);
		assert.equal(perModelTotals([{ agent: "worker", block: "x" }]), "");
	});
});
