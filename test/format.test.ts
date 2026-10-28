import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatCompletionBlock } from "../src/presentation/format.ts";
import { RESULT_LINE_MAX, truncateResultOutput } from "../src/execution/spawn.ts";
import { emptyUsage } from "../src/execution/run-control.ts";
import { formatTaskSummary, runLabel } from "../src/presentation/monitor.ts";
import { visibleWidth } from "@earendil-works/pi-tui";

describe("terminal task identities", () => {
	it("honors zero budgets and grapheme widths for ANSI and CJK summaries", () => {
		const task = "\x1b[31m修复 src/认证配置.ts 与 👩‍💻 e\u0301 宽度\x1b[0m";
		assert.equal(formatTaskSummary(task, 0), "");
		assert.equal(formatTaskSummary(task, -1), "");
		for (const width of [1, 2, 3, 8, 20, 40]) {
			for (const keysOnly of [true, false]) {
				const summary = formatTaskSummary(task, width, keysOnly);
				assert.ok(visibleWidth(summary) <= width, `${width}: ${summary}`);
				assert.doesNotMatch(summary, /\x1b/u);
				if (summary.includes("👩") || summary.includes("💻")) assert.ok(summary.includes("👩‍💻"));
			}
		}
	});

	it("extracts a path from styled tasks without incorporating the ANSI color code", () => {
		assert.equal(runLabel("\x1b[31msrc/feature.ts\x1b[0m"), "src/feature.ts");
		assert.equal(runLabel("\x1b[32mImplement `resolveModel`\x1b[0m"), "resolveModel");
	});
});

describe("truncateResultOutput", () => {
	it("does not claim a line budget when only a long line was clipped", () => {
		const long = "x".repeat(RESULT_LINE_MAX + 20);
		const result = truncateResultOutput(`${long}\nshort`, 40);
		assert.equal(result.truncated, true);
		assert.equal(result.shownLines, 2);
		assert.equal(result.totalLines, 2);
		assert.equal(result.widthClipped, true);
		assert.ok(result.text.includes("…"));
	});

	it("reports shown-of-total when lines were dropped", () => {
		const result = truncateResultOutput("a\nb\nc\nd", 2);
		assert.equal(result.truncated, true);
		assert.equal(result.shownLines, 2);
		assert.equal(result.totalLines, 4);
		assert.equal(result.widthClipped, false);
	});
});

describe("formatCompletionBlock", () => {
	it("states when no failure reason was recorded instead of showing only partial work", () => {
		const block = formatCompletionBlock({
			agent: "artisan", task: "Finish the change", exitCode: 1, stderr: "", usage: emptyUsage(),
			messages: [{ role: "assistant", content: [{ type: "text", text: "Partial work" }], stopReason: "toolUse" } as never],
		}, 40);
		assert.match(block, /no failure reason was recorded/i);
		assert.match(block, /Partial work/);
	});

	it("recovers a recorded assistant error even when the result summary omitted it", () => {
		const block = formatCompletionBlock({
			agent: "artisan", task: "Finish the change", exitCode: 1, stderr: "", usage: emptyUsage(),
			messages: [{ role: "assistant", content: [], stopReason: "error", errorMessage: "Provider unavailable" } as never],
		}, 40);
		assert.match(block, /Provider unavailable/);
	});

	it("inlines no output copy on a width-only clip and still routes to the full file", () => {
		const long = "x".repeat(RESULT_LINE_MAX + 5);
		const block = formatCompletionBlock({
			agent: "steward",
			task: "merge results",
			exitCode: 0,
			messages: [{ role: "assistant", content: [{ type: "text", text: long }], stopReason: "stop" } as never],
			stderr: "",
			usage: emptyUsage(),
		}, 40);
		assert.ok(!block.includes(long), "a truncated result must not appear inline");
		assert.ok(block.includes(`lines wider than ${RESULT_LINE_MAX} characters`));
		assert.match(block, /read the complete result file/i);
		assert.ok(!block.includes("40 of"));
	});

	it("inlines no output copy when lines were dropped, and names the true total", () => {
		const output = ["one", "two", "three", "four", "five"].join("\n");
		const block = formatCompletionBlock({
			agent: "scout",
			task: "survey modules",
			exitCode: 0,
			messages: [{ role: "assistant", content: [{ type: "text", text: output }], stopReason: "stop" } as never],
			stderr: "",
			usage: emptyUsage(),
		}, 2);
		assert.ok(!block.includes("three"), "dropped lines must not appear inline");
		assert.ok(block.includes("5 lines"));
		assert.match(block, /read the complete result file/i);
	});
});
