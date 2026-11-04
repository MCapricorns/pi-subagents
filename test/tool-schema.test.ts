import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { validateToolArguments, type Tool, type ToolCall } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerSubagentTool } from "../src/delegation/dispatch.ts";
import { createDispatchCore } from "../src/lifecycle/dispatch-core.ts";
import { createRuntime } from "../src/lifecycle/runtime.ts";

it("validates dispatch enums through the Pi SDK", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pi-tool-schema-"));
	const tools = new Map<string, Tool>();
	const pi = {
		on: () => undefined,
		getActiveTools: () => [],
		getAllTools: () => [],
		registerTool: (tool: Tool) => tools.set(tool.name, tool),
	} as unknown as ExtensionAPI;
	const runtime = createRuntime(pi, join(root, "config.json"));
	t.after(async () => {
		await runtime.shutdown();
		await rm(root, { recursive: true, force: true });
	});
	const core = createDispatchCore(runtime);
	registerSubagentTool(pi, runtime, core);
	const validate = (name: string, args: ToolCall["arguments"]) => validateToolArguments(
		tools.get(name)!, { type: "toolCall", id: "schema-test", name, arguments: args },
	);
	const task = { agent: "artisan", task: "Implement the bounded change" };
	for (const isolation of [undefined, "shared", "worktree"]) {
		const args = { ...task, ...(isolation ? { isolation } : {}) };
		assert.deepEqual(validate("subagent", args), args);
		assert.deepEqual(validate("subagent", { tasks: [args] }), { tasks: [args] });
	}
	assert.throws(() => validate("subagent", { ...task, isolation: "invalid" }), /isolation:/u);
	assert.throws(() => validate("subagent", { tasks: [{ ...task, isolation: "invalid" }] }), /tasks\.0\.isolation:/u);
});
