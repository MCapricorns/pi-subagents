import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CURRENT_MAIN_MODEL, buildModelPickerItems } from "../src/models.ts";
import { runSetup } from "../src/setup.ts";
import { pickerItemSearchText } from "../src/ui.ts";

describe("setup model picker helpers", () => {
	it("makes model identity, capabilities, and supported thinking searchable", () => {
		const [dynamic, model] = buildModelPickerItems({
			models: [{
				provider: "anthropic",
				id: "claude-sonnet",
				name: "Claude Sonnet",
				input: ["text", "image"],
				reasoning: true,
				thinkingLevelMap: { xhigh: null, max: "max" },
			}],
			mainRef: "anthropic/claude-sonnet",
		});
		expect(dynamic).toMatchObject({
			value: CURRENT_MAIN_MODEL,
			label: "Current main model (dynamic)",
		});
		expect(model.label).toBe("anthropic/claude-sonnet");
		expect(model.description).toContain("Claude Sonnet · vision");
		expect(model.description).toContain("thinking: off/minimal/low/medium/high/max");
		expect(model.description).toContain("current main");
		expect(pickerItemSearchText(model)).toContain("thinking:");
	});

	it("labels text-only models so agent model choices show the capability", () => {
		const [, model] = buildModelPickerItems({
			models: [{
				provider: "openai",
				id: "text-only",
				name: "text-only",
				input: ["text"],
				reasoning: false,
			}],
		});
		expect(model.description).toContain("text-only");
	});
});

describe("configured-agent flow", () => {
	it("shows Auto plus only the effective model's supported thinking levels", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-subagents-setup-agent-"));
		const configPath = join(dir, "pi-subagents.json");
		const projectAgents = join(dir, ".pi", "agents");
		mkdirSync(projectAgents, { recursive: true });
		writeFileSync(
			join(projectAgents, "explore.md"),
			"---\nname: explore\ndescription: project override\nthinking: high\n---\nProject explore prompt.\n",
			"utf8",
		);
		writeFileSync(configPath, JSON.stringify({ enabledAgents: ["explore"], agentScope: "project" }), "utf8");
		const model = {
			provider: "anthropic",
			id: "selected",
			name: "Selected",
			input: ["text"],
			reasoning: true,
			thinkingLevelMap: { medium: null, xhigh: null, max: null },
		};
		const screens: string[] = [];
		let agentPickerVisits = 0;
		const keybindings = {
			matches(data: string, action: string) {
				return (data === "enter" && action === "tui.select.confirm")
					|| (data === "escape" && action === "tui.select.cancel");
			},
		};
		const ctx: any = {
			mode: "tui",
			cwd: dir,
			isProjectTrusted: () => true,
			model,
			modelRegistry: { getAvailable: () => [model] },
			ui: {
				notify: vi.fn(),
				select: vi.fn(async (_title: string, options: string[]) =>
					options.find((option) => option.startsWith("Configure an agent"))),
				custom: (factory: any) => new Promise((resolve) => {
					const component = factory(
						{ requestRender: () => {} },
						{ fg: (_color: string, text: string) => text, bold: (text: string) => text },
						keybindings,
						resolve,
					);
					const screen = component.render(160).join("\n");
					screens.push(screen);
					if (screen.includes("Configure which agent?")) {
						agentPickerVisits += 1;
						component.handleInput(agentPickerVisits === 1 ? "enter" : "escape");
					} else {
						component.handleInput("enter");
					}
				}),
			},
		};
		try {
			await runSetup(ctx, configPath);
			const thinkingScreen = screens.find((screen) => screen.includes('Thinking for "explore"?'));
			expect(thinkingScreen).toContain("auto — high");
			expect(thinkingScreen).toContain("off — no reasoning tokens");
			expect(thinkingScreen).toContain("minimal — minimal reasoning");
			expect(thinkingScreen).toContain("low — light reasoning");
			expect(thinkingScreen).toContain("high — deep reasoning");
			expect(thinkingScreen).not.toContain("medium —");
			expect(thinkingScreen).not.toContain("xhigh —");
			expect(thinkingScreen).not.toContain("max —");
			const saved = JSON.parse(readFileSync(configPath, "utf8"));
			expect(saved.agentThinkingLevels).toEqual({});
			expect(agentPickerVisits).toBe(2);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("returns to the agent picker after a model pick so another agent can be set", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-subagents-setup-loop-"));
		const configPath = join(dir, "pi-subagents.json");
		writeFileSync(configPath, JSON.stringify({ enabledAgents: ["explore", "worker"] }), "utf8");
		const haiku = {
			provider: "anthropic",
			id: "haiku",
			name: "Haiku",
			input: ["text"],
			reasoning: false,
		};
		const sonnet = {
			provider: "anthropic",
			id: "sonnet",
			name: "Sonnet",
			input: ["text"],
			reasoning: false,
		};
		const screens: string[] = [];
		let agentPickerVisits = 0;
		const keybindings = {
			matches(data: string, action: string) {
				return (data === "enter" && action === "tui.select.confirm")
					|| (data === "escape" && action === "tui.select.cancel")
					|| (data === "down" && action === "tui.select.down");
			},
		};
		const ctx: any = {
			mode: "tui",
			cwd: dir,
			isProjectTrusted: () => true,
			model: haiku,
			modelRegistry: { getAvailable: () => [haiku, sonnet] },
			ui: {
				notify: vi.fn(),
				select: vi.fn(async (_title: string, options: string[]) =>
					options.find((option) => option.startsWith("Configure an agent"))),
				custom: (factory: any) => new Promise((resolve) => {
					const component = factory(
						{ requestRender: () => {} },
						{ fg: (_color: string, text: string) => text, bold: (text: string) => text },
						keybindings,
						resolve,
					);
					const screen = component.render(160).join("\n");
					screens.push(screen);
					if (screen.includes("Configure which agent?")) {
						agentPickerVisits += 1;
						if (agentPickerVisits === 1) component.handleInput("enter");
						else if (agentPickerVisits === 2) {
							component.handleInput("down");
							component.handleInput("enter");
						} else {
							component.handleInput("escape");
						}
					} else if (screen.includes('Model for "explore"?')) {
						component.handleInput("down");
						component.handleInput("enter");
					} else if (screen.includes('Model for "worker"?')) {
						component.handleInput("down");
						component.handleInput("down");
						component.handleInput("enter");
					} else {
						component.handleInput("enter");
					}
				}),
			},
		};
		try {
			await runSetup(ctx, configPath);
			expect(screens.filter((screen) => screen.includes("Configure which agent?")).length).toBe(3);
			expect(screens.some((screen) => screen.includes("Thinking for"))).toBe(false);
			const saved = JSON.parse(readFileSync(configPath, "utf8"));
			expect(saved.agentModels).toEqual({
				explore: "anthropic/haiku",
				worker: "anthropic/sonnet",
			});
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("full setup flow", () => {
	it("uses one model choice per agent and Auto thinking without pool/strength menus", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-subagents-setup-full-"));
		const configPath = join(dir, "pi-subagents.json");
		const screens: string[] = [];
		const keybindings = {
			matches(data: string, action: string) {
				return data === "enter" && action === "tui.select.confirm";
			},
		};
		const notify = vi.fn();
		const ctx: any = {
			mode: "tui",
			model: undefined,
			modelRegistry: { getAvailable: () => [] },
			ui: {
				notify,
				select: vi.fn(async (_title: string, options: string[]) =>
					options.find((option) => option.includes("(current)")) ?? options[0]),
				custom: (factory: any) => new Promise((resolve) => {
					const component = factory(
						{ requestRender: () => {} },
						{ fg: (_color: string, text: string) => text, bold: (text: string) => text },
						keybindings,
						resolve,
					);
					screens.push(component.render(160).join("\n"));
					component.handleInput("enter");
				}),
			},
		};
		try {
			await runSetup(ctx, configPath);
			const config = JSON.parse(readFileSync(configPath, "utf8"));
			expect(config.enabledAgents).toEqual(["explore", "worker", "cleaner", "reviewer"]);
			expect(config.agentModels).toEqual({});
			expect(config.agentThinkingLevels).toEqual({});
			expect(config).not.toHaveProperty("agentBackupModels");
			expect(config).not.toHaveProperty("thinkingLevel");
			for (const agent of ["explore", "worker", "cleaner", "reviewer"]) {
				expect(screens.some((screen) => screen.includes(`Model for "${agent}"?`))).toBe(true);
			}
			expect(screens.some((screen) => screen.includes("Primary/Backup"))).toBe(false);
			expect(screens.some((screen) => screen.includes("Thinking strength"))).toBe(false);
			expect(notify).toHaveBeenCalledWith(expect.stringContaining("Auto thinking"), "info");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
