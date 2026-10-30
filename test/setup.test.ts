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
import { promptMenu, promptSelectOne } from "../src/configuration/ui.ts";
import { buildModelPickerItems } from "../src/configuration/models.ts";
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
	act: (component: Component, screen: string, path: string) => void;
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
					step.act(component, screen, path);
				} catch (error) { reject(error); }
			}),
		},
	} as unknown as ExtensionContext;
	await runSetup(context, path);
	assert.deepEqual(notices, [], notices.join("\n"));
	assert.equal(steps.length, 0, "all expected screens must open");
	return path;
}

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


/** All callbacks are synchronous so failures reject custom(), rather than hang. */
function pickerContext(height: number, act: (c: Component) => void, terminal = { rows: height }, activeTheme = theme): ExtensionContext {
	return { mode: "tui", ui: { notify() {}, custom: async (factory: PickerFactory) => new Promise((resolve, reject) => {
		try { act(factory({ requestRender() {}, terminal } as TUI, activeTheme, keybindings, resolve)); }
		catch (error) { reject(error); }
	}) } } as unknown as ExtensionContext;
}
const choices = Array.from({ length: 30 }, (_, i) => ({
	value: String(i), label: "Model " + i + " · provider", description: "Reference: provider/model-" + i + ". " + "vision and reasoning capabilities ".repeat(8),
}));

function assertFrame(c: Component, width: number, height: number) {
	for (const verdict of ["pending", "failed"] as const) {
		const frame = hostFrame(c, width, height, verdict);
		const screen = frame.join("\n");
		assert.match(screen, /#3 · auth-fix/u, width + "×" + height + ": workflow identity");
		assert.match(screen, new RegExp("Acceptance required · " + (verdict === "failed" ? "FAIL" : "pending")));
		assert.ok(frame.every((line) => visibleWidth(line) <= width));
	}
	const lines = c.render(width);
	assert.ok(lines.length <= Math.max(3, height - 14));
	assert.ok(lines.every((line) => visibleWidth(line) <= width));
	return lines;
}

describe("setup in the fullscreen input dock", () => {
	it("prioritizes at least five model choices with controls visible at 24 and 28 rows", async () => {
		for (const height of [24, 28]) for (const width of [40, 80, 120]) {
			await promptSelectOne(pickerContext(height, (c) => {
				const lines = assertFrame(c, width, height);
				assert.ok(lines.filter((line) => /^(?:› |  )Model \d/u.test(line)).length >= 5, lines.join("\n"));
				assert.match(lines.join("\n"), /Enter select · Esc back/u);
				assert.match(lines.join("\n"), /PgUp\/Dn · Tab details/u);
				assert.match(lines.join("\n"), /Model 10 · provider \[saved\]/u);
				press(c, KEY.down);
				const moved = assertFrame(c, width, height).join("\n");
				assert.match(moved, /  Model 10 · provider \[saved\]/u);
				assert.match(moved, /› Model 11 · provider/u);
				assert.doesNotMatch(moved, /› Model 11 · provider \[saved\]/u);
				press(c, KEY.escape);
			}), "sentinel · Model", "Choose a model", choices, "10");
		}
	});

	it("keeps linear role and setting lists, focused rows, and acceptance visible", async () => {
		for (const height of [16, 24, 28]) for (const width of [40, 80, 120]) {
			for (const [title, items] of [
				["Subagents · Roles", ["scout", "artisan", "sentinel", "skeptic"]],
				["sentinel · Settings", ["Model", "Thinking", "Reset defaults"]],
			] as const) {
				await promptMenu(pickerContext(height, (c) => {
					for (const item of items) {
						const lines = assertFrame(c, width, height);
						assert.match(lines.join("\n"), new RegExp("› " + item));
						if (height >= 24) for (const label of items) assert.ok(lines.some((line) => line.includes(label)));
						press(c, KEY.down);
					}
					press(c, KEY.escape);
				}), title, "Changes save immediately", items.map((label) => ({ value: label, label, description: "Full setting details" })));
			}
		}
	});

	it("makes complete CJK references and long descriptions reachable by paging details at every size", async () => {
		const ref = "provider/非常长的推理模型-with-vision-and-tools".repeat(4);
		const description = "Verify implementation against callers. No edits. ".repeat(8) + "End of description.";
		const ansiTheme = { ...theme, fg: (_color: string, text: string) => "\x1b[90m" + text + "\x1b[39m" } as Theme;
		for (const height of [16, 24, 28]) for (const width of [40, 80, 120]) {
			const terminal = { rows: height };
			await promptSelectOne(pickerContext(height, (c) => {
				c.render(width);
				press(c, "\t");
				const pages: string[] = [];
				for (let page = 0; page < 100; page++) {
					const lines = assertFrame(c, width, height).map(stripTerminalSequences);
					const body = lines.slice(1, height < 20 ? -1 : -2).join("\n");
					if (body === pages.at(-1)) break;
					pages.push(body);
					press(c, KEY.pageDown);
				}
				const reached = pages.join("").replace(/\s+/gu, "");
				assert.ok(reached.includes(ref), "complete model reference is reachable");
				const reachedLines = new Set(pages.flatMap((page) => page.split("\n")).map((line) => line.trim()));
				assert.ok(wrapTextWithAnsi(ref + "\n" + description, width).every((line) => reachedLines.has(line.trim())),
					width + "×" + height + ": every detail line is reachable, including the final page");
				terminal.rows = 28;
				assertFrame(c, 120, 28);
				press(c, "\t", KEY.down);
				assert.match(c.render(120).map(stripTerminalSequences).join("\n"), /› Other/u);
				terminal.rows = height;
				assertFrame(c, width, height);
				press(c, KEY.enter);
			}, terminal, ansiTheme), "sentinel · Model", "", [
				{ value: "long", label: "Friendly model · provider", description: ref + "\n" + description },
				{ value: "other", label: "Other" },
			]);
		}
	});

	it("preserves Unicode paste and IME focus, empty results, and narrow width safety", async () => {
		for (const height of [16, 24, 28]) for (const width of [40, 80, 120]) {
			const result = await promptSelectOne(pickerContext(height, (c) => {
				const focusable = c as Component & Focusable;
				focusable.focused = true;
				press(c, "\x1b[200~中文模型\x1b[201~");
				let frame = hostFrame(c, width, height);
				assert.ok(frame.some((line) => line.includes(CURSOR_MARKER) && line.includes("中文模型")));
				assertFrame(c, width, height);
				focusable.focused = false;
				assert.ok(hostFrame(c, width, height).every((line) => !line.includes(CURSOR_MARKER)));
				focusable.focused = true;
				press(c, "\t");
				assert.ok(c.render(width).every((line) => !line.includes(CURSOR_MARKER)));
				press(c, "\t", "z");
				assert.match(c.render(width).join("\n"), /No matches/u);
				press(c, KEY.enter); // An empty result must not confirm or close.
				assertFrame(c, width, height);
				press(c, "\x7f");
				for (const narrow of [1, 2, 12, 32]) {
					const lines = c.render(narrow);
					assert.ok(lines.length <= Math.max(3, height - 14));
					assert.ok(lines.every((line) => visibleWidth(line) <= narrow));
				}
				press(c, KEY.enter);
			}), "sentinel · Model", "Search", [
				{ value: "test/zh", label: "中文模型 · provider", description: "reasoning · vision" },
				{ value: "test/other", label: "Other" },
			]);
			assert.equal(result, "test/zh");
		}
	});

	it("pages by the rendered list after resizing, wraps navigation, and restores the saved choice", async () => {
		const terminal = { rows: 16 };
		let expected = 0;
		const result = await promptSelectOne(pickerContext(16, (c) => {
			const first = c.render(40);
			assert.match(first.join("\n"), /› Model 10/u);
			const shown = first.filter((line) => /^(?:› |  )Model \d/u.test(line)).length;
			press(c, KEY.pageDown);
			assert.match(c.render(40).join("\n"), new RegExp("› Model " + (10 + shown) + "\\b"));
			terminal.rows = 28;
			const resized = c.render(80);
			const resizedShown = resized.filter((line) => /^(?:› |  )Model \d/u.test(line)).length;
			expected = 10 + shown + resizedShown;
			press(c, KEY.pageDown);
			assert.match(c.render(80).join("\n"), new RegExp("› Model " + expected + "\\b"));
			press(c, ...Array<string>(30 - expected).fill(KEY.down));
			assert.match(c.render(80).join("\n"), /› Model 0\b/u);
			press(c, KEY.up, KEY.enter);
		}, terminal), "Models", "", choices, "10");
		assert.equal(result, "29");
	});

	it("Esc from details restores the filtered list and IME focus without resolving the picker", async () => {
		let resolutions = 0;
		const context = pickerContext(24, (c) => {
			(c as Component & Focusable).focused = true;
			press(c, "中文", "\t");
			assert.match(c.render(40).join("\n"), /Details/u);
			press(c, KEY.escape);
			const list = c.render(40);
			assert.equal(resolutions, 0);
			assert.doesNotMatch(list.join("\n"), /Details/u);
			assert.ok(list.some((line) => line.includes(CURSOR_MARKER) && line.includes("中文")));
			assert.match(list.join("\n"), /1\/1 · PgUp\/Dn/u);
			press(c, KEY.enter);
		});
		const originalCustom = context.ui.custom;
		context.ui.custom = ((factory) => originalCustom((tui, theme, kb, done) => factory(tui, theme, kb, (value) => {
			resolutions++;
			done(value);
		}))) as typeof context.ui.custom;
		assert.equal(await promptSelectOne(context, "Models", "", [
			{ value: "zh", label: "中文模型" }, { value: "other", label: "Other" },
		]), "zh");
		assert.equal(resolutions, 1);
	});

	it("searches exact references and capabilities behind friendly names, including provider aliases", async () => {
		const models = [
			{ ...model("deployment-one"), provider: "azure", name: "Friendly Model" },
			{ ...model("deployment-two"), provider: "proxy", name: "Friendly Model", input: ["text", "image"] as ("text" | "image")[] },
		];
		const items = buildModelPickerItems({ models, configuredRef: "azure-openai-responses/deployment-one" });
		assert.equal(await promptSelectOne(pickerContext(24, (c) => {
			const screen = c.render(40).join("\n");
			assert.match(screen, /› Friendly Model · azure \[saved\]/u);
			press(c, "proxy/deployment-two");
			assert.match(c.render(40).join("\n"), /› Friendly Model · proxy/u);
			press(c, "\t");
			assert.match(c.render(40).join("\n"), /Reference: proxy\/deployment-two/u);
			press(c, KEY.escape, KEY.enter);
		}), "Models", "", items, "azure-openai-responses/deployment-one"), "proxy/deployment-two");
		assert.equal(await promptSelectOne(pickerContext(24, (c) => {
			press(c, "vision");
			assert.match(c.render(40).join("\n"), /› Friendly Model · proxy/u);
			press(c, KEY.enter);
		}), "Models", "", items), "proxy/deployment-two");
	});

	it("marks clipped previews with an ellipsis while keeping the full description in details", async () => {
		const description = "Uses the main window's model, including future changes. No model is pinned. ".repeat(6) + "Complete ending.";
		for (const width of [40, 80]) {
			await promptSelectOne(pickerContext(28, (c) => {
				const lines = c.render(width);
				assert.match(stripTerminalSequences(lines.at(-3) ?? ""), /…$/u);
				assert.ok(lines.every((line) => visibleWidth(line) <= width));
				press(c, "\t", KEY.pageDown);
				assert.match(c.render(width).join("\n"), /Complete ending\./u);
				press(c, KEY.escape, KEY.escape);
			}), "Models", "", [{ value: "dynamic", label: "Follow main (dynamic)", description }]);
		}
	});

	it("handles an empty catalog with a visible recovery message and Esc", async () => {
		assert.equal(await promptSelectOne(pickerContext(24, (c) => {
			assert.match(c.render(40).join("\n"), /No choices available/u);
			press(c, KEY.down, KEY.pageDown, KEY.enter, KEY.escape);
		}), "Models", "", []), undefined);
	});
});

describe("linear setup flow", () => {
	it("opens settings with up/down and Enter, saves immediately, and restores role and setting focus", async (t) => {
		const initial = baseConfig({ agentModels: { artisan: "test/reasoning" } });
		const path = await scenario(t, initial, [
			{ title: /Subagents · Roles/u, act(c, screen) {
				for (const role of ["scout", "artisan", "sentinel", "skeptic"]) assert.ok(screen.includes(role));
				press(c, KEY.down, KEY.down, KEY.enter);
			} },
			{ title: /sentinel · Settings/u, act(c, screen) {
				assert.match(screen, /› Model: Follow main/u);
				assert.match(screen, /Choose a setting · Changes save immediately/u);
				assert.doesNotMatch(screen, /Choose a role/u);
				assert.match(screen, /Thinking: high · role default/u);
				assert.match(screen, /Reset defaults/u);
				press(c, KEY.enter);
			} },
			{ title: /sentinel · Model/u, act: (c) => press(c, "other", KEY.enter) },
			{ title: /Saved sentinel model/u, act(c, screen, path) {
				assert.match(screen, /› Model: other · test/u);
				assert.equal(saved(path).agentModels.sentinel, "test/other", "persisted before another edit");
				press(c, KEY.down, KEY.enter);
			} },
			{ title: /sentinel · Thinking/u, act: (c) => press(c, "medium", KEY.enter) },
			{ title: /Saved sentinel thinking/u, act(c, screen, path) {
				assert.match(screen, /› Thinking: medium · override/u);
				assert.equal(saved(path).agentThinkingLevels.sentinel, "medium");
				press(c, KEY.escape);
			} },
			{ title: /Roles/u, act(c, screen) { assert.match(screen, /› sentinel/u); press(c, KEY.enter); } },
			{ title: /sentinel · Settings/u, act(c, screen) { assert.match(screen, /› Thinking: medium · override/u); press(c, KEY.escape); } },
			{ title: /Roles/u, act: (c) => press(c, KEY.escape) },
		]);
		assert.deepEqual(saved(path), baseConfig({ agentModels: { artisan: "test/reasoning", sentinel: "test/other" }, agentThinkingLevels: { sentinel: "medium" } }));
	});

	it("migrates legacy roles and exposes current config and distinct responsibilities", async (t) => {
		const path = await scenario(t, baseConfig({ agentModels: { reviewer: "test/other" }, agentThinkingLevels: { critic: "medium" } }), [
			{ title: /Roles/u, act(c, screen) {
				assert.doesNotMatch(screen, /reviewer|critic/u);
				press(c, KEY.down, KEY.down);
				assert.match(c.render(120).join("\n"), /Model: other · test[\s\S]*Thinking: high · role default/u);
				press(c, "\t");
				assert.match(c.render(120).join(" "), /implementation or diff against requirements and callers.*defects and regressions.*No edits/u);
				press(c, "\t", KEY.down);
				assert.match(c.render(120).join("\n"), /Thinking: medium · override/u);
				press(c, "\t");
				assert.match(c.render(120).join(" "), /named claim, design assumption, or review finding.*counterexamples and focused checks.*No edits/u);
				press(c, KEY.escape, KEY.escape);
			} },
		]);
		assert.deepEqual(saved(path), baseConfig({ agentModels: { sentinel: "test/other" }, agentThinkingLevels: { skeptic: "medium" } }));
	});

	it("Reset defaults only clears the selected role and keeps Reset selected", async (t) => {
		const path = await scenario(t, baseConfig({ agentModels: { scout: "test/other", skeptic: "test/reasoning" }, agentThinkingLevels: { scout: "high", skeptic: "low" } }), [
			{ title: /Roles/u, act: (c) => press(c, KEY.enter) },
			{ title: /scout · Settings/u, act: (c) => press(c, KEY.down, KEY.down, KEY.enter) },
			{ title: /Saved scout defaults/u, act(c, screen) {
				assert.match(screen, /Model: Follow main[\s\S]*Thinking: low · role default[\s\S]*› Reset defaults/u);
				press(c, KEY.escape);
			} },
			{ title: /Roles/u, act: (c) => press(c, KEY.escape) },
		]);
		assert.deepEqual(saved(path), baseConfig({ agentModels: { skeptic: "test/reasoning" }, agentThinkingLevels: { skeptic: "low" } }));
	});

	it("Esc returns exactly one level without applying an unconfirmed model or thinking choice", async (t) => {
		const initial = baseConfig({ agentModels: { scout: "test/other" } });
		const path = await scenario(t, initial, [
			{ title: /Roles/u, act: (c) => press(c, KEY.enter) },
			{ title: /scout · Settings/u, act: (c) => press(c, KEY.enter) },
			{ title: /scout · Model/u, act: (c) => press(c, "reasoning", "\t", KEY.escape, KEY.escape) },
			{ title: /scout · Settings/u, act(c, screen) {
				assert.match(screen, /› Model: other · test/u);
				press(c, KEY.down, KEY.enter);
			} },
			{ title: /scout · Thinking/u, act: (c) => press(c, "medium", KEY.escape) },
			{ title: /scout · Settings/u, act(c, screen) { assert.match(screen, /› Thinking: low · role default/u); press(c, KEY.escape); } },
			{ title: /Roles/u, act: (c) => press(c, KEY.escape) },
		]);
		assert.deepEqual(saved(path), initial);
	});

	it("shows saved unsupported thinking, keeps it across model changes, and can restore role default", async (t) => {
		const path = await scenario(t, baseConfig({ agentThinkingLevels: { scout: "high" } }), [
			{ title: /Roles/u, act(c, screen) { assert.match(screen, /off \(high requested\) · override/u); press(c, KEY.enter); } },
			{ title: /scout · Settings/u, act: (c) => press(c, KEY.down, KEY.enter) },
			{ title: /scout · Thinking/u, act(c, screen) {
				assert.match(screen, /› high \(runs as off\) \[saved\]/u);
				press(c, KEY.up);
				assert.match(c.render(120).join("\n"), /high \(runs as off\) \[saved\]/u);
				press(c, KEY.escape);
			} },
			{ title: /scout · Settings/u, act: (c) => press(c, KEY.up, KEY.enter) },
			{ title: /scout · Model/u, act: (c) => press(c, "reasoning", KEY.enter) },
			{ title: /Saved scout model/u, act(c, screen, path) {
				assert.equal(saved(path).agentThinkingLevels.scout, "high");
				assert.match(screen, /Thinking: high · override/u);
				press(c, KEY.down, KEY.enter);
			} },
			{ title: /scout · Thinking/u, act: (c) => press(c, "Role default", KEY.enter) },
			{ title: /Saved scout thinking/u, act(c, screen) { assert.match(screen, /› Thinking: low · role default/u); press(c, KEY.escape); } },
			{ title: /Roles/u, act: (c) => press(c, KEY.escape) },
		], [model("plain", false), model("reasoning")]);
		assert.deepEqual(saved(path), baseConfig({ agentModels: { scout: "test/reasoning" } }));
	});

	it("Follow main clears a pin to the same model, preserving other settings", async (t) => {
		const path = await scenario(t, baseConfig({ agentModels: { scout: "test/reasoning", artisan: "test/other" }, agentThinkingLevels: { scout: "medium" } }), [
			{ title: /Roles/u, act: (c) => press(c, KEY.enter) },
			{ title: /scout · Settings/u, act: (c) => press(c, KEY.enter) },
			{ title: /scout · Model/u, act(c, screen) {
				assert.match(screen, /› reasoning · test \[saved\]/u);
				press(c, KEY.up);
				assert.match(c.render(120).join("\n"), /› Follow main \(dynamic\)/u);
				press(c, KEY.enter);
			} },
			{ title: /Saved scout model/u, act(c, screen) { assert.match(screen, /Model: Follow main[\s\S]*Thinking: medium · override/u); press(c, KEY.escape); } },
			{ title: /Roles/u, act: (c) => press(c, KEY.escape) },
		]);
		assert.deepEqual(saved(path), baseConfig({ agentModels: { artisan: "test/other" }, agentThinkingLevels: { scout: "medium" } }));
	});

	it("fresh-install Esc leaves no config file", async (t) => {
		const path = await scenario(t, undefined, [{ title: /Roles/u, act: (c) => press(c, KEY.escape) }]);
		assert.equal(existsSync(path), false);
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
