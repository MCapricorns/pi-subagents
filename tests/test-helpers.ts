import { readFileSync } from "node:fs";

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
