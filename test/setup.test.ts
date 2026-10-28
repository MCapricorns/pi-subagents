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
import { promptRoleGrid, promptSelectOne } from "../src/configuration/ui.ts";

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

const RIGHT = "\x1b[C";

describe("role grid", () => {
	it("aligns headers and highlights the exact field Enter edits", async () => {
		const highlighted: string[] = [];
		const selectedTheme = { ...theme, bg: (_color: string, text: string) => { highlighted.push(text.trim()); return text; } } as Theme;
		const context = { mode: "tui", ui: {
			notify() {},
			custom: async (factory: PickerFactory) => new Promise((resolve) => {
				const c = factory(tui, selectedTheme, keybindings, resolve);
				for (const [field, value] of [["Model", "test/model"], ["Thinking (reasoning effort)", "high"], ["Reset", "reset"]]) {
					highlighted.length = 0;
					const lines = c.render(120);
					const header = lines.find((line) => /Role +Model +Thinking/u.test(line))!;
					const row = lines.find((line) => line.startsWith("› scout"))!;
					assert.equal(header.indexOf("Role"), row.indexOf("scout"));
					assert.equal(header.indexOf("Model"), row.indexOf("test/model"));
					assert.equal(header.indexOf("Thinking"), row.indexOf("high"));
					assert.deepEqual(highlighted, [value]);
					assert.ok(lines.includes(`scout · ${field} · Enter ${field === "Reset" ? "restore defaults" : "edit"}`));
					if (field !== "Reset") press(c, RIGHT);
				}
				press(c, KEY.enter);
			}),
		} } as unknown as ExtensionContext;
		assert.deepEqual(await promptRoleGrid(context, [{ role: "scout", model: "test/model", thinking: "high", description: "Research" }]), { row: 0, column: 2, role: "scout", field: "reset" });
	});

	it("shows every role with model and thinking side by side", async (t) => {
		await scenario(t, baseConfig({ agentModels: { reviewer: "test/other" }, agentThinkingLevels: { critic: "medium" } }), [{
			title: /Subagents · Roles/u, act(c, screen) {
				assert.match(screen, /Role\s+Model\s+Thinking/u);
				for (const role of ["scout", "artisan", "reviewer", "critic"]) assert.match(screen, new RegExp(role));
				assert.match(screen, /reviewer +test\/other +high/u);
				assert.match(screen, /critic +Follow main +medium\*/u);
				press(c, KEY.escape);
			},
		}]);
	});

	it("edits reviewer model and thinking from one row and keeps the focused cell", async (t) => {
		const path = await scenario(t, baseConfig({ agentModels: { artisan: "test/reasoning" } }), [
			{ title: /Roles/u, act: (c) => press(c, KEY.down, KEY.down, KEY.enter) },
			{ title: /reviewer · Model/u, act: (c) => press(c, "other", KEY.enter) },
			{ title: /Saved reviewer model/u, act(c, screen) {
				assert.match(screen, /› reviewer +test\/other +high/u);
				press(c, RIGHT, KEY.enter);
			} },
			{ title: /reviewer · Thinking/u, act: (c) => press(c, "medium", KEY.enter) },
			{ title: /Saved reviewer thinking/u, act(c, screen) {
				assert.match(screen, /reviewer +test\/other +medium\*/u);
				press(c, KEY.escape);
			} },
		]);
		assert.deepEqual(saved(path), baseConfig({ agentModels: { artisan: "test/reasoning", reviewer: "test/other" }, agentThinkingLevels: { reviewer: "medium" } }));
	});

	it("reset lives in its own column and only clears the focused role", async (t) => {
		const path = await scenario(t, baseConfig({ agentModels: { scout: "test/other", critic: "test/reasoning" }, agentThinkingLevels: { scout: "high", critic: "low" } }), [
			{ title: /Roles/u, act: (c) => press(c, RIGHT, RIGHT, KEY.enter) },
			{ title: /Saved scout defaults/u, act(c, screen) {
				assert.match(screen, /› scout +Follow main +low/u);
				assert.match(screen, /critic +test\/reasoning +low\*/u);
				press(c, KEY.escape);
			} },
		]);
		assert.deepEqual(saved(path), baseConfig({ agentModels: { critic: "test/reasoning" }, agentThinkingLevels: { critic: "low" } }));
	});

	it("Esc in a picker keeps the saved value and the focused cell", async (t) => {
		const initial = baseConfig({ agentModels: { scout: "test/other" } });
		const path = await scenario(t, initial, [
			{ title: /Roles/u, act: (c) => press(c, KEY.enter) },
			{ title: /scout · Model/u, act: (c) => press(c, "reasoning", KEY.escape) },
			{ title: /Roles/u, act(c, screen) { assert.match(screen, /› scout +test\/other/u); press(c, KEY.escape); } },
		]);
		assert.deepEqual(saved(path), initial);
	});

	it("shows a clamped thinking level without overwriting the preference", async (t) => {
		const path = await scenario(t, baseConfig({ agentThinkingLevels: { scout: "high" } }), [
			{ title: /Roles/u, act(c, screen) { assert.match(screen, /scout +Follow main +off \(high requested\)\*/u); press(c, RIGHT, KEY.enter); } },
			{ title: /scout · Thinking/u, act(c, screen) { assert.match(screen, /low → off/u); press(c, KEY.escape); } },
			{ title: /Roles/u, act: (c) => press(c, KEY.escape) },
		], [model("plain", false)]);
		assert.equal(saved(path).agentThinkingLevels.scout, "high");
	});

	it("keeps every row inside narrow terminal widths", async (t) => {
		await scenario(t, baseConfig(), [{ title: /Roles/u, act(c) {
			for (const width of [1, 12, 32, 60, 120]) assert.ok(c.render(width).every((line) => visibleWidth(line) <= width));
			press(c, KEY.down, RIGHT, KEY.escape);
		} }]);
	});

	it("fresh-install Esc leaves no config file", async (t) => {
		const path = await scenario(t, undefined, [{ title: /Roles/u, act: (c) => press(c, KEY.escape) }]);
		assert.equal(existsSync(path), false);
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
