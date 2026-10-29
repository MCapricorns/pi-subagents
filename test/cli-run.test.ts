import assert from "node:assert/strict";
import childProcess, { spawnSync, type SpawnOptions } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { appendBoundedStderr, buildChildLaunchArgs, CHILD_STDERR_MAX_CHARS, runCliAgentAttempt } from "../src/execution/cli-run.ts";
import { getResultOutput, isFailedResult, isModelLevelFailure } from "../src/execution/spawn.ts";
import { RunControl, type SteeringReceipt } from "../src/execution/run-control.ts";

async function withChild(
	onPrompt: string,
	verify: (result: Awaited<ReturnType<typeof runCliAgentAttempt>>, receipt?: SteeringReceipt) => void,
	stopOnStart = false,
	onSteer?: string,
	env?: NodeJS.ProcessEnv,
	onUiResponse?: string,
	timeoutMs = 10_000,
): Promise<void> {
	const root = await mkdtemp(join(tmpdir(), "pi-subagents-cli-test-"));
	const child = join(root, "child.mjs");
	const previousScript = process.argv[1];
	await writeFile(child, `
const send = (event) => process.stdout.write(JSON.stringify(event) + "\\n");
const assistant = (stopReason, text = "", errorMessage) => send({
 type: "message_end", message: { role: "assistant", content: [{ type: "text", text }], stopReason, errorMessage }
});
process.stdin.setEncoding("utf8");
let buffer = "";
process.stdin.on("data", chunk => {
 buffer += chunk;
 let index;
 while ((index = buffer.indexOf("\\n")) >= 0) {
  const command = JSON.parse(buffer.slice(0, index));
  buffer = buffer.slice(index + 1);
  if (command.type === "steer") { ${onSteer ?? ""} continue; }
  if (command.type === "extension_ui_response") { ${onUiResponse ?? ""} continue; }
  if (command.type !== "prompt") continue;
  send({ type: "response", id: command.id, command: "prompt", success: true, data: { disposition: "started" } });
  send({ type: "agent_start" });
  ${onPrompt}
 }
});
`, "utf8");
	try {
		process.argv[1] = child;
		const control = new RunControl("Test native Pi", 1);
		let steering: Promise<SteeringReceipt> | undefined;
		const result = await runCliAgentAttempt({
			defaultCwd: root, agent: { name: "artisan", description: "test", systemPrompt: "" },
			agentName: "artisan", task: "Test native Pi", thinkingLevel: "off", idleTimeoutMs: 0,
			scratchRoot: join(root, "tmp"), prompt: "Test native Pi", control, env,
			signal: AbortSignal.timeout(timeoutMs), startupTimeoutMs: 5_000,
			onLive: (event) => {
				if (stopOnStart && event.kind === "status" && event.status === "running") void control.stop("User cancelled");
				if (onSteer && !steering && event.kind === "status" && event.status === "running") {
					steering = control.steer("Please check the caller");
					void steering.catch(() => undefined);
				}
			},
		});
		if (stopOnStart) await control.stop("User cancelled");
		verify(result, steering ? await steering : undefined);
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
		assert.equal(valueOf(args, "--exclude-tools"), "subagent,subagent_workflow,subagent_status,subagent_message,subagent_stop");
		assert.equal(valueOf(args, "--model"), "anthropic/claude-sonnet");
		assert.equal(valueOf(args, "--thinking"), "high");
	});

	it("keeps an explicit role list a strict intersection, MCP tools included", () => {
		const readOnly = buildChildLaunchArgs({ ...base, agent: { tools: ["read", "grep"] } });
		assert.equal(valueOf(readOnly, "--tools"), "read,grep");
		assert.equal(valueOf(readOnly, "--exclude-tools"), "subagent,subagent_workflow,subagent_status,subagent_message,subagent_stop,mcp__*");

		const named = buildChildLaunchArgs({ ...base, agent: { tools: ["read", "mcp__docs__search"] } });
		assert.equal(valueOf(named, "--tools"), "read,mcp__docs__search");
		// `--tools` filters MCP tools once an entry names one.
		assert.equal(valueOf(named, "--exclude-tools"), "subagent,subagent_workflow,subagent_status,subagent_message,subagent_stop");
	});

	it("installs the console policy as an explicit extension only on Windows", () => {
		const args = buildChildLaunchArgs({ ...base, agent: {} });
		const extension = valueOf(args, "--extension");
		if (process.platform === "win32") assert.match(extension ?? "", /hidden-console\.cjs$/u);
		else assert.equal(extension, undefined);
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

describe("stable steering receipts", () => {
	it("preserves the receipt returned by the attached attempt", async () => {
		const control = new RunControl("Fixture", 1);
		const token = control.beginAttempt();
		const receipt: SteeringReceipt = { requestId: "native-7", disposition: "handled", acknowledgedAt: 123 };
		control.attach(token, { stop: async () => {}, steer: async () => receipt });
		control.updateAttemptPhase(token, "running");
		assert.equal(await control.steer("Additional instruction"), receipt);
	});

	it("normalizes a legacy control to accepted without claiming a queue or RPC acknowledgement", async () => {
		const control = new RunControl("Fixture", 1);
		const token = control.beginAttempt();
		control.attach(token, { stop: async () => {}, steer: async () => {} });
		control.updateAttemptPhase(token, "running");
		const before = Date.now();
		const receipt = await control.steer("Additional instruction");
		assert.equal(receipt.disposition, "accepted");
		assert.equal(receipt.requestId, undefined);
		assert.ok(receipt.acknowledgedAt >= before && receipt.acknowledgedAt <= Date.now());
	});
});


describe("bounded stderr retention", () => {
	it("keeps short output whole and trims long output to its newest tail", () => {
		assert.equal(appendBoundedStderr("ab", "cd", 10), "abcd");
		assert.equal(appendBoundedStderr("abcdef", "ghij", 5), "fghij");
		assert.equal(appendBoundedStderr("", "0123456789", 4), "6789");
	});
});


describe("native RPC child lifecycle", () => {
	it("settles native descriptor exhaustion without an unhandled child error", () => {
		const moduleUrl = new URL("../src/execution/cli-run.ts", import.meta.url).href;
		const fixture = spawnSync(process.execPath, ["--unhandled-rejections=strict", "--input-type=module", "--eval", `
import assert from "node:assert/strict";
import { runCliAgentAttempt } from ${JSON.stringify(moduleUrl)};
const nativeProcess = process.binding("process_wrap").Process.prototype;
const originalSpawn = nativeProcess.spawn;
for (const code of ["EMFILE", "ENFILE"]) {
 // Exercise Node's real missing-stdio and next-tick error path without
 // consuming file descriptors or launching a child.
 nativeProcess.spawn = () => process.binding("uv")["UV_" + code];
 try {
  const result = await runCliAgentAttempt({
   defaultCwd: process.cwd(), agent: { name: "scout", description: "fixture", systemPrompt: "" },
   agentName: "scout", task: "Test failed spawn", thinkingLevel: "off", idleTimeoutMs: 0,
   scratchRoot: process.cwd(), prompt: "Test failed spawn", startupTimeoutMs: 1_000,
  });
  assert.equal(result.exitCode, 1);
  assert.equal(result.dispatchFailed, true);
  assert.equal(result.stopReason, "error");
  assert.match(result.errorMessage, new RegExp("Failed to start.*" + code));
 } finally { nativeProcess.spawn = originalSpawn; }
}
console.log("fixture survived both spawn failures");
`], { encoding: "utf8", windowsHide: true, timeout: 45_000 });
		assert.ifError(fixture.error);
		assert.equal(fixture.status, 0, fixture.stderr || fixture.stdout);
		assert.match(fixture.stdout, /fixture survived both spawn failures/u);
	});

	it("launches a hidden child while preserving RPC pipes and process-group policy", async (t) => {
		const original = childProcess.spawn;
		const launches: SpawnOptions[] = [];
		t.mock.method(childProcess, "spawn", (command: string, args: string[], options: SpawnOptions) => {
			if (command === process.execPath) launches.push(options);
			return original(command, args, options);
		});
		syncBuiltinESMExports();
		t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
		await withChild('assistant("stop", "RPC still works"); send({type:"agent_settled"});', (result) => {
			assert.equal(result.exitCode, 0);
			assert.equal(getResultOutput(result), "RPC still works");
		});
		assert.equal(launches.length, 1);
		assert.equal(launches[0]!.windowsHide, true);
		assert.equal(launches[0]!.shell, false);
		assert.deepEqual(launches[0]!.stdio, ["pipe", "pipe", "pipe"]);
		assert.equal(launches[0]!.detached, process.platform !== "win32");
	});

	it("preloads descendant console handling without replacing the inherited environment", async () => {
		const env = { ...process.env, NODE_OPTIONS: "--no-warnings", PI_SUBAGENT_DEPTH: "2", FIXTURE_VALUE: "kept" };
		await withChild(`assistant("stop", JSON.stringify({
 nodeOptions: process.env.NODE_OPTIONS, depth: process.env.PI_SUBAGENT_DEPTH, value: process.env.FIXTURE_VALUE
})); send({type:"agent_settled"});`, (result) => {
			assert.equal(result.exitCode, 0, result.stderr);
			const inherited = JSON.parse(getResultOutput(result));
			assert.equal(inherited.depth, "3");
			assert.equal(inherited.value, "kept");
			if (process.platform === "win32") assert.match(inherited.nodeOptions, /^--no-warnings --require .*hidden-console\.cjs/u);
			else assert.equal(inherited.nodeOptions, "--no-warnings");
		}, false, undefined, env);
		assert.equal(env.NODE_OPTIONS, "--no-warnings");
		assert.equal(env.PI_SUBAGENT_DEPTH, "2");
	});

	it("uses the official RPC mode", () => {
		const args = buildChildLaunchArgs({ agent: {}, thinkingLevel: "off" });
		assert.deepEqual(args.slice(0, 2), ["--mode", "rpc"]);
	});
	for (const disposition of ["queued", "handled", undefined, "unknown"]) {
		it(`returns the child steering receipt for ${disposition ?? "empty success"}`, async () => {
			const before = Date.now();
			await withChild("", (result, receipt) => {
				assert.equal(isFailedResult(result), false);
				assert.match(getResultOutput(result), /Please check the caller/u);
				assert.equal(receipt?.requestId, "steer-1");
				assert.equal(receipt.disposition, disposition === "queued" || disposition === "handled" ? disposition : "accepted");
				assert.ok(receipt.acknowledgedAt >= before && receipt.acknowledgedAt <= Date.now());
			}, false, `send({ type: "response", id: command.id, command: "steer", success: true, data: ${JSON.stringify(disposition ? { disposition } : {})} }); assistant("stop", command.message); send({ type: "agent_settled" });`);
		});
	}
	for (const response of [
		{ code: `send({ type: "response", id: command.id, command: "steer", success: false, error: "Fixture rejected steer" }); assistant("stop", "Finished"); send({ type: "agent_settled" });`, error: /Fixture rejected steer/u },
		{ code: `send({ type: "response", id: "wrong-id", command: "steer", success: true, data: { disposition: "queued" } }); assistant("stop", "Finished"); send({ type: "agent_settled" });`, error: /settled before acknowledging/u },
		{ code: `process.exit(1);`, error: /exited before acknowledging/u },
	]) {
		it(`rejects unacknowledged or failed steering: ${response.error}`, async () => {
			await assert.rejects(withChild("", () => assert.fail("A receipt must not be invented"), false, response.code), response.error);
		});
	}
	it("fails delivery after the acknowledgement timeout while the child is still running", { timeout: 15_000 }, async () => {
		await assert.rejects(withChild("", () => assert.fail("A receipt must not be invented"), false,
			`setTimeout(() => { assistant("stop", "Finished without acknowledging"); send({ type: "agent_settled" }); }, 10_200);`,
			undefined, undefined, 14_000), /No acknowledgement; message delivery is unconfirmed/u);
	});
	for (const method of ["select", "confirm", "input", "editor"]) {
		it(`cancels a matching ${method} dialog without approval`, async () => {
			await withChild(`send({ type: "extension_ui_request", id: "dialog-1", method: "${method}" });`, (result) => {
				assert.equal(isFailedResult(result), false, result.stderr);
				assert.deepEqual(JSON.parse(getResultOutput(result)), { type: "extension_ui_response", id: "dialog-1", cancelled: true });
				assert.match(result.stderr, new RegExp(`Cancelled child extension ${method} dialog.*approval was not granted`));
			}, false, undefined, undefined, `assistant("stop", JSON.stringify(command)); send({ type: "agent_settled" });`);
		});
	}
	it("ignores fire-and-forget UI notifications without responding", async () => {
		await withChild(`send({ type: "extension_ui_request", id: "notification", method: "notify" }); setTimeout(() => { assistant("stop", "Finished"); send({ type: "agent_settled" }); }, 20);`, (result) => {
			assert.equal(isFailedResult(result), false, result.stderr);
			assert.equal(getResultOutput(result), "Finished");
			assert.equal(result.stderr, "");
		}, false, undefined, undefined, `process.exit(3);`);
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
