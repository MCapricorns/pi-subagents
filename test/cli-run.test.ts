import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { appendBoundedStderr, buildChildLaunchArgs, CHILD_STDERR_MAX_CHARS, runCliAgentAttempt } from "../src/execution/cli-run.ts";
import { getResultOutput, isFailedResult, isModelLevelFailure } from "../src/execution/spawn.ts";
import { RunControl } from "../src/execution/run-control.ts";

async function withChild(
	onPrompt: string,
	verify: (result: Awaited<ReturnType<typeof runCliAgentAttempt>>) => void,
	stopOnStart = false,
): Promise<void> {
	const root = await mkdtemp(join(tmpdir(), "pi-subagents-cli-test-"));
	const child = join(root, "child.mjs");
	const previousScript = process.argv[1];
	await writeFile(child, `
const send = (event) => process.stdout.write(JSON.stringify(event) + "\\n");
const assistant = (stopReason, text = "", errorMessage) => send({
 type: "message_end", message: { role: "assistant", content: [{ type: "text", text }], stopReason, errorMessage }
});
process.stdin.resume();
process.stdin.on("end", () => {
 send({ type: "agent_start" });
 ${onPrompt}
});
`, "utf8");
	try {
		process.argv[1] = child;
		const control = new RunControl("Test native Pi", 1);
		const result = await runCliAgentAttempt({
			defaultCwd: root, agent: { name: "artisan", description: "test", systemPrompt: "" },
			agentName: "artisan", task: "Test native Pi", thinkingLevel: "off", idleTimeoutMs: 0,
			scratchRoot: join(root, "tmp"), prompt: "Test native Pi", control,
			signal: AbortSignal.timeout(10_000), startupTimeoutMs: 5_000,
			onLive: (event) => {
				if (stopOnStart && event.kind === "status" && event.status === "running") void control.stop("User cancelled");
			},
		});
		if (stopOnStart) await control.stop("User cancelled");
		verify(result);
	} finally {
		process.argv[1] = previousScript;
		await rm(root, { recursive: true, force: true });
	}
}

describe("child launch arguments", () => {
	const base = { thinkingLevel: "high" as const };

	function valueOf(args: string[], flag: string): string | undefined {
		const index = args.indexOf(flag);
		return index === -1 ? undefined : args[index + 1];
	}

	it("keeps MCP tools for a role that inherits the parent's tools", () => {
		const args = buildChildLaunchArgs({ ...base, agent: { model: "anthropic/claude-sonnet" } });
		assert.equal(valueOf(args, "--tools"), undefined);
		assert.equal(args.includes("--no-tools"), false);
		assert.equal(valueOf(args, "--exclude-tools"), "subagent,subagent_workflow,subagent_status,subagent_stop");
		assert.equal(valueOf(args, "--model"), "anthropic/claude-sonnet");
		assert.equal(valueOf(args, "--thinking"), "high");
	});

	it("keeps an explicit role list a strict intersection, MCP tools included", () => {
		const readOnly = buildChildLaunchArgs({ ...base, agent: { tools: ["read", "grep"] } });
		assert.equal(valueOf(readOnly, "--tools"), "read,grep");
		assert.equal(valueOf(readOnly, "--exclude-tools"), "subagent,subagent_workflow,subagent_status,subagent_stop,mcp__*");

		const named = buildChildLaunchArgs({ ...base, agent: { tools: ["read", "mcp__docs__search"] } });
		assert.equal(valueOf(named, "--tools"), "read,mcp__docs__search");
		// `--tools` filters MCP tools once an entry names one.
		assert.equal(valueOf(named, "--exclude-tools"), "subagent,subagent_workflow,subagent_status,subagent_stop");
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

describe("bounded stderr retention", () => {
	it("keeps short output whole and trims long output to its newest tail", () => {
		assert.equal(appendBoundedStderr("ab", "cd", 10), "abcd");
		assert.equal(appendBoundedStderr("abcdef", "ghij", 5), "fghij");
		assert.equal(appendBoundedStderr("", "0123456789", 4), "6789");
	});
});


describe("native JSON child lifecycle", () => {
	it("uses the official one-shot JSON mode", () => {
		const args = buildChildLaunchArgs({ agent: {}, thinkingLevel: "off" });
		assert.deepEqual(args.slice(0, 2), ["--mode", "json"]);
		assert.equal(args.includes("rpc"), false);
	});
	it("cancels a live child and waits for its process to close", async () => {
		await withChild('setInterval(() => {}, 1000);', (result) => {
			assert.equal(result.stopReason, "aborted");
			assert.match(result.errorMessage ?? "", /User cancelled/);
			assert.equal(isModelLevelFailure(result), false);
		}, true);
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

	it("accepts normal native settlement and process exit", async () => {
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
		await withChild(`process.stderr.write("x".repeat(${CHILD_STDERR_MAX_CHARS * 2}) + "LAST-LINE\\n", () => process.exit(9));`, (result) => {
			assert.equal(isFailedResult(result), true);
			assert.ok(result.stderr.length <= CHILD_STDERR_MAX_CHARS, `stderr is ${result.stderr.length} characters`);
			assert.match(result.stderr, /LAST-LINE\n$/u);
		});
	});

	it("does not report a truncated final answer as success", async () => {
		await withChild('assistant("length", "Partial answer"); send({ type: "agent_settled" });', (result) => {
			assert.equal(isFailedResult(result), true);
			assert.match(result.errorMessage ?? "", /output limit/);
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
