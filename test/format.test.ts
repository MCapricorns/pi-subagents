import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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
		agent: "researcher",
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
	it("hands successful implementation to main for review without approving it", () => {
		const result = { ...answer("Changed src/cache.ts; cache tests passed."), agent: "worker" };
		const block = formatCompletionBlock(result, 40);
		assert.match(block, /Review handoff: main\. Worker completion is not review approval/u);
		assert.match(block, /actual diff, affected callers, acceptance criteria, and check evidence/u);
		assert.doesNotMatch(formatCompletionBlock(answer("Research evidence"), 40), /Review handoff/u);
		assert.doesNotMatch(formatCompletionBlock({ ...result, exitCode: 1 }, 40), /Review handoff/u);
	});

	it("states when no failure reason was recorded instead of showing only partial work", () => {
		const block = formatCompletionBlock({
			agent: "worker", task: "Finish the change", exitCode: 1, stderr: "", usage: emptyUsage(),
			messages: [{ role: "assistant", content: [{ type: "text", text: "Partial work" }], stopReason: "toolUse" } as never],
		}, 40);
		assert.match(block, /no failure reason was recorded/i);
		assert.match(block, /Partial work/);
		assert.doesNotMatch(block, /do not re-dispatch/u, "an ordinary task failure is not a model handoff");
	});

	it("recovers a recorded assistant error and hands the model-level failure to main", () => {
		const block = formatCompletionBlock({
			agent: "worker", task: "Finish the change", exitCode: 1, stderr: "", usage: emptyUsage(),
			messages: [{ role: "assistant", content: [], stopReason: "error", errorMessage: "Provider unavailable" } as never],
		}, 40);
		assert.match(block, /Provider unavailable/);
		assert.match(block, /The worker could not complete this task:/u);
		assert.match(block, /No automatic model upgrade was attempted/u);
		assert.match(block, /Main must inspect that work and decide how to proceed; do not repeat this failed phase automatically/u);

		const researcherBlock = formatCompletionBlock({
			agent: "researcher", task: "Inspect callers", exitCode: 1, stderr: "", usage: emptyUsage(),
			messages: [{ role: "assistant", content: [], stopReason: "error", errorMessage: "Provider unavailable" } as never],
		}, 40);
		assert.match(researcherBlock, /The researcher could not complete this task:/u);
		assert.doesNotMatch(researcherBlock, /The worker could not complete this task:/u);
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
		const root = mkdtempSync(join(tmpdir(), "pi-subagents-format-lines-"));
		try {
			const output = ["one", "two", "three", "four", "five"].join("\n");
			const block = formatCompletionBlock(answer(output), 2, { resultRoot: root });
			assert.ok(!block.includes("three"), "dropped lines must not appear inline");
			assert.ok(!block.includes("one"), "saved artifact must not be duplicated inline");
			assert.ok(block.includes("5 lines"));
			assert.match(block, /read the complete result file/i);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("inlines a bounded head without faking a file path when resultRoot is unavailable", () => {
		const output = ["one", "two", "three", "four", "five"].join("\n");
		const result = answer(output);
		const block = formatCompletionBlock(result, 2);
		assert.equal(result.resultFile, undefined);
		assert.ok(block.includes("one\ntwo"));
		assert.ok(!block.includes("three"));
		assert.ok(block.includes("5 lines"));
		assert.doesNotMatch(block, /read the complete result file/i);
		assert.match(block, /could not be saved.*result root unavailable/i);
	});

	it("falls back to a bounded head when writing the result artifact fails", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-subagents-format-fail-"));
		const blockingFile = join(root, "not-a-dir");
		writeFileSync(blockingFile, "occupied", "utf8");
		try {
			const lineOutput = ["alpha", "beta", "gamma", "delta"].join("\n");
			const lineResult = answer(lineOutput);
			const lineBlock = formatCompletionBlock(lineResult, 2, { resultRoot: blockingFile });
			assert.equal(lineResult.resultFile, undefined);
			assert.ok(lineBlock.includes("alpha\nbeta"));
			assert.ok(!lineBlock.includes("gamma"));
			assert.match(lineBlock, /could not be saved/i);

			const charOutput = "a".repeat(2 * RESULT_LINE_CHARS + 50);
			const charResult = answer(charOutput);
			const charBlock = formatCompletionBlock(charResult, 2, { resultRoot: blockingFile });
			assert.equal(charResult.resultFile, undefined);
			assert.ok(charBlock.includes("a".repeat(2 * RESULT_LINE_CHARS)));
			assert.ok(!charBlock.includes(charOutput));
			assert.match(charBlock, /could not be saved/i);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
