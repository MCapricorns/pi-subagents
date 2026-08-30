import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { BUILTIN_AGENT_NAMES, DEFAULT_CONFIG, type SubagentsConfig } from "../src/config.ts";
import { CURRENT_MAIN_MODEL, buildModelPickerItems } from "../src/models.ts";
import { runSetup } from "../src/setup.ts";
import { pickerItemSearchText } from "../src/ui.ts";

function existingConfig(overrides: Partial<SubagentsConfig> = {}): SubagentsConfig {
	return {
		...DEFAULT_CONFIG,
		enabledAgents: ["explorer"],
		agentModels: {},
		agentThinkingLevels: {},
		...overrides,
	};
}

const TEST_TUI = { requestRender: () => {} };
const TEST_THEME = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
const TEST_KEYBINDINGS = {
	matches(data: string, action: string) {
		return (data === "enter" && action === "tui.select.confirm")
			|| (data === "escape" && action === "tui.select.cancel")
			|| (data === "down" && action === "tui.select.down");
	},
};

function pickerDriver(onOpen: (component: any, screen: string) => void): (factory: any) => Promise<unknown> {
	return (factory) => new Promise((resolve) => {
		const component = factory(TEST_TUI, TEST_THEME, TEST_KEYBINDINGS, resolve);
		onOpen(component, component.render(160).join("\n"));
	});
}

function setupContext(cwd: string, ui: any, models: any[] = [], model: any = models[0]): any {
	return {
		mode: "tui",
		cwd,
		isProjectTrusted: () => true,
		model,
		modelRegistry: { getAvailable: () => models },
		ui,
	};
}

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
			join(projectAgents, "explorer.md"),
			"---\nname: explorer\ndescription: project override\nthinking: high\n---\nProject explorer prompt.\n",
			"utf8",
		);
		writeFileSync(configPath, JSON.stringify({ enabledAgents: ["explorer"], agentScope: "project" }), "utf8");
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
		let settingsMenuVisits = 0;
		const ctx = setupContext(dir, {
			notify: vi.fn(),
			select: vi.fn(async (title: string, options: string[]) => {
				if (title !== "pi-subagents settings") return undefined;
				return settingsMenuVisits++ === 0
					? options.find((option) => option.startsWith("Configure an agent"))
					: undefined;
			}),
			custom: pickerDriver((component, screen) => {
				screens.push(screen);
				if (screen.includes("Configure which agent?")) {
					agentPickerVisits += 1;
					component.handleInput(agentPickerVisits === 1 ? "enter" : "escape");
				} else {
					component.handleInput("enter");
				}
			}),
		}, [model], model);
		try {
			await runSetup(ctx, configPath);
			const thinkingScreen = screens.find((screen) => screen.includes('Thinking for "explorer"?'));
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
		writeFileSync(configPath, JSON.stringify({ enabledAgents: ["explorer", "executor"] }), "utf8");
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
		let settingsMenuVisits = 0;
		const ctx = setupContext(dir, {
			notify: vi.fn(),
			select: vi.fn(async (title: string, options: string[]) => {
				if (title !== "pi-subagents settings") return undefined;
				return settingsMenuVisits++ === 0
					? options.find((option) => option.startsWith("Configure an agent"))
					: undefined;
			}),
			custom: pickerDriver((component, screen) => {
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
				} else if (screen.includes('Model for "explorer"?')) {
					component.handleInput("down");
					component.handleInput("enter");
				} else if (screen.includes('Model for "executor"?')) {
					component.handleInput("down");
					component.handleInput("down");
					component.handleInput("enter");
				} else {
					component.handleInput("enter");
				}
			}),
		}, [haiku, sonnet], haiku);
		try {
			await runSetup(ctx, configPath);
			expect(screens.filter((screen) => screen.includes("Configure which agent?")).length).toBe(3);
			expect(screens.some((screen) => screen.includes("Thinking for"))).toBe(false);
			const saved = JSON.parse(readFileSync(configPath, "utf8"));
			expect(saved.agentModels).toEqual({
				explorer: "anthropic/haiku",
				executor: "anthropic/sonnet",
			});
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("setup back navigation", () => {
	it("walks thinking → model → agent → settings on Esc without changing config", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-subagents-setup-back-stack-"));
		const configPath = join(dir, "pi-subagents.json");
		const original = existingConfig({
			enabledAgents: ["explorer", "executor"],
			agentModels: { executor: "deepseek/deepseek-v4-flash" },
			agentThinkingLevels: { explorer: "high", executor: "max" },
		});
		writeFileSync(configPath, JSON.stringify(original), "utf8");
		const model = {
			provider: "anthropic",
			id: "reasoning",
			name: "Reasoning",
			input: ["text"],
			reasoning: true,
		};
		const screens: string[] = [];
		let settingsVisits = 0;
		let agentVisits = 0;
		let modelVisits = 0;
		const notify = vi.fn();
		const ctx = setupContext(dir, {
			notify,
			select: vi.fn(async (title: string, options: string[]) => {
				if (title !== "pi-subagents settings") return undefined;
				return settingsVisits++ === 0
					? options.find((option) => option.startsWith("Configure an agent"))
					: undefined;
			}),
			custom: pickerDriver((component, screen) => {
				screens.push(screen);
				if (screen.includes("Configure which agent?")) {
					agentVisits += 1;
					component.handleInput(agentVisits === 1 ? "enter" : "escape");
				} else if (screen.includes('Model for "explorer"?')) {
					modelVisits += 1;
					component.handleInput(modelVisits === 1 ? "enter" : "escape");
				} else {
					component.handleInput("escape");
				}
			}),
		}, [model], model);
		try {
			await runSetup(ctx, configPath);
			expect(screens.map((screen) =>
				screen.includes("Thinking for") ? "thinking"
					: screen.includes("Model for") ? "model"
						: "agent"
			)).toEqual(["agent", "model", "thinking", "model", "agent"]);
			expect(JSON.parse(readFileSync(configPath, "utf8"))).toEqual(original);
			expect(notify).not.toHaveBeenCalled();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("returns an escaped enable picker to the settings menu", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-subagents-setup-enable-back-"));
		const configPath = join(dir, "pi-subagents.json");
		const original = existingConfig();
		writeFileSync(configPath, JSON.stringify(original), "utf8");
		const menuTitles: string[] = [];
		let settingsVisits = 0;
		const ctx = setupContext(dir, {
			notify: vi.fn(),
			select: vi.fn(async (title: string, options: string[]) => {
				menuTitles.push(title);
				return settingsVisits++ === 0
					? options.find((option) => option.startsWith("Enable"))
					: undefined;
			}),
			custom: pickerDriver((component) => component.handleInput("escape")),
		});
		try {
			await runSetup(ctx, configPath);
			expect(menuTitles).toEqual(["pi-subagents settings", "pi-subagents settings"]);
			expect(JSON.parse(readFileSync(configPath, "utf8"))).toEqual(original);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("offers only agent settings, with no delegation-injection toggle", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-subagents-setup-menu-"));
		const configPath = join(dir, "pi-subagents.json");
		const original = existingConfig();
		writeFileSync(configPath, JSON.stringify(original), "utf8");
		let offered: string[] = [];
		const ctx = setupContext(dir, {
			notify: vi.fn(),
			select: vi.fn(async (_title: string, options: string[]) => {
				offered = options;
				return undefined;
			}),
			custom: vi.fn(),
		});
		try {
			await runSetup(ctx, configPath);
			expect(offered).toEqual([
				"Enable/disable agents",
				"Configure an agent (model + thinking)",
				"Full re-setup",
			]);
			expect(JSON.parse(readFileSync(configPath, "utf8"))).toEqual(original);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("returns an escaped full re-setup pass to settings without saving", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-subagents-setup-full-back-"));
		const configPath = join(dir, "pi-subagents.json");
		const original = existingConfig();
		writeFileSync(configPath, JSON.stringify(original), "utf8");
		let settingsVisits = 0;
		const ctx = setupContext(dir, {
			notify: vi.fn(),
			select: vi.fn(async (title: string, options: string[]) => {
				if (title !== "pi-subagents settings") return undefined;
				return settingsVisits++ === 0
					? options.find((option) => option.startsWith("Full"))
					: undefined;
			}),
			custom: pickerDriver((component) => component.handleInput("escape")),
		});
		try {
			await runSetup(ctx, configPath);
			expect(settingsVisits).toBe(2);
			expect(JSON.parse(readFileSync(configPath, "utf8"))).toEqual(original);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("settings preservation", () => {
	it("keeps unrelated agent model and thinking choices when the enabled set changes", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-subagents-setup-preserve-agent-"));
		const configPath = join(dir, "pi-subagents.json");
		// A custom agent is the "unrelated" record here: a removed built-in name
		// would be pruned on load, which is a different guarantee.
		const original = existingConfig({
			enabledAgents: ["explorer", "my-custom-agent"],
			agentModels: { "my-custom-agent": "deepseek/deepseek-v4-flash" },
			agentThinkingLevels: { "my-custom-agent": "max" },
		});
		writeFileSync(configPath, JSON.stringify(original), "utf8");
		const ctx = setupContext(dir, {
			notify: vi.fn(),
			select: vi.fn(async (_title: string, options: string[]) =>
				options.find((option) => option.startsWith("Enable"))),
			custom: pickerDriver((component) => {
				// Executor is the second built-in row: toggle it on and confirm.
				component.handleInput("down");
				component.handleInput(" ");
				component.handleInput("enter");
			}),
		});
		try {
			await runSetup(ctx, configPath);
			const saved = JSON.parse(readFileSync(configPath, "utf8"));
			expect(saved.enabledAgents).toContain("executor");
			expect(saved.agentModels["my-custom-agent"]).toBe("deepseek/deepseek-v4-flash");
			expect(saved.agentThinkingLevels["my-custom-agent"]).toBe("max");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("enable/disable flow", () => {
	it("newly enabling executor inherits the explorer model and thinking", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-subagents-setup-enable-"));
		const configPath = join(dir, "pi-subagents.json");
			writeFileSync(
				configPath,
				JSON.stringify({
					// Both roles are already known, so loadConfig must not auto-adopt
					// executor: the wizard is what toggles it on here.
					enabledAgents: ["explorer"],
					knownAgents: ["explorer", "executor"],
					agentModels: { explorer: "anthropic/haiku" },
					agentThinkingLevels: { explorer: "low" },
				}),
				"utf8",
			);
			const ctx = setupContext(dir, {
				notify: vi.fn(),
				select: vi.fn(async (_title: string, options: string[]) =>
					options.find((option) => option.startsWith("Enable"))),
				custom: pickerDriver((component) => {
					// Move to executor (second row) and toggle it on, then confirm.
					component.handleInput("down");
					component.handleInput(" ");
					component.handleInput("enter");
				}),
			});
			try {
				await runSetup(ctx, configPath);
				const saved = JSON.parse(readFileSync(configPath, "utf8"));
				expect(saved.enabledAgents).toEqual(["explorer", "executor"]);
				expect(saved.agentModels).toEqual({ explorer: "anthropic/haiku", executor: "anthropic/haiku" });
				expect(saved.agentThinkingLevels).toEqual({ explorer: "low", executor: "low" });
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
		const selectTitles: string[] = [];
		const notify = vi.fn();
		const ctx = setupContext(dir, {
			notify,
			select: vi.fn(async (title: string, options: string[]) => {
				selectTitles.push(title);
				return options.find((option) => option.includes("(current)")) ?? options[0];
			}),
			custom: pickerDriver((component, screen) => {
				screens.push(screen);
				component.handleInput("enter");
			}),
		});
		try {
			await runSetup(ctx, configPath);
			const config = JSON.parse(readFileSync(configPath, "utf8"));
			expect(config.enabledAgents).toEqual(["explorer", "executor"]);
			expect(config.agentModels).toEqual({});
			expect(config.agentThinkingLevels).toEqual({});
			expect(config).not.toHaveProperty("agentBackupModels");
			expect(config).not.toHaveProperty("thinkingLevel");
			expect(config).not.toHaveProperty("proactiveInjection");
			// First run is pickers only — no plain select questions remain.
			expect(selectTitles).toEqual([]);
			expect(screens.some((screen) => screen.includes("explorer — read-only codebase recon"))).toBe(true);
			expect(screens.some((screen) => screen.includes("executor — implement / fix / clean up"))).toBe(true);
			for (const agent of ["explorer", "executor"]) {
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
