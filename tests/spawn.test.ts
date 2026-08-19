import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { registerApiProvider, unregisterApiProviders } from "@earendil-works/pi-ai/compat";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { formatCompletionBlock } from "../src/format.ts";
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
	isRetryableStartupFailure,
	pruneResultArtifacts,
	resultArtifactProjectKey,
	RESULT_ARTIFACT_MAX_AGE_MS,
	RESULT_ARTIFACT_MAX_FILES_PER_PROJECT,
	RESULT_LINE_MAX,
	reviewVerdict,
	runSingleAgent,
	runSingleAgentWithMainFallback,
	sessionExists,
	truncateResultOutput,
	writeChildRetryPolicyExtension,
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

describe("child retry policy", () => {
	it("uses a Pi extension provider adapter that forces maxRetries=0", async () => {
		const policy = await writeChildRetryPolicyExtension("test-provider/selected");
		const sourceId = `pi-subagents-test-${Date.now()}`;
		try {
			const source = readFileSync(policy.filePath, "utf8");
			expect(source).not.toContain("SettingsManager");
			expect(source).not.toContain("NODE_OPTIONS");
			const loadablePath = join(policy.dir, "loadable-policy.mjs");
			writeFileSync(
				loadablePath,
				source.replace(
					'"@earendil-works/pi-ai/compat"',
					JSON.stringify(import.meta.resolve("@earendil-works/pi-ai/compat")),
				),
				"utf8",
			);
			registerApiProvider({
				api: "pi-subagents-test-api" as any,
				stream: (() => undefined) as any,
				streamSimple: ((_model: unknown, _context: unknown, options: unknown) => options) as any,
			}, sourceId);
			const extension = (await import(`${pathToFileURL(loadablePath).href}?${Date.now()}`)).default;
			let registration: { provider: string; config: any } | undefined;
			let beforeProviderRequest: ((event: unknown, ctx: any) => void) | undefined;
			extension({
				registerProvider(provider: string, config: any) {
					registration = { provider, config };
				},
				on(event: string, handler: (event: unknown, ctx: any) => void) {
					if (event === "before_provider_request") beforeProviderRequest = handler;
				},
			});
			expect(registration).toBeUndefined();
			beforeProviderRequest?.({}, { model: { provider: "test-provider" } });
			expect(registration?.provider).toBe("test-provider");
			const options = registration?.config.streamSimple(
				{ api: "pi-subagents-test-api" },
				{},
				{ maxRetries: 9, marker: true },
			);
			expect(options).toEqual({ maxRetries: 0, marker: true });
		} finally {
			unregisterApiProviders(sourceId);
			rmSync(policy.dir, { recursive: true, force: true });
		}
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
			idleTimeoutMs: 1_000,
		});
			expect(getFinalOutput(result.messages)).toBe("started");
			expect(result.stopReason).toBe("error");
			expect(result.errorMessage).toContain("idle timeout");
			expect(result.exitCode).not.toBe(0);
		} finally {
			process.argv[1] = previousScript;
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("lets Pi's outer turn retry recover a terminated stream", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-subagents-turn-retry-"));
		const script = join(dir, "turn-retry-child.mjs");
		const abortLog = join(dir, "abort.log");
		writeFileSync(
			script,
			fakeRpcScript({
				autoSettle: false,
				onPrompt: `send({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "partial" }], stopReason: "error", errorMessage: "terminated" } });
	send({ type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 10 });
	setTimeout(() => {
		send({ type: "auto_retry_end", success: true, attempt: 1 });
		send({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "recovered after terminated" }], stopReason: "stop" } });
		send({ type: "agent_settled" });
	}, 30);`,
				onAbortRetry: `fs.appendFileSync(${JSON.stringify(abortLog)}, "aborted\\n");
	send({ type: "auto_retry_end", success: false, attempt: 1 });
	send({ type: "agent_settled" });`,
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
				task: "retry terminated streams",
				makeDetails: (results) => ({ mode: "single", results }),
			});
			expect(existsSync(abortLog)).toBe(false);
			expect(result.stopReason).toBe("stop");
			expect(getFinalOutput(result.messages)).toBe("recovered after terminated");
			expect(result.exitCode).toBe(0);
		} finally {
			process.argv[1] = previousScript;
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("does not fire idle timeout while stdout is active", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-subagents-idle-active-"));
		const script = join(dir, "active-child.mjs");
		// Run longer than the idle timeout while emitting a line every 200ms.
		writeFileSync(
			script,
			fakeRpcScript({
				onPrompt: `let n = 0;
const timer = setInterval(() => {
	n++;
	send({ type: "message_update", assistantMessageEvent: { type: "thinking_delta" } });
	if (n >= 7) {
		clearInterval(timer);
		send({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop" } });
		send({ type: "agent_settled" });
	}
}, 200);`,
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
				idleTimeoutMs: 1_000,
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
			messages: [{ role: "assistant", content: [], stopReason: "error", errorMessage: "429 rate limit" } as any],
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

	it("is false when a task failure ends with a non-error assistant stop", () => {
		expect(
			isModelLevelFailure(result({
				exitCode: 1,
				stopReason: "error",
				messages: [{ ...assistant("build failed"), stopReason: "stop" }],
			})),
		).toBe(false);
	});

	it("is true when a terminal provider error preserves partial text", () => {
		expect(
			isModelLevelFailure(result({
				exitCode: 1,
				stopReason: "error",
				messages: [{ ...assistant("partial response"), stopReason: "error", errorMessage: "stream terminated" } as any],
			})),
		).toBe(true);
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

describe("runSingleAgentWithMainFallback", () => {
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
	send({ type: "tool_execution_end", toolName: "bash", isError: true, result: { content: [{ type: "text", text: "selected-model test failed" }] } });
	send({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "partial selected-model output" }], stopReason: "error", errorMessage: "429 rate limit", usage: { input: 3, output: 2, cacheRead: 1, cacheWrite: 0, cost: { total: 0.01 }, totalTokens: 6 } } });
} else {
	send({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "recovered on main model" }], stopReason: "stop" } });
}`,
	});

	it("hands directly to main and re-clamps thinking after selected-model failure", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-subagents-fallback-"));
		const script = join(dir, "fallback-child.cjs");
		const log = join(dir, "attempts.log");
		writeFileSync(script, fallbackChildScript(log), "utf8");
		const previousScript = process.argv[1];
		process.argv[1] = script;
		const liveModels: Array<{ kind: "model"; model?: string; thinking?: string; fallbackFrom?: string }> = [];
		try {
			const result = await runSingleAgentWithMainFallback(
				{
					defaultCwd: process.cwd(),
					agent: { ...agent, model: "openai-codex/gpt-5.6-sol" },
					agentName: agent.name,
					task: "review",
					thinkingLevel: "high",
					thinkingLevelForModel: (ref) => ref === "anthropic/main" ? "max" : "low",
					onLive: (event) => {
						if (event.kind === "model") liveModels.push(event);
					},
					makeDetails: (results) => ({ mode: "single", results }),
				},
				"anthropic/main",
			);
			expect(result.exitCode).toBe(0);
			expect(getFinalOutput(result.messages)).toBe("recovered on main model");
			expect(result.model).toBe("anthropic/main");
			expect(result.thinking).toBe("max");
			expect(result.modelFallbackFrom).toBe("openai-codex/gpt-5.6-sol");
			expect(result.failedTools).toEqual([{ toolName: "bash", error: "selected-model test failed" }]);
			expect(result.usage).toMatchObject({ input: 3, output: 2, cacheRead: 1, cost: 0.01, turns: 2 });
			expect(liveModels).toEqual([
				{ kind: "model", model: "openai-codex/gpt-5.6-sol", thinking: "low" },
				{ kind: "model", model: "anthropic/main", thinking: "max", fallbackFrom: "openai-codex/gpt-5.6-sol" },
			]);
			expect(readFileSync(log, "utf8").split("\n").filter(Boolean)).toHaveLength(2);
		} finally {
			process.argv[1] = previousScript;
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("reports the fallback origin when both selected and main models fail", async () => {
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
			const result = await runSingleAgentWithMainFallback(
				{
					defaultCwd: process.cwd(),
					agent: { ...agent, model: "openai-codex/gpt-5.6-sol" },
					agentName: agent.name,
					task: "review",
					makeDetails: (results) => ({ mode: "single", results }),
				},
				"anthropic/main",
			);
			expect(result.exitCode).toBe(1);
			expect(result.stopReason).toBe("error");
			expect(result.errorMessage).toBe("provider down");
			expect(result.modelFallbackFrom).toBe("openai-codex/gpt-5.6-sol");
			expect(result.model).toBe("anthropic/main");
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
			const result = await runSingleAgentWithMainFallback({
				defaultCwd: process.cwd(),
				agent: { ...agent, model: "openai-codex/gpt-5.6-sol" },
				agentName: agent.name,
				task: "review",
				makeDetails: (results) => ({ mode: "single", results }),
			});
			expect(result.exitCode).toBe(1);
			expect(result.modelFallbackFrom).toBeUndefined();
			expect(readFileSync(log, "utf8").split("\n").filter(Boolean)).toHaveLength(1);
		} finally {
			process.argv[1] = previousScript;
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("does not hand to main for an ordinary tool failure", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-subagents-tool-failure-"));
		const script = join(dir, "tool-failure-child.mjs");
		const log = join(dir, "attempts.log");
		writeFileSync(
			script,
			fakeRpcScript({
				setup: `const modelIndex = process.argv.indexOf("--model");\nfs.appendFileSync(${JSON.stringify(log)}, process.argv[modelIndex + 1] + "\\n");`,
				onPrompt: `send({ type: "tool_execution_end", toolName: "bash", isError: true, result: { content: [{ type: "text", text: "tests failed" }] } });
	send({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "The task failed because its test tool failed." }], stopReason: "stop" } });`,
			}),
			"utf8",
		);
		const previousScript = process.argv[1];
		process.argv[1] = script;
		try {
			const result = await runSingleAgentWithMainFallback(
				{
					defaultCwd: process.cwd(),
					agent: { ...agent, model: "anthropic/primary" },
					agentName: agent.name,
					task: "run tests",
					makeDetails: (results) => ({ mode: "single", results }),
				},
				"openai/main",
			);
			expect(result.exitCode).toBe(0);
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
		expect(buildFallbackResumeReason()).toContain("current main model");
	});
});

describe("runSingleAgentWithMainFallback session resume", () => {
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
	send({ type: "tool_execution_end", toolName: "bash", isError: true, result: { content: [{ type: "text", text: "selected-model test failed" }] } });
	send({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "partial selected-model output" }], stopReason: "error", errorMessage: "429 rate limit", usage: { input: 3, output: 2, cacheRead: 1, cacheWrite: 0, cost: { total: 0.01 }, totalTokens: 6 } } });
} else {
	send({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "recovered" }], stopReason: "stop" } });
}`,
	});

	it("resumes the session when handing from selected to main model", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-subagents-resume-"));
		const script = join(dir, "resume-child.cjs");
		const log = join(dir, "flags.log");
		writeFileSync(script, sessionAwareChild(log), "utf8");
		await withArgv(script, async () => {
			const result = await runSingleAgentWithMainFallback(
				{
					defaultCwd: process.cwd(),
					agent: { ...agent, model: "openai-codex/gpt-5.6-sol" },
					agentName: agent.name,
					task: "review src/index.ts",
					makeDetails: (results) => ({ mode: "single", results }),
				},
				"anthropic/main",
			);
			expect(result.exitCode).toBe(0);
			expect(result.model).toBe("anthropic/main");
			expect(result.modelFallbackFrom).toBe("openai-codex/gpt-5.6-sol");
			// The fallback attempt reused the prior session, inheriting its context.
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
			const result = await runSingleAgentWithMainFallback({
				defaultCwd: process.cwd(),
				agent: { ...agent, model: "openai-codex/gpt-5.6-sol" },
				agentName: agent.name,
				task: "review",
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

describe("runSingleAgentWithMainFallback startup retry", () => {
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
				const result = await runSingleAgentWithMainFallback({
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
				const result = await runSingleAgentWithMainFallback({
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
				const result = await runSingleAgentWithMainFallback({
					defaultCwd: process.cwd(),
					agent,
					agentName: agent.name,
					task: "real error",
					startupRetryDelaysMs: [10, 10, 10],
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

	it("does not retry after the child accepted the prompt", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-subagents-startup-accepted-"));
		const script = join(dir, "accepted-child.cjs");
		const log = join(dir, "attempts.log");
		writeFileSync(
			script,
			fakeRpcScript({
				setup: `fs.appendFileSync(process.env.LOG_PATH, "attempt\\n");`,
				emitAgentStart: false,
				autoSettle: false,
				onPrompt: `setTimeout(() => process.exit(1), 10);`,
			}),
			"utf8",
		);
		try {
			await withArgv(script, async () => {
				const result = await runSingleAgentWithMainFallback({
					defaultCwd: process.cwd(),
					agent,
					agentName: agent.name,
					task: "accepted then crashed",
					startupRetryDelaysMs: [10, 10, 10],
					env: { ...process.env, LOG_PATH: log },
					makeDetails: (results) => ({ mode: "single", results }),
				});
				expect(result.rpcPromptAccepted).toBe(true);
				expect(result.startupRetries).toBeUndefined();
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
				const result = await runSingleAgentWithMainFallback({
					defaultCwd: process.cwd(),
					agent,
					agentName: agent.name,
					task: "real model error",
					startupRetryDelaysMs: [10, 10, 10],
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

	it("is not retryable after an accepted prompt or agent activity", () => {
		expect(isRetryableStartupFailure(base({ rpcPromptAccepted: true }), 120)).toBe(false);
		expect(isRetryableStartupFailure(base({ rpcActivity: true }), 120)).toBe(false);
	});

	it("is not retryable when stderr carries a real error", () => {
		expect(isRetryableStartupFailure(base({ stderr: "ENOENT: spawn pi" }), 120)).toBe(false);
	});

	it("is not retryable when an error message is set", () => {
		expect(isRetryableStartupFailure(base({ errorMessage: "429 rate limit" }), 120)).toBe(false);
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

describe("failed tool diagnostics", () => {
	it("shows every retained diagnostic in explicit status even when the run failed", () => {
		const failed = result({
			exitCode: 1,
			stopReason: "error",
			errorMessage: "provider failed",
			failedTools: Array.from({ length: 4 }, (_, index) => ({
				toolName: `tool-${index + 1}`,
				error: `error-${index + 1}`,
			})),
		});
		const formatted = formatCompletionBlock(failed, 80, undefined, { failedToolDetails: true });
		for (let index = 1; index <= 4; index++) {
			expect(formatted).toContain(`- tool-${index}: error-${index}`);
		}
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

	it("groups results by a stable full-project-path key", () => {
		const artifactPath = writeResultArtifact("body", "worker", "/home/user/my-project");
		expect(dirname(artifactPath)).toContain(join("pi-subagents-results", resultArtifactProjectKey("/home/user/my-project")));
		expect(readFileSync(artifactPath, "utf8")).toBe("body");
		rmSync(artifactPath, { force: true });
	});

	it("uses the result's original project cwd instead of the query cwd", () => {
		const parent = mkdtempSync(join(isolatedTemp, "pi-subagents-result-cwd-"));
		const original = join(parent, "original", "same-name");
		const query = join(parent, "query", "same-name");
		mkdirSync(original, { recursive: true });
		mkdirSync(query, { recursive: true });
		const formatted = formatCompletionBlock(result({
			projectCwd: original,
			messages: [assistant("line one\nline two")],
		}), 1, query);
		const artifact = /full result: (.+)\)/.exec(formatted)?.[1];
		expect(artifact).toBeDefined();
		expect(dirname(artifact!)).toContain(resultArtifactProjectKey(original));
		expect(dirname(artifact!)).not.toContain(resultArtifactProjectKey(query));
		rmSync(artifact!, { force: true });
		rmSync(parent, { recursive: true, force: true });
	});

	it("keeps same-named projects in separate retention buckets", () => {
		const parent = mkdtempSync(join(isolatedTemp, "pi-subagents-project-keys-"));
		const first = join(parent, "one", "same-name");
		const second = join(parent, "two", "same-name");
		mkdirSync(first, { recursive: true });
		mkdirSync(second, { recursive: true });
		const firstArtifact = writeResultArtifact("one", "worker", first);
		const secondArtifact = writeResultArtifact("two", "worker", second);
		expect(dirname(firstArtifact)).not.toBe(dirname(secondArtifact));
		rmSync(firstArtifact, { force: true });
		rmSync(secondArtifact, { force: true });
		rmSync(parent, { recursive: true, force: true });
	});

	it("bounds Markdown artifacts by age and count without touching other files", () => {
		expect(RESULT_ARTIFACT_MAX_AGE_MS).toBe(7 * 24 * 60 * 60 * 1_000);
		expect(RESULT_ARTIFACT_MAX_FILES_PER_PROJECT).toBe(50);
		const root = mkdtempSync(join(isolatedTemp, "pi-subagents-artifact-prune-"));
		const project = join(root, "project");
		mkdirSync(project);
		const now = 10_000_000;
		const writeAt = (name: string, mtimeMs: number): void => {
			const path = join(project, name);
			writeFileSync(path, name, "utf8");
			utimesSync(path, mtimeMs / 1_000, mtimeMs / 1_000);
		};
		writeAt("pi-subagent-10000000000000-aaaaaaaaaaaa-newest.md", now - 100);
		writeAt("pi-subagent-10000000000001-bbbbbbbbbbbb-second.md", now - 200);
		writeAt("pi-subagent-10000000000002-cccccccccccc-overflow.md", now - 300);
		writeAt("pi-subagent-10000000000003-dddddddddddd-expired.md", now - 2_000);
		writeAt("unknown.md", now - 2_000);
		writeAt("unrelated.txt", now - 2_000);

		pruneResultArtifacts(root, { now, maxAgeMs: 1_000, maxFilesPerProject: 2 });

		expect(readdirSync(project).sort()).toEqual([
			"pi-subagent-10000000000000-aaaaaaaaaaaa-newest.md",
			"pi-subagent-10000000000001-bbbbbbbbbbbb-second.md",
			"unknown.md",
			"unrelated.txt",
		]);
		rmSync(root, { recursive: true, force: true });
	});
});
