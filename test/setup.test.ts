import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";
import { describe, it, type TestContext } from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionCommandContext, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
	KeybindingsManager,
	TUI_KEYBINDINGS,
	type Component,
	type TUI,
} from "@earendil-works/pi-tui";
import type { SubagentsConfig } from "../src/configuration/config.ts";
import { ensureDefaultConfig, runSetup } from "../src/configuration/setup.ts";

const KEY = {
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
		agentModels: {},
		agentThinkingLevels: {},
		...overrides,
	};
}

function writeConfig(config: SubagentsConfig, t: TestContext): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-subagents-setup-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const path = join(dir, "pi-subagents.json");
	writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, "utf8");
	return path;
}

function renderComponent(factory: PickerFactory, done: (value: unknown) => void): Component {
	return factory(tui, theme, keybindings, done) as Component;
}

describe("runSetup menu", () => {
	it("lists the two fixed roles with their current routes, and Esc exits", async (t) => {
		const path = writeConfig(baseConfig({ agentModels: { artisan: "test/reasoning" } }), t);
		const reasoning = model("reasoning");
		let offered: string[] = [];
		const context = {
			mode: "tui",
			model: reasoning,
			scopedModels: [],
			modelRegistry: { getAvailable: () => [reasoning] },
			ui: {
				notify() {},
				select: async (_title: string, options: string[]) => {
					offered = options;
					return undefined;
				},
				custom: async () => {
					throw new Error("no picker should open when Esc leaves the menu");
				},
			},
		} as unknown as ExtensionCommandContext;

		await runSetup(context, path);

		assert.equal(offered.length, 3);
		assert.match(offered[0] ?? "", /^scout — .*thinking: low/u);
		assert.match(offered[0] ?? "", /current main model/u);
		assert.match(offered[1] ?? "", /^artisan — .*model: test\/reasoning.*thinking: high/u);
		assert.match(offered[2] ?? "", /^Both roles/u);
	});

	it("configures one role through model then thinking pickers and saves", async (t) => {
		const path = writeConfig(baseConfig(), t);
		const reasoning = model("reasoning");
		const other = model("other");
		let menuCalls = 0;
		let customCalls = 0;
		const context = {
			mode: "tui",
			cwd: dirname(path),
			model: reasoning,
			scopedModels: [],
			modelRegistry: { getAvailable: () => [reasoning, other] },
			ui: {
				notify() {},
				select: async (_title: string, options: string[]) =>
					menuCalls++ === 0 ? options.find((option) => option.startsWith("scout")) : undefined,
				custom: async (factory: PickerFactory) => new Promise((resolve) => {
					customCalls++;
					const component = renderComponent(factory, resolve);
					if (customCalls === 1) {
						for (const character of "other") component.handleInput?.(character);
					}
					component.handleInput?.(KEY.enter);
				}),
			},
		} as unknown as ExtensionCommandContext;

		await runSetup(context, path);

		assert.equal(customCalls, 2, "model picker then thinking picker");
		const saved = JSON.parse(readFileSync(path, "utf8")) as SubagentsConfig;
		assert.equal(saved.agentModels.scout, "test/other");
		assert.deepEqual(saved.agentThinkingLevels, {}, "the role default stays unwritten");
	});

	it("walks both roles from the Both roles entry", async (t) => {
		const path = writeConfig(baseConfig(), t);
		const reasoning = model("reasoning");
		const titles: string[] = [];
		const context = {
			mode: "tui",
			cwd: dirname(path),
			model: reasoning,
			scopedModels: [],
			modelRegistry: { getAvailable: () => [reasoning] },
			ui: {
				notify() {},
				select: async (_title: string, options: string[]) =>
					options.find((option) => option.startsWith("Both")) ?? options[0],
				custom: async (factory: PickerFactory) => new Promise((resolve) => {
					const component = renderComponent(factory, resolve);
					titles.push(component.render(120)[1] ?? "");
					component.handleInput?.(KEY.enter);
				}),
			},
		} as unknown as ExtensionCommandContext;

		await runSetup(context, path);

		assert.match(titles[0] ?? "", /Model for scout/u);
		assert.match(titles[1] ?? "", /Thinking for scout/u);
		assert.match(titles[2] ?? "", /Model for artisan/u);
		assert.match(titles[3] ?? "", /Thinking for artisan/u);
		const saved = JSON.parse(readFileSync(path, "utf8")) as SubagentsConfig;
		assert.deepEqual(saved, { agentModels: {}, agentThinkingLevels: {} });
	});

	it("ignores stale roles left in an old config file", async (t) => {
		const dir = mkdtempSync(join(tmpdir(), "pi-subagents-setup-"));
		t.after(() => rmSync(dir, { recursive: true, force: true }));
		const path = join(dir, "pi-subagents.json");
		// A pre-simplification file: removed keys and stale role overrides are
		// normalized away on load before the menu ever sees them.
		writeFileSync(path, JSON.stringify({
			enabledAgents: ["scout", "retired-role"],
			agentModels: { "retired-role": "test/reasoning", scout: "test/reasoning" },
			maxConcurrentAgents: 4,
		}), "utf8");
		const reasoning = model("reasoning");
		let offered: string[] = [];
		const context = {
			mode: "tui",
			cwd: dir,
			model: reasoning,
			scopedModels: [],
			modelRegistry: { getAvailable: () => [reasoning] },
			ui: {
				notify() {},
				select: async (_title: string, options: string[]) => {
					offered = options;
					return undefined;
				},
				custom: async () => undefined,
			},
		} as unknown as ExtensionCommandContext;

		await runSetup(context, path);

		assert.equal(offered.length, 3);
		assert.ok(offered.every((option) => !/retired-role/u.test(option)), offered.join("\n"));
	});
});

describe("first install", () => {
	function freshConfigPath(t: TestContext): string {
		const dir = mkdtempSync(join(tmpdir(), "pi-subagents-first-run-"));
		t.after(() => rmSync(dir, { recursive: true, force: true }));
		return join(dir, "pi-subagents.json");
	}

	it("writes the default config once and announces /subagents-setup", async (t) => {
		const path = freshConfigPath(t);
		const notices: string[] = [];
		const context = {
			mode: "tui",
			ui: {
				notify: (message: string) => notices.push(message),
			},
		} as unknown as ExtensionContext;

		await ensureDefaultConfig(context, path);

		const saved = JSON.parse(readFileSync(path, "utf8")) as SubagentsConfig;
		assert.deepEqual(saved, {
			agentModels: {},
			agentThinkingLevels: {},
		}, "no override keeps both roles on the main model");
		assert.equal(notices.length, 1, notices.join("\n"));
		assert.match(notices[0] ?? "", /\/subagents-setup/u);

		await ensureDefaultConfig(context, path);
		assert.equal(notices.length, 1, "the existing file keeps later sessions silent");
	});

	it("asks for each role's thinking level right after its model", async (t) => {
		const path = freshConfigPath(t);
		const reasoning = model("reasoning");
		const notices: string[] = [];
		const titles: string[] = [];
		const context = {
			mode: "tui",
			cwd: dirname(path),
			model: reasoning,
			scopedModels: [],
			modelRegistry: { getAvailable: () => [reasoning] },
			ui: {
				notify: (message: string) => notices.push(message),
				select: async (_title: string, options: string[]) => options[0],
				custom: async (factory: PickerFactory) => new Promise((resolve) => {
					const component = renderComponent(factory, resolve);
					titles.push(component.render(120)[1] ?? "");
					component.handleInput?.(KEY.enter);
				}),
			},
		} as unknown as ExtensionContext;

		await runSetup(context, path);

		assert.match(titles[0] ?? "", /Model for scout/u);
		assert.match(titles[1] ?? "", /Thinking for scout/u);
		assert.match(titles[2] ?? "", /Model for artisan/u);
		assert.match(titles[3] ?? "", /Thinking for artisan/u);
		const saved = JSON.parse(readFileSync(path, "utf8")) as SubagentsConfig;
		assert.deepEqual(saved.agentThinkingLevels, {});
	});
});
