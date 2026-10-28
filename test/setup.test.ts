import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { describe, it, type TestContext } from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
	CURSOR_MARKER, KeybindingsManager, TUI_KEYBINDINGS, stripTerminalSequences, visibleWidth, wrapTextWithAnsi,
	type Component, type Focusable, type TUI,
} from "@earendil-works/pi-tui";
import type { SubagentsConfig } from "../src/configuration/config.ts";
import { ensureDefaultConfig, runSetup } from "../src/configuration/setup.ts";
import { promptRoleGrid, promptSelectOne } from "../src/configuration/ui.ts";
import { formatSubagentWidgetLines } from "../src/presentation/widget.ts";
import type { WorkflowRun } from "../src/workflow/state.ts";
// Exercise the installed host's input-dock allocation, including its widget spacer.
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

function hostFrame(editor: Component, width: number, height: number, verdict: "pending" | "failed" = "pending") {
	const work: WorkflowRun["nodes"] = Array.from({ length: 8 }, (_, i) => ({
		id: "step" + i, agent: "artisan", task: "Work " + i, phaseId: "work", cwd: process.cwd(),
		ancestors: [], dependsOn: [], state: "running", startedAt: 1_000,
	}));
	const graph: WorkflowRun = {
		id: 3, name: "auth-fix", slug: "auth-fix", cwd: process.cwd(), state: "running", startedAt: 1_000,
		controller: new AbortController(), nodes: [...work, {
			id: "workflow-acceptance", kind: "acceptance", agent: "sentinel", task: "Required acceptance", phaseId: "acceptance",
			cwd: process.cwd(), ancestors: [], dependsOn: work.map((node) => node.id), state: verdict,
			...(verdict === "failed" ? { error: "Regression check failed" } : {}),
		}],
	};
	const empty = { render: () => [], invalidate() {} };
	const viewport = createChatViewport({
		document: { render: () => ["Transcript"], invalidate() {} }, pendingMessages: empty, status: empty,
		widgetsAbove: { render: (columns) => ["", ...formatSubagentWidgetLines([], [graph], theme, columns, 10_000)], invalidate() {} },
		editor, footer: { render: () => ["project", "model · high"], invalidate() {} }, scrollbar: "hidden",
	});
	return renderLayoutFrame(viewport.root, width, height, () => {}).lines;
}

describe("setup in the fullscreen input dock", () => {
	it("preserves workflow identity and required acceptance while moving between roles and fields", async () => {
		for (const height of [24, 16]) for (const width of [40, 80, 120]) {
			const terminal = { rows: height };
			const context = { mode: "tui", ui: { notify() {}, custom: async (factory: PickerFactory) => new Promise((resolve) => {
				const c = factory({ requestRender() {}, terminal } as TUI, theme, keybindings, resolve);
				for (const role of ["scout", "artisan", "sentinel", "skeptic"]) {
					for (const field of ["Model", "Thinking", "Reset"]) {
						for (const verdict of ["pending", "failed"] as const) {
							const frame = hostFrame(c, width, height, verdict);
							const screen = frame.join("\n");
							assert.match(screen, /#3 · auth-fix/u, `${width}×${height}: workflow identity`);
							assert.match(screen, new RegExp("Acceptance required · " + (verdict === "failed" ? "FAIL" : "pending")), `${width}×${height}: acceptance`);
							assert.ok(screen.includes(`${role} · ${field}`), `${width}×${height}: focused role and field`);
							assert.ok(frame.every((line) => visibleWidth(line) <= width));
						}
						press(c, RIGHT);
					}
					press(c, KEY.down);
				}
				press(c, KEY.escape);
			}) } } as unknown as ExtensionContext;
			await promptRoleGrid(context, ["scout", "artisan", "sentinel", "skeptic"].map((role) => ({
				role, model: "provider/非常长的推理模型-with-vision-and-tools".repeat(3),
				thinking: "off (high requested)", thinkingOverridden: true, description: "Verify implementation. No edits. ".repeat(5),
			})));
		}
	});

	it("pages through full CJK values and descriptions, then reveals the active field after navigation and resize", async () => {
		const modelRef = "provider/非常长的推理模型-with-vision-and-tools".repeat(4);
		const description = "Verify implementation against callers. No edits. ".repeat(8);
		const ansiTheme = { ...theme, fg: (_color: string, text: string) => "\x1b[90m" + text + "\x1b[39m" } as Theme;
		for (const height of [24, 16]) for (const width of [40, 80, 120]) {
			const terminal = { rows: height };
			const context = { mode: "tui", ui: { notify() {}, custom: async (factory: PickerFactory) => new Promise((resolve) => {
				const c = factory({ requestRender() {}, terminal } as TUI, ansiTheme, keybindings, resolve);
				c.render(width);
				press(c, ...Array<string>(40).fill("\x1b[5~"));
				const content: string[] = [];
				let previous = "";
				for (let page = 0; page < 80; page++) {
					const lines = c.render(width);
					assert.ok(lines.length <= Math.max(3, height - 14));
					assert.ok(lines.every((line) => visibleWidth(line) <= width));
					const headerRows = height === 16 ? 1 : 3;
					const footerRows = height === 16 ? 1 : 2;
					const visible = lines.slice(headerRows, -footerRows).map(stripTerminalSequences).join("\n");
					if (visible === previous) break;
					content.push(visible);
					previous = visible;
					assert.match(hostFrame(c, width, height).join("\n"), /Acceptance required · pending/u);
					press(c, KEY.pageDown);
				}
				const text = content.join("\n").replace(/\s+/g, "");
				assert.ok(text.includes(modelRef), `${width}×${height}: complete model is reachable`);
				const detailWidth = width >= 88 ? width - 27 : width;
				const reachedLines = new Set(content.flatMap((page) => page.split("\n")).map((line) => line.trim()));
				assert.ok(wrapTextWithAnsi(description, detailWidth).every((line) => reachedLines.has(line.trim())),
					`${width}×${height}: every description line is reachable`);
				press(c, RIGHT);
				let screen = hostFrame(c, width, height).join("\n");
				assert.match(screen, /sentinel · Thinking/u);
				assert.match(screen, /off \(high requested\)/u);
				if (height === 16) {
					press(c, KEY.pageDown);
					screen = hostFrame(c, width, height).join("\n");
				}
				assert.match(screen, /Source: override/u);
				terminal.rows = 28;
				c.render(120);
				terminal.rows = 24;
				screen = hostFrame(c, 40, 24).join("\n");
				assert.match(screen, /sentinel · Thinking/u);
				assert.match(screen, /off \(high requested\)/u);
				assert.match(screen, /Acceptance required · pending/u);
				press(c, KEY.enter);
			}) } } as unknown as ExtensionContext;
			assert.deepEqual(await promptRoleGrid(context, [
				{ role: "sentinel", model: modelRef, thinking: "off (high requested)", thinkingOverridden: true, description },
			]), { row: 0, column: 1, role: "sentinel", field: "thinking" });
		}
	});

	it("keeps Unicode search and its IME marker visible when the editor slot changes focus", async () => {
		for (const height of [24, 16]) for (const width of [40, 80, 120]) {
			const context = { mode: "tui", ui: { notify() {}, custom: async (factory: PickerFactory) => new Promise((resolve) => {
				const c = factory({ requestRender() {}, terminal: { rows: height } } as TUI, theme, keybindings, resolve);
				const focusable = c as Component & Focusable;
				focusable.focused = true;
				press(c, "\x1b[200~中文模型\x1b[201~");
				let frame = hostFrame(c, width, height);
				assert.match(frame.join("\n"), /Acceptance required · pending/u);
				assert.ok(frame.some((line) => line.includes(CURSOR_MARKER) && line.includes("中文模型")));
				assert.match(frame.join("\n"), /sentinel · Model/u);
				assert.ok(frame.every((line) => visibleWidth(line) <= width));
				focusable.focused = false;
				assert.ok(hostFrame(c, width, height).every((line) => !line.includes(CURSOR_MARKER)));
				focusable.focused = true;
				press(c, "z");
				frame = hostFrame(c, width, height);
				assert.match(frame.join("\n"), /No matches/u);
				assert.match(frame.join("\n"), /Acceptance required · pending/u);
				press(c, "\x7f", KEY.enter);
			}) } } as unknown as ExtensionContext;
			assert.equal(await promptSelectOne(context, "sentinel · Model", "Search capabilities", [
				{ value: "test/zh", label: "provider/中文模型-with-vision-and-reasoning".repeat(3), description: "推理模型 · vision · tools ".repeat(5) },
				{ value: "test/other", label: "Other" },
			]), "test/zh");
		}
	});
});

describe("role grid", () => {
	it("highlights only the field Enter edits across both pane layouts", async () => {
		const highlighted: string[] = [];
		const selectedTheme = { ...theme, underline: (text: string) => { highlighted.push(text); return text; } } as Theme;
		const context = { mode: "tui", ui: {
			notify() {},
			custom: async (factory: PickerFactory) => new Promise((resolve) => {
				const c = factory(tui, selectedTheme, keybindings, resolve);
				for (const [label, field] of [["Model", "Model"], ["Thinking (reasoning effort)", "Thinking"], ["Reset", "Reset"]]) {
					for (const width of [40, 80, 120]) {
						highlighted.length = 0;
						const screen = c.render(width).join("\n");
						assert.deepEqual(highlighted, [field]);
						assert.ok(screen.includes(`scout · ${label}`));
						assert.match(screen, /test\/model/u);
						assert.match(screen, /Source: role default/u);
					}
					if (field !== "Reset") press(c, RIGHT);
				}
				press(c, KEY.enter);
			}),
		} } as unknown as ExtensionContext;
		assert.deepEqual(await promptRoleGrid(context, [{ role: "scout", model: "test/model", thinking: "high", description: "Research" }]), { row: 0, column: 2, role: "scout", field: "reset" });
	});

	it("shows canonical roles with migrated model and thinking preferences side by side", async (t) => {
		const path = await scenario(t, baseConfig({ agentModels: { reviewer: "test/other" }, agentThinkingLevels: { critic: "medium" } }), [{
			title: /Subagents · Roles/u, act(c, screen) {
				assert.match(screen, /Model · Enter edit/u);
				for (const role of ["scout", "artisan", "sentinel", "skeptic"]) assert.match(screen, new RegExp(role));
				assert.doesNotMatch(screen, /reviewer|critic/u);
				press(c, KEY.down, KEY.down);
				assert.match(c.render(120).join("\n"), /sentinel · Model[\s\S]*test\/other[\s\S]*high/u);
				press(c, KEY.down);
				assert.match(c.render(120).join("\n"), /skeptic · Model[\s\S]*Follow main[\s\S]*medium[\s\S]*Source: override \*/u);
				press(c, KEY.escape);
			},
		}]);
		assert.deepEqual(saved(path), baseConfig({ agentModels: { sentinel: "test/other" }, agentThinkingLevels: { skeptic: "medium" } }));
	});

	it("explains implementation verification and named-claim challenges in their selected rows", async (t) => {
		await scenario(t, baseConfig(), [{ title: /Roles/u, act(c) {
			press(c, KEY.down, KEY.down);
			c.render(120);
			press(c, KEY.pageDown);
			const sentinel = c.render(120).join(" ").replace(/\s+/g, " ");
			assert.match(sentinel, /sentinel · Model/u);
			assert.match(sentinel, /implementation or diff against requirements and callers.*defects and regressions/u);
			assert.match(sentinel, /No edits/u);
			press(c, KEY.down);
			c.render(120);
			press(c, KEY.pageDown);
			const skeptic = c.render(120).join(" ").replace(/\s+/g, " ");
			assert.match(skeptic, /skeptic · Model/u);
			assert.match(skeptic, /named claim, design assumption, or review finding.*counterexamples and focused checks/u);
			assert.match(skeptic, /No edits/u);
			press(c, KEY.escape);
		} }]);
	});

	it("edits sentinel model and thinking from one row and keeps the focused cell", async (t) => {
		const path = await scenario(t, baseConfig({ agentModels: { artisan: "test/reasoning" } }), [
			{ title: /Roles/u, act: (c) => press(c, KEY.down, KEY.down, KEY.enter) },
			{ title: /sentinel · Model/u, act: (c) => press(c, "other", KEY.enter) },
			{ title: /Saved sentinel model/u, act(c, screen) {
				assert.match(screen, /sentinel · Model/u);
				assert.match(screen, /test\/other/u);
				assert.match(screen, /Source: role default/u);
				press(c, RIGHT, KEY.enter);
			} },
			{ title: /sentinel · Thinking/u, act: (c) => press(c, "medium", KEY.enter) },
			{ title: /Saved sentinel thinking/u, act(c, screen) {
				assert.match(screen, /sentinel · Thinking/u);
				assert.match(screen, /medium[\s\S]*Source: override \*/u);
				press(c, KEY.escape);
			} },
		]);
		assert.deepEqual(saved(path), baseConfig({ agentModels: { artisan: "test/reasoning", sentinel: "test/other" }, agentThinkingLevels: { sentinel: "medium" } }));
	});

	it("reset lives in its own column and only clears the focused role", async (t) => {
		const path = await scenario(t, baseConfig({ agentModels: { scout: "test/other", skeptic: "test/reasoning" }, agentThinkingLevels: { scout: "high", skeptic: "low" } }), [
			{ title: /Roles/u, act: (c) => press(c, RIGHT, RIGHT, KEY.enter) },
			{ title: /Saved scout defaults/u, act(c, screen) {
				assert.match(screen, /scout · Reset/u);
				assert.match(screen, /Follow main[\s\S]*low[\s\S]*Source: role default/u);
				press(c, KEY.down, KEY.down, KEY.down);
				assert.match(c.render(120).join("\n"), /test\/reasoning[\s\S]*low[\s\S]*Source: override/u);
				press(c, KEY.escape);
			} },
		]);
		assert.deepEqual(saved(path), baseConfig({ agentModels: { skeptic: "test/reasoning" }, agentThinkingLevels: { skeptic: "low" } }));
	});

	it("Esc in a picker keeps the saved value and the focused cell", async (t) => {
		const initial = baseConfig({ agentModels: { scout: "test/other" } });
		const path = await scenario(t, initial, [
			{ title: /Roles/u, act: (c) => press(c, KEY.enter) },
			{ title: /scout · Model/u, act: (c) => press(c, "reasoning", KEY.escape) },
			{ title: /Roles/u, act(c, screen) { assert.match(screen, /scout · Model[\s\S]*test\/other/u); press(c, KEY.escape); } },
		]);
		assert.deepEqual(saved(path), initial);
	});

	it("shows a clamped thinking level without overwriting the preference", async (t) => {
		const path = await scenario(t, baseConfig({ agentThinkingLevels: { scout: "high" } }), [
			{ title: /Roles/u, act(c, screen) { assert.match(screen, /off \(high requested\)[\s\S]*Source: override \*/u); press(c, RIGHT, KEY.enter); } },
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

	it("keeps full selected values and their source readable in a narrow role register", async () => {
		const modelRef = "provider/非常长的推理模型-with-vision-and-tools";
		const context = { mode: "tui", ui: { notify() {}, custom: async (factory: PickerFactory) => new Promise((resolve) => {
			const c = factory(tui, theme, keybindings, resolve);
			for (const width of [40, 80, 120]) {
				const lines = c.render(width);
				assert.ok(lines.every((line) => visibleWidth(line) <= width));
				assert.ok(lines.join("").replace(/\s+/g, "").includes(modelRef));
				assert.match(lines.join("\n"), /off \(high requested\)[\s\S]*Source: override \*/u);
			}
			press(c, KEY.enter);
		}) } } as unknown as ExtensionContext;
		assert.deepEqual(await promptRoleGrid(context, [
			{ role: "sentinel", model: modelRef, thinking: "off (high requested)", thinkingOverridden: true, description: "Verify implementation. No edits." },
		], { column: 1 }), { row: 0, column: 1, role: "sentinel", field: "thinking" });
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

	it("pages by the rendered viewport after a terminal resize", async () => {
		const terminal = { rows: 12 };
		let expectedChoice = "";
		const context = { mode: "tui", ui: { notify() {}, custom: async (factory: PickerFactory) => new Promise((resolve) => {
			const c = factory({ requestRender() {}, terminal } as TUI, theme, keybindings, resolve);
			const first = c.render(40);
			assert.ok(first.length <= terminal.rows);
			const shown = first.filter((line) => /^(?:› |  )Model \d/u.test(line)).length;
			press(c, KEY.pageDown);
			assert.match(c.render(40).join("\n"), new RegExp("› Model " + (10 + shown) + "\\b"));
			terminal.rows = 28;
			const resized = c.render(80);
			assert.ok(resized.length <= terminal.rows - 14);
			const resizedShown = resized.filter((line) => /^(?:› |  )Model \d/u.test(line)).length;
			expectedChoice = String(10 + shown + resizedShown);
			press(c, KEY.pageDown, KEY.enter);
		}) } } as unknown as ExtensionContext;
		const choice = await promptSelectOne(context, "Models", "Search", Array.from({ length: 30 }, (_, index) => ({
			value: String(index), label: "Model " + index, description: "reasoning and vision capabilities ".repeat(6),
		})), "10");
		assert.equal(choice, expectedChoice);
	});

	it("pages, wraps navigation, and starts on the configured value", async () => {
		const context = { mode: "tui", ui: {
			notify() {}, custom: async (factory: PickerFactory) => new Promise((resolve) => {
				const c = factory(tui, theme, keybindings, resolve);
				const first = c.render(80);
				assert.match(first.join("\n"), /› Model 10/u);
				const shown = first.filter((line) => /^(?:› |  )Model \d/u.test(line)).length;
				press(c, KEY.pageDown);
				assert.match(c.render(80).join("\n"), new RegExp("› Model " + (10 + shown) + "\\b"));
				for (let i = 0; i < 20 - (10 + shown); i++) press(c, KEY.down);
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
