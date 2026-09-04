import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { RunView } from "../src/monitor.ts";
import { emptyUsage } from "../src/rpc-run.ts";
import { formatActiveRunLines } from "../src/widget.ts";

const plainTheme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as unknown as Theme;

describe("formatActiveRunLines", () => {
	it("shows the current thinking strength for an active run", () => {
		const now = 10_000;
		const run: RunView = {
			id: 7,
			agent: "sentinel",
			task: "Review the staged diff",
			model: "openai/gpt-5.4",
			thinking: "high",
			status: "running",
			usage: emptyUsage(),
			startedAt: now - 1_000,
			activeSince: now - 1_000,
			elapsedMs: 0,
		};

		const lines = formatActiveRunLines([run], plainTheme, 160, now);
		assert.equal(lines.length, 1);
		assert.match(lines[0], /think:high/u);
	});
});
