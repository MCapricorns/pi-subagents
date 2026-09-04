import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import {
	KeybindingsManager,
	TUI_KEYBINDINGS,
	visibleWidth,
	type Component,
	type TUI,
} from "@earendil-works/pi-tui";
import type { SubagentsConfig } from "../src/config.ts";
import { SetupOverlay, runSetup } from "../src/setup.ts";

const KEY = {
	down: "\x1b[B",
	right: "\x1b[C",
	enter: "\r",
	escape: "\x1b",
} as const;

const theme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
	italic: (text: string) => text,
	strikethrough: (text: string) => text,
} as Theme;

const keybindings = new KeybindingsManager(TUI_KEYBINDINGS);
const tui = { requestRender() {} } as TUI;

function model(id: string, reasoning: boolean): Model<Api> {
	return {
		id,
		name: id,
		api: "openai-responses",
		provider: "test",
		baseUrl: "https://example.test",
		reasoning,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 8_192,
	};
}

function baseConfig(overrides: Partial<SubagentsConfig> = {}): SubagentsConfig {
	return {
		enabledAgents: ["scout", "artisan", "steward", "sentinel"],
		knownAgents: ["scout", "artisan", "steward", "sentinel"],
		agentModels: {},
		agentThinkingLevels: {},
		maxResultLines: 40,
		agentScope: "user",
		idleTimeoutSec: 90,
		...overrides,
	};
}

function createOverlay(
	config: SubagentsConfig,
	models: readonly Model<Api>[],
	onDone: (result: SubagentsConfig | undefined) => void,
): SetupOverlay {
	return new SetupOverlay({
		config,
		models,
		mainModel: models[0],
		theme,
		tui,
		keybindings,
		onDone,
	});
}

function moveToSave(component: Component, agentCount: number, startRow = 0): void {
	for (let i = startRow; i < agentCount; i++) component.handleInput?.(KEY.down);
	component.handleInput?.(KEY.enter);
}

describe("SetupOverlay", () => {
	it("renders every built-in plus configured custom agents without overflowing narrow widths", () => {
		const component = createOverlay(
			baseConfig({
				enabledAgents: ["scout", "artisan", "steward", "sentinel", "long-custom-agent"],
				agentModels: { artisan: "test/reasoning", "long-custom-agent": "test/plain" },
				agentThinkingLevels: { "long-custom-agent": "off" },
			}),
			[model("reasoning", true), model("plain", false)],
			() => {},
		);

		for (const width of [1, 8, 36, 120]) {
			for (const line of component.render(width)) {
				assert.ok(visibleWidth(line) <= width, `line width ${visibleWidth(line)} exceeded ${width}: ${line}`);
			}
		}

		const display = component.render(120).join("\n");
		assert.match(display, /recon \/ research/);
		assert.match(display, /external facts/);
		for (const name of ["scout", "artisan", "steward", "sentinel", "long-custom-agent"]) {
			assert.match(display, new RegExp(name));
		}
		assert.match(display, /sentinel.*follow artisan.*test\/reasoning/i);
		assert.match(display, /long-custom-agent.*test\/plain.*off \(override\)/i);
	});

	it("keeps disabled known custom agents in later setup sessions", () => {
		let result: SubagentsConfig | undefined;
		const component = createOverlay(
			baseConfig({ knownAgents: ["scout", "artisan", "steward", "sentinel", "dormant-custom"] }),
			[model("reasoning", true)],
			(value) => {
				result = value;
			},
		);

		assert.match(component.render(120).join("\n"), /dormant-custom \(custom\)/);
		moveToSave(component, 5);
		assert.ok(result?.knownAgents.includes("dormant-custom"));
	});

	it("keeps both exit actions visible when custom agents exceed the viewport", () => {
		const customAgents = Array.from({ length: 10 }, (_, index) => `custom-${index + 1}`);
		const component = createOverlay(
			baseConfig({ enabledAgents: ["scout", "artisan", "steward", "sentinel", ...customAgents] }),
			[model("reasoning", true)],
			() => {},
		);

		const visibleOverlay = component.render(36).slice(0, 21).join("\n");
		assert.match(visibleOverlay, /Save & Exit/);
		assert.match(visibleOverlay, /Cancel/);
	});

	it("uses an in-overlay searchable model picker and clamps thinking when the model changes", () => {
		let result: SubagentsConfig | undefined;
		const models = [model("reasoning", true), model("plain", false)];
		const component = createOverlay(
			baseConfig({
				agentModels: { artisan: "test/reasoning" },
				agentThinkingLevels: { artisan: "max" },
			}),
			models,
			(value) => {
				result = value;
			},
		);

		component.handleInput(KEY.down); // artisan
		component.handleInput(KEY.right); // model
		component.handleInput(KEY.enter); // open searchable picker
		for (const width of [1, 8, 36, 80]) {
			for (const line of component.render(width)) {
				assert.ok(visibleWidth(line) <= width, `picker line exceeded ${width}: ${line}`);
			}
		}
		for (const char of "plain") component.handleInput(char);
		assert.match(component.render(80).join("\n"), /filter: plain/);
		component.handleInput(KEY.enter);
		moveToSave(component, 4, 1);

		assert.equal(result?.agentModels.artisan, "test/plain");
		assert.equal(result?.agentThinkingLevels.artisan, "off");
		assert.ok(!("sentinel" in (result?.agentModels ?? {})), "sentinel inheritance must not be persisted");
	});

	it("offers the role default as a thinking choice that clears the override", () => {
		let result: SubagentsConfig | undefined;
		const plain = model("plain", false);
		const component = createOverlay(
			baseConfig({
				agentModels: { artisan: "test/plain" },
				agentThinkingLevels: { artisan: "off" },
			}),
			[plain],
			(value) => {
				result = value;
			},
		);

		component.handleInput(KEY.down); // artisan
		component.handleInput(KEY.right); // model
		component.handleInput(KEY.right); // thinking
		component.handleInput(KEY.enter); // only other semantic choice is role default
		moveToSave(component, 4, 1);

		assert.ok(!("artisan" in (result?.agentThinkingLevels ?? {})));
	});
});

describe("runSetup transaction", () => {
	it("opens one overlay and leaves the file byte-for-byte unchanged on Escape", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-subagents-setup-"));
		const path = join(dir, "pi-subagents.json");
		const original = `${JSON.stringify({
			enabledAgents: ["artisan", "my-custom"],
			agentModels: { artisan: "test/reasoning", "my-custom": "test/plain" },
			agentThinkingLevels: { artisan: "high" },
			maxResultLines: 40,
			agentScope: "user",
			idleTimeoutSec: 90,
			legacyUnknownKey: true,
		}, null, 2)}\n`;
		writeFileSync(path, original, "utf8");
		let customCalls = 0;
		let overlayOptions: unknown;
		const reasoning = model("reasoning", true);
		const context = {
			mode: "tui",
			model: reasoning,
			scopedModels: [],
			modelRegistry: { getAvailable: () => [reasoning, model("plain", false)] },
			ui: {
				notify() {},
				custom: async (factory: Function, options: unknown) => {
					customCalls++;
					overlayOptions = options;
					return new Promise((resolve) => {
						const component = factory(tui, theme, keybindings, resolve) as Component;
						component.handleInput?.(" "); // mutate the draft before cancelling
						component.handleInput?.(KEY.escape);
					});
				},
			},
		} as unknown as ExtensionCommandContext;

		await runSetup(context, path);

		assert.equal(customCalls, 1);
		assert.deepEqual(overlayOptions, {
			overlay: true,
			overlayOptions: { anchor: "center", width: "90%", minWidth: 36, maxHeight: "90%", margin: 1 },
		});
		assert.equal(readFileSync(path, "utf8"), original);
	});

	it("persists the complete draft only from Save & Exit", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-subagents-setup-"));
		const path = join(dir, "pi-subagents.json");
		writeFileSync(path, `${JSON.stringify({
			enabledAgents: ["artisan"],
			knownAgents: ["scout", "artisan", "steward", "sentinel"],
			agentModels: {},
			agentThinkingLevels: {},
			maxResultLines: 40,
			agentScope: "user",
			idleTimeoutSec: 90,
		}, null, 2)}\n`, "utf8");
		const reasoning = model("reasoning", true);
		const context = {
			mode: "tui",
			model: reasoning,
			scopedModels: [],
			modelRegistry: { getAvailable: () => [reasoning] },
			ui: {
				notify() {},
				custom: async (factory: Function) => new Promise((resolve) => {
					const component = factory(tui, theme, keybindings, resolve) as Component;
					component.handleInput?.(" "); // enable scout
					for (let i = 0; i < 4; i++) component.handleInput?.(KEY.down);
					component.handleInput?.(KEY.enter);
				}),
			},
		} as unknown as ExtensionCommandContext;

		await runSetup(context, path);

		const saved = JSON.parse(readFileSync(path, "utf8")) as SubagentsConfig;
		assert.deepEqual(saved.enabledAgents, ["artisan", "scout"]);
		assert.deepEqual(saved.knownAgents, ["scout", "artisan", "steward", "sentinel"]);
	});
});
