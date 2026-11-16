import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import registerExtension from "../index.ts";
import { DEFAULT_CONFIG, loadConfig, saveConfig } from "../src/configuration/config.ts";
import { ORCHESTRATION_SECTION } from "../src/delegation/orchestration.ts";
import { DELEGATION_SECTION } from "../src/delegation/prompt.ts";
import { monitor } from "../src/presentation/monitor.ts";

function model(id: string): Model<Api> {
	return {
		id, name: id, provider: "fixture", api: "openai-responses", baseUrl: "https://example.test",
		reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000, maxTokens: 8_192,
	};
}

it("resets old settings and installs live orchestration without changing the stable prompt", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pi-orchestration-"));
	const previous = { PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR, PI_SUBAGENT_DEPTH: process.env.PI_SUBAGENT_DEPTH };
	process.env.PI_CODING_AGENT_DIR = root;
	delete process.env.PI_SUBAGENT_DEPTH;
	const configPath = join(root, "pi-subagents.json");
	await writeFile(configPath, JSON.stringify({ models: { artisan: "old/worker", sentinel: "old/review" } }));
	const evidence = join(root, "existing-result.txt");
	await writeFile(evidence, "preserved evidence");
	const handlers = new Map<string, Array<(event: any, ctx: ExtensionContext) => Promise<any>>>();
	const tools = new Map<string, any>();
	const commands: string[] = [];
	const notices: string[] = [];
	const main = model("main");
	const worker = model("worker");
	const ctx = {
		cwd: root, mode: "print", hasUI: false, model: main, scopedModels: [],
		modelRegistry: { getAvailable: () => [main, worker] },
		ui: { notify: (message: string) => notices.push(message) },
	} as unknown as ExtensionContext;
	const pi = {
		on: (name: string, handler: (event: any, ctx: ExtensionContext) => Promise<any>) => {
			handlers.set(name, [...handlers.get(name) ?? [], handler]);
		},
		registerCommand: (name: string) => commands.push(name),
		registerTool: (tool: any) => tools.set(tool.name, tool),
		registerMessageRenderer() {}, getActiveTools: () => ["read", "write"], getAllTools: () => [], sendMessage() {},
	} as unknown as ExtensionAPI;
	t.after(async () => {
		for (const handler of handlers.get("session_shutdown") ?? []) await handler({}, ctx);
		for (const [key, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		await rm(root, { recursive: true, force: true });
	});
	registerExtension(pi);
	for (const handler of handlers.get("session_start") ?? []) await handler({}, ctx);
	assert.deepEqual(await loadConfig(configPath), DEFAULT_CONFIG);
	assert.ok(notices.some((message) => /deleted the old config.*subagents-setup/u.test(message)));
	assert.equal(await readFile(evidence, "utf8"), "preserved evidence");
	assert.deepEqual(commands, ["subagents-setup", "subagents-cleanup"]);

	const before = handlers.get("before_agent_start")![0]!;
	const sections: Record<string, string> = { custom: "Preserve another extension" };
	const event = { systemPrompt: "base prompt", systemPromptOptions: { sections } };
	assert.equal(await before(event, ctx), undefined, "section updates must not replace Pi's cached prompt");
	const stable = sections[DELEGATION_SECTION];
	assert.match(stable!, /Main judges difficulty/u);
	assert.match(stable!, /Delegate simple, bounded work by default/u);
	assert.match(sections[ORCHESTRATION_SECTION]!, /Workers currently follow main/u);
	await saveConfig({ ...DEFAULT_CONFIG, model: "fixture/worker", thinking: "low" }, configPath);
	await before(event, ctx);
	assert.equal(sections[DELEGATION_SECTION], stable);
	assert.match(sections[ORCHESTRATION_SECTION]!, /Main judges difficulty, plans, handles complex work, and reviews: fixture\/main/u);
	assert.match(sections[ORCHESTRATION_SECTION]!, /Workers execute: fixture\/worker \(thinking preference: low/u);
	assert.equal(sections.custom, "Preserve another extension");

	const scoped = { ...ctx, scopedModels: [{ model: main, thinkingLevel: "high" }] } as ExtensionContext;
	await before(event, scoped);
	assert.match(sections[ORCHESTRATION_SECTION]!, /Dispatch is blocked/u);
	assert.equal(sections[DELEGATION_SECTION], stable);
	await assert.rejects(
		tools.get("subagent").execute("blocked-worker", { agent: "artisan", task: "Write a file", wait: true }, new AbortController().signal, undefined, scoped),
		/Dispatch paused.*No main-model worker was started/u,
	);
	assert.equal(monitor.getRuns().length, 0, "unavailable workers fail before allocating a run");
	assert.equal((await loadConfig(configPath)).model, "fixture/worker");

	const opaque = await before({ systemPrompt: "opaque prompt" }, ctx);
	assert.match(opaque.systemPrompt, /^opaque prompt[\s\S]*Workers execute: fixture\/worker/u);
	await writeFile(configPath, "{unfinished edit");
	assert.equal(await before(event, ctx), undefined, "a broken worker config must not prevent main from responding");
	assert.match(sections[ORCHESTRATION_SECTION]!, /Worker dispatch is paused/u);
	await assert.rejects(tools.get("subagent").execute("broken-config", { agent: "artisan", task: "Write a file", wait: true }, new AbortController().signal, undefined, ctx), /invalid or incompatible/u);
	assert.equal(monitor.getRuns().length, 0);
});
