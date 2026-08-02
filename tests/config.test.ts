import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_ENABLED_AGENTS, loadConfig, normalizeConfig } from "../src/config.ts";

describe("normalizeConfig", () => {
	it("returns defaults for non-object input", () => {
		const config = normalizeConfig(undefined);
		expect(config.enabledAgents).toEqual([...DEFAULT_ENABLED_AGENTS]);
		expect(config.proactiveInjection).toBe(true);
		expect(config.agentScope).toBe("user");
		expect(config.agentModels).toEqual({});
	});

	it("keeps valid enabledAgents and drops non-strings", () => {
		const config = normalizeConfig({ enabledAgents: ["explore", "plan", 42, null, "explore"] });
		expect(config.enabledAgents).toEqual(["explore", "plan"]);
	});

	it("honors an explicitly empty enabledAgents array", () => {
		expect(normalizeConfig({ enabledAgents: [] }).enabledAgents).toEqual([]);
	});

	it("keeps only valid provider/model references in agentModels", () => {
		const config = normalizeConfig({
			agentModels: { explore: "anthropic/claude-haiku-4-5", bad: "noslash", empty: "  " },
		});
		expect(config.agentModels).toEqual({ explore: "anthropic/claude-haiku-4-5" });
	});

	it("accepts a boolean proactiveInjection", () => {
		expect(normalizeConfig({ proactiveInjection: false }).proactiveInjection).toBe(false);
		expect(normalizeConfig({ proactiveInjection: "nope" }).proactiveInjection).toBe(true);
	});

	it("validates agentScope", () => {
		expect(normalizeConfig({ agentScope: "both" }).agentScope).toBe("both");
		expect(normalizeConfig({ agentScope: "everywhere" }).agentScope).toBe("user");
	});
});

describe("loadConfig", () => {
	it("returns defaults when the file is missing", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-subagents-test-"));
		const config = await loadConfig(join(dir, "does-not-exist.json"));
		expect(config.enabledAgents).toEqual([...DEFAULT_ENABLED_AGENTS]);
	});

	it("falls back to defaults on corrupt JSON instead of throwing", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-subagents-test-"));
		const path = join(dir, "corrupt.json");
		const { writeFile } = await import("node:fs/promises");
		await writeFile(path, "{ not json", "utf8");
		const config = await loadConfig(path);
		expect(config.proactiveInjection).toBe(true);
	});
});
