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
	type Component,
	type TUI,
} from "@earendil-works/pi-tui";
import type { SubagentsConfig } from "../src/config.ts";
import { runSetup } from "../src/setup.ts";

const KEY = {
	down: "\x1b[B",
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
type PickerFactory = (
	tui: TUI,
	theme: Theme,
	keybindings: KeybindingsManager,
	done: (value: unknown) => void,
) => Component;


function model(id: string, reasoning = true): Model<Api> {
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
		enabledAgents: ["scout", "artisan", "steward"],
		knownAgents: ["scout", "artisan", "steward"],
		agentModels: {},
		agentThinkingLevels: {},
		maxResultLines: 40,
		agentScope: "user",
		idleTimeoutSec: 90,
		...overrides,
	};
}

function writeConfig(config: SubagentsConfig): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-subagents-setup-"));
	const path = join(dir, "pi-subagents.json");
	writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, "utf8");
	return path;
}

function renderComponent(factory: PickerFactory, done: (value: unknown) => void): Component {
	return factory(tui, theme, keybindings, done) as Component;
}

describe("runSetup menu", () => {
	it("opens the Git-era settings menu instead of a grid overlay", async () => {
		const path = writeConfig(baseConfig());
		const reasoning = model("reasoning");
		let selectCalls = 0;
		let customCalls = 0;
		const context = {
			mode: "tui",
			model: reasoning,
			scopedModels: [],
			modelRegistry: { getAvailable: () => [reasoning] },
			ui: {
				notify() {},
				select: async (title: string) => {
					selectCalls++;
					assert.equal(title, "pi-subagents settings");
					return undefined;
				},
				custom: async () => {
					customCalls++;
					return undefined;
				},
			},
		} as unknown as ExtensionCommandContext;

		await runSetup(context, path);

		assert.equal(selectCalls, 1);
		assert.equal(customCalls, 0);
	});

	it("configures a custom role through the nested fuzzy model picker", async () => {
		const path = writeConfig(baseConfig({
			enabledAgents: ["scout", "artisan", "steward", "custom-worker"],
			knownAgents: ["scout", "artisan", "steward", "custom-worker"],
			agentModels: { "custom-worker": "test/reasoning" },
		}));
		const reasoning = model("reasoning");
		const other = model("other");
		let menuCall = 0;
		let customCall = 0;
		const context = {
			mode: "tui",
			model: reasoning,
			scopedModels: [],
			modelRegistry: { getAvailable: () => [reasoning, other] },
			ui: {
				notify() {},
				select: async (_title: string, options: string[]) => {
					if (menuCall++ > 0) return undefined;
					return options.find((option) => option.startsWith("Configure"));
				},
				custom: async (factory: PickerFactory) => new Promise((resolve) => {
					const component = renderComponent(factory, resolve);
					customCall++;
					if (customCall === 1) {
						for (let index = 0; index < 3; index++) component.handleInput?.(KEY.down);
						assert.match(component.render(120).join("\n"), /custom-worker \(custom\)/);
						component.handleInput?.(KEY.enter);
					} else if (customCall === 2) {
						const initialDisplay = component.render(120).join("\n");
						assert.match(initialDisplay, /Current main model \(dynamic\)/);
						for (const character of "other") component.handleInput?.(character);
						assert.match(component.render(120).join("\n"), /filter: other/);
						component.handleInput?.(KEY.enter);
					} else if (customCall === 3) {
						component.handleInput?.(KEY.enter);
					} else {
						component.handleInput?.(KEY.escape);
					}
				}),
			},
		} as unknown as ExtensionCommandContext;

		await runSetup(context, path);

		const saved = JSON.parse(readFileSync(path, "utf8")) as SubagentsConfig;
		assert.equal(customCall, 4);
		assert.equal(saved.agentModels["custom-worker"], "test/other");
		assert.ok(!("custom-worker" in saved.agentThinkingLevels));
	});

	it("keeps disabled custom agents visible in the enable menu", async () => {
		const path = writeConfig(baseConfig({
			knownAgents: ["scout", "artisan", "steward", "dormant-custom"],
		}));
		const reasoning = model("reasoning");
		let customDisplay = "";
		const context = {
			mode: "tui",
			model: reasoning,
			scopedModels: [],
			modelRegistry: { getAvailable: () => [reasoning] },
			ui: {
				notify() {},
				select: async (_title: string, options: string[]) =>
					options.find((option) => option.startsWith("Enable")),
				custom: async (factory: PickerFactory) => new Promise((resolve) => {
					const component = renderComponent(factory, resolve);
					customDisplay = component.render(120).join("\n");
					for (let index = 0; index < 3; index++) component.handleInput?.(KEY.down);
					component.handleInput?.(" ");
					component.handleInput?.(KEY.enter);
				}),
			},
		} as unknown as ExtensionCommandContext;

		await runSetup(context, path);

		const saved = JSON.parse(readFileSync(path, "utf8")) as SubagentsConfig;
		assert.match(customDisplay, /dormant-custom \(custom\)/);
		assert.ok(saved.enabledAgents.includes("dormant-custom"));
		assert.ok(saved.knownAgents.includes("dormant-custom"));
	});
});
