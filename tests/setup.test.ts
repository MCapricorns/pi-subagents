import { describe, expect, it } from "vitest";
import {
	CURRENT_MAIN_MODEL,
	applyModelPoolChoice,
	buildAgentModelPoolRows,
	buildModelPickerItems,
} from "../src/models.ts";
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

	it("uses a first-class clear/default option for backup picks", () => {
		const items = buildModelPickerItems({
			models: [],
			availableRefs: [],
			slot: "backup",
			configuredRef: "removed/stale-backup",
		});
		expect(items[0]).toMatchObject({
			value: CURRENT_MAIN_MODEL,
			label: "Current main model (default)",
		});
		expect(items[1].label).toBe("removed/stale-backup");
		expect(items[1].description).toContain("unavailable");
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
