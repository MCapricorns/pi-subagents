import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import registerExtension from "../index.ts";
import { getProjectRoot } from "../src/execution/spawn.ts";

type CommandHandler = (args: string, ctx: ExtensionCommandContext) => Promise<void>;

it("deletes storage only for /subagents-cleanup without an unknown argument", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pi-subagents-extension-"));
	const previous = { agentDir: process.env.PI_CODING_AGENT_DIR, depth: process.env.PI_SUBAGENT_DEPTH };
	process.env.PI_CODING_AGENT_DIR = root;
	delete process.env.PI_SUBAGENT_DEPTH;
	const commands = new Map<string, CommandHandler>();
	const shutdownHandlers: Array<(event: unknown, ctx: unknown) => Promise<void>> = [];
	const pi = {
		on: (event: string, handler: (event: unknown, ctx: unknown) => Promise<void>) => {
			if (event === "session_shutdown") shutdownHandlers.push(handler);
		},
		registerCommand: (name: string, command: { handler: CommandHandler }) => commands.set(name, command.handler),
		registerMessageRenderer: () => undefined,
		registerTool: () => undefined,
		getActiveTools: () => [],
		getAllTools: () => [],
		sendMessage: () => undefined,
	} as unknown as ExtensionAPI;
	t.after(async () => {
		for (const handler of shutdownHandlers) await handler({}, { mode: "print", ui: {} });
		for (const [key, value] of [["PI_CODING_AGENT_DIR", previous.agentDir], ["PI_SUBAGENT_DEPTH", previous.depth]] as const) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		await rm(root, { recursive: true, force: true });
	});
	registerExtension(pi);

	// A session whose owner died is exactly what a real cleanup reclaims.
	const session = join(getProjectRoot(join(root, "pi-subagents.json"), join(root, "project")), "sessions", "pi-subagent-session-dead");
	await mkdir(session, { recursive: true });
	await writeFile(join(session, "owner.json"), JSON.stringify({ pid: 999_999, createdAt: 0 }));
	const notices: Array<{ message: string; level: string }> = [];
	const ctx = { ui: { notify: (message: string, level: string) => notices.push({ message, level }) } } as unknown as ExtensionCommandContext;
	const cleanup = commands.get("subagents-cleanup");
	assert.ok(cleanup);

	await cleanup("--dry-run", ctx);
	assert.equal(existsSync(session), true);
	assert.deepEqual(notices.at(-1)?.level, "warning");
	assert.match(notices.at(-1)!.message, /unknown argument "--dry-run"; nothing was deleted/u);

	await cleanup("dry-run", ctx);
	assert.equal(existsSync(session), true);
	assert.match(notices.at(-1)!.message, /^pi-subagents storage:/u);

	await cleanup("", ctx);
	assert.equal(existsSync(session), false);
	assert.match(notices.at(-1)!.message, /^pi-subagents cleanup: freed/u);
});
