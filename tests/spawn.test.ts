import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	currentSubagentDepth,
	SUBAGENT_TIMEOUT_MS,
	getFinalOutput,
	isFailedResult,
	isModelLevelFailure,
	RESULT_LINE_MAX,
	reviewVerdict,
	runSingleAgent,
	runSingleAgentWithModelFallback,
	truncateResultOutput,
	writeResultArtifact,
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

describe("reviewVerdict", () => {
	it("parses the reviewer prompt's machine-readable verdict lines", () => {
		expect(reviewVerdict("## Verdict\nAPPROVE\nVERDICT: REVIEW_PASS")).toBe("pass");
		expect(reviewVerdict("## Verdict\nREQUEST_CHANGES\nVERDICT: REVIEW_FAIL")).toBe("fail");
		expect(reviewVerdict("\n\tVERDICT: review_pass\n")).toBe("pass");
	});

	it("only the last standalone VERDICT line counts", () => {
		// Discussion that merely mentions the tokens must not be misclassified.
		expect(reviewVerdict("Use VERDICT: REVIEW_PASS for approval...\n## Verdict\nREQUEST_CHANGES\nVERDICT: REVIEW_FAIL")).toBe("fail");
		expect(reviewVerdict("VERDICT: REVIEW_FAIL is the bad one\nVERDICT: REVIEW_PASS")).toBe("pass");
		expect(reviewVerdict("inline VERDICT: REVIEW_PASS not on its own line")).toBeUndefined();
	});

	it("returns undefined without a verdict marker", () => {
		expect(reviewVerdict("## Verdict\nAPPROVE")).toBeUndefined();
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
	it("has no default timeout", () => {
		expect(SUBAGENT_TIMEOUT_MS).toBe(0);
	});

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

	it("terminates a child that exceeds an explicitly configured timeout", async () => {
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

describe("isModelLevelFailure", () => {
	it("fails when the provider rejected the run before any text was produced", () => {
		const failed = result({
			exitCode: 1,
			stopReason: "error",
			messages: [{ role: "assistant", content: [], stopReason: "error", errorMessage: "model not found" } as any],
		});
		expect(isModelLevelFailure(failed)).toBe(true);
	});

	it("is false for clean runs", () => {
		expect(isModelLevelFailure(result({ exitCode: 0, stopReason: "end" }))).toBe(false);
	});

	it("is false when the model produced text (task-level failure)", () => {
		expect(
			isModelLevelFailure(result({ exitCode: 1, stopReason: "error", messages: [assistant("build failed")] })),
		).toBe(false);
	});

	it("is false for aborts and timeouts", () => {
		expect(isModelLevelFailure(result({ exitCode: 1, stopReason: "aborted" }))).toBe(false);
		expect(
			isModelLevelFailure(result({ exitCode: 1, stopReason: "error", errorMessage: "Subagent timed out after 5 seconds." })),
		).toBe(false);
	});

	it("is false without any evidence of a model/provider error", () => {
		expect(isModelLevelFailure(result({ exitCode: 1 }))).toBe(false);
	});
});

describe("runSingleAgentWithModelFallback", () => {
	const agent = {
		name: "fake",
		description: "fake",
		systemPrompt: "",
		source: "builtin" as const,
		filePath: "/agents/fake.md",
	};

	// Child script: fails fast when launched with the broken model, succeeds on
	// any other model; appends one line per attempt so tests can count retries.
	const fallbackChildScript = (attemptLog: string): string => `
const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(attemptLog)}, "attempt\\n");
const modelArg = process.argv.indexOf("--model");
const model = modelArg !== -1 ? process.argv[modelArg + 1] : "";
if (model.startsWith("openai-codex")) {
  process.stdout.write(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "model not found" } }) + "\\n");
  process.exit(1);
}
process.stdout.write(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "recovered on main model" }], stopReason: "end" } }) + "\\n");
process.exit(0);
`;

	it("retries once with the fallback model after a model-level failure", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-subagents-fallback-"));
		const script = join(dir, "fallback-child.cjs");
		const log = join(dir, "attempts.log");
		writeFileSync(script, fallbackChildScript(log), "utf8");
		const previousScript = process.argv[1];
		process.argv[1] = script;
		try {
			const result = await runSingleAgentWithModelFallback(
				{
					defaultCwd: process.cwd(),
					agent: { ...agent, model: "openai-codex/gpt-5.6-sol" },
					agentName: agent.name,
					task: "review",
					makeDetails: (results) => ({ mode: "single", results }),
					timeoutMs: 2_000,
				},
				"deepseek/deepseek-v4-flash",
			);
			expect(result.exitCode).toBe(0);
			expect(getFinalOutput(result.messages)).toBe("recovered on main model");
			expect(result.model).toBe("deepseek/deepseek-v4-flash");
			expect(result.modelFallbackFrom).toBe("openai-codex/gpt-5.6-sol");
			expect(readFileSync(log, "utf8").split("\n").filter(Boolean)).toHaveLength(2);
		} finally {
			process.argv[1] = previousScript;
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("reports the retried failure with the fallback origin when both attempts fail", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-subagents-fallback-"));
		const script = join(dir, "always-fail-child.mjs");
		writeFileSync(
			script,
			`process.stdout.write(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "provider down" } }) + "\\n");
process.exit(1);
`,
			"utf8",
		);
		const previousScript = process.argv[1];
		process.argv[1] = script;
		try {
			const result = await runSingleAgentWithModelFallback(
				{
					defaultCwd: process.cwd(),
					agent: { ...agent, model: "openai-codex/gpt-5.6-sol" },
					agentName: agent.name,
					task: "review",
					makeDetails: (results) => ({ mode: "single", results }),
					timeoutMs: 2_000,
				},
				"deepseek/deepseek-v4-flash",
			);
			expect(result.exitCode).toBe(1);
			expect(result.stopReason).toBe("error");
			expect(result.errorMessage).toBe("provider down");
			expect(result.modelFallbackFrom).toBe("openai-codex/gpt-5.6-sol");
			expect(result.model).toBe("deepseek/deepseek-v4-flash");
		} finally {
			process.argv[1] = previousScript;
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("does not retry without a fallback model ref", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-subagents-fallback-"));
		const script = join(dir, "fallback-child.cjs");
		const log = join(dir, "attempts.log");
		writeFileSync(script, fallbackChildScript(log), "utf8");
		const previousScript = process.argv[1];
		process.argv[1] = script;
		try {
			const result = await runSingleAgentWithModelFallback({
				defaultCwd: process.cwd(),
				agent: { ...agent, model: "openai-codex/gpt-5.6-sol" },
				agentName: agent.name,
				task: "review",
				makeDetails: (results) => ({ mode: "single", results }),
				timeoutMs: 2_000,
			});
			expect(result.exitCode).toBe(1);
			expect(result.modelFallbackFrom).toBeUndefined();
			expect(readFileSync(log, "utf8").split("\n").filter(Boolean)).toHaveLength(1);
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

describe("truncateResultOutput", () => {
	it("leaves short output untouched", () => {
		const out = "line one\nline two";
		expect(truncateResultOutput(out, 80)).toEqual({ text: out, truncated: false });
	});

	it("keeps output at exactly maxLines untouched", () => {
		const out = Array.from({ length: 5 }, (_, i) => `line ${i}`).join("\n");
		expect(truncateResultOutput(out, 5)).toEqual({ text: out, truncated: false });
	});

	it("truncates long output to the first maxLines lines", () => {
		const out = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n");
		const { text, truncated } = truncateResultOutput(out, 10);
		expect(truncated).toBe(true);
		expect(text.split("\n")).toHaveLength(10);
		expect(text).toContain("line 0");
		expect(text).not.toContain("line 10");
	});

	it("caps an oversized single line", () => {
		const long = "x".repeat(500);
		const { text, truncated } = truncateResultOutput(long, 80);
		expect(truncated).toBe(true);
		expect(text.length).toBeLessThanOrEqual(RESULT_LINE_MAX + 1); // + ellipsis
		expect(text.endsWith("…")).toBe(true);
	});
});

describe("writeResultArtifact", () => {
	it("persists the full output and returns a readable path", () => {
		const artifactPath = writeResultArtifact("full text\n", "reviewer");
		expect(artifactPath).toContain("pi-subagents-results");
		expect(artifactPath).toContain("reviewer");
		expect(readFileSync(artifactPath, "utf8")).toBe("full text\n");
		rmSync(artifactPath, { force: true });
	});
});
