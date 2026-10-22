import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { appendBoundedStderr, buildChildLaunchArgs, renderChildRetryPolicySource, RPC_STDERR_MAX_CHARS, runRpcAgentAttempt } from "../src/execution/rpc-run.ts";
import { getResultOutput, isFailedResult, isModelLevelFailure, isRetryableStartupFailure, runSingleAgentWithMainFallback } from "../src/execution/spawn.ts";
import { RpcRunControl } from "../src/execution/rpc-control.ts";

async function withChild(
	onPrompt: string,
	verify: (result: Awaited<ReturnType<typeof runRpcAgentAttempt>>) => void,
	scenario: { exitBeforePrompt?: boolean; exhaustStartupRetries?: boolean } = {},
): Promise<void> {
	const root = await mkdtemp(join(tmpdir(), "pi-subagents-rpc-test-"));
	const child = join(root, "child.mjs");
	const previousScript = process.argv[1];
	await writeFile(child, `
import { createInterface } from "node:readline";
const send = (event) => process.stdout.write(JSON.stringify(event) + "\\n");
const assistant = (stopReason, text = "", errorMessage) => send({
  type: "message_end",
  message: { role: "assistant", content: [{ type: "text", text }], stopReason, errorMessage }
});
createInterface({ input: process.stdin }).on("line", (line) => {
  const command = JSON.parse(line);
  if (${scenario.exitBeforePrompt === true} && command.type === "get_state") process.exit(17);
  send({ type: "response", command: command.type, id: command.id, success: true,
    data: command.type === "get_session_stats" ? { tokens: { input: 0, output: 0 }, cost: 0 } : {} });
  if (command.type === "prompt") {
    send({ type: "agent_start" });
    ${onPrompt}
  }
  if (command.type === "abort") send({ type: "agent_settled" });
});
`, "utf8");
	try {
		process.argv[1] = child;
		const control = new RpcRunControl("Test the transport", 1);
		const options = {
			defaultCwd: root,
			agent: { name: "artisan", description: "test", systemPrompt: "" },
			agentName: "artisan",
			task: "Test the transport",
			thinkingLevel: "off",
			idleTimeoutMs: 0,
			scratchRoot: join(root, "tmp"),
			prompt: "Test the transport",
			control,
			rpcReadyTimeoutMs: 5_000,
			rpcCommandTimeoutMs: 5_000,
			signal: AbortSignal.timeout(10_000),
		} satisfies Parameters<typeof runRpcAgentAttempt>[0];
		const result = scenario.exhaustStartupRetries
			? await runSingleAgentWithMainFallback({
				...options, sessionRoot: join(root, "sessions"), startupRetryDelaysMs: [],
				makeDetails: (results) => ({ mode: "single", results }),
			})
			: await runRpcAgentAttempt(options);
		verify(result);
	} finally {
		process.argv[1] = previousScript;
		await rm(root, { recursive: true, force: true });
	}
}

describe("child launch arguments", () => {
	const base = { thinkingLevel: "high" as const, retryPolicyPath: "/tmp/policy.mjs" };

	function valueOf(args: string[], flag: string): string | undefined {
		const index = args.indexOf(flag);
		return index === -1 ? undefined : args[index + 1];
	}

	it("keeps MCP tools for a role that inherits the parent's tools", () => {
		const args = buildChildLaunchArgs({ ...base, agent: { model: "anthropic/claude-sonnet" } });
		assert.equal(valueOf(args, "--tools"), undefined);
		assert.equal(args.includes("--no-tools"), false);
		assert.equal(valueOf(args, "--exclude-tools"), "subagent,subagent_status,subagent_stop");
		assert.equal(valueOf(args, "--model"), "anthropic/claude-sonnet");
		assert.equal(valueOf(args, "--thinking"), "high");
		assert.equal(valueOf(args, "--extension"), "/tmp/policy.mjs");
	});

	it("keeps an explicit role list a strict intersection, MCP tools included", () => {
		const readOnly = buildChildLaunchArgs({ ...base, agent: { tools: ["read", "grep"] } });
		assert.equal(valueOf(readOnly, "--tools"), "read,grep");
		assert.equal(valueOf(readOnly, "--exclude-tools"), "subagent,subagent_status,subagent_stop,mcp__*");

		const named = buildChildLaunchArgs({ ...base, agent: { tools: ["read", "mcp__docs__search"] } });
		assert.equal(valueOf(named, "--tools"), "read,mcp__docs__search");
		// `--tools` filters MCP tools once an entry names one.
		assert.equal(valueOf(named, "--exclude-tools"), "subagent,subagent_status,subagent_stop");
	});

	it("starts a child without tools when the role resolved to none", () => {
		const args = buildChildLaunchArgs({ ...base, agent: { tools: [] } });
		assert.equal(args.includes("--no-tools"), true);
		assert.equal(valueOf(args, "--tools"), undefined);
	});

	it("resumes an existing session and starts a named one otherwise", () => {
		const fresh = buildChildLaunchArgs({
			...base,
			agent: {},
			sessionDir: "/sessions/run",
			sessionId: "abc",
		});
		assert.equal(valueOf(fresh, "--session-dir"), "/sessions/run");
		assert.equal(valueOf(fresh, "--session-id"), "abc");
		assert.equal(fresh.includes("--session"), false);

		const resumed = buildChildLaunchArgs({
			...base,
			agent: {},
			sessionDir: "/sessions/run",
			sessionId: "abc",
			resumeExistingSession: true,
		});
		assert.equal(valueOf(resumed, "--session"), "abc");
		assert.equal(resumed.includes("--session-id"), false);
		assert.equal(buildChildLaunchArgs({ ...base, agent: {} }).includes("--no-session"), true);
	});
});

describe("child provider retry policy", () => {
	it("registers a Pi 1.0 stream override for the selected provider api", () => {
		const source = renderChildRetryPolicySource("anthropic/claude-sonnet");
		assert.match(source, /const selectedProvider = "anthropic";/u);
		assert.match(source, /const api = model\?\.api;/u);
		assert.match(source, /pi\.registerProvider\(providerId, \{\s*api,/u);
		assert.match(source, /maxRetries: 0/u);
		assert.match(source, /getApiProvider\(requestModel\.api\)/u);
		assert.equal(renderChildRetryPolicySource(undefined).includes("const selectedProvider = undefined;"), true);
	});
});

describe("bounded stderr retention", () => {
	it("keeps short output whole and trims long output to its newest tail", () => {
		assert.equal(appendBoundedStderr("ab", "cd", 10), "abcd");
		assert.equal(appendBoundedStderr("abcdef", "ghij", 5), "fghij");
		assert.equal(appendBoundedStderr("", "0123456789", 4), "6789");
	});
});

describe("RPC terminal failure reporting", () => {
	it("preserves safe silent startup retries before any prompt was sent", async () => {
		await withChild("", (result) => {
			assert.match(result.errorMessage ?? "", /exited before settling.*code=17/);
			assert.equal(result.rpcPromptDispatched, undefined);
			assert.equal(result.rpcStartupFailed, true);
			assert.equal(isRetryableStartupFailure(result, 100), true);
			assert.equal(isModelLevelFailure(result), false);
		}, { exitBeforePrompt: true });
	});

	it("keeps the actual exit reason after startup retries are exhausted and directs main to take over", async () => {
		await withChild("", (result) => {
			assert.equal(isFailedResult(result), true);
			assert.match(result.errorMessage ?? "", /failed to start after 1 attempt/);
			assert.match(result.errorMessage ?? "", /exited before settling.*code=17/);
			assert.match(result.errorMessage ?? "", /Main handles/);
			assert.doesNotMatch(result.errorMessage ?? "", /typically|Retry the dispatch/);
		}, { exitBeforePrompt: true, exhaustStartupRetries: true });
	});

	for (const code of [0, 17]) {
		it(`reports a child exiting with code ${code} before settlement instead of returning only partial output`, async () => {
			await withChild(`assistant("toolUse", "Partial implementation"); process.exit(${code});`, (result) => {
				assert.equal(isFailedResult(result), true);
				assert.match(result.errorMessage ?? "", new RegExp(`exited before settling.*code=${code}`));
				assert.equal(result.stopReason, "error");
				assert.equal(result.dispatchFailed, true);
				assert.equal(isModelLevelFailure(result), false, "a process exit is not evidence of a provider failure");
				assert.match(getResultOutput(result), /Partial implementation/);
			});
		});
	}

	it("reports the OS termination signal when the platform provides it", async () => {
		await withChild('assistant("toolUse"); process.stdout.write("", () => process.kill(process.pid, "SIGTERM"));', (result) => {
			assert.equal(isFailedResult(result), true);
			assert.match(result.errorMessage ?? "", process.platform === "win32" ? /exited before settling.*code=/ : /signal=SIGTERM/);
		});
	});

	it("accepts recorded settlement even if the child exits before final usage statistics", async () => {
		await withChild('assistant("stop", "Finished before exit"); send({ type: "agent_settled" }); process.stdout.write("", () => process.exit(0));', (result) => {
			assert.equal(isFailedResult(result), false);
			assert.equal(result.errorMessage, undefined);
			assert.equal(getResultOutput(result), "Finished before exit");
		});
	});

	it("includes stderr without replacing a recorded provider error", async () => {
		await withChild('assistant("error", "", "Provider connection closed"); process.stderr.write("child shutdown detail\\n"); process.exit(23);', (result) => {
			assert.equal(isFailedResult(result), true);
			assert.match(getResultOutput(result), /Provider connection closed/);
			assert.match(result.stderr, /child shutdown detail/);
		});
	});

	it("does not turn a deliberately failing tool call into a failed run", async () => {
		await withChild(`
assistant("toolUse");
send({ type: "tool_execution_end", toolName: "powershell", isError: true,
  result: { content: [{ type: "text", text: "Regression failed as expected (red)" }] } });
assistant("stop", "Implemented the fix; the regression now passes.");
send({ type: "agent_settled" });`, (result) => {
			assert.equal(isFailedResult(result), false);
			assert.equal(result.errorMessage, undefined);
			assert.equal(result.failedTools?.length, 1);
			assert.match(getResultOutput(result), /regression now passes/);
		});
	});

	it("frames records split across chunks and keeps every text block of the final answer", async () => {
		await withChild(`
const record = JSON.stringify({ type: "message_end", message: { role: "assistant",
  content: [{ type: "text", text: "First half." }, { type: "thinking", thinking: "x" }, { type: "text", text: "Second half." }],
  stopReason: "stop" } }) + "\\n";
process.stdout.write(record.slice(0, 17));
setTimeout(() => process.stdout.write(record.slice(17) + JSON.stringify({ type: "agent_settled" }) + "\\n"), 20);`, (result) => {
			assert.equal(isFailedResult(result), false);
			assert.equal(result.usage.turns, 1);
			assert.equal(getResultOutput(result), "First half.\n\nSecond half.");
		});
	});

	it("keeps only the newest bounded stderr tail of a chatty child", async () => {
		await withChild(`process.stderr.write("x".repeat(${RPC_STDERR_MAX_CHARS * 2}) + "LAST-LINE\\n", () => process.exit(9));`, (result) => {
			assert.equal(isFailedResult(result), true);
			assert.ok(result.stderr.length <= RPC_STDERR_MAX_CHARS, `stderr is ${result.stderr.length} characters`);
			assert.match(result.stderr, /LAST-LINE\n$/u);
		});
	});

	it("clears an earlier provider error when Pi's retry succeeds", async () => {
		await withChild(`
assistant("error", "", "Transient provider failure");
send({ type: "auto_retry_start" });
assistant("stop", "Recovered successfully");
send({ type: "agent_settled" });`, (result) => {
			assert.equal(isFailedResult(result), false);
			assert.equal(result.errorMessage, undefined);
			assert.equal(getResultOutput(result), "Recovered successfully");
		});
	});
});
