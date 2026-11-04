import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { formatCompletionBlock, RESULT_LINE_CHARS } from "../src/presentation/format.ts";
import { emptyUsage } from "../src/execution/run-control.ts";
import type { SingleResult } from "../src/execution/spawn.ts";
import { formatTaskSummary, runLabel } from "../src/presentation/monitor.ts";
import { visibleWidth } from "@earendil-works/pi-tui";

function answer(text: string): SingleResult {
	return {
		agent: "scout",
		task: "survey modules",
		exitCode: 0,
		messages: [{ role: "assistant", content: [{ type: "text", text }], stopReason: "stop" } as never],
		stderr: "",
		usage: emptyUsage(),
	};
}

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

describe("formatCompletionBlock", () => {
	it("states when no failure reason was recorded instead of showing only partial work", () => {
		const block = formatCompletionBlock({
			agent: "artisan", task: "Finish the change", exitCode: 1, stderr: "", usage: emptyUsage(),
			messages: [{ role: "assistant", content: [{ type: "text", text: "Partial work" }], stopReason: "toolUse" } as never],
		}, 40);
		assert.match(block, /no failure reason was recorded/i);
		assert.match(block, /Partial work/);
		assert.doesNotMatch(block, /do not re-dispatch/u, "an ordinary task failure is not a model handoff");
	});

	it("recovers a recorded assistant error and hands the model-level failure to main", () => {
		const block = formatCompletionBlock({
			agent: "artisan", task: "Finish the change", exitCode: 1, stderr: "", usage: emptyUsage(),
			messages: [{ role: "assistant", content: [], stopReason: "error", errorMessage: "Provider unavailable" } as never],
		}, 40);
		assert.match(block, /Provider unavailable/);
		assert.match(block, /Main must inspect that work and finish with its own tools; do not re-dispatch this phase/u);
	});

	it("inlines long prose lines that fit the character budget", () => {
		const paragraph = "word ".repeat(80).trim();
		assert.ok(paragraph.length > RESULT_LINE_CHARS);
		const block = formatCompletionBlock(answer(`${paragraph}\nshort`), 40);
		assert.ok(block.includes(paragraph));
		assert.doesNotMatch(block, /result file/iu);
	});

	it("routes an answer over the character budget to one full-result file", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-subagents-format-"));
		try {
			const long = "x".repeat(40 * RESULT_LINE_CHARS + 1);
			const result = answer(long);
			const first = formatCompletionBlock(result, 40, { resultRoot: root });
			assert.ok(!first.includes(long), "an oversized result must not appear inline");
			assert.ok(first.includes(`${long.length} characters`));
			assert.match(first, /read the complete result file/i);
			assert.ok(result.resultFile && existsSync(result.resultFile));
			const second = formatCompletionBlock(result, 40, { resultRoot: root });
			assert.ok(second.includes(result.resultFile), "every delivery names the same artifact");
			assert.equal(readdirSync(root).length, 1);
			const stopped: SingleResult = { ...result, exitCode: 1, stopReason: "aborted", errorMessage: "Stopped by subagent_stop." };
			const third = formatCompletionBlock(stopped, 40, { resultRoot: root });
			assert.notEqual(stopped.resultFile, result.resultFile, "a derived result with different text gets its own artifact");
			assert.ok(third.includes(stopped.resultFile!));
			assert.equal(readdirSync(root).length, 2);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("inlines no output copy when lines were dropped, and names the true total", () => {
		const output = ["one", "two", "three", "four", "five"].join("\n");
		const block = formatCompletionBlock(answer(output), 2);
		assert.ok(!block.includes("three"), "dropped lines must not appear inline");
		assert.ok(block.includes("5 lines"));
		assert.match(block, /read the complete result file/i);
	});
});
