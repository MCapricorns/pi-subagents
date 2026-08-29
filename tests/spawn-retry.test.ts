/** Startup retry coverage split from spawn.test.ts: these suites drive real
 * RPC child processes with per-test argv swap-in and real retry delays, so
 * they stay serial inside the file but parallelize across files. */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { fakeRpcScript } from "./fake-rpc.ts";
import { readJsonLines } from "./test-helpers.ts";
import {
	addStartupRetryJitter,
	getFinalOutput,
	isModelLevelFailure,
	runSingleAgentWithMainFallback,
	SUBAGENT_STARTUP_RETRY_DELAYS_MS,
} from "../src/spawn.ts";

let savedTemp: string | undefined;
let savedTmp: string | undefined;
let isolatedTemp: string;

beforeAll(() => {
	savedTemp = process.env.TEMP;
	savedTmp = process.env.TMP;
	isolatedTemp = mkdtempSync(join(tmpdir(), "pi-subagents-spawn-retry-"));
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

/** Every run gets an isolated throwaway session root; nothing lands in the
 * real per-project tree during tests. */
function sessionRootForTests(): string {
	return mkdtempSync(join(tmpdir(), "pi-subagents-test-sessions-"));
}

function scratchRootForTests(): string {
	return mkdtempSync(join(tmpdir(), "pi-subagents-test-scratch-"));
}


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
		setup: `const log = process.env.LOG_PATH;\nfs.appendFileSync(log, Date.now() + "\\n");\nconst count = fs.readFileSync(log, "utf8").split("\\n").filter(Boolean).length;\nif (count <= ${failTimes}) process.exit(1);`,
		onPrompt: `send({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "recovered after startup retry" }], stopReason: "stop" } });`,
	});

	const withArgv = (script: string, fn: () => Promise<void>): Promise<void> => {
		const previousScript = process.argv[1];
		process.argv[1] = script;
		return fn().finally(() => {
			process.argv[1] = previousScript;
		});
	};

	it("uses an extended finite jittered default retry window", () => {
		expect(SUBAGENT_STARTUP_RETRY_DELAYS_MS).toHaveLength(5);
		expect(SUBAGENT_STARTUP_RETRY_DELAYS_MS.reduce((total, delay) => total + delay, 0)).toBeGreaterThan(10_000);
		expect(addStartupRetryJitter(250, 0)).toBe(250);
		expect(addStartupRetryJitter(250, 1)).toBe(500);
		expect(addStartupRetryJitter(3000, 1)).toBe(4000);
		expect(addStartupRetryJitter(Number.NaN, 1)).toBe(0);
		expect(addStartupRetryJitter(Number.POSITIVE_INFINITY, 1)).toBe(0);
		expect(addStartupRetryJitter(Number.NEGATIVE_INFINITY, 1)).toBe(0);
		expect(addStartupRetryJitter(250, Number.NaN)).toBe(250);
	});

	it("keeps a custom retry delay unjittered, then succeeds", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-subagents-startup-retry-"));
		const script = join(dir, "retry-child.cjs");
		const log = join(dir, "attempts.log");
		const random = vi.spyOn(Math, "random").mockImplementation(() => {
			throw new Error("custom retry delays must not use jitter");
		});
		writeFileSync(script, retryThenSucceedScript(1), "utf8");
		try {
			await withArgv(script, async () => {
				const result = await runSingleAgentWithMainFallback({
					defaultCwd: process.cwd(),
					sessionRoot: sessionRootForTests(),
					scratchRoot: scratchRootForTests(),
					agent,
					agentName: agent.name,
					task: "survive a startup race",
					startupRetryDelaysMs: [80],
					env: { ...process.env, LOG_PATH: log },
					makeDetails: (results) => ({ mode: "single", results }),
				});
				expect(result.exitCode).toBe(0);
				expect(getFinalOutput(result.messages)).toBe("recovered after startup retry");
				expect(result.startupRetries).toBe(1);
				expect(result.dispatchFailed).toBeUndefined();
				const attempts = readFileSync(log, "utf8").split("\n").filter(Boolean).map(Number);
				expect(attempts).toHaveLength(2);
				expect(attempts[1] - attempts[0]).toBeGreaterThanOrEqual(60);
				expect(random).not.toHaveBeenCalled();
			});
		} finally {
			random.mockRestore();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("normalizes a non-finite custom delay instead of waiting forever", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-subagents-startup-infinite-delay-"));
		const script = join(dir, "retry-child.cjs");
		const log = join(dir, "attempts.log");
		writeFileSync(script, retryThenSucceedScript(1), "utf8");
		try {
			await withArgv(script, async () => {
				const result = await runSingleAgentWithMainFallback({
					defaultCwd: process.cwd(),
					sessionRoot: sessionRootForTests(),
					scratchRoot: scratchRootForTests(),
					agent,
					agentName: agent.name,
					task: "do not hang on an invalid delay",
					startupRetryDelaysMs: [Number.POSITIVE_INFINITY],
					env: { ...process.env, LOG_PATH: log },
					makeDetails: (results) => ({ mode: "single", results }),
				});
				expect(result.exitCode).toBe(0);
				expect(result.startupRetries).toBe(1);
				expect(readFileSync(log, "utf8").split("\n").filter(Boolean)).toHaveLength(2);
			});
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("returns an aborted result when only the signal cancels a long retry wait", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-subagents-startup-signal-"));
		const script = join(dir, "silent-child.cjs");
		const log = join(dir, "attempts.log");
		writeFileSync(script, `const fs = require("node:fs");\nfs.appendFileSync(process.env.LOG_PATH, "attempt\\n");\nprocess.exit(1);`, "utf8");
		let sessionDir: string | undefined;
		try {
			await withArgv(script, async () => {
				const abortController = new AbortController();
				let notifyRetry: (() => void) | undefined;
				const retrying = new Promise<void>((resolve) => {
					notifyRetry = resolve;
				});
				const running = runSingleAgentWithMainFallback({
					defaultCwd: process.cwd(),
					sessionRoot: sessionRootForTests(),
					scratchRoot: scratchRootForTests(),
					agent,
					agentName: agent.name,
					task: "abort during retry",
					startupRetryDelaysMs: [10_000],
					signal: abortController.signal,
					onLive: (event) => {
						if (event.kind === "status" && event.status === "running") notifyRetry?.();
					},
					env: { ...process.env, LOG_PATH: log },
					makeDetails: (results) => ({ mode: "single", results }),
				});
				await retrying;
				const cancelledAt = Date.now();
				abortController.abort();
				const result = await running;
				sessionDir = result.sessionDir;
				expect(Date.now() - cancelledAt).toBeLessThan(1_000);
				expect(result.exitCode).toBe(1);
				expect(result.stopReason).toBe("aborted");
				expect(result.errorMessage).toBe("Subagent was aborted");
				expect(readFileSync(log, "utf8").split("\n").filter(Boolean)).toHaveLength(1);
			});
		} finally {
			if (sessionDir) rmSync(sessionDir, { recursive: true, force: true });
			rmSync(dir, { recursive: true, force: true });
		}
	}, 10_000);

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
					sessionRoot: sessionRootForTests(),
					scratchRoot: scratchRootForTests(),
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
					sessionRoot: sessionRootForTests(),
					scratchRoot: scratchRootForTests(),
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

	it("retries a get_state handshake timeout, then succeeds", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-subagents-startup-handshake-"));
		const script = join(dir, "handshake-retry-child.cjs");
		const log = join(dir, "attempts.log");
		const argvLog = join(dir, "argv.log");
		writeFileSync(
			script,
			fakeRpcScript({
				setup: `fs.appendFileSync(process.env.LOG_PATH, "attempt\\n");
fs.appendFileSync(process.env.ARGV_LOG, JSON.stringify(process.argv) + "\\n");
const count = fs.readFileSync(process.env.LOG_PATH, "utf8").split("\\n").filter(Boolean).length;`,
				onGetState: `if (count > 1) respond(command);`,
				onPrompt: `send({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "recovered after handshake timeout" }], stopReason: "stop" } });`,
			}),
			"utf8",
		);
		try {
			await withArgv(script, async () => {
				const toolSnapshots = [
					["read", "bash", "first_plugin"],
					["read", "powershell", "retry_plugin"],
				];
				let snapshotIndex = 0;
				const result = await runSingleAgentWithMainFallback({
					defaultCwd: process.cwd(),
					sessionRoot: sessionRootForTests(),
					scratchRoot: scratchRootForTests(),
					agent: { ...agent, tools: ["read"] },
					resolveAgentForAttempt: (candidate) => ({
						...candidate,
						tools: toolSnapshots[snapshotIndex++]!,
					}),
					agentName: agent.name,
					task: "survive a handshake timeout",
					startupRetryDelaysMs: [10],
					// The ready timer starts when the command is written, so this must
					// cover the retry child's full node boot on a cold/slow Windows FS,
					// not just its (immediate) response once booted.
					rpcReadyTimeoutMs: 1500,
					env: { ...process.env, LOG_PATH: log, ARGV_LOG: argvLog },
					makeDetails: (results) => ({ mode: "single", results }),
				});
				expect(result.exitCode).toBe(0);
				expect(getFinalOutput(result.messages)).toBe("recovered after handshake timeout");
				expect(result.startupRetries).toBe(1);
				expect(result.dispatchFailed).toBeUndefined();
				expect(isModelLevelFailure(result)).toBe(false);
				expect(readFileSync(log, "utf8").split("\n").filter(Boolean)).toHaveLength(2);
				const invocations = readJsonLines<string[]>(argvLog);
				expect(invocations).toHaveLength(2);
				expect(snapshotIndex).toBe(2);
				expect(invocations.map((invocation) => invocation[invocation.indexOf("--tools") + 1])).toEqual([
					"read,bash,first_plugin",
					"read,powershell,retry_plugin",
				]);
			});
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("does not replay an initial prompt when work starts but its ACK is lost", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-subagents-startup-prompt-ack-"));
		const script = join(dir, "lost-prompt-ack.cjs");
		const launchLog = join(dir, "launches.log");
		const workLog = join(dir, "work.log");
		writeFileSync(
			script,
			fakeRpcScript({
				setup: `fs.appendFileSync(process.env.LOG_PATH, "attempt\\n");`,
				emitAgentStart: false,
				autoSettle: false,
				onPromptPreflight: "",
				onPrompt: `fs.appendFileSync(process.env.WORK_LOG, "model call or edit started\\n");`,
			}),
			"utf8",
		);
		try {
			await withArgv(script, async () => {
				const result = await runSingleAgentWithMainFallback({
					defaultCwd: process.cwd(),
					sessionRoot: sessionRootForTests(),
					scratchRoot: scratchRootForTests(),
					agent,
					agentName: agent.name,
					task: "perform one side effect",
					startupRetryDelaysMs: [10, 10],
					rpcCommandTimeoutMs: 80,
					env: { ...process.env, LOG_PATH: launchLog, WORK_LOG: workLog },
					makeDetails: (results) => ({ mode: "single", results }),
				});
				expect(result.exitCode).toBe(1);
				expect(result.rpcPromptDispatched).toBe(true);
				expect(result.rpcPromptAccepted).toBeUndefined();
				expect(result.rpcStartupFailed).toBeUndefined();
				expect(result.rpcPromptRejected).toBeUndefined();
				expect(result.startupRetries).toBeUndefined();
				expect(result.dispatchFailed).toBeUndefined();
				expect(result.errorMessage).toContain("Timed out waiting for RPC response to prompt");
				expect(isModelLevelFailure(result)).toBe(false);
				expect(readFileSync(launchLog, "utf8").split("\n").filter(Boolean)).toHaveLength(1);
				expect(readFileSync(workLog, "utf8").split("\n").filter(Boolean)).toHaveLength(1);
			});
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("does not hand off after idle timeout when a dispatched prompt's ACK is lost", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-subagents-startup-idle-ack-"));
		const script = join(dir, "lost-prompt-ack-idle.cjs");
		const launchLog = join(dir, "launches.log");
		const workLog = join(dir, "work.log");
		writeFileSync(
			script,
			fakeRpcScript({
				setup: `fs.appendFileSync(process.env.LOG_PATH, "attempt\\n");`,
				emitAgentStart: false,
				autoSettle: false,
				onPromptPreflight: "",
				onPrompt: `fs.appendFileSync(process.env.WORK_LOG, "model call or edit started\\n");`,
			}),
			"utf8",
		);
		try {
			await withArgv(script, async () => {
				const result = await runSingleAgentWithMainFallback(
					{
						defaultCwd: process.cwd(),
						sessionRoot: sessionRootForTests(),
						scratchRoot: scratchRootForTests(),
						agent: { ...agent, model: "selected/model" },
						agentName: agent.name,
						task: "perform one side effect before going idle",
						idleTimeoutMs: 500,
						rpcCommandTimeoutMs: 2_000,
						env: { ...process.env, LOG_PATH: launchLog, WORK_LOG: workLog },
						makeDetails: (results) => ({ mode: "single", results }),
					},
					"main/fallback",
				);
				expect(result.exitCode).toBe(1);
				expect(result.errorMessage).toContain("idle timeout");
				expect(result.rpcPromptDispatched).toBe(true);
				expect(result.rpcPromptAccepted).toBeUndefined();
				expect(result.modelFallbackFrom).toBeUndefined();
				expect(isModelLevelFailure(result)).toBe(false);
				expect(readFileSync(launchLog, "utf8").split("\n").filter(Boolean)).toHaveLength(1);
				expect(readFileSync(workLog, "utf8").split("\n").filter(Boolean)).toHaveLength(1);
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
					sessionRoot: sessionRootForTests(),
					scratchRoot: scratchRootForTests(),
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
