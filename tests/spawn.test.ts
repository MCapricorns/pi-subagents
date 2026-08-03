import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	currentSubagentDepth,
	getFinalOutput,
	isFailedResult,
	runSingleAgent,
	mapWithConcurrencyLimit,
	type SingleResult,
} from "../src/spawn.ts";

function assistant(text: string): any {
	return { role: "assistant", content: [{ type: "text", text }] };
}

function result(overrides: Partial<SingleResult>): SingleResult {
	return {
		agent: "worker",
		agentSource: "builtin",
		task: "t",
		exitCode: 0,
		messages: [],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		...overrides,
	};
}

describe("getFinalOutput", () => {
	it("returns the last assistant text part", () => {
		const messages = [assistant("first"), { role: "user", content: [] } as any, assistant("last")];
		expect(getFinalOutput(messages)).toBe("last");
	});
	it("returns empty string when there is no assistant text", () => {
		expect(getFinalOutput([{ role: "user", content: [] } as any])).toBe("");
	});
});

describe("isFailedResult", () => {
	it("fails on non-zero exit code", () => {
		expect(isFailedResult(result({ exitCode: 1 }))).toBe(true);
	});
	it("fails on error/aborted stop reason", () => {
		expect(isFailedResult(result({ stopReason: "error" }))).toBe(true);
		expect(isFailedResult(result({ stopReason: "aborted" }))).toBe(true);
	});
	it("passes on clean exit", () => {
		expect(isFailedResult(result({ exitCode: 0, stopReason: "end" }))).toBe(false);
	});
});

describe("currentSubagentDepth", () => {
	it("defaults to 0", () => {
		expect(currentSubagentDepth({})).toBe(0);
	});
	it("parses a positive integer", () => {
		expect(currentSubagentDepth({ PI_SUBAGENT_DEPTH: "3" })).toBe(3);
	});
	it("ignores garbage", () => {
		expect(currentSubagentDepth({ PI_SUBAGENT_DEPTH: "abc" })).toBe(0);
	});
});

describe("runSingleAgent transport and lifecycle", () => {
	const agent = {
		name: "fake",
		description: "fake",
		systemPrompt: "",
		source: "builtin" as const,
		filePath: "/agents/fake.md",
	};

	it("sends the task through stdin", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-subagents-spawn-"));
		const script = join(dir, "stdin-child.mjs");
		writeFileSync(
			script,
			`let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => input += chunk);
process.stdin.on("end", () => process.stdout.write(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: input }] } }) + "\\n"));
`,
			"utf8",
		);
		const previousScript = process.argv[1];
		process.argv[1] = script;
		try {
			const result = await runSingleAgent({
				defaultCwd: process.cwd(),
				agent,
				agentName: agent.name,
				task: "hello from stdin",
				makeDetails: (results) => ({ mode: "single", results }),
				timeoutMs: 2_000,
			});
			expect(getFinalOutput(result.messages)).toBe("Task: hello from stdin");
			expect(result.exitCode).toBe(0);
		} finally {
			process.argv[1] = previousScript;
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("terminates a child that exceeds the watchdog timeout", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-subagents-timeout-"));
		const script = join(dir, "stuck-child.mjs");
		writeFileSync(script, "process.stdin.resume(); setInterval(() => {}, 1000);\n", "utf8");
		const previousScript = process.argv[1];
		process.argv[1] = script;
		try {
			const result = await runSingleAgent({
				defaultCwd: process.cwd(),
				agent,
				agentName: agent.name,
				task: "hang",
				makeDetails: (results) => ({ mode: "single", results }),
				timeoutMs: 20,
			});
			expect(result.stopReason).toBe("error");
			expect(result.errorMessage).toContain("timed out");
			expect(result.exitCode).not.toBe(0);
		} finally {
			process.argv[1] = previousScript;
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("mapWithConcurrencyLimit", () => {
	it("preserves input order", async () => {
		const out = await mapWithConcurrencyLimit([1, 2, 3, 4], 2, async (n) => n * 10);
		expect(out).toEqual([10, 20, 30, 40]);
	});
	it("returns empty for empty input", async () => {
		expect(await mapWithConcurrencyLimit([], 4, async (n) => n)).toEqual([]);
	});
});
