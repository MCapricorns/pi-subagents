/** Child-transport and fallback lifecycle coverage split from spawn.test.ts:
 * these suites drive real RPC child processes with per-test argv swap-in, so
 * they cannot run concurrently within one worker — splitting them lets the
 * slow process-bound half parallelize with the fast unit half across files. */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fakeRpcScript } from "./fake-rpc.ts";
import { readJsonLines } from "./test-helpers.ts";
import {
	buildFallbackResumeReason,
	buildResumePrompt,
	getFinalOutput,
	isModelLevelFailure,
	RpcRunControl,
	runSingleAgent,
	runSingleAgentWithMainFallback,
	sessionExists,
	type SingleResult,
} from "../src/spawn.ts";

let savedTemp: string | undefined;
let savedTmp: string | undefined;
let isolatedTemp: string;

beforeAll(() => {
	savedTemp = process.env.TEMP;
	savedTmp = process.env.TMP;
	isolatedTemp = mkdtempSync(join(tmpdir(), "pi-subagents-spawn-lifecycle-"));
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

/** Every run gets an isolated throwaway session root; nothing lands in the
 * real per-project tree during tests. */
function sessionRootForTests(): string {
	return mkdtempSync(join(tmpdir(), "pi-subagents-test-sessions-"));
}

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
				sessionRoot: sessionRootForTests(),
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

	it("passes inherited tool allowlists and preserves an explicitly empty active set", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-subagents-spawn-tools-"));
		const script = join(dir, "tool-args-child.mjs");
		writeFileSync(
			script,
			fakeRpcScript({
				onPrompt: `send({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: JSON.stringify(process.argv.slice(2)) }], stopReason: "stop" } });`,
			}),
			"utf8",
		);
		const previousScript = process.argv[1];
		process.argv[1] = script;
		try {
			for (const [tools, expectedFlag, expectedValue] of [
				[[], "--no-tools", undefined],
				[["read", "powershell", "web_search"], "--tools", "read,powershell,web_search"],
			] as const) {
				const result = await runSingleAgent({
					defaultCwd: process.cwd(),
					sessionRoot: sessionRootForTests(),
					agent: { ...agent, tools: [...tools] },
					agentName: agent.name,
					task: "inspect tool args",
					makeDetails: (results) => ({ mode: "single", results }),
				});
				const args = JSON.parse(getFinalOutput(result.messages)) as string[];
				expect(args[args.indexOf("--exclude-tools") + 1]).toBe(
					"subagent,subagent_control,subagent_wait,subagent_status,subagent_stop",
				);
				const flagIndex = args.indexOf(expectedFlag);
				expect(flagIndex).toBeGreaterThanOrEqual(0);
				if (expectedValue === undefined) expect(args).not.toContain("--tools");
				else expect(args[flagIndex + 1]).toBe(expectedValue);
			}
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
			sessionRoot: sessionRootForTests(),
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
				sessionRoot: sessionRootForTests(),
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
				sessionRoot: sessionRootForTests(),
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
					sessionRoot: sessionRootForTests(),
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

	it("hands off after an explicit initial prompt rejection", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-subagents-prompt-reject-fallback-"));
		const script = join(dir, "prompt-reject-child.mjs");
		const log = join(dir, "attempts.log");
		writeFileSync(
			script,
			fakeRpcScript({
				setup: `const modelIndex = process.argv.indexOf("--model");
const model = modelIndex === -1 ? "" : process.argv[modelIndex + 1];
fs.appendFileSync(${JSON.stringify(log)}, model + "\\n");`,
				onPromptPreflight: `if (model === "selected/model") {
	respond(command, false, "model not found");
	return;
}
respond(command);`,
				onPrompt: `send({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "main accepted" }], stopReason: "stop" } });`,
			}),
			"utf8",
		);
		const previousScript = process.argv[1];
		process.argv[1] = script;
		try {
			const result = await runSingleAgentWithMainFallback(
				{
					defaultCwd: process.cwd(),
					sessionRoot: sessionRootForTests(),
					agent: { ...agent, model: "selected/model" },
					agentName: agent.name,
					task: "review",
					makeDetails: (results) => ({ mode: "single", results }),
				},
				"main/model",
			);
			expect(result.exitCode).toBe(0);
			expect(getFinalOutput(result.messages)).toBe("main accepted");
			expect(result.modelFallbackFrom).toBe("selected/model");
			expect(readFileSync(log, "utf8").trim().split("\n")).toEqual(["selected/model", "main/model"]);
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
					sessionRoot: sessionRootForTests(),
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
				sessionRoot: sessionRootForTests(),
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
					sessionRoot: sessionRootForTests(),
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
		expect(prompt).toContain("Current objective: Implement X in src/foo.ts");
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

	it("resumes the session and refreshes tools when handing from selected to main model", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-subagents-resume-"));
		const script = join(dir, "resume-child.cjs");
		const log = join(dir, "flags.log");
		writeFileSync(script, sessionAwareChild(log), "utf8");
		await withArgv(script, async () => {
			const toolSnapshots = [
				["read", "bash", "selected_plugin"],
				["read", "powershell", "fallback_plugin"],
			];
			let snapshotIndex = 0;
			const result = await runSingleAgentWithMainFallback(
				{
					defaultCwd: process.cwd(),
					sessionRoot: sessionRootForTests(),
					agent: { ...agent, model: "openai-codex/gpt-5.6-sol", tools: ["read"] },
					resolveAgentForAttempt: (candidate) => ({
						...candidate,
						tools: toolSnapshots[snapshotIndex++]!,
					}),
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
			const invocations = readJsonLines<string[]>(log);
			expect(invocations).toHaveLength(2);
			expect(snapshotIndex).toBe(2);
			expect(invocations.map((invocation) => invocation[invocation.indexOf("--tools") + 1])).toEqual([
				"read,bash,selected_plugin",
				"read,powershell,fallback_plugin",
			]);
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
				sessionRoot: sessionRootForTests(),
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
