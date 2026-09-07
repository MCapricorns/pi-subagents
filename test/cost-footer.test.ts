import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { describe, it } from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { costLedger } from "../src/presentation/cost-ledger.ts";
import { renderCostFooter } from "../src/presentation/cost-footer.ts";

const plainTheme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as unknown as Theme;

const footerData = {
	getGitBranch: () => "main",
	getExtensionStatuses: () => new Map([["pi-subagents", "subagents 2 running"]]),
	onBranchChange: () => () => undefined,
};

function makeCtx(overrides: Record<string, unknown> = {}): Parameters<typeof renderCostFooter>[3] {
	return {
		mode: "tui",
		sessionManager: {
			getCwd: () => "/home/user/proj",
			getSessionName: () => undefined,
		},
		getContextUsage: () => ({ tokens: 25_000, contextWindow: 200_000, percent: 12.5 }),
		model: { provider: "zhipu", id: "glm-4.7", reasoning: true },
		thinkingLevel: "high",
		...overrides,
	} as unknown as Parameters<typeof renderCostFooter>[3];
}

describe("renderCostFooter", () => {
	it("keeps the project line first and lists one line per model, current first", () => {
		costLedger.reset();
		costLedger.record("anthropic/claude-sonnet-4", { input: 1_200, output: 800, cost: 0.0312 });
		costLedger.record("zhipu/glm-4.7", { input: 300, output: 120, cost: 0.0042 });
		costLedger.markCurrentModel("zhipu/glm-4.7");

		const lines = renderCostFooter(160, plainTheme, footerData, makeCtx()).map(stripVTControlCharacters);

		assert.match(lines[0]!, /^\/home\/user\/proj \(main\)$/u);
		assert.match(lines[1]!, /zhipu\/glm-4\.7/u);
		assert.match(lines[1]!, /\$0\.0042/u);
		assert.match(lines[1]!, /12\.5%\/200\.0k/u);
		assert.match(lines[1]!, / • high$/u);
		assert.match(lines[2]!, /^anthropic\/claude-sonnet-4 .* \$0\.0312$/u);
		assert.match(lines[3]!, /^subagents 2 running$/u);
		costLedger.reset();
	});

	it("never sums two models' costs into one number", () => {
		costLedger.reset();
		costLedger.record("anthropic/claude-sonnet-4", { input: 1000, cost: 0.03 });
		costLedger.record("openai/gpt-5-mini", { input: 1000, cost: 0.09 });
		costLedger.markCurrentModel("anthropic/claude-sonnet-4");
		const text = renderCostFooter(160, plainTheme, footerData, makeCtx()).map(stripVTControlCharacters).join("\n");
		assert.ok(!text.includes("$0.12"));
		assert.match(text, /\$0\.03/u);
		assert.match(text, /\$0\.09/u);
		costLedger.reset();
	});

	it("shows the live throughput with ~ while streaming", () => {
		costLedger.reset();
		costLedger.markCurrentModel("zhipu/glm-4.7");
		costLedger.noteStreamStart("zhipu/glm-4.7");
		costLedger.noteStreamDelta(4000);
		const line = stripVTControlCharacters(renderCostFooter(160, plainTheme, footerData, makeCtx())[1]!);
		assert.match(line, /~\d+(\.\d+)? tok\/s/u);
		costLedger.reset();
	});

	it("drops the context share when no context usage is known", () => {
		costLedger.reset();
		costLedger.markCurrentModel("zhipu/glm-4.7");
		const line = stripVTControlCharacters(
			renderCostFooter(160, plainTheme, footerData, makeCtx({ getContextUsage: () => undefined }))[1]!,
		);
		assert.ok(!line.includes("%/"));
		costLedger.reset();
	});

	it("truncates rows to the terminal width", () => {
		costLedger.reset();
		costLedger.markCurrentModel("zhipu/glm-4.7");
		costLedger.record("anthropic/claude-sonnet-4-with-a-very-long-ref-name", { input: 1, cost: 1 });
		const lines = renderCostFooter(40, plainTheme, footerData, makeCtx()).map(stripVTControlCharacters);
		for (const line of lines) {
			assert.ok(line.length <= 40, `line too long: ${line}`);
		}
		costLedger.reset();
	});

	it("omits spend rows entirely when nothing is tracked", () => {
		costLedger.reset();
		const lines = renderCostFooter(160, plainTheme, footerData, makeCtx()).map(stripVTControlCharacters);
		assert.equal(lines.length, 2);
		assert.match(lines[0]!, /^\/home\/user\/proj \(main\)$/u);
		costLedger.reset();
	});

	it("caps settled models by spend and collapses the rest into one marker", () => {
		costLedger.reset();
		costLedger.markCurrentModel("zhipu/glm-4.7");
		for (let i = 0; i < 6; i++) {
			costLedger.record(`provider/model-${i}`, { cost: i + 1 });
		}
		const lines = renderCostFooter(160, plainTheme, footerData, makeCtx()).map(stripVTControlCharacters);
		assert.equal(lines.length, 7);
		assert.match(lines[1]!, /zhipu\/glm-4\.7/u);
		assert.match(lines[2]!, /^provider\/model-5 \$6\.0000$/u);
		assert.match(lines[3]!, /^provider\/model-4 \$5\.0000$/u);
		assert.match(lines[4]!, /^provider\/model-3 \$4\.0000$/u);
		assert.match(lines[5]!, /^… \+3 more models$/u);
		assert.match(lines[6]!, /^subagents 2 running$/u);
		costLedger.reset();
	});

	it("drops the token flow before truncating a settled row", () => {
		costLedger.reset();
		costLedger.markCurrentModel("zhipu/glm-4.7");
		costLedger.record("provider/claude-sonnet-4", { input: 12_000, output: 3_400, cost: 0.0312 });
		const line = stripVTControlCharacters(renderCostFooter(34, plainTheme, footerData, makeCtx())[2]!);
		assert.equal(line, "provider/claude-sonnet-4 $0.0312");
		costLedger.reset();
	});
});
