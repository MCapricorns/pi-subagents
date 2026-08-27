import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RpcRunControl, getFinalOutput, runSingleAgent } from "../src/spawn.ts";
import { fakeRpcScript } from "./fake-rpc.ts";
import { readJsonLines, waitFor } from "./test-helpers.ts";

const agent = {
	name: "fake",
	description: "fake",
	systemPrompt: "",
	source: "builtin" as const,
	filePath: "/agents/fake.md",
};

function readLog(path: string): Array<Record<string, unknown>> {
	try {
		return readJsonLines(path);
	} catch {
		return [];
	}
}

describe("RPC JSONL framing", () => {
	it("uses --mode rpc and preserves split UTF-8 plus U+2028/U+2029 inside LF records", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-subagents-rpc-framing-"));
		const script = join(dir, "unicode-child.mjs");
		const argsLog = join(dir, "args.json");
		const value = "前缀😀\u2028中间\u2029结尾";
		writeFileSync(
			script,
			fakeRpcScript({
				setup: `fs.writeFileSync(${JSON.stringify(argsLog)}, JSON.stringify(process.argv));`,
				onPrompt: `const record = Buffer.from(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: input }], stopReason: "stop" } }) + "\\n", "utf8");
for (let index = 0; index < record.length; index++) process.stdout.write(record.subarray(index, index + 1));`,
			}),
			"utf8",
		);
		const previous = process.argv[1];
		process.argv[1] = script;
		try {
			const result = await runSingleAgent({
				defaultCwd: process.cwd(),
				agent,
				agentName: agent.name,
				task: value,
				stdinText: value,
				makeDetails: (results) => ({ mode: "single", results }),
			});
			expect(result.exitCode).toBe(0);
			expect(getFinalOutput(result.messages)).toBe(value);
			const argv = JSON.parse(readFileSync(argsLog, "utf8")) as string[];
			expect(argv).toContain("--mode");
			expect(argv[argv.indexOf("--mode") + 1]).toBe("rpc");
			expect(argv).not.toContain("-p");
			expect(argv).not.toContain("json");
		} finally {
			process.argv[1] = previous;
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("wraps slash-prefixed objectives so RPC starts a model turn instead of an extension command", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-subagents-rpc-slash-prompt-"));
		const script = join(dir, "slash-child.mjs");
		writeFileSync(
			script,
			fakeRpcScript({
				onPrompt: `send({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: input }], stopReason: "stop" } });`,
			}),
			"utf8",
		);
		const previous = process.argv[1];
		process.argv[1] = script;
		try {
			const result = await runSingleAgent({
				defaultCwd: process.cwd(),
				agent,
				agentName: agent.name,
				task: "/subagents-setup",
				stdinText: "/subagents-setup",
				makeDetails: (results) => ({ mode: "single", results }),
			});
			const output = getFinalOutput(result.messages);
			expect(result.exitCode).toBe(0);
			expect(output).toContain("plain-text sub-agent instructions");
			expect(output).toContain("/subagents-setup");
			expect(output.trimStart().startsWith("/")).toBe(false);
		} finally {
			process.argv[1] = previous;
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("forwards text activity and toolCallId values to live observers", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-subagents-rpc-records-"));
		const script = join(dir, "records-child.mjs");
		writeFileSync(
			script,
			fakeRpcScript({
				onPrompt: `const delta = "x".repeat(5000);
send({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta } });
send({ type: "tool_execution_start", toolCallId: "read-a", toolName: "read", args: { path: "a.ts" } });
send({ type: "tool_execution_end", toolCallId: "read-a", toolName: "read", isError: false });
send({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop" } });`,
			}),
			"utf8",
		);
		const previous = process.argv[1];
		process.argv[1] = script;
		const live: any[] = [];
		try {
			await runSingleAgent({
				defaultCwd: process.cwd(),
				agent,
				agentName: agent.name,
				task: "record",
				onLive: (event) => live.push(event),
				makeDetails: (results) => ({ mode: "single", results }),
			});
			expect(live).toContainEqual({ kind: "text" });
			expect(live).toContainEqual(expect.objectContaining({ kind: "tool_start", toolCallId: "read-a" }));
			expect(live).toContainEqual(expect.objectContaining({ kind: "tool_end", toolCallId: "read-a" }));
			expect(live.filter((event) => event.kind === "status").map((event) => event.status))
				.not.toContain("done");
			expect(live.filter((event) => event.kind === "status").map((event) => event.status))
				.not.toContain("failed");
		} finally {
			process.argv[1] = previous;
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("RPC handshake", () => {
	it("probes get_state before sending the initial prompt", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-subagents-rpc-handshake-"));
		const script = join(dir, "handshake-child.mjs");
		const log = join(dir, "commands.log");
		writeFileSync(
			script,
			fakeRpcScript({
				setup: `const commandLog = ${JSON.stringify(log)};`,
				onGetState: `fs.appendFileSync(commandLog, JSON.stringify({ type: "get_state" }) + "\\n");
respond(command);`,
				onPrompt: `fs.appendFileSync(commandLog, JSON.stringify({ type: "prompt" }) + "\\n");
send({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "ready" }], stopReason: "stop" } });`,
			}),
			"utf8",
		);
		const previous = process.argv[1];
		process.argv[1] = script;
		try {
			const result = await runSingleAgent({
				defaultCwd: process.cwd(),
				agent,
				agentName: agent.name,
				task: "handshake",
				makeDetails: (results) => ({ mode: "single", results }),
			});
			expect(result.exitCode).toBe(0);
			expect(readLog(log).map((entry) => entry.type)).toEqual(["get_state", "prompt"]);
		} finally {
			process.argv[1] = previous;
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("does not start the prompt ACK clock until get_state succeeds", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-subagents-rpc-ready-"));
		const script = join(dir, "slow-ready-child.mjs");
		writeFileSync(
			script,
			fakeRpcScript({
				onGetState: `await new Promise((resolve) => setTimeout(resolve, 80));\nrespond(command);`,
				onPrompt: `send({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "booted" }], stopReason: "stop" } });`,
			}),
			"utf8",
		);
		const previous = process.argv[1];
		process.argv[1] = script;
		try {
			const result = await runSingleAgent({
				defaultCwd: process.cwd(),
				agent,
				agentName: agent.name,
				task: "slow boot",
				rpcCommandTimeoutMs: 40,
				rpcReadyTimeoutMs: 500,
				makeDetails: (results) => ({ mode: "single", results }),
			});
			expect(result.exitCode).toBe(0);
			expect(getFinalOutput(result.messages)).toBe("booted");
			expect(result.rpcStartupFailed).toBeUndefined();
		} finally {
			process.argv[1] = previous;
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("RPC control ordering", () => {

	it("gracefully aborts before process teardown so partial output is retained", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-subagents-rpc-stop-"));
		const script = join(dir, "stop-child.mjs");
		const log = join(dir, "commands.log");
		writeFileSync(
			script,
			fakeRpcScript({
				setup: `const commandLog = ${JSON.stringify(log)};`,
				onPrompt: `send({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "partial output" } });`,
				onAbort: `fs.appendFileSync(commandLog, JSON.stringify({ type: "abort" }) + "\\n");
send({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "partial output" }], stopReason: "aborted" } });
send({ type: "agent_settled" });`,
				autoSettle: false,
			}),
			"utf8",
		);
		const previous = process.argv[1];
		process.argv[1] = script;
		const control = new RpcRunControl("objective", 1);
		try {
			const running = runSingleAgent({
				defaultCwd: process.cwd(),
				agent,
				agentName: agent.name,
				task: "objective",
				control,
				makeDetails: (results) => ({ mode: "single", results }),
			});
			await waitFor(() => control.getPhase() === "running");
			await control.stop("manual stop");
			const result = await running;
			expect(readLog(log).map((entry) => entry.type)).toEqual(["abort"]);
			expect(result.stopReason).toBe("aborted");
			expect(result.errorMessage).toBe("manual stop");
			expect(getFinalOutput(result.messages)).toBe("partial output");
		} finally {
			process.argv[1] = previous;
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("RpcRunControl attempt tokens", () => {
	it("ignores stale attempt phase events after a newer attempt attaches", () => {
		const phases: string[] = [];
		const control = new RpcRunControl("task", 7, (phase) => phases.push(phase));
		const noOp = { stop: async () => {} };
		const oldToken = control.beginAttempt();
		control.attach(oldToken, noOp);
		const currentToken = control.beginAttempt();
		control.attach(currentToken, noOp);

		control.updateAttemptPhase(oldToken, "interrupting");
		expect(phases).toEqual([]);
		control.updateAttemptPhase(currentToken, "running");
		expect(phases).toEqual(["running"]);
		expect(control.getPhase()).toBe("running");
	});
});
