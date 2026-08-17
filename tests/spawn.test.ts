import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fakeRpcScript } from "./fake-rpc.ts";
import {
	buildFallbackResumeReason,
	buildResumePrompt,
	currentSubagentDepth,
	extractToolErrorText,
	getFinalOutput,
	getResultOutput,
	isFailedResult,
	isModelLevelFailure,
	isPermanentModelCandidateError,
	isRetryableStartupFailure,
	isTerminalModelError,
	RESULT_LINE_MAX,
	reviewVerdict,
	runSingleAgent,
	runSingleAgentWithModelFallback,
	sessionExists,
	truncateResultOutput,
	writeResultArtifact,
	type SingleResult,
} from "../src/spawn.ts";

let savedTemp: string | undefined;
let savedTmp: string | undefined;
let isolatedTemp: string;

beforeAll(() => {
	savedTemp = process.env.TEMP;
	savedTmp = process.env.TMP;
	isolatedTemp = mkdtempSync(join(tmpdir(), "pi-subagents-spawn-suite-"));
	process.env.TEMP = isolatedTemp;
	process.env.TMP = isolatedTemp;
});

afterAll(() => {
	if (savedTemp === undefined) delete process.env.TEMP;
	else process.env.TEMP = savedTemp;
	if (savedTmp === undefined) delete process.env.TMP;
	else process.env.TMP = savedTmp;
	rmSync(isolatedTemp, { recursive: true, force: true });
});

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
			fakeRpcScript({
				onPrompt: `send({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: input }], stopReason: "stop" } });`,
			}),
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
			});
			expect(getFinalOutput(result.messages)).toBe("Task: hello from stdin");
			expect(result.exitCode).toBe(0);
		} finally {
			process.argv[1] = previousScript;
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("terminates a child whose stdout goes idle past the idle timeout", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-subagents-idle-"));
		const script = join(dir, "idle-child.mjs");
		// Start with one stdout line, then go silent (resume stdin, no more output).
		writeFileSync(
			script,
		fakeRpcScript({
			onPrompt: `send({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "started" }], stopReason: "stop" } }); setInterval(() => {}, 1000);`,
			autoSettle: false,
		}),
		"utf8",
	);
		const previousScript = process.argv[1];
		process.argv[1] = script;
		try {
		const result = await runSingleAgent({
			defaultCwd: process.cwd(),
			agent,
			agentName: agent.name,
			task: "hang after one line",
			makeDetails: (results) => ({ mode: "single", results }),
			idleTimeoutMs: 50,
		});
			expect(result.stopReason).toBe("error");
			expect(result.errorMessage).toContain("idle timeout");
			expect(result.exitCode).not.toBe(0);
		} finally {
			process.argv[1] = previousScript;
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("does not fire idle timeout while stdout is active", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-subagents-idle-active-"));
		const script = join(dir, "active-child.mjs");
		// Emit a line every 20ms so stdout never goes idle; finish before the idle timeout.
		writeFileSync(
			script,
			fakeRpcScript({
				onPrompt: `let n = 0;
const timer = setInterval(() => {
	n++;
	send({ type: "message_update", assistantMessageEvent: { type: "thinking_delta" } });
	if (n >= 5) {
		clearInterval(timer);
		send({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop" } });
		send({ type: "agent_settled" });
	}
}, 20);`,
				autoSettle: false,
			}),
			"utf8",
		);
		const previousScript = process.argv[1];
		process.argv[1] = script;
		try {
			const result = await runSingleAgent({
				defaultCwd: process.cwd(),
				agent,
				agentName: agent.name,
				task: "keep busy",
				makeDetails: (results) => ({ mode: "single", results }),
				idleTimeoutMs: 100,
			});
			expect(result.exitCode).toBe(0);
			expect(getFinalOutput(result.messages)).toBe("done");
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

	it("uses the final assistant error even after earlier text and failed tools", () => {
		const failed = result({
			exitCode: 1,
			stopReason: "error",
			errorMessage: "503 Service Unavailable",
			messages: [
				{ ...assistant("I inspected the repository."), stopReason: "toolUse" },
				{ role: "assistant", content: [], stopReason: "error", errorMessage: "503 Service Unavailable" } as any,
			],
			failedTools: [{ toolName: "bash", error: "an earlier test command failed" }],
		});
		expect(getFinalOutput(failed.messages)).toBe("I inspected the repository.");
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

	it("is false for aborts", () => {
		expect(isModelLevelFailure(result({ exitCode: 1, stopReason: "aborted" }))).toBe(false);
	});

	it("is true for idle timeouts even with partial output", () => {
		expect(
			isModelLevelFailure(result({
				exitCode: 1,
				stopReason: "error",
				errorMessage: "Subagent idle timeout: no activity for 90 seconds.",
				messages: [assistant("partial work")],
			})),
		).toBe(true);
	});

	it("is true for idle timeouts with no output", () => {
		expect(
			isModelLevelFailure(result({
				exitCode: 1,
				stopReason: "error",
				errorMessage: "Subagent idle timeout: no activity for 90 seconds.",
			})),
		).toBe(true);
	});

	it("is false without any evidence of a model/provider error", () => {
		expect(isModelLevelFailure(result({ exitCode: 1 }))).toBe(false);
	});

	it("is false for results synthesized from a dispatch exception", () => {
		// A body-catch result (spawn infra, fs, delivery bugs) has empty messages
		// and a non-empty stderr, but it never came from the provider: it must not
		// be classified as a model-level failure.
		expect(
			isModelLevelFailure(
				result({
					exitCode: 1,
					stopReason: "error",
					stderr: "Failed to start the sub-agent process.",
					errorMessage: "ENOENT: spawn pi ENOENT",
					dispatchFailed: true,
				}),
			),
		).toBe(false);
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
	const fallbackChildScript = (attemptLog: string): string => fakeRpcScript({
		setup: `fs.appendFileSync(${JSON.stringify(attemptLog)}, "attempt\\n");\nconst modelArg = process.argv.indexOf("--model");\nconst model = modelArg !== -1 ? process.argv[modelArg + 1] : "";`,
		onPrompt: `if (model.startsWith("openai-codex")) {
	send({ type: "message_end", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "model not found" } });
} else {
	send({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "recovered on main model" }], stopReason: "stop" } });
}`,
	});

	it("falls back to the next pool model and reports the live/final model", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-subagents-fallback-"));
		const script = join(dir, "fallback-child.cjs");
		const log = join(dir, "attempts.log");
		writeFileSync(script, fallbackChildScript(log), "utf8");
		const previousScript = process.argv[1];
		process.argv[1] = script;
		const liveModels: Array<{ model?: string; fallbackFrom?: string }> = [];
		try {
			const result = await runSingleAgentWithModelFallback(
				{
					defaultCwd: process.cwd(),
					agent: { ...agent, model: "openai-codex/gpt-5.6-sol" },
					agentName: agent.name,
					task: "review",
					runLevelRetryDelaysMs: [],
					onLive: (event) => {
						if (event.kind === "model") liveModels.push(event);
					},
					makeDetails: (results) => ({ mode: "single", results }),
				},
				["deepseek/deepseek-v4-flash"],
			);
			expect(result.exitCode).toBe(0);
			expect(getFinalOutput(result.messages)).toBe("recovered on main model");
			expect(result.model).toBe("deepseek/deepseek-v4-flash");
			expect(result.modelFallbackFrom).toBe("openai-codex/gpt-5.6-sol");
			expect(result.modelRetries).toBe(0);
			expect(liveModels).toEqual([
				{ kind: "model", model: "openai-codex/gpt-5.6-sol" },
				{ kind: "model", model: "deepseek/deepseek-v4-flash", fallbackFrom: "openai-codex/gpt-5.6-sol" },
			]);
			expect(readFileSync(log, "utf8").split("\n").filter(Boolean)).toHaveLength(2);
		} finally {
			process.argv[1] = previousScript;
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("reports the retried failure with the fallback origin when both attempts fail (run-level retry disabled)", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-subagents-fallback-"));
		const script = join(dir, "always-fail-child.mjs");
		writeFileSync(
			script,
			fakeRpcScript({
				onPrompt: `send({ type: "message_end", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "provider down" } });`,
			}),
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
					runLevelRetryDelaysMs: [],
				},
				["deepseek/deepseek-v4-flash"],
			);
			expect(result.exitCode).toBe(1);
			expect(result.stopReason).toBe("error");
			expect(result.errorMessage).toBe("provider down");
			expect(result.modelFallbackFrom).toBe("openai-codex/gpt-5.6-sol");
			expect(result.model).toBe("deepseek/deepseek-v4-flash");
			expect(result.modelRetries).toBe(0);
		} finally {
			process.argv[1] = previousScript;
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("does not fall back when no fallback model ref is configured", async () => {
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
				runLevelRetryDelaysMs: [],
				makeDetails: (results) => ({ mode: "single", results }),
			});
			expect(result.exitCode).toBe(1);
			expect(result.modelFallbackFrom).toBeUndefined();
			expect(result.modelRetries).toBe(0);
			expect(readFileSync(log, "utf8").split("\n").filter(Boolean)).toHaveLength(1);
		} finally {
			process.argv[1] = previousScript;
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("does not advance the model pool for an ordinary tool failure", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-subagents-tool-failure-"));
		const script = join(dir, "tool-failure-child.mjs");
		const log = join(dir, "attempts.log");
		writeFileSync(
			script,
			fakeRpcScript({
				setup: `const modelIndex = process.argv.indexOf("--model");\nfs.appendFileSync(${JSON.stringify(log)}, process.argv[modelIndex + 1] + "\\n");`,
				onPrompt: `send({ type: "tool_execution_end", toolName: "bash", isError: true, result: { content: [{ type: "text", text: "tests failed" }] } });
	send({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "The task failed because its test tool failed." }], stopReason: "error", errorMessage: "task failed after a tool error" } });`,
			}),
			"utf8",
		);
		const previousScript = process.argv[1];
		process.argv[1] = script;
		try {
			const result = await runSingleAgentWithModelFallback(
				{
					defaultCwd: process.cwd(),
					agent: { ...agent, model: "anthropic/primary" },
					agentName: agent.name,
					task: "run tests",
					runLevelRetryDelaysMs: [10, 10],
					makeDetails: (results) => ({ mode: "single", results }),
				},
				["openai/backup", "google/main"],
			);
			expect(result.exitCode).toBe(1);
			expect(result.failedTools).toHaveLength(1);
			expect(result.model).toBe("anthropic/primary");
			expect(result.modelFallbackFrom).toBeUndefined();
			expect(readFileSync(log, "utf8").trim()).toBe("anthropic/primary");
		} finally {
			process.argv[1] = previousScript;
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("runSingleAgentWithModelFallback run-level retry", () => {
	const agent = {
		name: "fake",
		description: "fake",
		systemPrompt: "",
		source: "builtin" as const,
		filePath: "/agents/fake.md",
	};

	// Child that fails with a transient error for the first `failTimes` launches
	// (counting via LOG_PATH), then emits a normal success on the same model.
	const transientThenRecoverScript = (failTimes: number): string => fakeRpcScript({
		setup: `const log = process.env.LOG_PATH;\nfs.appendFileSync(log, "attempt\\n");\nconst count = fs.readFileSync(log, "utf8").split("\\n").filter(Boolean).length;`,
		onPrompt: `if (count <= ${failTimes}) {
	send({ type: "message_end", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "provider down" } });
} else {
	send({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "recovered on same model" }], stopReason: "stop" } });
}`,
	});

	const withArgv = (script: string, fn: () => Promise<void>): Promise<void> => {
		const previousScript = process.argv[1];
		process.argv[1] = script;
		return fn().finally(() => {
			process.argv[1] = previousScript;
		});
	};

	it("skips same-model retries for a permanent model error, then falls back", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-subagents-runlevel-fallback-"));
		const script = join(dir, "broken-child.cjs");
		const log = join(dir, "attempts.log");
		// A stale model id is permanent for that candidate; the fallback should
		// start immediately even when retry delays are configured.
		writeFileSync(
			script,
			fakeRpcScript({
				setup: `fs.appendFileSync(${JSON.stringify(log)}, "attempt\\n");\nconst modelArg = process.argv.indexOf("--model");\nconst model = modelArg !== -1 ? process.argv[modelArg + 1] : "";`,
				onPrompt: `if (model.startsWith("openai-codex")) {
	send({ type: "message_end", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "model not found" } });
} else {
	send({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "recovered on main model" }], stopReason: "stop" } });
}`,
			}),
			"utf8",
		);
		try {
			await withArgv(script, async () => {
				const result = await runSingleAgentWithModelFallback(
					{
						defaultCwd: process.cwd(),
						agent: { ...agent, model: "openai-codex/gpt-5.6-sol" },
						agentName: agent.name,
						task: "review",
						runLevelRetryDelaysMs: [10, 10, 10, 10, 10],
						makeDetails: (results) => ({ mode: "single", results }),
					},
					["deepseek/deepseek-v4-flash"],
				);
				expect(result.exitCode).toBe(0);
				expect(getFinalOutput(result.messages)).toBe("recovered on main model");
				expect(result.model).toBe("deepseek/deepseek-v4-flash");
				expect(result.modelFallbackFrom).toBe("openai-codex/gpt-5.6-sol");
				expect(result.modelRetries).toBe(0);
				// One stale-primary attempt, then one fallback attempt — no 60s backoff.
				expect(readFileSync(log, "utf8").split("\n").filter(Boolean)).toHaveLength(2);
			});
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("recovers on a later same-model retry without falling back", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-subagents-runlevel-recover-"));
		const script = join(dir, "recover-child.cjs");
		const log = join(dir, "attempts.log");
		writeFileSync(script, transientThenRecoverScript(3), "utf8");
		try {
			await withArgv(script, async () => {
				const result = await runSingleAgentWithModelFallback(
					{
						defaultCwd: process.cwd(),
						agent: { ...agent, model: "openai-codex/gpt-5.6-sol" },
						agentName: agent.name,
						task: "review",
						runLevelRetryDelaysMs: [10, 10, 10, 10, 10],
						env: { ...process.env, LOG_PATH: log },
						makeDetails: (results) => ({ mode: "single", results }),
					},
					["deepseek/deepseek-v4-flash"],
				);
				expect(result.exitCode).toBe(0);
				expect(getFinalOutput(result.messages)).toBe("recovered on same model");
				expect(result.model).toBe("openai-codex/gpt-5.6-sol");
				expect(result.modelFallbackFrom).toBeUndefined();
				expect(result.modelRetries).toBe(3);
				// 1 initial + 3 same-model retries; the 4th launch succeeds.
				expect(readFileSync(log, "utf8").split("\n").filter(Boolean)).toHaveLength(4);
			});
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("advances immediately to backup on a terminal primary error", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-subagents-runlevel-terminal-"));
		const script = join(dir, "quota-child.cjs");
		const log = join(dir, "attempts.log");
		writeFileSync(
			script,
			fakeRpcScript({
				setup: `fs.appendFileSync(${JSON.stringify(log)}, "attempt\\n");\nconst modelIndex = process.argv.indexOf("--model");\nconst model = modelIndex === -1 ? "" : process.argv[modelIndex + 1];`,
				onPrompt: `if (model.startsWith("openai-codex")) {
	send({ type: "message_end", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "insufficient_quota: you exceeded your quota" } });
} else {
	send({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "backup recovered" }], stopReason: "stop" } });
}`,
			}),
			"utf8",
		);
		try {
			await withArgv(script, async () => {
				const result = await runSingleAgentWithModelFallback(
					{
						defaultCwd: process.cwd(),
						agent: { ...agent, model: "openai-codex/gpt-5.6-sol" },
						agentName: agent.name,
						task: "review",
						runLevelRetryDelaysMs: [10, 10, 10, 10, 10],
						env: { ...process.env, LOG_PATH: log },
						makeDetails: (results) => ({ mode: "single", results }),
					},
					["deepseek/deepseek-v4-flash"],
				);
				expect(result.exitCode).toBe(0);
				expect(getFinalOutput(result.messages)).toBe("backup recovered");
				expect(result.model).toBe("deepseek/deepseek-v4-flash");
				expect(result.modelFallbackFrom).toBe("openai-codex/gpt-5.6-sol");
				expect(result.modelRetries).toBe(0);
				expect(readFileSync(log, "utf8").split("\n").filter(Boolean)).toHaveLength(2);
			});
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("stops same-model retries and advances when a retry becomes terminal", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-subagents-runlevel-late-terminal-"));
		const script = join(dir, "late-terminal-child.cjs");
		const log = join(dir, "attempts.log");
		writeFileSync(
			script,
			fakeRpcScript({
				setup: `fs.appendFileSync(${JSON.stringify(log)}, "attempt\\n");\nconst count = fs.readFileSync(${JSON.stringify(log)}, "utf8").split("\\n").filter(Boolean).length;\nconst modelArg = process.argv.indexOf("--model");\nconst model = modelArg === -1 ? "" : process.argv[modelArg + 1];`,
				onPrompt: `if (!model.startsWith("openai-codex")) {
	send({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "backup recovered after terminal retry" }], stopReason: "stop" } });
} else if (count === 1) {
	send({ type: "message_end", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "503 provider down" } });
} else {
	send({ type: "message_end", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "insufficient_quota" } });
}`,
			}),
			"utf8",
		);
		try {
			await withArgv(script, async () => {
				const result = await runSingleAgentWithModelFallback(
					{
						defaultCwd: process.cwd(),
						agent: { ...agent, model: "openai-codex/gpt-5.6-sol" },
						agentName: agent.name,
						task: "review",
						runLevelRetryDelaysMs: [10, 10],
						makeDetails: (results) => ({ mode: "single", results }),
					},
					["deepseek/deepseek-v4-flash"],
				);
				expect(result.exitCode).toBe(0);
				expect(getFinalOutput(result.messages)).toBe("backup recovered after terminal retry");
				expect(result.model).toBe("deepseek/deepseek-v4-flash");
				expect(result.modelFallbackFrom).toBe("openai-codex/gpt-5.6-sol");
				expect(result.modelRetries).toBe(1);
				expect(readFileSync(log, "utf8").split("\n").filter(Boolean)).toHaveLength(3);
			});
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("retries a transient backup, then advances to the current main model", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-subagents-runlevel-chain-"));
		const script = join(dir, "chain-child.cjs");
		const log = join(dir, "attempts.log");
		writeFileSync(
			script,
			fakeRpcScript({
				setup: `const modelIndex = process.argv.indexOf("--model");\nconst model = modelIndex === -1 ? "" : process.argv[modelIndex + 1];\nfs.appendFileSync(${JSON.stringify(log)}, model + "\\n");`,
				onPrompt: `if (model.startsWith("openai-codex")) {
	send({ type: "message_end", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "Request failed with status 401 Unauthorized" } });
} else if (model.startsWith("deepseek")) {
	send({ type: "message_end", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "provider down" } });
} else {
	send({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "main recovered" }], stopReason: "stop" } });
}`,
			}),
			"utf8",
		);
		try {
			await withArgv(script, async () => {
				const result = await runSingleAgentWithModelFallback(
					{
						defaultCwd: process.cwd(),
						agent: { ...agent, model: "openai-codex/gpt-5.6-sol" },
						agentName: agent.name,
						task: "review",
						runLevelRetryDelaysMs: [10],
						makeDetails: (results) => ({ mode: "single", results }),
					},
					["deepseek/deepseek-v4-flash", "anthropic/main"],
				);
				expect(result.exitCode).toBe(0);
				expect(getFinalOutput(result.messages)).toBe("main recovered");
				expect(result.model).toBe("anthropic/main");
				expect(result.modelFallbackFrom).toBe("openai-codex/gpt-5.6-sol");
				expect(result.modelRetries).toBe(1);
				expect(readFileSync(log, "utf8").trim().split("\n")).toEqual([
					"openai-codex/gpt-5.6-sol",
					"deepseek/deepseek-v4-flash",
					"deepseek/deepseek-v4-flash",
					"anthropic/main",
				]);
			});
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("session resume helpers", () => {
	it("sessionExists matches pi's <timestamp>Z_<id>.jsonl naming", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-subagents-sesshelper-"));
		try {
			expect(sessionExists(dir, "abc")).toBe(false);
			writeFileSync(join(dir, "2026-08-13T12-55-01-130Z_abc.jsonl"), "");
			expect(sessionExists(dir, "abc")).toBe(true);
			expect(sessionExists(dir, "other")).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("buildResumePrompt references the task and tells the model not to redo work", () => {
		const prompt = buildResumePrompt("Implement X in src/foo.ts", "a transient provider error");
		expect(prompt).toContain("Implement X in src/foo.ts");
		expect(prompt).toContain("Do NOT redo");
	});

	it("buildFallbackResumeReason mentions the failed model", () => {
		expect(buildFallbackResumeReason("openai-codex/gpt-5.6-sol")).toContain("openai-codex/gpt-5.6-sol");
		expect(buildFallbackResumeReason()).toContain("configured pool");
	});
});

describe("runSingleAgentWithModelFallback session resume", () => {
	const agent = {
		name: "fake",
		description: "fake",
		systemPrompt: "",
		source: "builtin" as const,
		filePath: "/agents/fake.md",
	};

	const withArgv = (script: string, fn: () => Promise<void>): Promise<void> => {
		const previousScript = process.argv[1];
		process.argv[1] = script;
		return fn().finally(() => {
			process.argv[1] = previousScript;
		});
	};

	// Child that simulates a real pi session: it writes a session file named
	// <ts>Z_<id>.jsonl into its --session-dir so the NEXT attempt resumes. Logs
	// each invocation's flags so the test can assert --session-id vs --session.
	const sessionAwareChild = (log: string): string => fakeRpcScript({
		setup: `const argv = process.argv;\nfs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(argv) + "\\n");\nconst modelIdx = argv.indexOf("--model");\nconst model = modelIdx !== -1 ? argv[modelIdx + 1] : "";`,
		onPrompt: `if (model.startsWith("openai-codex")) {
	send({ type: "message_end", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "model not found" } });
} else {
	send({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "recovered" }], stopReason: "stop" } });
}`,
	});

	it("resumes the session (not restarts) when falling back to another model", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-subagents-resume-"));
		const script = join(dir, "resume-child.cjs");
		const log = join(dir, "flags.log");
		writeFileSync(script, sessionAwareChild(log), "utf8");
		await withArgv(script, async () => {
			const result = await runSingleAgentWithModelFallback(
				{
					defaultCwd: process.cwd(),
					agent: { ...agent, model: "openai-codex/gpt-5.6-sol" },
					agentName: agent.name,
					task: "review src/index.ts",
					runLevelRetryDelaysMs: [],
					makeDetails: (results) => ({ mode: "single", results }),
				},
				["deepseek/deepseek-v4-flash"],
			);
			expect(result.exitCode).toBe(0);
			expect(result.model).toBe("deepseek/deepseek-v4-flash");
			expect(result.modelFallbackFrom).toBe("openai-codex/gpt-5.6-sol");
			// The fallback attempt resumed the prior session, inheriting its context.
			expect(result.resumed).toBe(true);
			const invocations = readFileSync(log, "utf8")
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line) as string[]);
			expect(invocations).toHaveLength(2);
			// First attempt CREATES the session (--session-id, no bare --session);
			// the fallback RESUMES it (bare --session, no --session-id). Both carry
			// --session-dir; `arr.includes("--session")` is an exact-token match, so
			// it is true only when the bare resume flag is present.
			expect(invocations[0].includes("--session-id")).toBe(true);
			expect(invocations[0].includes("--session")).toBe(false);
			expect(invocations[1].includes("--session-id")).toBe(false);
			expect(invocations[1].includes("--session")).toBe(true);
			const firstSessionId = invocations[0][invocations[0].indexOf("--session-id") + 1];
			const resumedSessionId = invocations[1][invocations[1].indexOf("--session") + 1];
			expect(resumedSessionId).toBe(firstSessionId);
			expect(invocations[1][invocations[1].indexOf("--session-dir") + 1]).toBe(
				invocations[0][invocations[0].indexOf("--session-dir") + 1],
			);
			expect(result.sessionId).toBe(firstSessionId);
		});
		rmSync(dir, { recursive: true, force: true });
	});

	it("retains the session dir for a model-level failure until runtime cleanup", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-subagents-nowork-"));
		const script = join(dir, "always-fail.cjs");
		writeFileSync(
			script,
			fakeRpcScript({
				onPrompt: `send({ type: "message_end", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "provider down" } });`,
			}),
			"utf8",
		);
		await withArgv(script, async () => {
			const result = await runSingleAgentWithModelFallback({
				defaultCwd: process.cwd(),
				agent: { ...agent, model: "openai-codex/gpt-5.6-sol" },
				agentName: agent.name,
				task: "review",
				runLevelRetryDelaysMs: [],
				makeDetails: (results) => ({ mode: "single", results }),
			});
			expect(isModelLevelFailure(result)).toBe(true);
			// Logical thread sessions are retained regardless of outcome so control
			// resume can restart completed/failed context until parent shutdown.
			expect(result.sessionDir).toBeDefined();
			expect(existsSync(result.sessionDir!)).toBe(true);
			rmSync(result.sessionDir!, { recursive: true, force: true });
		});
		rmSync(dir, { recursive: true, force: true });
	});
});

describe("isTerminalModelError (unit)", () => {
	const base = (overrides: Partial<SingleResult>): SingleResult => ({
		agent: "worker",
		agentSource: "builtin",
		task: "t",
		exitCode: 1,
		messages: [],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		...overrides,
	});

	it("is terminal for quota / billing / usage-limit text", () => {
		expect(isTerminalModelError(base({ errorMessage: "insufficient_quota: exceeded" }))).toBe(true);
		expect(isTerminalModelError(base({ errorMessage: "You have exceeded your quota" }))).toBe(true);
		expect(isTerminalModelError(base({ errorMessage: "out of budget" }))).toBe(true);
		expect(isTerminalModelError(base({ errorMessage: "billing: card declined" }))).toBe(true);
		expect(isTerminalModelError(base({ errorMessage: "monthly usage limit reached" }))).toBe(true);
	});

	it("is terminal for auth / invalid-key text", () => {
		expect(isTerminalModelError(base({ errorMessage: "invalid api key" }))).toBe(true);
		expect(isTerminalModelError(base({ errorMessage: "Incorrect API key provided" }))).toBe(true);
		expect(isTerminalModelError(base({ errorMessage: "Request failed with status 401" }))).toBe(true);
		expect(isTerminalModelError(base({ errorMessage: "403 forbidden" }))).toBe(true);
		expect(isTerminalModelError(base({ errorMessage: "unauthorized" }))).toBe(true);
	});

	it("is NOT terminal for transient provider errors", () => {
		expect(isTerminalModelError(base({ errorMessage: "model not found" }))).toBe(false);
		expect(isTerminalModelError(base({ errorMessage: "provider down" }))).toBe(false);
		expect(isTerminalModelError(base({ errorMessage: "503 Service Unavailable" }))).toBe(false);
		expect(isTerminalModelError(base({ errorMessage: "429 Too Many Requests" }))).toBe(false);
		expect(isTerminalModelError(base({ errorMessage: "overloaded" }))).toBe(false);
		expect(isTerminalModelError(base({ errorMessage: "network error: fetch failed" }))).toBe(false);
		expect(isTerminalModelError(base({ errorMessage: "Subagent idle timeout: no activity for 90 seconds." }))).toBe(false);
	});

	it("does NOT let noisy stderr override a transient errorMessage", () => {
		// A transient 503 must stay retryable even when stderr coincidentally
		// mentions a terminal-looking word (npm warning, proxy banner).
		expect(isTerminalModelError(base({ errorMessage: "503 Service Unavailable", stderr: "npm warn billing..." }))).toBe(false);
		expect(isTerminalModelError(base({ errorMessage: "overloaded", stderr: "403 forbidden in some log line" }))).toBe(false);
	});

	it("classifies a terminal error from stderr when there is no errorMessage", () => {
		expect(isTerminalModelError(base({ stderr: "invalid api key provided" }))).toBe(true);
		expect(isTerminalModelError(base({ stderr: "insufficient_quota" }))).toBe(true);
	});

	it("is NOT terminal when there is no error message", () => {
		expect(isTerminalModelError(base({}))).toBe(false);
		expect(isTerminalModelError(base({ errorMessage: "" }))).toBe(false);
	});

	it("classifies permanent model/provider configuration failures separately", () => {
		expect(isPermanentModelCandidateError(base({ errorMessage: "model not found" }))).toBe(true);
		expect(isPermanentModelCandidateError(base({ errorMessage: "Unknown model: stale/id" }))).toBe(true);
		expect(isPermanentModelCandidateError(base({ errorMessage: "404 Not Found" }))).toBe(true);
		expect(isPermanentModelCandidateError(base({ stderr: "provider does not exist" }))).toBe(true);
		expect(isPermanentModelCandidateError(base({ errorMessage: "503 Service Unavailable" }))).toBe(false);
		expect(isPermanentModelCandidateError(base({ errorMessage: "429 Too Many Requests" }))).toBe(false);
		expect(isPermanentModelCandidateError(base({ errorMessage: "network timeout" }))).toBe(false);
	});
});

describe("runSingleAgentWithModelFallback startup retry", () => {
	const agent = {
		name: "fake",
		description: "fake",
		systemPrompt: "",
		source: "builtin" as const,
		filePath: "/agents/fake.md",
	};

	// Child that records each launch to LOG_PATH: it exits silently (no stdout, no
	// stderr) on the first `failTimes` launches, then emits a normal success.
	const retryThenSucceedScript = (failTimes: number): string => fakeRpcScript({
		setup: `const log = process.env.LOG_PATH;\nfs.appendFileSync(log, "attempt\\n");\nconst count = fs.readFileSync(log, "utf8").split("\\n").filter(Boolean).length;\nif (count <= ${failTimes}) process.exit(1);`,
		onPrompt: `send({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "recovered after startup retry" }], stopReason: "stop" } });`,
	});

	const withArgv = (script: string, fn: () => Promise<void>): Promise<void> => {
		const previousScript = process.argv[1];
		process.argv[1] = script;
		return fn().finally(() => {
			process.argv[1] = previousScript;
		});
	};

	it("retries a silent zero-activity startup failure, then succeeds", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-subagents-startup-retry-"));
		const script = join(dir, "retry-child.cjs");
		const log = join(dir, "attempts.log");
		writeFileSync(script, retryThenSucceedScript(1), "utf8");
		try {
			await withArgv(script, async () => {
				const result = await runSingleAgentWithModelFallback({
					defaultCwd: process.cwd(),
					agent,
					agentName: agent.name,
					task: "survive a startup race",
					startupRetryDelaysMs: [10],
					env: { ...process.env, LOG_PATH: log },
					makeDetails: (results) => ({ mode: "single", results }),
				});
				expect(result.exitCode).toBe(0);
				expect(getFinalOutput(result.messages)).toBe("recovered after startup retry");
				expect(result.startupRetries).toBe(1);
				expect(result.dispatchFailed).toBeUndefined();
				expect(readFileSync(log, "utf8").split("\n").filter(Boolean)).toHaveLength(2);
			});
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("surfaces a dispatch failure after exhausting startup retries", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-subagents-startup-exhaust-"));
		const script = join(dir, "always-silent.cjs");
		const log = join(dir, "attempts.log");
		writeFileSync(
			script,
			`const fs = require("node:fs");
fs.appendFileSync(process.env.LOG_PATH, "attempt\\n");
process.exit(1);`,
			"utf8",
		);
		try {
			await withArgv(script, async () => {
				const result = await runSingleAgentWithModelFallback({
					defaultCwd: process.cwd(),
					agent,
					agentName: agent.name,
					task: "never starts",
					startupRetryDelaysMs: [10, 10, 10],
					env: { ...process.env, LOG_PATH: log },
					makeDetails: (results) => ({ mode: "single", results }),
				});
				expect(result.exitCode).toBe(1);
				expect(result.dispatchFailed).toBe(true);
				expect(result.startupRetries).toBeUndefined();
				expect(result.errorMessage).toContain("failed to start after 4 attempts");
				expect(result.errorMessage).toContain("concurrent pi startup race");
				expect(readFileSync(log, "utf8").split("\n").filter(Boolean)).toHaveLength(4);
			});
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("does not retry a failure that wrote to stderr (real error, not a race)", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-subagents-startup-stderr-"));
		const script = join(dir, "stderr-child.cjs");
		const log = join(dir, "attempts.log");
		writeFileSync(
			script,
			`const fs = require("node:fs");
fs.appendFileSync(process.env.LOG_PATH, "attempt\\n");
process.stderr.write("some real error\\n");
process.exit(1);`,
			"utf8",
		);
		try {
			await withArgv(script, async () => {
				const result = await runSingleAgentWithModelFallback({
					defaultCwd: process.cwd(),
					agent,
					agentName: agent.name,
					task: "real error",
					startupRetryDelaysMs: [10, 10, 10],
					runLevelRetryDelaysMs: [],
					env: { ...process.env, LOG_PATH: log },
					makeDetails: (results) => ({ mode: "single", results }),
				});
				expect(result.exitCode).toBe(1);
				expect(result.dispatchFailed).toBeUndefined();
				expect(result.startupRetries).toBeUndefined();
				expect(result.stderr).toContain("some real error");
				expect(readFileSync(log, "utf8").split("\n").filter(Boolean)).toHaveLength(1);
			});
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("does not retry a run that produced model output", async () => {
		// A run that emitted a message_end (even a failing one) did real work and
		// must not be retried as a startup race; it belongs to model fallback.
		const dir = mkdtempSync(join(tmpdir(), "pi-subagents-startup-output-"));
		const script = join(dir, "output-child.cjs");
		const log = join(dir, "attempts.log");
		writeFileSync(
			script,
			fakeRpcScript({
				setup: `fs.appendFileSync(process.env.LOG_PATH, "attempt\\n");`,
				onPrompt: `send({ type: "message_end", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "provider down" } });`,
			}),
			"utf8",
		);
		try {
			await withArgv(script, async () => {
				const result = await runSingleAgentWithModelFallback({
					defaultCwd: process.cwd(),
					agent,
					agentName: agent.name,
					task: "real model error",
					startupRetryDelaysMs: [10, 10, 10],
					runLevelRetryDelaysMs: [],
					env: { ...process.env, LOG_PATH: log },
					makeDetails: (results) => ({ mode: "single", results }),
				});
				expect(result.exitCode).toBe(1);
				expect(result.dispatchFailed).toBeUndefined();
				expect(result.startupRetries).toBeUndefined();
				expect(result.errorMessage).toBe("provider down");
				expect(readFileSync(log, "utf8").split("\n").filter(Boolean)).toHaveLength(1);
			});
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("isRetryableStartupFailure (unit)", () => {
	const base = (overrides: Partial<SingleResult>): SingleResult => ({
		agent: "worker",
		agentSource: "builtin",
		task: "t",
		exitCode: 1,
		messages: [],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		...overrides,
	});

	it("is retryable for a silent zero-activity fast exit", () => {
		expect(isRetryableStartupFailure(base({}), 120)).toBe(true);
	});

	it("is not retryable on a clean exit", () => {
		expect(isRetryableStartupFailure(base({ exitCode: 0 }), 120)).toBe(false);
	});

	it("is not retryable when aborted", () => {
		expect(isRetryableStartupFailure(base({ stopReason: "aborted" }), 120)).toBe(false);
	});

	it("is not retryable when a dispatch crash already synthesized the result", () => {
		expect(isRetryableStartupFailure(base({ dispatchFailed: true }), 120)).toBe(false);
	});

	it("is not retryable when stderr carries a real error", () => {
		expect(isRetryableStartupFailure(base({ stderr: "ENOENT: spawn pi" }), 120)).toBe(false);
	});

	it("is not retryable when an error message is set", () => {
		expect(isRetryableStartupFailure(base({ errorMessage: "model not found" }), 120)).toBe(false);
	});

	it("is not retryable when the run produced model output", () => {
		expect(
			isRetryableStartupFailure(base({ messages: [{ role: "assistant", content: [{ type: "text", text: "hi" }] } as any] }), 120),
		).toBe(false);
	});

	it("is not retryable when usage shows the provider was reached", () => {
		expect(isRetryableStartupFailure(base({ usage: { input: 10, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 } }), 120)).toBe(false);
	});

	it("is not retryable when the run outlived the startup window", () => {
		expect(isRetryableStartupFailure(base({}), 5000)).toBe(false);
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

describe("extractToolErrorText", () => {
	it("keeps the last non-empty lines of a tool's error content", () => {
		expect(extractToolErrorText([{ type: "text", text: "head\n\nMSBuild.exe failed\nfatal error C3861: undeclared" }])).toBe("head\nMSBuild.exe failed\nfatal error C3861: undeclared");
		expect(extractToolErrorText([{ type: "text", text: "a\n\nb\nc" }])).toBe("a\nb\nc");
	});

	it("clips long lines to RESULT_LINE_MAX", () => {
		const long = "x".repeat(RESULT_LINE_MAX + 10);
		const out = extractToolErrorText([{ type: "text", text: long }]);
		expect(out.length).toBe(RESULT_LINE_MAX + 1); // clipped + ellipsis
		expect(out.endsWith("…")).toBe(true);
	});

	it("ignores non-text parts and non-array input", () => {
		expect(extractToolErrorText([{ type: "image", text: "no" }, { type: "text", text: "real" }])).toBe("real");
		expect(extractToolErrorText(undefined)).toBe("");
		expect(extractToolErrorText({ type: "text", text: "x" })).toBe("");
	});
});

describe("getResultOutput", () => {
	it("returns the final assistant text for a successful run", () => {
		const r = result({ exitCode: 0, messages: [assistant("all done")] });
		expect(getResultOutput(r)).toBe("all done");
	});

	it("returns just the error when a failed run has no partial output", () => {
		const r = result({ exitCode: 1, errorMessage: "crashed" });
		expect(getResultOutput(r)).toBe("crashed");
	});

	it("includes both error and partial output when a failed run has messages", () => {
		const r = result({
			exitCode: 1,
			errorMessage: "Subagent was aborted",
			stopReason: "aborted",
			messages: [assistant("I read src/index.ts and started editing...")],
		});
		const out = getResultOutput(r);
		expect(out).toContain("Subagent was aborted");
		expect(out).toContain("--- Partial output ---");
		expect(out).toContain("I read src/index.ts and started editing...");
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

	it("groups results under a per-project subdirectory when cwd is given", () => {
		const artifactPath = writeResultArtifact("body", "worker", "/home/user/my-project");
		expect(artifactPath).toContain(join("pi-subagents-results", "my-project"));
		expect(readFileSync(artifactPath, "utf8")).toBe("body");
		rmSync(artifactPath, { force: true });
	});
});
