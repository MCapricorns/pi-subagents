import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	BUILTIN_AGENT_NAMES,
	DEFAULT_ENABLED_AGENTS,
	DEFAULT_IDLE_TIMEOUT_SEC,
	DEFAULT_MAX_RESULT_LINES,
	IDLE_TIMEOUT_SEC_LIMIT,
	MAX_RESULT_LINES_LIMIT,
	loadConfig,
	normalizeConfig,
	saveConfig,
} from "../src/config.ts";

describe("normalizeConfig", () => {
	it("ships two built-ins and enables all of them on a fresh install", () => {
		const config = normalizeConfig(undefined);
		expect(BUILTIN_AGENT_NAMES).toEqual(["explorer", "executor"]);
		expect(DEFAULT_ENABLED_AGENTS).toEqual([...BUILTIN_AGENT_NAMES]);
		expect(config.enabledAgents).toEqual([...DEFAULT_ENABLED_AGENTS]);
		expect(config.knownAgents).toEqual([...BUILTIN_AGENT_NAMES]);
		expect(config.agentScope).toBe("user");
		expect(config.agentModels).toEqual({});
		expect(config.agentThinkingLevels).toEqual({});
	});

	it("seeds knownAgents from enabledAgents and keeps explicit entries", () => {
		const config = normalizeConfig({ enabledAgents: ["executor"], knownAgents: ["explorer", 42, "executor"] });
		expect(config.enabledAgents).toEqual(["executor"]);
		expect(config.knownAgents).toEqual(["explorer", "executor"]);
		// An empty record still means the fresh-install default catalog.
		expect(normalizeConfig({}).knownAgents).toEqual([...BUILTIN_AGENT_NAMES]);
	});

	it("drops the removed tuning keys instead of honoring them", () => {
		const config = normalizeConfig({ maxConcurrency: 9, maxFixRounds: 0, announcedFeatures: ["x"], notifyOnReviewPass: true });
		expect(config).not.toHaveProperty("maxConcurrency");
		expect(config).not.toHaveProperty("maxFixRounds");
		expect(config).not.toHaveProperty("announcedFeatures");
		expect(config).not.toHaveProperty("notifyOnReviewPass");
	});

	it("keeps valid enabledAgents and drops non-strings", () => {
		const config = normalizeConfig({
			enabledAgents: ["explorer", "executor", 42, null, "explorer"],
		});
		expect(config.enabledAgents).toEqual(["explorer", "executor"]);
	});

	it("honors an explicitly empty enabledAgents array", () => {
		const config = normalizeConfig({ enabledAgents: [] });
		expect(config.enabledAgents).toEqual([]);
	});

	it("keeps only valid provider/model references in agentModels", () => {
		const config = normalizeConfig({
			agentModels: { explorer: "anthropic/claude-haiku-4-5", bad: "noslash", empty: "  " },
		});
		expect(config.agentModels).toEqual({ explorer: "anthropic/claude-haiku-4-5" });
	});

	it("defaults maxResultLines to 40 and clamps invalid values", () => {
		expect(DEFAULT_MAX_RESULT_LINES).toBe(40);
		expect(normalizeConfig({ maxResultLines: 200 }).maxResultLines).toBe(200);
		expect(normalizeConfig({ maxResultLines: 99_999 }).maxResultLines).toBe(MAX_RESULT_LINES_LIMIT);
		expect(normalizeConfig({ maxResultLines: "many" }).maxResultLines).toBe(DEFAULT_MAX_RESULT_LINES);
	});

	it("keeps only valid thinking levels in agentThinkingLevels", () => {
		const config = normalizeConfig({
			agentThinkingLevels: { explorer: "high", bad: "ultra", empty: "" },
		});
		expect(config.agentThinkingLevels).toEqual({ explorer: "high" });
	});

	it("validates agentScope", () => {
		expect(normalizeConfig({ agentScope: "both" }).agentScope).toBe("both");
		expect(normalizeConfig({ agentScope: "everywhere" }).agentScope).toBe("user");
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
});

describe("loadConfig", () => {
	it("round-trips selected models and thinking preferences", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-subagents-test-"));
		const path = join(dir, "pi-subagents.json");
		const config = normalizeConfig({
			agentModels: { executor: "anthropic/primary" },
			agentThinkingLevels: { executor: "high" },
		});
		await saveConfig(config, path);
		const loaded = await loadConfig(path);
		expect(loaded.agentModels).toEqual({ executor: "anthropic/primary" });
		expect(loaded.agentThinkingLevels).toEqual({ executor: "high" });
		const saved = JSON.parse(readFileSync(path, "utf8"));
		expect(saved.agentModels).toEqual({ executor: "anthropic/primary" });
		expect(saved.agentThinkingLevels).toEqual({ executor: "high" });
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
		expect(config.enabledAgents).toEqual([...DEFAULT_ENABLED_AGENTS]);
		expect(config.agentScope).toBe("user");
	});

	it("persists the normalized shape and drops every legacy key", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-subagents-test-"));
		const path = join(dir, "pi-subagents.json");
		// A config written across many older versions.
		writeFileSync(path, JSON.stringify({
			enabledAgents: ["explorer"],
			knownAgents: [...BUILTIN_AGENT_NAMES],
			agentModels: { explorer: "anthropic/legacy" },
			agentThinkingLevels: { explorer: "low" },
			thinkingLevel: "max",
			agentBackupModels: { explorer: "openai/backup" },
			maxConcurrency: 12,
			maxFixRounds: 5,
			proactiveInjection: false,
			announcedFeatures: ["cleanerDefaulted", "documenterDefaulted"],
			notifyOnReviewPass: true,
		}), "utf8");

		const config = await loadConfig(path);
		expect(config.enabledAgents).toEqual(["explorer"]);
		expect(config.agentModels).toEqual({ explorer: "anthropic/legacy" });
		expect(config.agentThinkingLevels).toEqual({ explorer: "low" });

		const saved = JSON.parse(readFileSync(path, "utf8"));
		expect(saved.enabledAgents).toEqual(["explorer"]);
		expect(saved.knownAgents).toEqual([...BUILTIN_AGENT_NAMES]);
		expect(saved.agentModels).toEqual({ explorer: "anthropic/legacy" });
		expect(saved.agentThinkingLevels).toEqual({ explorer: "low" });
		for (const key of ["agentBackupModels", "thinkingLevel", "maxConcurrency", "maxFixRounds", "proactiveInjection", "announcedFeatures", "notifyOnReviewPass"]) {
			expect(saved).not.toHaveProperty(key);
		}
	});

	it("normalizes an upgraded config and saves the result", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-subagents-test-"));
		const path = join(dir, "pi-subagents.json");
		writeFileSync(
			path,
			JSON.stringify({ enabledAgents: ["explorer", 42], agentModels: { bad: "noslash" } }),
			"utf8",
		);

		const config = await loadConfig(path);
		// The file predates the current catalog, so every unseen built-in is
		// adopted; explorer has no configured route, so nothing is copied.
		expect(config.enabledAgents).toEqual([...BUILTIN_AGENT_NAMES]);
		expect(config.knownAgents).toEqual([...BUILTIN_AGENT_NAMES]);
		expect(config.agentModels).toEqual({});

		const saved = JSON.parse(readFileSync(path, "utf8"));
		expect(saved.enabledAgents).toEqual([...BUILTIN_AGENT_NAMES]);
		expect(saved.agentModels).toEqual({});
	});

	it("adopts the newly shipped executor on an old-version upgrade and follows explorer's route", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-subagents-test-"));
		const path = join(dir, "pi-subagents.json");
		writeFileSync(path, JSON.stringify({
			enabledAgents: ["explorer", "worker", "reviewer"],
			agentModels: { explorer: "anthropic/claude-haiku-4-5" },
			agentThinkingLevels: { explorer: "low" },
		}), "utf8");

		const config = await loadConfig(path);
		// Unseen names append in catalog order; previously known ones keep their
		// place. Removed-role names in an old config stay listed but inert.
		expect(config.enabledAgents).toEqual(["explorer", "worker", "reviewer", "executor"]);
		expect([...config.knownAgents].sort()).toEqual(["executor", "explorer", "reviewer", "worker"]);
		// The adopted role follows the explorer lane the user picked.
		expect(config.agentModels).toEqual({
			explorer: "anthropic/claude-haiku-4-5",
			executor: "anthropic/claude-haiku-4-5",
		});
		expect(config.agentThinkingLevels).toEqual({
			explorer: "low",
			executor: "low",
		});

		const saved = JSON.parse(readFileSync(path, "utf8"));
		expect(saved.enabledAgents).toHaveLength(4);
		expect(saved.agentModels.executor).toBe("anthropic/claude-haiku-4-5");

		// Reloading the persisted shape is a no-op: the adoption happened once.
		const reloaded = await loadConfig(path);
		expect(reloaded).toEqual(config);
	});

	it("keeps an explicitly disabled agent disabled once the config knows it", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-subagents-test-"));
		const path = join(dir, "pi-subagents.json");
		writeFileSync(path, JSON.stringify({
			enabledAgents: ["explorer"],
			knownAgents: [...BUILTIN_AGENT_NAMES],
		}), "utf8");

		const config = await loadConfig(path);
		expect(config.enabledAgents).toEqual(["explorer"]);

		const saved = JSON.parse(readFileSync(path, "utf8"));
		expect(saved.enabledAgents).toEqual(["explorer"]);
	});
});
