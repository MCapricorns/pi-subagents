import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	BUILTIN_AGENT_NAMES,
	DEFAULT_ENABLED_AGENTS,
	DEFAULT_IDLE_TIMEOUT_SEC,
	DEFAULT_MAX_CONCURRENCY,
	DEFAULT_MAX_FIX_ROUNDS,
	DEFAULT_MAX_RESULT_LINES,
	DEFAULT_THINKING_LEVEL,
	IDLE_TIMEOUT_SEC_LIMIT,
	MAX_CONCURRENCY_LIMIT,
	MAX_FIX_ROUNDS_LIMIT,
	MAX_RESULT_LINES_LIMIT,
	loadConfig,
	normalizeConfig,
	saveConfig,
} from "../src/config.ts";

describe("normalizeConfig", () => {
	it("returns all four built-ins for a fresh config", () => {
		const config = normalizeConfig(undefined);
		expect(BUILTIN_AGENT_NAMES).toEqual(["explore", "worker", "cleaner", "reviewer"]);
		expect(DEFAULT_ENABLED_AGENTS).toEqual(["explore", "worker", "cleaner", "reviewer"]);
		expect(config.enabledAgents).toEqual([...DEFAULT_ENABLED_AGENTS]);
		expect(config.proactiveInjection).toBe(true);
		expect(config.agentScope).toBe("user");
		expect(config.agentModels).toEqual({});
		expect(config.agentThinkingLevels).toEqual({});
		expect(config).not.toHaveProperty("agentBackupModels");
		expect(config).not.toHaveProperty("thinkingLevel");
		expect(config.notifyOnReviewPass).toBe(false);
		expect(config.maxConcurrency).toBe(DEFAULT_MAX_CONCURRENCY);
	});

	it("keeps valid enabledAgents and drops non-strings", () => {
		const config = normalizeConfig({ enabledAgents: ["explore", "worker", 42, null, "explore"] });
		expect(config.enabledAgents).toEqual(["explore", "worker"]);
	});

	it("preserves an existing explicit agent list without injecting cleaner", () => {
		const existing = ["explore", "worker", "reviewer"];
		expect(normalizeConfig({ enabledAgents: existing }).enabledAgents).toEqual(existing);
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

	it("drops legacy backup-pool and global-thinking keys", () => {
		const config = normalizeConfig({
			agentBackupModels: { explore: "anthropic/claude-sonnet-4-5" },
			thinkingLevel: "max",
		});
		expect(config).not.toHaveProperty("agentBackupModels");
		expect(config).not.toHaveProperty("thinkingLevel");
	});

	it("defaults maxResultLines to 80 and clamps invalid values", () => {
		expect(DEFAULT_MAX_RESULT_LINES).toBe(80);
		expect(normalizeConfig({ maxResultLines: 200 }).maxResultLines).toBe(200);
		expect(normalizeConfig({ maxResultLines: 99_999 }).maxResultLines).toBe(MAX_RESULT_LINES_LIMIT);
		expect(normalizeConfig({ maxResultLines: "many" }).maxResultLines).toBe(DEFAULT_MAX_RESULT_LINES);
	});

	it("uses high as the fallback Auto preference for agents without a declaration", () => {
		expect(DEFAULT_THINKING_LEVEL).toBe("high");
	});

	it("keeps only valid thinking levels in agentThinkingLevels", () => {
		const config = normalizeConfig({
			agentThinkingLevels: { explore: "high", bad: "ultra", empty: "" },
		});
		expect(config.agentThinkingLevels).toEqual({ explore: "high" });
	});

	it("defaults notifyOnReviewPass to false and preserves an explicit true", () => {
		expect(normalizeConfig({}).notifyOnReviewPass).toBe(false);
		expect(normalizeConfig({ notifyOnReviewPass: true }).notifyOnReviewPass).toBe(true);
		expect(normalizeConfig({ notifyOnReviewPass: "yes" }).notifyOnReviewPass).toBe(false);
	});

	it("accepts a boolean proactiveInjection", () => {
		expect(normalizeConfig({ proactiveInjection: false }).proactiveInjection).toBe(false);
		expect(normalizeConfig({ proactiveInjection: "nope" }).proactiveInjection).toBe(true);
	});

	it("validates agentScope", () => {
		expect(normalizeConfig({ agentScope: "both" }).agentScope).toBe("both");
		expect(normalizeConfig({ agentScope: "everywhere" }).agentScope).toBe("user");
	});

	it("clamps the numeric limits and rejects non-numbers", () => {
		const config = normalizeConfig({ maxConcurrency: 6 });
		expect(config.maxConcurrency).toBe(6);

		const clamped = normalizeConfig({ maxConcurrency: 0 });
		expect(clamped.maxConcurrency).toBe(1);
		expect(normalizeConfig({ maxConcurrency: 999 }).maxConcurrency).toBe(MAX_CONCURRENCY_LIMIT);

		const invalid = normalizeConfig({ maxConcurrency: "many" });
		expect(invalid.maxConcurrency).toBe(DEFAULT_MAX_CONCURRENCY);
	});

	it("defaults maxFixRounds to 2 and clamps to [0, 5]", () => {
		expect(DEFAULT_MAX_FIX_ROUNDS).toBe(2);
		expect(normalizeConfig({}).maxFixRounds).toBe(2);
		expect(normalizeConfig({ maxFixRounds: 0 }).maxFixRounds).toBe(0);
		expect(normalizeConfig({ maxFixRounds: 3 }).maxFixRounds).toBe(3);
		expect(normalizeConfig({ maxFixRounds: 99 }).maxFixRounds).toBe(MAX_FIX_ROUNDS_LIMIT);
		expect(normalizeConfig({ maxFixRounds: 2.6 }).maxFixRounds).toBe(3);
		expect(normalizeConfig({ maxFixRounds: "many" }).maxFixRounds).toBe(DEFAULT_MAX_FIX_ROUNDS);
	});

	it("defaults idleTimeoutSec to 90 and clamps to [0, 600]", () => {
		expect(DEFAULT_IDLE_TIMEOUT_SEC).toBe(90);
		expect(normalizeConfig({}).idleTimeoutSec).toBe(90);
		expect(normalizeConfig({ idleTimeoutSec: 0 }).idleTimeoutSec).toBe(0);
		expect(normalizeConfig({ idleTimeoutSec: 120 }).idleTimeoutSec).toBe(120);
		expect(normalizeConfig({ idleTimeoutSec: 999 }).idleTimeoutSec).toBe(IDLE_TIMEOUT_SEC_LIMIT);
		expect(normalizeConfig({ idleTimeoutSec: 45.6 }).idleTimeoutSec).toBe(46);
		expect(normalizeConfig({ idleTimeoutSec: "off" }).idleTimeoutSec).toBe(DEFAULT_IDLE_TIMEOUT_SEC);
	});

	it("drops the obsolete visionModel key during normalization", () => {
		expect("visionModel" in normalizeConfig({ visionModel: "anthropic/claude-sonnet-4-5" })).toBe(false);
		expect("visionModel" in normalizeConfig({})).toBe(false);
	});

	it("keeps announcedFeatures as a string array and drops garbage", () => {
		expect(normalizeConfig({ announcedFeatures: ["visionModel", 42, ""] }).announcedFeatures).toEqual([
			"visionModel",
		]);
		expect(normalizeConfig({}).announcedFeatures).toEqual([]);
	});
});

describe("loadConfig", () => {
	it("round-trips selected models and thinking preferences", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-subagents-test-"));
		const path = join(dir, "pi-subagents.json");
		const config = normalizeConfig({
			agentModels: { worker: "anthropic/primary" },
			agentThinkingLevels: { worker: "high" },
		});
		await saveConfig(config, path);
		const loaded = await loadConfig(path);
		expect(loaded.agentModels).toEqual({ worker: "anthropic/primary" });
		expect(loaded.agentThinkingLevels).toEqual({ worker: "high" });
		const saved = JSON.parse(readFileSync(path, "utf8"));
		expect(saved.agentModels).toEqual({ worker: "anthropic/primary" });
		expect(saved.agentThinkingLevels).toEqual({ worker: "high" });
	});

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

	it("persists schema upgrades: missing new fields are filled in and saved back", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-subagents-test-"));
		const path = join(dir, "pi-subagents.json");
		// A config written by the old pool/global-thinking schema.
		writeFileSync(path, JSON.stringify({
			enabledAgents: ["explore"],
			thinkingLevel: "max",
			agentBackupModels: { explore: "openai/backup" },
		}), "utf8");

		const config = await loadConfig(path);
		expect(config.maxConcurrency).toBe(DEFAULT_MAX_CONCURRENCY);

		const saved = JSON.parse(readFileSync(path, "utf8"));
		expect(saved.enabledAgents).toEqual(["explore"]);
		expect(saved).not.toHaveProperty("agentBackupModels");
		expect(saved).not.toHaveProperty("thinkingLevel");
		expect(saved.maxConcurrency).toBe(DEFAULT_MAX_CONCURRENCY);
	});

	it("normalizes an upgraded config and saves the result", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-subagents-test-"));
		const path = join(dir, "pi-subagents.json");
		writeFileSync(
			path,
			JSON.stringify({ enabledAgents: ["explore", 42], agentModels: { bad: "noslash" } }),
			"utf8",
		);

		const config = await loadConfig(path);
		expect(config.enabledAgents).toEqual(["explore"]);
		expect(config.agentModels).toEqual({});

		const saved = JSON.parse(readFileSync(path, "utf8"));
		expect(saved.enabledAgents).toEqual(["explore"]);
		expect(saved.agentModels).toEqual({});
	});
});
