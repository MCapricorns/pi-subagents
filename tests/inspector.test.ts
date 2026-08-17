import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import { BackgroundTaskQueue, type BackgroundTask } from "../src/background.ts";
import register from "../src/index.ts";
import { buildInspectorSnapshot } from "../src/inspector.ts";
import { InspectorOverlay } from "../src/inspector-panel.ts";
import { monitor } from "../src/monitor.ts";
import type { SubagentThread } from "../src/runtime.ts";
import { inspectorStore } from "../src/trajectory.ts";
import { fakeRpcScript } from "./fake-rpc.ts";

interface StubCommand {
	name: string;
	description?: string;
	handler: (args: string, ctx: any) => Promise<void>;
}

interface StubPi {
	tools: any[];
	commands: StubCommand[];
	hooks: Record<string, (event: any, ctx: any) => any>;
	api: any;
}

function makeStub(): StubPi {
	const stub: StubPi = { tools: [], commands: [], hooks: {}, api: undefined };
	stub.api = {
		registerTool: (tool: any) => stub.tools.push(tool),
		registerMessageRenderer: () => {},
		registerCommand: (name: string, opts: any) => stub.commands.push({ name, ...opts }),
		registerShortcut: () => {},
		sendMessage: () => {},
		on: (event: string, handler: any) => {
			stub.hooks[event] = handler;
		},
	};
	return stub;
}

const fakeTheme = {
	fg: (_color: string, text: string): string => text,
	bold: (text: string): string => text,
} as any;

function executionContextForDispatch(): any {
	return {
		cwd: process.cwd(),
		model: undefined,
		scopedModels: [],
		modelRegistry: { getAvailable: () => [] },
		ui: { notify: vi.fn() },
	};
}

function makeTui() {
	return { requestRender: vi.fn() } as any;
}

function emptyRuntime(threads?: Map<number, SubagentThread>): { threads: Map<number, SubagentThread> } {
	return { threads: threads ?? new Map() };
}

let savedDepth: string | undefined;
let savedAgentDir: string | undefined;

beforeEach(() => {
	savedDepth = process.env.PI_SUBAGENT_DEPTH;
	savedAgentDir = process.env.PI_CODING_AGENT_DIR;
	delete process.env.PI_SUBAGENT_DEPTH;
});

afterEach(() => {
	vi.restoreAllMocks();
	monitor.clear();
	inspectorStore.clearAll();
	if (savedDepth === undefined) delete process.env.PI_SUBAGENT_DEPTH;
	else process.env.PI_SUBAGENT_DEPTH = savedDepth;
	if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
});

describe("/subagents-inspect command registration", () => {
	it("registers the command and requests an overlay via ctx.ui.custom", async () => {
		const stub = makeStub();
		register(stub.api);
		const command = stub.commands.find((candidate) => candidate.name === "subagents-inspect");
		expect(command).toBeDefined();

		const custom = vi.fn(async (_factory: any, _options?: any) => undefined);
		const notify = vi.fn();
		await command!.handler("", { mode: "tui", ui: { custom, notify } });
		expect(custom).toHaveBeenCalledOnce();
		const [, options] = custom.mock.calls[0];
		expect(options).toMatchObject({ overlay: true });
		expect(options.overlayOptions).toMatchObject({ width: "92%" });

		// The factory returns a well-formed component.
		const [factory] = custom.mock.calls[0];
		const tui = makeTui();
		let closed = false;
		const component = factory(tui, fakeTheme, undefined, () => {
			closed = true;
		});
		expect(typeof component.render).toBe("function");
		expect(typeof component.handleInput).toBe("function");
		expect(typeof component.invalidate).toBe("function");
		expect(closed).toBe(false);
		(component as { dispose: () => void }).dispose();
	});

	it("refuses to open outside the interactive TUI", async () => {
		const stub = makeStub();
		register(stub.api);
		const command = stub.commands.find((candidate) => candidate.name === "subagents-inspect");
		const custom = vi.fn(async (_factory: unknown, _options?: unknown) => undefined);
		const notify = vi.fn();
		await command!.handler("", { mode: "rpc", ui: { custom, notify } });
		expect(custom).not.toHaveBeenCalled();
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("interactive TUI"), "error");
	});
});

describe("InspectorOverlay", () => {
	it("shows the empty state with control hints and footer", () => {
		const overlay = new InspectorOverlay({ runtime: emptyRuntime(), tui: makeTui(), theme: fakeTheme, done: () => {} });
		const lines = overlay.render(160).join("\n");
		expect(lines).toContain("No sub-agent threads yet");
		expect(lines).toContain("subagent_control");
		expect(lines).toContain("subagent_stop");
		expect(lines).toContain("Esc close");
		overlay.dispose();
	});

	it("rerenders on monitor and trajectory updates and keeps the selection stable", () => {
		const tui = makeTui();
		const overlay = new InspectorOverlay({ runtime: emptyRuntime(), tui, theme: fakeTheme, done: () => {} });
		const firstId = monitor.addRun("worker", "Implement the feature in src/feature.ts");
		expect(tui.requestRender).toHaveBeenCalled();

		// The newest thread is selected by default and survives later updates.
		monitor.addRun("explore", "Map the codebase in src/");
		const selected = overlay.render(120).join("\n");
		expect(selected).toContain("❯");
		const lines = overlay.render(120);
		const cursorLine = lines.find((line) => line.includes("❯"));
		expect(cursorLine).toContain("explore");

		// Trajectory appends also rerender, without moving the cursor.
		tui.requestRender.mockClear();
		inspectorStore.get(firstId).trajectory.append({ kind: "status", status: "running" });
		expect(tui.requestRender).toHaveBeenCalled();
		const afterCursor = overlay.render(120).find((line) => line.includes("❯"));
		expect(afterCursor).toContain("explore");
		overlay.dispose();
	});

	it("moves the selection with arrow keys and closes cleanly on Escape", () => {
		const tui = makeTui();
		let done = false;
		const overlay = new InspectorOverlay({ runtime: emptyRuntime(), tui, theme: fakeTheme, done: () => {
			done = true;
			overlay.dispose();
		} });
		monitor.addRun("worker", "First task in src/one.ts");
		monitor.addRun("explore", "Second task in src/two.ts");
		tui.requestRender.mockClear();

		// Default selection is the newest; up moves to the first.
		overlay.handleInput("\x1b[A");
		let cursor = overlay.render(120).find((line) => line.includes("❯"));
		expect(cursor).toContain("worker");
		overlay.handleInput("\x1b[B");
		cursor = overlay.render(120).find((line) => line.includes("❯"));
		expect(cursor).toContain("explore");

		overlay.handleInput("\x1b");
		expect(done).toBe(true);

		// After Escape, further store mutations never rerender (unsubscribed).
		tui.requestRender.mockClear();
		monitor.addRun("worker", "Third task");
		expect(tui.requestRender).not.toHaveBeenCalled();
	});

	it("parks a live thread and resumes a parked one via the p shortcut", async () => {
		const runId = monitor.addRun("worker", "Parkable task in src/park.ts");
		monitor.setStatus(runId, "running");
		const park = vi.fn(async () => {});
		const resume = vi.fn(async () => ({ exitCode: -1 }));
		const thread = {
			id: runId,
			generation: 1,
			agentName: "worker",
			task: "Parkable task in src/park.ts",
			vision: false,
			state: "running",
			control: { getPhase: () => "running" },
			park,
			resume,
		} as unknown as SubagentThread;
		park.mockImplementation(async () => {
			thread.state = "parked";
			monitor.setStatus(runId, "parked");
		});
		const threads = new Map<number, SubagentThread>([[runId, thread]]);
		const overlay = new InspectorOverlay({ runtime: emptyRuntime(threads), tui: makeTui(), theme: fakeTheme, done: () => {} });

		overlay.handleInput("p");
		await new Promise((resolve) => setImmediate(resolve));
		await new Promise((resolve) => setImmediate(resolve));
		expect(park).toHaveBeenCalledOnce();
		expect(thread.state).toBe("parked");
		expect(monitor.findRun(runId)?.status).toBe("parked");

		overlay.handleInput("p");
		await new Promise((resolve) => setImmediate(resolve));
		expect(resume).toHaveBeenCalledWith(undefined);
		overlay.dispose();
	});

	it("renders header facts, transcript, recent tools and trajectory for the selected thread", () => {
		const runId = monitor.addRun("worker", "Fix the flaky test in tests/flaky.test.ts", "anthropic/claude-sonnet-4-5", "high");
		monitor.setStatus(runId, "running");
		monitor.setUsage(runId, { input: 1234, output: 567, cacheRead: 0, cacheWrite: 0, cost: 0.0123, contextTokens: 1801, turns: 2 }, "anthropic/claude-sonnet-4-5");
		const state = inspectorStore.get(runId);
		state.trajectory.append({ kind: "dispatch", agent: "worker", task: "Fix the flaky test in tests/flaky.test.ts", model: "anthropic/claude-sonnet-4-5", thinking: "high", pool: ["openai/gpt-5"] });
		state.trajectory.append({ kind: "tool_start", tool: "read", summary: "path=tests/flaky.test.ts" });
		state.trajectory.append({ kind: "tool_end", tool: "read", isError: false });
		state.trajectory.append({ kind: "steer", instruction: "focus on the timing race" });
		state.transcript.appendThinking("comparing the two runs");
		state.transcript.appendText("I found the race in the setup hook.");

		const overlay = new InspectorOverlay({ runtime: emptyRuntime(), tui: makeTui(), theme: fakeTheme, done: () => {} });
		const text = overlay.render(160).join("\n");
		expect(text).toContain(`#${runId} worker`);
		expect(text).toContain("gen 1");
		expect(text).toContain("task: Fix the flaky test in tests/flaky.test.ts");
		expect(text).toContain("anthropic/claude-sonnet-4-5");
		expect(text).toContain("chain: anthropic/claude-sonnet-4-5 → openai/gpt-5");
		expect(text).toContain("thinking high");
		expect(text).toContain("↑1.2k");
		expect(text).toContain("$0.0123");
		expect(text).toContain("I found the race in the setup hook.");
		expect(text).toContain("comparing the two runs");
		expect(text).toContain("recent tools");
		expect(text).toContain("read path=tests/flaky.test.ts");
		expect(text).toContain("trajectory");
		expect(text).toContain("steer: focus on the timing race");
		expect(text).toContain("→ read");
		overlay.dispose();
	});

	it("correlates parallel same-name tool calls by toolCallId", () => {
		const runId = monitor.addRun("worker", "parallel reads");
		const state = inspectorStore.get(runId);
		state.trajectory.append({ kind: "dispatch", agent: "worker", task: "parallel reads" }, 1);
		state.trajectory.append({ kind: "tool_start", tool: "read", toolCallId: "read-a", summary: "path=a.ts" }, 2);
		state.trajectory.append({ kind: "tool_start", tool: "read", toolCallId: "read-b", summary: "path=b.ts" }, 3);
		state.trajectory.append({ kind: "tool_end", tool: "read", toolCallId: "read-b", isError: true }, 4);
		const tools = buildInspectorSnapshot({ runtime: emptyRuntime(), selectedId: runId }).detail?.tools;
		expect(tools).toEqual([
			expect.objectContaining({ summary: "path=a.ts", running: true, isError: undefined }),
			expect.objectContaining({ summary: "path=b.ts", running: false, isError: true }),
		]);
	});

	it("strips untrusted terminal controls before rendering themed text", () => {
		const runId = monitor.addRun("worker", "unsafe\u001b]52;c;dGFzaw==\u0007 task");
		const state = inspectorStore.get(runId);
		state.retainFrom({
			agent: "worker",
			task: "clear\u001b[2Jscreen",
			label: "label\u001b]0;owned\u0007",
			status: "running",
		});
		state.trajectory.append({ kind: "dispatch", agent: "worker", task: "unsafe" });
		state.trajectory.append({ kind: "steer", instruction: "copy\u001b]52;c;c2VjcmV0\u0007" });
		state.transcript.appendText("output\u001b[2J\u001b]52;c;c2VjcmV0\u0007safe");
		monitor.removeRun(runId);
		const overlay = new InspectorOverlay({ runtime: emptyRuntime(), tui: makeTui(), theme: fakeTheme, done: () => {} });
		const lines = overlay.render(100);
		expect(lines.join("\n")).toContain("clearscreen");
		expect(lines.join("\n")).toContain("outputsafe");
		expect(lines.join("\n")).not.toContain("\u001b]");
		expect(lines.join("\n")).not.toContain("\u001b[2J");
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(100);
		overlay.dispose();
	});

	it("degrades to a single pane at narrow widths and never overflows the width", () => {
		const runId = monitor.addRun("worker", "Wide task with a long objective in src/wide-component-file.ts");
		monitor.setStatus(runId, "running");
		inspectorStore.get(runId).transcript.appendText("some streaming output that is quite long and must be clipped");
		const overlay = new InspectorOverlay({ runtime: emptyRuntime(), tui: makeTui(), theme: fakeTheme, done: () => {} });
		for (const width of [50, 60, 80]) {
			const lines = overlay.render(width);
			expect(lines.join("\n")).toContain(`#${runId} worker`);
			for (const line of lines) {
				expect(visibleWidth(line)).toBeLessThanOrEqual(width);
			}
		}
		overlay.dispose();
	});

	it("keeps completed threads inspectable after their widget row is gone", () => {
		const runId = monitor.addRun("explore", "Finished search in src/");
		monitor.setStatus(runId, "running");
		const state = inspectorStore.get(runId);
		state.trajectory.append({ kind: "dispatch", agent: "explore", task: "Finished search in src/", model: "a/model" });
		state.trajectory.append({ kind: "settled", status: "done", model: "a/model" });
		state.retainFrom({ agent: "explore", task: "Finished search in src/", status: "done", model: "a/model" });
		monitor.removeRun(runId);

		const snapshot = buildInspectorSnapshot({ runtime: emptyRuntime(), selectedId: runId });
		expect(snapshot.items).toHaveLength(1);
		expect(snapshot.items[0].id).toBe(runId);
		expect(snapshot.detail?.status).toBe("done");
		expect(snapshot.detail?.model).toBe("a/model");
		expect(snapshot.detail?.trajectory.map((event) => event.kind)).toContain("settled");
	});

	it("derives settled status and end time from trajectory after a live row disappears", () => {
		const runId = monitor.addRun("reviewer", "chain round");
		const state = inspectorStore.get(runId);
		state.retainFrom({ agent: "reviewer", task: "chain round", status: "queued", startedAt: 100 });
		state.trajectory.append({ kind: "dispatch", agent: "reviewer", task: "chain round" }, 100);
		state.trajectory.append({ kind: "settled", status: "done" }, 250);
		monitor.removeRun(runId);
		const snapshot = buildInspectorSnapshot({ runtime: emptyRuntime(), selectedId: runId, now: 10_000 });
		expect(snapshot.items[0]).toMatchObject({ status: "done", stateText: "done", elapsedMs: 150 });
		expect(snapshot.detail).toMatchObject({ status: "done", endedAt: 250, elapsedMs: 150 });
	});

	it("captures streamed deltas and redacted tool args end-to-end through dispatch", async () => {
		const stub = makeStub();
		const capturedTasks: BackgroundTask[] = [];
		const backgroundController = new AbortController();
		vi.spyOn(BackgroundTaskQueue.prototype, "enqueue").mockImplementation((task) => {
			capturedTasks.push(task);
			return backgroundController;
		});

		let childDir: string | undefined;
		const previousScript = process.argv[1];
		try {
			childDir = mkdtempSync(join(tmpdir(), "pi-subagents-inspect-child-"));
			const childScript = join(childDir, "fake-pi-child.mjs");
			writeFileSync(
				childScript,
				fakeRpcScript({
					onPrompt: `send({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "let me check " } });
send({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "the config first" } });
send({ type: "tool_execution_start", toolCallId: "bash-1", toolName: "bash", args: { command: "curl -H 'Authorization: Bearer command-secret' api", authorization: "Bearer topsecret-token", path: "src/config.ts" } });
send({ type: "tool_execution_end", toolCallId: "bash-1", toolName: "bash", isError: false });
send({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "The config lives " } });
send({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "in src/config.ts." } });
send({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "The config lives in src/config.ts." }], usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.001 }, totalTokens: 15 }, stopReason: "stop" } });`,
				}),
				"utf8",
			);
			process.argv[1] = childScript;

			register(stub.api);
			const tool = stub.tools.find((candidate) => candidate.name === "subagent");
			await tool.execute(
				"call-inspect",
				{ agent: "worker", task: "Find the config in src/config.ts" },
				new AbortController().signal,
				() => {},
				executionContextForDispatch(),
			);
			expect(capturedTasks).toHaveLength(1);
			const runId = monitor.getRuns()[0]?.id;
			expect(runId).toBeDefined();
			await capturedTasks[0](backgroundController.signal);

			const state = inspectorStore.get(runId!);
			// Streamed deltas reached the bounded transcript with payloads intact.
			const transcript = state.transcript.snapshot();
			expect(transcript.text).toBe("The config lives in src/config.ts.");
			expect(transcript.thinking).toBe("let me check the config first");

			// Orchestration + tool activity reached the append-only trajectory.
			const kinds = state.trajectory.getEvents().map((event) => event.kind);
			expect(kinds).toContain("dispatch");
			expect(kinds).toContain("tool_start");
			expect(kinds).toContain("tool_end");
			expect(kinds).toContain("usage");
			expect(kinds).toContain("settled");
			const toolStart = state.trajectory.getEvents().find((event) => event.kind === "tool_start");
			expect(toolStart).toMatchObject({ tool: "bash", toolCallId: "bash-1" });
			if (toolStart?.kind !== "tool_start") throw new Error("expected a tool_start event");
			expect(toolStart.summary).toContain("authorization=<redacted>");
			expect(toolStart.summary).not.toContain("topsecret-token");
			expect(toolStart.summary).not.toContain("command-secret");

			// The settled thread stays inspectable with its retained snapshot.
			const detail = buildInspectorSnapshot({ runtime: emptyRuntime(), selectedId: runId }).detail;
			expect(detail?.status).toBe("done");
			expect(detail?.usage.input).toBe(10);
		} finally {
			backgroundController.abort();
			await stub.hooks["session_shutdown"]?.({}, {});
			monitor.clear();
			inspectorStore.clearAll();
			process.argv[1] = previousScript;
			if (childDir) rmSync(childDir, { recursive: true, force: true });
		}
	});

	it("requests the trajectory across generations without overwriting history", () => {
		const runId = monitor.addRun("worker", "Original objective in src/a.ts");
		const state = inspectorStore.get(runId);
		state.trajectory.append({ kind: "dispatch", agent: "worker", task: "Original objective in src/a.ts" }, 1_000);
		state.trajectory.restart();
		state.transcript.clear();
		state.trajectory.append({ kind: "resume" }, 2_000);
		state.trajectory.append({ kind: "dispatch", agent: "worker", task: "New objective in src/b.ts", resumed: true }, 2_100);

		const detail = buildInspectorSnapshot({ runtime: emptyRuntime(), selectedId: runId }).detail;
		expect(detail?.trajectory.map((event) => event.kind)).toEqual(["resume", "dispatch"]);
		expect(detail?.trajectoryTotal).toBe(3);
		expect(detail?.trajectory.every((event) => event.generation === 2)).toBe(true);
	});
});
