import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { describe, it, type TestContext } from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
	KeybindingsManager, TUI_KEYBINDINGS, visibleWidth,
	type Component, type Focusable, type TUI,
} from "@earendil-works/pi-tui";
import type { SubagentsConfig } from "../src/configuration/config.ts";
import { ensureDefaultConfig, runSetup } from "../src/configuration/setup.ts";
import { promptSelectOne } from "../src/configuration/ui.ts";

const KEY = { enter: "\r", escape: "\x1b", down: "\x1b[B", up: "\x1b[A", pageDown: "\x1b[6~" };
const theme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as Theme;
const keybindings = new KeybindingsManager(TUI_KEYBINDINGS);
const tui = { requestRender() {}, terminal: { rows: 28 } } as TUI;
type PickerFactory = (tui: TUI, theme: Theme, kb: KeybindingsManager, done: (value: unknown) => void) => Component;

function model(id: string, reasoning = true): Model<Api> {
	return {
		id, name: id, api: "openai-responses", provider: "test", baseUrl: "https://example.test",
		reasoning, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000, maxTokens: 8_192,
	};
}
function baseConfig(overrides: Partial<SubagentsConfig> = {}): SubagentsConfig {
	return { agentModels: {}, agentThinkingLevels: {}, ...overrides };
}
function freshConfigPath(t: TestContext): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-subagents-setup-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	return join(dir, "pi-subagents.json");
}
function saved(path: string): SubagentsConfig { return JSON.parse(readFileSync(path, "utf8")); }
function press(component: Component, ...keys: string[]) {
	for (const key of keys) component.handleInput?.(key);
}
interface Step {
	title: RegExp;
	act: (component: Component, screen: string) => void;
}
async function scenario(t: TestContext, initial: SubagentsConfig | undefined, steps: Step[], models = [model("reasoning"), model("other")]) {
	const path = freshConfigPath(t);
	if (initial) writeFileSync(path, JSON.stringify(initial), "utf8");
	const notices: string[] = [];
	const context = {
		mode: "tui", model: models[0], scopedModels: [], modelRegistry: { getAvailable: () => models },
		ui: {
			notify: (message: string) => notices.push(message),
			custom: async (factory: PickerFactory) => new Promise((resolve, reject) => {
				try {
					const component = factory(tui, theme, keybindings, resolve);
					const screen = component.render(120).join("\n");
					const step = steps.shift();
					assert.ok(step, "unexpected screen: " + screen);
					assert.match(screen, step.title);
					step.act(component, screen);
				} catch (error) { reject(error); }
			}),
		},
	} as unknown as ExtensionContext;
	await runSetup(context, path);
	assert.deepEqual(notices, [], notices.join("\n"));
	assert.equal(steps.length, 0, "all expected screens must open");
	return path;
}
const close: Step = { title: /Subagents · Settings/u, act: (c) => press(c, KEY.escape) };

describe("role settings panel", () => {
	it("groups roles and separates model, thinking, and reset actions", async (t) => {
		await scenario(t, baseConfig({ agentModels: { artisan: "test/reasoning" } }), [{
			title: /Subagents · Settings/u,
			act(c, screen) {
				assert.match(screen, /scout · Research · read-only/u);
				assert.match(screen, /artisan · Engineering/u);
				assert.match(screen, /Model +Follow main/u);
				assert.match(screen, /Model +test\/reasoning/u);
				assert.match(screen, /Thinking +low · role default/u);
				assert.match(screen, /Thinking +high · role default/u);
				assert.equal(screen.split("Reset role").length - 1, 2);
				press(c, KEY.escape);
			},
		}]);
	});

	it("edits only the model, keeps thinking, and restores focus with saved feedback", async (t) => {
		const path = await scenario(t, baseConfig({ agentThinkingLevels: { scout: "high" } }), [
			{ title: /Settings/u, act: (c) => press(c, KEY.enter) },
			{ title: /scout · Model/u, act: (c) => press(c, "other", KEY.enter) },
			{ title: /Saved scout model/u, act(c, screen) {
				assert.match(screen, /› Model +test\/other/u);
				assert.match(screen, /high · override/u);
				press(c, KEY.escape);
			} },
		]);
		assert.deepEqual(saved(path), baseConfig({ agentModels: { scout: "test/other" }, agentThinkingLevels: { scout: "high" } }));
	});

	it("edits thinking directly without walking the model picker", async (t) => {
		const path = await scenario(t, baseConfig(), [
			{ title: /Settings/u, act: (c) => press(c, KEY.down, KEY.enter) },
			{ title: /scout · Thinking/u, act: (c) => press(c, "high", KEY.enter) },
			close,
		]);
		assert.equal(saved(path).agentThinkingLevels.scout, "high");
		assert.deepEqual(saved(path).agentModels, {});
	});

	it("offers an explicit role default that clears a thinking override", async (t) => {
		const path = await scenario(t, baseConfig({ agentThinkingLevels: { scout: "high" } }), [
			{ title: /Settings/u, act: (c) => press(c, KEY.down, KEY.enter) },
			{ title: /scout · Thinking/u, act: (c) => press(c, "Role default", KEY.enter) },
			close,
		]);
		assert.deepEqual(saved(path).agentThinkingLevels, {});
	});

	it("Esc from a picker returns without changing the saved config", async (t) => {
		const initial = baseConfig({ agentModels: { scout: "test/reasoning" } });
		const path = await scenario(t, initial, [
			{ title: /Settings/u, act: (c) => press(c, KEY.enter) },
			{ title: /scout · Model/u, act: (c) => press(c, "other", KEY.escape) },
			close,
		]);
		assert.deepEqual(saved(path), initial);
	});

	it("restores one role's defaults and preserves the other role", async (t) => {
		const path = await scenario(t, baseConfig({
			agentModels: { scout: "test/other", artisan: "test/reasoning" },
			agentThinkingLevels: { scout: "high", artisan: "low" },
		}), [
			{ title: /Settings/u, act: (c) => press(c, KEY.down, KEY.down, KEY.enter) }, close,
		]);
		assert.deepEqual(saved(path), baseConfig({ agentModels: { artisan: "test/reasoning" }, agentThinkingLevels: { artisan: "low" } }));
	});

	it("shows effective thinking when the model cannot reason", async (t) => {
		const path = await scenario(t, baseConfig({ agentThinkingLevels: { scout: "high" } }), [{
			title: /Settings/u, act(c, screen) {
				assert.match(screen, /off · override \(high requested\)/u);
				assert.match(screen, /off · role default \(high requested\)/u);
				press(c, KEY.down, KEY.enter);
			},
		}, {
			title: /scout · Thinking/u, act(c, screen) {
				assert.match(screen, /Role default/u);
				assert.match(screen, /low → off/u);
				assert.doesNotMatch(screen, /^\s*high$/mu);
				press(c, KEY.escape);
			},
		}, close], [model("plain", false)]);
		assert.equal(saved(path).agentThinkingLevels.scout, "high", "viewing clamped levels must not rewrite preferences");
	});

	it("identifies unavailable model overrides and the actual main fallback", async (t) => {
		await scenario(t, baseConfig({ agentModels: { scout: "test/missing" } }), [{
			title: /Settings/u, act(c, screen) {
				assert.match(screen, /test\/missing \(unavailable\)/u);
				assert.match(screen, /Unavailable selection; using main/u);
				assert.match(screen, /Main: test\/reasoning/u);
				press(c, KEY.escape);
			},
		}]);
	});

	it("opens the same panel on a fresh install and saves only a chosen field", async (t) => {
		const path = await scenario(t, undefined, [
			{ title: /Settings/u, act: (c) => press(c, KEY.enter) },
			{ title: /scout · Model/u, act: (c) => press(c, KEY.enter) }, close,
		]);
		assert.deepEqual(saved(path), baseConfig());
	});

	it("fresh-install Esc leaves no config file", async (t) => {
		const path = await scenario(t, undefined, [close]);
		assert.equal(existsSync(path), false);
	});

	it("keeps focus visible and lines within narrow terminal widths", async (t) => {
		await scenario(t, baseConfig(), [{ title: /Settings/u, act(c) {
			press(c, KEY.down, KEY.down, KEY.down, KEY.down);
			for (const width of [1, 12, 32, 60, 120]) {
				const lines = c.render(width);
				assert.ok(lines.every((line) => visibleWidth(line) <= width), "overflow at " + width);
				if (width >= 32) assert.match(lines.join("\n"), /› Thinking/u);
			}
			press(c, KEY.escape);
		} }]);
	});
});

describe("searchable picker", () => {
	it("filters pasted Unicode text, supports backspace, and handles no matches", async () => {
		const context = { mode: "tui", ui: {
			notify() {},
			custom: async (factory: PickerFactory) => new Promise((resolve) => {
				const c = factory(tui, theme, keybindings, resolve);
				(c as Component & Focusable).focused = true;
				press(c, "\x1b[200~中文模型\x1b[201~");
				assert.match(c.render(80).join("\n"), /1\/1 matches/u);
				press(c, "z");
				assert.match(c.render(80).join("\n"), /No matches/u);
				press(c, "\x7f");
				for (const width of [1, 16, 40, 80]) assert.ok(c.render(width).every((line) => visibleWidth(line) <= width));
				press(c, KEY.enter);
			}),
		} } as unknown as ExtensionContext;
		const choice = await promptSelectOne(context, "Models", "Search", [
			{ value: "test/zh", label: "中文模型", description: "reasoning · vision" },
			{ value: "test/other", label: "Other" },
		]);
		assert.equal(choice, "test/zh");
	});

	it("pages, wraps navigation, and starts on the configured value", async () => {
		const context = { mode: "tui", ui: {
			notify() {}, custom: async (factory: PickerFactory) => new Promise((resolve) => {
				const c = factory(tui, theme, keybindings, resolve);
				assert.match(c.render(80).join("\n"), /› Model 10/u);
				press(c, KEY.pageDown);
				assert.match(c.render(80).join("\n"), /› Model 18/u);
				press(c, KEY.down, KEY.down);
				assert.match(c.render(80).join("\n"), /› Model 0/u);
				press(c, KEY.up, KEY.enter);
			}),
		} } as unknown as ExtensionContext;
		assert.equal(await promptSelectOne(context, "Models", "", Array.from({ length: 20 }, (_, i) => ({ value: String(i), label: "Model " + i })), "10"), "19");
	});
});

describe("first install", () => {
	it("writes defaults once and announces /subagents-setup", async (t) => {
		const path = freshConfigPath(t);
		const notices: string[] = [];
		const context = { mode: "tui", ui: { notify: (message: string) => notices.push(message) } } as unknown as ExtensionContext;
		await ensureDefaultConfig(context, path);
		assert.deepEqual(saved(path), baseConfig());
		assert.equal(notices.length, 1);
		assert.match(notices[0]!, /\/subagents-setup/u);
		await ensureDefaultConfig(context, path);
		assert.equal(notices.length, 1);
	});

	it("reports the TUI requirement without opening a custom screen in RPC", async () => {
		const notices: string[] = [];
		const context = { mode: "rpc", ui: { notify: (message: string) => notices.push(message) } } as unknown as ExtensionContext;
		await runSetup(context);
		assert.match(notices[0]!, /requires Pi's interactive TUI/u);
	});
});
