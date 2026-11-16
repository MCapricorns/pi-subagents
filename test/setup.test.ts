import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, type TestContext } from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
	CURSOR_MARKER, KeybindingsManager, TUI_KEYBINDINGS, compositeTuiLine, visibleWidth,
	type Component, type Focusable, type OverlayOptions, type TUI,
} from "@earendil-works/pi-tui";
import { DEFAULT_CONFIG, type SubagentsConfig } from "../src/configuration/config.ts";
import { ensureDefaultConfig, runSetup } from "../src/configuration/setup.ts";
import { SETUP_OVERLAY_OPTIONS, promptSettings, promptSelectOne, type SettingsView } from "../src/configuration/ui.ts";
import { emptyUsage } from "../src/execution/run-control.ts";
import type { RunView } from "../src/presentation/monitor.ts";
import { formatSubagentWidgetLines } from "../src/presentation/widget.ts";
// Exercise the installed host's input-dock allocation and overlay compositing.
import { createChatViewport } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/chat-viewport.js";
import { renderLayoutFrame } from "../node_modules/@earendil-works/pi-tui/dist/layout.js";

const KEY = { enter: "\r", escape: "\x1b", down: "\x1b[B", up: "\x1b[A", pageDown: "\x1b[6~" };
const theme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	underline: (text: string) => text,
	bold: (text: string) => text,
} as Theme;
const keybindings = new KeybindingsManager(TUI_KEYBINDINGS);
const tui = { requestRender() {}, terminal: { rows: 28, columns: 120 } } as TUI;
type PickerFactory = (tui: TUI, theme: Theme, kb: KeybindingsManager, done: (value: unknown) => void) => Component;
interface CustomOptions {
	overlay?: boolean;
	blocked?: { kind: string; message: string };
	overlayOptions?: OverlayOptions | (() => OverlayOptions);
}

function model(id: string, reasoning = true): Model<Api> {
	return {
		id, name: id, api: "openai-responses", provider: "test", baseUrl: "https://example.test",
		reasoning, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000, maxTokens: 8_192,
	};
}
function baseConfig(overrides: Partial<SubagentsConfig> = {}): SubagentsConfig {
	return { ...DEFAULT_CONFIG, ...overrides };
}
function settingsView(model = "test/worker"): SettingsView {
	return {
		main: "test/main", status: "Changes save immediately", focus: "researcher.model",
		roles: [
			{ role: "researcher", model, thinking: "high", unavailable: false },
			{ role: "worker", model: "Follow main", thinking: "medium", unavailable: false },
		],
	};
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
	writeFileSync(path, JSON.stringify(initial ?? baseConfig()), "utf8");
	const notices: string[] = [];
	const context = {
		mode: "tui", model: models[0], scopedModels: [], modelRegistry: { getAvailable: () => models },
		ui: {
			notify: (message: string) => notices.push(message),
			custom: async (factory: PickerFactory, options?: CustomOptions) => new Promise((resolve, reject) => {
				try {
					assert.equal(options?.overlay, true, "setup screens must open as standalone overlay panels");
					assert.equal(options?.blocked?.kind, "question");
					assert.deepEqual(options?.overlayOptions, SETUP_OVERLAY_OPTIONS);
					const component = factory(tui, theme, keybindings, resolve);
					const screen = component.render(100).join("\n");
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


function overlayWidth(termWidth: number): number {
	const availWidth = Math.max(1, termWidth - 4);
	const pctWidth = Math.floor(termWidth * 0.86);
	return Math.max(1, Math.min(Math.max(pctWidth, 72), availWidth));
}

function overlayMaxHeight(termHeight: number): number {
	const availHeight = Math.max(1, termHeight - 2);
	return Math.max(6, Math.min(Math.floor(termHeight * 0.88), availHeight));
}

function hostOverlayFrame(overlay: Component, width: number, height: number) {
	const runs: RunView[] = Array.from({ length: 8 }, (_, i) => ({
		id: i + 1, agent: "worker", task: "Work " + i, status: "running",
		usage: emptyUsage(), elapsedMs: 0, startedAt: 1_000, activeSince: 1_000,
	}));
	const empty = { render: () => [], invalidate() {} };
	const viewport = createChatViewport({
		document: { render: () => ["Transcript"], invalidate() {} }, pendingMessages: empty, status: empty,
		widgetsAbove: { render: (columns) => ["", ...formatSubagentWidgetLines(runs, theme, columns, 10_000)], invalidate() {} },
		editor: { render: () => ["> user prompt stays in the editor"], invalidate() {} },
		footer: { render: () => ["project", "model · high"], invalidate() {} }, scrollbar: "hidden",
	});
	const base = renderLayoutFrame(viewport.root, width, height, () => {}).lines;
	const panelWidth = overlayWidth(width);
	const panelLines = overlay.render(panelWidth).slice(0, overlayMaxHeight(height));
	const startRow = Math.max(0, Math.floor((height - panelLines.length) / 2));
	const startCol = Math.max(0, Math.floor((width - panelWidth) / 2));
	const composited = [...base];
	while (composited.length < height) composited.push("");
	for (let i = 0; i < panelLines.length; i++) {
		const row = startRow + i;
		if (row >= 0 && row < composited.length) {
			composited[row] = compositeTuiLine(composited[row] ?? "", panelLines[i]!, startCol, panelWidth, width);
		}
	}
	return { base, panelLines, composited };
}

describe("independent role settings", () => {
	it("edits both roles independently, preserving focus and saved preferences", async (t) => {
		const path = await scenario(t, baseConfig({ researcher: { thinking: "high" } }), [
			{ title: /Subagents/u, act(c, screen) {
				assert.match(screen, /Researcher.*Read-only research/u);
				assert.match(screen, /Worker.*Implementation & checks/u);
				assert.match(screen, /Model.*Follow main/u);
				assert.match(screen, /Thinking.*high/u);
				press(c, KEY.enter);
			} },
			{ title: /Researcher model/u, act: (c) => press(c, "other", KEY.enter) },
			{ title: /Researcher model saved/u, act(c, screen) {
				assert.match(screen, /› Model.*test\/other/u);
				press(c, KEY.down, KEY.enter);
			} },
			{ title: /Researcher thinking/u, act: (c) => press(c, "low", KEY.enter) },
			{ title: /Researcher thinking saved/u, act(c, screen) {
				assert.match(screen, /› Thinking.*low/u);
				press(c, KEY.down, KEY.down, KEY.enter);
			} },
			{ title: /Worker model/u, act: (c) => press(c, "test/reasoning", KEY.enter) },
			{ title: /Worker model saved/u, act: (c) => press(c, KEY.down, KEY.enter) },
			{ title: /Worker thinking/u, act: (c) => press(c, "high", KEY.enter) },
			{ title: /Worker thinking saved/u, act(c, screen) {
				assert.match(screen, /› Thinking.*high/u);
				assert.match(screen, /Model.*test\/other/u);
				press(c, KEY.escape);
			} },
		]);
		assert.deepEqual(saved(path), baseConfig({ researcher: { model: "test/other", thinking: "low" }, worker: { model: "test/reasoning", thinking: "high" } }));
	});

	for (const role of ["researcher", "worker"] as const) {
		it(`cancels model changes and resets only ${role}`, async (t) => {
			const initial = baseConfig({ researcher: { model: "test/other", thinking: "high" }, worker: { model: "test/reasoning", thinking: "low" } });
			const path = await scenario(t, initial, [
				{ title: /Subagents/u, act: (c) => press(c, ...(role === "worker" ? [KEY.down, KEY.down, KEY.down] : []), KEY.enter) },
				{ title: /model/u, act: (c) => press(c, "unmatched", KEY.escape) },
				{ title: /Subagents/u, act: (c) => press(c, KEY.down, KEY.down, KEY.enter) },
				{ title: /defaults restored/u, act(c, screen) {
					assert.match(screen, /Model.*Follow main/u);
					assert.match(screen, /Thinking.*medium/u);
					press(c, KEY.escape);
				} },
			]);
			assert.deepEqual(saved(path), { ...initial, [role]: { thinking: "medium" } });
		});
	}

	it("shows clamped thinking without discarding the saved preference", async (t) => {
		const path = await scenario(t, baseConfig({ researcher: { model: "test/plain", thinking: "high" } }), [{
			title: /Subagents/u, act(c, screen) {
				assert.match(screen, /off \(high requested\)/u);
				press(c, KEY.escape);
			},
		}], [model("plain", false)]);
		assert.equal(saved(path).researcher.thinking, "high");
	});

	it("renders the actual Pi overlay without replacing the input editor", async () => {
		for (const height of [24, 16, 14]) for (const width of [40, 80, 120]) {
			const context = { mode: "tui", ui: { custom: async (factory: PickerFactory, options?: CustomOptions) => new Promise((resolve) => {
				assert.equal(options?.overlay, true);
				assert.equal(options?.blocked?.kind, "question");
				const component = factory({ requestRender() {}, terminal: { rows: height, columns: width } } as TUI, theme, keybindings, resolve);
				const { base, panelLines, composited } = hostOverlayFrame(component, width, height);
				assert.match(base.join("\n"), /user prompt stays in the editor/u);
				assert.match(base.join("\n"), /Subagents.*8 running/u);
				assert.match(panelLines.join("\n"), /Model/u);
				assert.match(panelLines.join("\n"), /Thinking/u);
				assert.match(panelLines.join("\n"), /Reset/u);
				assert.ok(panelLines.every((line) => visibleWidth(line) <= overlayWidth(width)));
				assert.ok(composited.every((line) => visibleWidth(line) <= width));
				assert.ok(component.render(overlayWidth(width)).length <= overlayMaxHeight(height));
				press(component, KEY.escape);
			}) } } as unknown as ExtensionContext;
			await promptSettings(context, settingsView());
		}
	});

	it("keeps long Unicode values accessible when paging and resizing", async () => {
		const terminal = { rows: 16, columns: 40 };
		const ref = "provider/" + "中文模型".repeat(22) + "/end";
		const context = { mode: "tui", ui: { custom: async (factory: PickerFactory) => new Promise((resolve) => {
			const component = factory({ requestRender() {}, terminal } as TUI, theme, keybindings, resolve);
			let rendered = "";
			for (let i = 0; i < 20; i++) {
				const frame = component.render(36);
				assert.ok(frame.every((line) => visibleWidth(line) <= 36));
				assert.ok(frame.length <= overlayMaxHeight(terminal.rows));
				rendered += frame.join("\n");
				press(component, KEY.pageDown);
			}
			assert.match(rendered, /\/end/u);
			terminal.rows = 28;
			press(component, KEY.down);
			assert.match(component.render(80).join("\n"), /› Thinking/u);
			press(component, KEY.enter);
		}) } } as unknown as ExtensionContext;
		assert.equal(await promptSettings(context, settingsView(ref)), "researcher.thinking");
	});
});

describe("searchable picker", () => {
	it("filters pasted Unicode text, supports backspace, and handles no matches", async () => {
		const context = { mode: "tui", ui: {
			notify() {},
			custom: async (factory: PickerFactory, options?: CustomOptions) => new Promise((resolve) => {
				assert.equal(options?.overlay, true);
				const c = factory(tui, theme, keybindings, resolve);
				(c as Component & Focusable).focused = true;
				assert.ok(c.render(40).some((line) => line.includes(CURSOR_MARKER)), "focus reaches the search input for IME placement");
				(c as Component & Focusable).focused = false;
				assert.ok(c.render(40).every((line) => !line.includes(CURSOR_MARKER)));
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

	it("pages by the rendered modal viewport after a terminal resize", async () => {
		const terminal = { rows: 14 };
		let expectedChoice = "";
		const context = { mode: "tui", ui: { notify() {}, custom: async (factory: PickerFactory) => new Promise((resolve) => {
			const c = factory({ requestRender() {}, terminal } as TUI, theme, keybindings, resolve);
			const first = c.render(50);
			assert.ok(first.length <= overlayMaxHeight(terminal.rows));
			const shown = first.filter((line) => /Model \d+\b/u.test(line) && (line.includes("› Model ") || line.includes("  Model "))).length;
			press(c, KEY.pageDown);
			assert.match(c.render(50).join("\n"), new RegExp("› Model " + (10 + shown) + "\\b"));
			terminal.rows = 28;
			const resized = c.render(80);
			assert.ok(resized.length <= overlayMaxHeight(terminal.rows));
			const resizedShown = resized.filter((line) => /Model \d+\b/u.test(line) && (line.includes("› Model ") || line.includes("  Model "))).length;
			expectedChoice = String(10 + shown + resizedShown);
			press(c, KEY.pageDown, KEY.enter);
		}) } } as unknown as ExtensionContext;
		const choice = await promptSelectOne(context, "Models", "Search", Array.from({ length: 35 }, (_, index) => ({
			value: String(index), label: "Model " + index, description: "reasoning and vision capabilities ".repeat(6),
		})), "10");
		assert.equal(choice, expectedChoice);
	});

	it("pages, wraps navigation, and starts on the configured value", async () => {
		const context = { mode: "tui", ui: {
			notify() {}, custom: async (factory: PickerFactory) => new Promise((resolve) => {
				const c = factory(tui, theme, keybindings, resolve);
				const first = c.render(80);
				assert.match(first.join("\n"), /› Model 10\b/u);
				const shown = first.filter((line) => /Model \d+\b/u.test(line) && (line.includes("› Model ") || line.includes("  Model "))).length;
				press(c, KEY.pageDown);
				assert.match(c.render(80).join("\n"), new RegExp("› Model " + (10 + shown) + "\\b"));
				for (let i = 0; i < 25 - (10 + shown); i++) press(c, KEY.down);
				assert.match(c.render(80).join("\n"), /› Model 0\b/u);
				press(c, KEY.up, KEY.enter);
			}),
		} } as unknown as ExtensionContext;
		assert.equal(await promptSelectOne(context, "Models", "", Array.from({ length: 25 }, (_, i) => ({ value: String(i), label: "Model " + i })), "10"), "24");
	});
});

describe("first install", () => {
	it("resets legacy config once and tells the user how to configure the worker", async (t) => {
		const path = freshConfigPath(t);
		writeFileSync(path, JSON.stringify({ agentModels: { worker: "test/old" }, agentThinkingLevels: { worker: "max" } }));
		const notices: string[] = [];
		const context = { ui: { notify: (message: string) => notices.push(message) } } as unknown as ExtensionContext;
		await ensureDefaultConfig(context, path);
		assert.ok(existsSync(path));
		assert.deepEqual(saved(path), baseConfig());
		assert.match(notices[0]!, /overwrote the old config.*independent role settings.*\/subagents-setup/u);
		await ensureDefaultConfig(context, path);
		assert.equal(notices.length, 1);
	});

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
