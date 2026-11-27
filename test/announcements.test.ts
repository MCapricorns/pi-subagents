import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_CONFIG, loadConfig, updateConfig } from "../src/configuration/config.ts";
import { getRecoveryManifestPath } from "../src/isolation/recovery.ts";
import { createRuntime } from "../src/lifecycle/runtime.ts";
import { registerAnnouncements } from "../src/presentation/announcements.ts";

describe("session-start recovery announcements", () => {
	it("continues initialization when the recovery manifest is unreadable", async () => {
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
			await updateConfig(configPath, (config) => { config.worker.model = "fixture/missing"; });
			const path = getRecoveryManifestPath(configPath);
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
			assert.equal((await loadConfig(configPath)).worker.model, "fixture/missing");
			assert.ok(notices.some((message) => /setting is preserved and dispatch is paused/u.test(message)));
			assert.equal(await readFile(path, "utf8"), "{unfinished", "startup must preserve the unreadable manifest");
		} finally { await runtime.shutdown(); await rm(root, { recursive: true, force: true }); }
	});

	it("preserves worker settings outside the session scope and warns at startup", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-subagents-announcements-"));
		const configPath = join(root, "agent", "config.json");
		const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<void>>();
		const pi = {
			getActiveTools: () => [], getAllTools: () => [],
			on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<void>) => handlers.set(name, handler),
		} as unknown as ExtensionAPI;
		const runtime = createRuntime(pi, configPath);
		const notices: string[] = [];
		const scoped = { provider: "test", id: "scoped" };
		const outside = { provider: "test", id: "outside" };
		try {
			await updateConfig(configPath, (config) => { config.worker = { model: "test/outside", thinking: "high" }; });
			registerAnnouncements(pi, runtime);
			await handlers.get("session_start")!({}, {
				cwd: root, mode: "print", hasUI: false,
				modelRegistry: { getAvailable: () => [scoped, outside] },
				scopedModels: [{ model: scoped }],
				ui: { notify: (message: string) => notices.push(message) },
			} as unknown as ExtensionContext);
			assert.deepEqual((await loadConfig(configPath)).worker.model, "test/outside");
			assert.equal(notices.length, 1);
			assert.match(notices[0]!, /worker model test\/outside is unavailable.*setting is preserved and dispatch is paused/u);
		} finally { await runtime.shutdown(); await rm(root, { recursive: true, force: true }); }
	});

	for (const broken of ["{broken", JSON.stringify({ ...DEFAULT_CONFIG, worker: { model: "typo", thinking: "medium" } })]) {
		it(`preserves invalid current settings on session_start and warns: ${broken.slice(0, 20)}`, async () => {
			const root = await mkdtemp(join(tmpdir(), "pi-subagents-announcements-"));
			const configPath = join(root, "agent", "config.json");
			const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<void>>();
			const pi = {
				getActiveTools: () => [], getAllTools: () => [],
				on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<void>) => handlers.set(name, handler),
			} as unknown as ExtensionAPI;
			const runtime = createRuntime(pi, configPath);
			const notices: string[] = [];
			try {
				await mkdir(dirname(configPath), { recursive: true });
				await writeFile(configPath, broken, "utf8");
				registerAnnouncements(pi, runtime);
				await handlers.get("session_start")!({}, {
					cwd: root, mode: "print", hasUI: false,
					modelRegistry: { getAvailable: () => [] },
					scopedModels: [],
					ui: { notify: (message: string) => notices.push(message) },
				} as unknown as ExtensionContext);
				assert.equal(await readFile(configPath, "utf8"), broken);
				assert.equal(notices.length, 1);
				assert.match(notices[0]!, /Dispatch is paused/u);
			} finally { await runtime.shutdown(); await rm(root, { recursive: true, force: true }); }
		});
	}
});
