import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatCompletionBlock } from "../src/presentation/format.ts";
import { formatRunStatusLine } from "../src/presentation/status.ts";
import { RESULT_LINE_MAX, truncateResultOutput } from "../src/execution/spawn.ts";
import { emptyUsage } from "../src/execution/rpc-control.ts";
import type { RunView } from "../src/presentation/monitor.ts";

function run(partial: Partial<RunView> & Pick<RunView, "id" | "status">): RunView {
	return {
		agent: "artisan",
		task: "task",
		usage: emptyUsage(),
		elapsedMs: 0,
		...partial,
	};
}

describe("formatRunStatusLine", () => {
	it("hides a done-only leftover and counts settled rows beside live siblings", () => {
		assert.equal(formatRunStatusLine([run({ id: 1, status: "done" })]), undefined);
		assert.equal(
			formatRunStatusLine([
				run({ id: 1, status: "running" }),
				run({ id: 2, status: "running" }),
				run({ id: 3, status: "done" }),
				run({ id: 4, status: "done" }),
				run({ id: 5, status: "done" }),
			]),
			"subagents 2 running · 3 done",
		);
	});

	it("labels failed rows as stopped so mixed live+failed counts appear", () => {
		assert.equal(
			formatRunStatusLine([
				run({ id: 1, status: "running" }),
				run({ id: 2, status: "failed" }),
			]),
			"subagents 1 running · 1 stopped",
		);
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

	it("states a width clip without inventing a 40-of-2 line loss", () => {
		const long = "x".repeat(RESULT_LINE_MAX + 5);
		const block = formatCompletionBlock({
			agent: "steward",
			task: "merge results",
			exitCode: 0,
			messages: [{ role: "assistant", content: [{ type: "text", text: long }], stopReason: "stop" } as never],
			stderr: "",
			usage: emptyUsage(),
		}, 40);
		assert.ok(block.includes("1 line shown"));
		assert.ok(block.includes(`clipped to ${RESULT_LINE_MAX} characters`));
		assert.ok(!block.includes("40 of"));
	});
});
