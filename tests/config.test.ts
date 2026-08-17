import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
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
	it("returns defaults for non-object input", () => {
		const config = normalizeConfig(undefined);
		expect(config.enabledAgents).toEqual([...DEFAULT_ENABLED_AGENTS]);
		expect(config.proactiveInjection).toBe(true);
		expect(config.agentScope).toBe("user");
		expect(config.agentModels).toEqual({});
		expect(config.agentBackupModels).toEqual({});
		expect(config.agentThinkingLevels).toEqual({});
		expect(config.thinkingLevel).toBe(DEFAULT_THINKING_LEVEL);
		expect(config.notifyOnReviewPass).toBe(false);
		expect(config.maxConcurrency).toBe(DEFAULT_MAX_CONCURRENCY);
	});

	it("keeps valid enabledAgents and drops non-strings", () => {
		const config = normalizeConfig({ enabledAgents: ["explore", "worker", 42, null, "explore"] });
		expect(config.enabledAgents).toEqual(["explore", "worker"]);
	});

	it("strips removed agents from upgraded configs", () => {
		const config = normalizeConfig({
			enabledAgents: ["explore", "plan", "worker"],
			agentModels: { plan: "anthropic/claude-haiku-4-5", worker: "openai/gpt-5" },
			agentBackupModels: { plan: "openai/old", worker: "anthropic/backup" },
			agentThinkingLevels: { plan: "high", worker: "medium" },
		});
		expect(config.enabledAgents).toEqual(["explore", "worker"]);
		expect(config.agentModels).toEqual({ worker: "openai/gpt-5" });
		expect(config.agentBackupModels).toEqual({ worker: "anthropic/backup" });
		expect(config.agentThinkingLevels).toEqual({ worker: "medium" });
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

	it("keeps valid backup model refs and defaults a missing key to an empty pool", () => {
		const config = normalizeConfig({
			agentBackupModels: {
				explore: " anthropic/claude-sonnet-4-5 ",
				bad: "noslash",
				empty: "  ",
				spaced: "openai/model id",
			},
		});
		expect(config.agentBackupModels).toEqual({ explore: "anthropic/claude-sonnet-4-5" });
		expect(normalizeConfig({}).agentBackupModels).toEqual({});
	});

	it("defaults maxResultLines to 80 and clamps invalid values", () => {
		expect(DEFAULT_MAX_RESULT_LINES).toBe(80);
		expect(normalizeConfig({ maxResultLines: 200 }).maxResultLines).toBe(200);
		expect(normalizeConfig({ maxResultLines: 99_999 }).maxResultLines).toBe(MAX_RESULT_LINES_LIMIT);
		expect(normalizeConfig({ maxResultLines: "many" }).maxResultLines).toBe(DEFAULT_MAX_RESULT_LINES);
	});

	it("defaults the global thinking level to literal high", () => {
		expect(DEFAULT_THINKING_LEVEL).toBe("high");
	});

	it("keeps only valid thinking levels in agentThinkingLevels", () => {
		const config = normalizeConfig({
			agentThinkingLevels: { explore: "high", bad: "ultra", empty: "" },
		});
		expect(config.agentThinkingLevels).toEqual({ explore: "high" });
	});

	it("validates the configured thinking level", () => {
		expect(normalizeConfig({ thinkingLevel: "high" }).thinkingLevel).toBe("high");
		expect(normalizeConfig({ thinkingLevel: "invalid" }).thinkingLevel).toBe(DEFAULT_THINKING_LEVEL);
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

	it("merges a legacy maxParallelTasks into maxConcurrency (larger wins)", () => {
		// Old config: concurrency 2, parallel cap 8 → merged to 8.
		const merged = normalizeConfig({ maxConcurrency: 2, maxParallelTasks: 8 });
		expect(merged.maxConcurrency).toBe(8);

		// The old key alone also folds in, clamped to the new limit.
		const alone = normalizeConfig({ maxParallelTasks: 999 });
		expect(alone.maxConcurrency).toBe(MAX_CONCURRENCY_LIMIT);

		// Invalid legacy values are ignored; concurrency stays as configured.
		const invalid = normalizeConfig({ maxConcurrency: 3, maxParallelTasks: "many" });
		expect(invalid.maxConcurrency).toBe(3);
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

	it("keeps a valid visionModel and drops invalid ones", () => {
		expect(normalizeConfig({ visionModel: "anthropic/claude-sonnet-4-5" }).visionModel).toBe(
			"anthropic/claude-sonnet-4-5",
		);
		expect(normalizeConfig({ visionModel: "noslash" }).visionModel).toBeUndefined();
		expect(normalizeConfig({ visionModel: 42 }).visionModel).toBeUndefined();
		expect(normalizeConfig({}).visionModel).toBeUndefined();
	});

	it("keeps announcedFeatures as a string array and drops garbage", () => {
		expect(normalizeConfig({ announcedFeatures: ["visionModel", 42, ""] }).announcedFeatures).toEqual([
			"visionModel",
		]);
		expect(normalizeConfig({}).announcedFeatures).toEqual([]);
	});
});

describe("loadConfig", () => {
	it("round-trips configured backup model refs through save/load", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-subagents-test-"));
		const path = join(dir, "pi-subagents.json");
		const config = normalizeConfig({
			agentModels: { worker: "anthropic/primary" },
			agentBackupModels: { worker: "openai/backup" },
		});
		await saveConfig(config, path);
		const loaded = await loadConfig(path);
		expect(loaded.agentModels).toEqual({ worker: "anthropic/primary" });
		expect(loaded.agentBackupModels).toEqual({ worker: "openai/backup" });
		expect(JSON.parse(readFileSync(path, "utf8")).agentBackupModels).toEqual({ worker: "openai/backup" });
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
		// A config written by an older version, without the numeric limits.
		writeFileSync(path, JSON.stringify({ enabledAgents: ["explore"], thinkingLevel: "high" }), "utf8");

		const config = await loadConfig(path);
		expect(config.maxConcurrency).toBe(DEFAULT_MAX_CONCURRENCY);

		const saved = JSON.parse(readFileSync(path, "utf8"));
		expect(saved.enabledAgents).toEqual(["explore"]);
		expect(saved.agentBackupModels).toEqual({});
		expect(saved.thinkingLevel).toBe("high");
		expect(saved.maxConcurrency).toBe(DEFAULT_MAX_CONCURRENCY);
	});

	it("cleans removed agents out of an old config and saves the result", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-subagents-test-"));
		const path = join(dir, "pi-subagents.json");
		writeFileSync(
			path,
			JSON.stringify({ enabledAgents: ["explore", "plan"], agentModels: { plan: "a/b" } }),
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
