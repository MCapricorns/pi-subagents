import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";
import { BackgroundTaskQueue, type BackgroundTask } from "../src/background.ts";
import { monitor } from "../src/monitor.ts";
import { fakeRpcScript } from "./fake-rpc.ts";

export interface StubPi {
	tools: any[];
	activeTools: string[];
	commands: string[];
	hooks: Record<string, (event: any, ctx: any) => any>;
	messages: Array<{ message: any; options: any }>;
	api: any;
}

/** Minimal ExtensionAPI harness shared by integration-style extension tests. */
export function makeStub(): StubPi {
	const stub: StubPi = {
		tools: [],
		activeTools: ["read", "bash", "edit", "write"],
		commands: [],
		hooks: {},
		messages: [],
		api: undefined,
	};
	stub.api = {
		registerTool: (tool: any) => stub.tools.push(tool),
		getActiveTools: () => [...stub.activeTools],
		registerMessageRenderer: () => {},
		registerCommand: (name: string) => stub.commands.push(name),
		registerShortcut: () => {},
		sendMessage: (message: any, options: any) => stub.messages.push({ message, options }),
		on: (event: string, handler: any) => {
			stub.hooks[event] = handler;
		},
	};
	return stub;
}

export async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error("Timed out waiting for test condition");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

export function readJsonLines<T>(path: string): T[] {
	return readFileSync(path, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as T);
}

/** Standard dispatch context for tool.execute in integration-style tests. */
export function executionContext(overrides: { uiNotify?: ReturnType<typeof vi.fn> } = {}): any {
	return {
		cwd: process.cwd(),
		model: undefined,
		scopedModels: [],
		modelRegistry: { getAvailable: () => [] },
		ui: { notify: overrides.uiNotify ?? vi.fn() },
	};
}

/** Run a registered tool with the standard fresh signal and no-op updater. */
export function runTool(tool: any, callId: string, params: any, ctx: any): Promise<any> {
	return tool.execute(callId, params, new AbortController().signal, () => {}, ctx);
}

/** Freeze the queue so background tasks run only when the test drives them:
 * call `tasks[i](controllers[i].signal)` and settle the returned promise. */
export function captureEnqueue(): { tasks: BackgroundTask[]; controllers: AbortController[] } {
	const tasks: BackgroundTask[] = [];
	const controllers: AbortController[] = [];
	vi.spyOn(BackgroundTaskQueue.prototype, "enqueue").mockImplementation((task) => {
		tasks.push(task);
		const controller = new AbortController();
		controllers.push(controller);
		return controller;
	});
	return { tasks, controllers };
}

/** Point process.argv[1] at a fake RPC child; call the returned restore in the
 * test's finally block. */
export function fakeChild(onPrompt: string): () => void {
	const dir = mkdtempSync(join(tmpdir(), "pi-subagents-child-"));
	const script = join(dir, "fake-pi-child.mjs");
	writeFileSync(script, fakeRpcScript({ onPrompt }), "utf8");
	const previous = process.argv[1];
	process.argv[1] = script;
	return () => {
		process.argv[1] = previous;
		rmSync(dir, { recursive: true, force: true });
	};
}

/** Tear an extension stub down: abort captured queue controllers (hanging
 * spawn mocks listen on those signals), then run the real shutdown hook. */
export async function shutdownExtension(
	stub: StubPi,
	captured?: { controllers: AbortController[] },
): Promise<void> {
	for (const controller of captured?.controllers ?? []) controller.abort();
	await stub.hooks["session_shutdown"]?.({}, {});
	monitor.clear();
}
