import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
	CURRENT_MAIN_MODEL,
	applyModelPoolChoice,
	buildAgentModelPoolRows,
	buildModelPickerItems,
} from "../src/models.ts";
import { runSetup } from "../src/setup.ts";
import { pickerItemSearchText } from "../src/ui.ts";

describe("setup model picker helpers", () => {
	it("makes provider/model, capabilities, and availability searchable", () => {
		const [dynamic, model] = buildModelPickerItems({
			models: [{
				provider: "anthropic",
				id: "claude-sonnet",
				name: "Claude Sonnet",
				input: ["text", "image"],
				reasoning: true,
			}],
			availableRefs: ["anthropic/claude-sonnet"],
			slot: "primary",
			mainRef: "anthropic/claude-sonnet",
		});
		expect(dynamic).toMatchObject({
			value: CURRENT_MAIN_MODEL,
			label: "Current main model (dynamic)",
		});
		expect(model.label).toBe("anthropic/claude-sonnet");
		expect(model.description).toBe("Claude Sonnet · vision + reasoning · available · current main");
		expect(pickerItemSearchText(model)).toContain("vision + reasoning");
		expect(pickerItemSearchText(model)).toContain("available");
	});

	it("uses a first-class clear/default option and hides unavailable saved backups", () => {
		const items = buildModelPickerItems({
			models: [],
			availableRefs: [],
			slot: "backup",
			configuredRef: "removed/stale-backup",
		});
		expect(items).toEqual([expect.objectContaining({
			value: CURRENT_MAIN_MODEL,
			label: "Current main model (default)",
		})]);
	});
});

describe("full setup flow", () => {
	it("asks every enabled agent for an explicit thinking-strength choice", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-subagents-setup-full-"));
		const configPath = join(dir, "pi-subagents.json");
		const screens: string[] = [];
		const keybindings = {
			matches(data: string, action: string) {
				return (data === "down" && action === "tui.select.down") ||
					(data === "enter" && action === "tui.select.confirm");
			},
		};
		const ctx: any = {
			mode: "tui",
			model: undefined,
			modelRegistry: { getAvailable: () => [] },
			ui: {
				notify: vi.fn(),
				select: vi.fn(async (_title: string, options: string[]) =>
					options.find((option) => option.includes("(current)")) ?? options[0]),
				custom: (factory: any) => new Promise((resolve) => {
					const component = factory(
						{ requestRender: () => {} },
						{ fg: (_color: string, text: string) => text, bold: (text: string) => text },
						keybindings,
						resolve,
					);
					const rendered = component.render(160).join("\n");
					screens.push(rendered);
					if (rendered.includes("Agent model pools")) {
						for (let index = 0; index < 4; index++) component.handleInput("down");
					}
					component.handleInput("enter");
				}),
			},
		};
		try {
			await runSetup(ctx, configPath);
			const config = JSON.parse(readFileSync(configPath, "utf8"));
			expect(config.enabledAgents).toEqual(["explore", "worker", "cleaner", "reviewer"]);
			expect(config.agentThinkingLevels).toEqual({});
			expect(screens.some((screen) => screen.includes("cleaner — evidence-first cleanup"))).toBe(true);
			expect(screens.some((screen) => screen.includes('Thinking strength for "explore"?'))).toBe(true);
			expect(screens.some((screen) => screen.includes('Thinking strength for "worker"?'))).toBe(true);
			expect(screens.some((screen) => screen.includes('Thinking strength for "cleaner"?'))).toBe(true);
			expect(screens.some((screen) => screen.includes('Thinking strength for "reviewer"?'))).toBe(true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("setup model-pool state helpers", () => {
	it("shows Primary and Backup together and clears dynamic choices without placeholders", () => {
		const initial = {
			agentModels: { worker: "anthropic/primary" },
			agentBackupModels: { worker: "openai/backup" },
		};
		expect(buildAgentModelPoolRows(["worker"], initial)).toEqual([
			{ name: "worker", primary: "anthropic/primary", backup: "openai/backup" },
		]);
		const cleared = applyModelPoolChoice(initial, "worker", "backup", CURRENT_MAIN_MODEL);
		expect(cleared.agentBackupModels).toEqual({});
		expect(Object.values(cleared.agentBackupModels)).not.toContain(CURRENT_MAIN_MODEL);
	});
});
