import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadConfig, saveConfig } from "../src/configuration/config.ts";
import { getRecoveryManifestPath } from "../src/isolation/recovery.ts";
import { createRuntime } from "../src/lifecycle/runtime.ts";
import { registerAnnouncements } from "../src/presentation/announcements.ts";

describe("session-start recovery announcements", () => {
	for (const location of ["legacy", "current"] as const) {
		it(`continues initialization when the ${location} recovery manifest is unreadable`, async () => {
			const root = await mkdtemp(join(tmpdir(), "pi-subagents-announcements-"));
			const configPath = join(root, "agent", "config.json");
			const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<void>>();
			const pi = {
				getActiveTools: () => [], getAllTools: () => [],
				on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<void>) => handlers.set(name, handler),
			} as unknown as ExtensionAPI;
			const runtime = createRuntime(pi, configPath);
			const notices: string[] = [];
			const widgets: string[] = [];
			try {
				await saveConfig({ agentModels: { artisan: "fixture/missing" }, agentThinkingLevels: {} }, configPath);
				const path = location === "legacy" ? join(dirname(configPath), "pi-subagents-recovery.json") : getRecoveryManifestPath(configPath);
				await mkdir(dirname(path), { recursive: true });
				await writeFile(path, "{unfinished");
				runtime.restoredRunIds = [9];
				registerAnnouncements(pi, runtime);
				await handlers.get("session_start")!({}, {
					cwd: root, mode: "tui", hasUI: true, modelRegistry: { getAvailable: () => [] },
					ui: { notify: (message: string) => notices.push(message), setWidget: (id: string) => widgets.push(id) },
				} as unknown as ExtensionContext);
				assert.deepEqual(widgets, ["pi-subagents"]);
				assert.equal(runtime.restoredNotified, true);
				assert.ok(notices.some((message) => /recovery inspection failed.*continuing startup/iu.test(message)));
				assert.ok(notices.some((message) => /restored 1 interrupted run/u.test(message)));
				assert.deepEqual((await loadConfig(configPath)).agentModels, {});
				assert.equal(await readFile(path, "utf8"), "{unfinished", "startup must preserve the unreadable manifest");
			} finally { await runtime.shutdown(); await rm(root, { recursive: true, force: true }); }
		});
	}
});
