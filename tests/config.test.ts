import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	BUILTIN_AGENT_NAMES,
	DEFAULT_ENABLED_AGENTS,
	DEFAULT_IDLE_TIMEOUT_SEC,
	DEFAULT_MAX_RESULT_LINES,
	DEFAULT_THINKING_LEVEL,
	IDLE_TIMEOUT_SEC_LIMIT,
	MAX_RESULT_LINES_LIMIT,
	loadConfig,
	normalizeConfig,
	saveConfig,
} from "../src/config.ts";

describe("normalizeConfig", () => {
	it("ships five built-ins and enables all of them on a fresh install", () => {
		const config = normalizeConfig(undefined);
		expect(BUILTIN_AGENT_NAMES).toEqual(["explorer", "worker", "cleaner", "documenter", "synthesizer", "reviewer"]);
		expect(DEFAULT_ENABLED_AGENTS).toEqual([...BUILTIN_AGENT_NAMES]);
		expect(config.enabledAgents).toEqual([...DEFAULT_ENABLED_AGENTS]);
		expect(config.knownAgents).toEqual([...BUILTIN_AGENT_NAMES]);
		expect(config.agentScope).toBe("user");
		expect(config.agentModels).toEqual({});
		expect(config.agentThinkingLevels).toEqual({});
		expect(config.notifyOnReviewPass).toBe(false);
	});

	it("seeds knownAgents from enabledAgents and keeps explicit entries", () => {
		const config = normalizeConfig({ enabledAgents: ["worker"], knownAgents: ["explorer", 42, "worker"] });
		expect(config.enabledAgents).toEqual(["worker"]);
		expect(config.knownAgents).toEqual(["explorer", "worker"]);
		// An empty record still means the fresh-install default catalog.
		expect(normalizeConfig({}).knownAgents).toEqual([...BUILTIN_AGENT_NAMES]);
	});

	it("drops the removed tuning keys instead of honoring them", () => {
		const config = normalizeConfig({ maxConcurrency: 9, maxFixRounds: 0, announcedFeatures: ["x"] });
		expect(config).not.toHaveProperty("maxConcurrency");
		expect(config).not.toHaveProperty("maxFixRounds");
		expect(config).not.toHaveProperty("announcedFeatures");
	});

	it("keeps valid enabledAgents and drops non-strings", () => {
		const config = normalizeConfig({
			enabledAgents: ["explorer", "worker", 42, null, "explorer"],
		});
		expect(config.enabledAgents).toEqual(["explorer", "worker"]);
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

	it("drops legacy backup-pool and global-thinking keys", () => {
		const config = normalizeConfig({
			agentBackupModels: { explorer: "anthropic/claude-sonnet-4-5" },
			thinkingLevel: "max",
		});
		expect(config).not.toHaveProperty("agentBackupModels");
		expect(config).not.toHaveProperty("thinkingLevel");
	});

	it("defaults maxResultLines to 40 and clamps invalid values", () => {
		expect(DEFAULT_MAX_RESULT_LINES).toBe(40);
		expect(normalizeConfig({ maxResultLines: 200 }).maxResultLines).toBe(200);
		expect(normalizeConfig({ maxResultLines: 99_999 }).maxResultLines).toBe(MAX_RESULT_LINES_LIMIT);
		expect(normalizeConfig({ maxResultLines: "many" }).maxResultLines).toBe(DEFAULT_MAX_RESULT_LINES);
	});

	it("uses high as the fallback Auto preference for agents without a declaration", () => {
		expect(DEFAULT_THINKING_LEVEL).toBe("high");
	});

	it("keeps only valid thinking levels in agentThinkingLevels", () => {
		const config = normalizeConfig({
			agentThinkingLevels: { explorer: "high", bad: "ultra", empty: "" },
		});
		expect(config.agentThinkingLevels).toEqual({ explorer: "high" });
	});

	it("defaults notifyOnReviewPass to false and preserves an explicit true", () => {
		expect(normalizeConfig({}).notifyOnReviewPass).toBe(false);
		expect(normalizeConfig({ notifyOnReviewPass: true }).notifyOnReviewPass).toBe(true);
		expect(normalizeConfig({ notifyOnReviewPass: "yes" }).notifyOnReviewPass).toBe(false);
	});

	it("drops the retired proactiveInjection toggle", () => {
		expect("proactiveInjection" in normalizeConfig({ proactiveInjection: false })).toBe(false);
		expect("proactiveInjection" in normalizeConfig({})).toBe(false);
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

	it("drops the obsolete visionModel key during normalization", () => {
		expect("visionModel" in normalizeConfig({ visionModel: "anthropic/claude-sonnet-4-5" })).toBe(false);
		expect("visionModel" in normalizeConfig({})).toBe(false);
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
		for (const key of ["agentBackupModels", "thinkingLevel", "maxConcurrency", "maxFixRounds", "proactiveInjection", "announcedFeatures"]) {
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

	it("adopts unseen built-ins on an old-version upgrade and follows explorer's route", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-subagents-test-"));
		const path = join(dir, "pi-subagents.json");
		writeFileSync(path, JSON.stringify({
			enabledAgents: ["explorer", "worker", "reviewer"],
			agentModels: { explorer: "anthropic/claude-haiku-4-5" },
			agentThinkingLevels: { explorer: "low" },
		}), "utf8");

		const config = await loadConfig(path);
		// Unseen names append in catalog order; previously known ones keep their place.
		expect([...config.enabledAgents].sort()).toEqual([...BUILTIN_AGENT_NAMES].sort());
		expect([...config.knownAgents].sort()).toEqual([...BUILTIN_AGENT_NAMES].sort());
		// The adopted light roles follow the explorer lane the user picked.
		expect(config.agentModels).toEqual({
			explorer: "anthropic/claude-haiku-4-5",
			cleaner: "anthropic/claude-haiku-4-5",
			documenter: "anthropic/claude-haiku-4-5",
			synthesizer: "anthropic/claude-haiku-4-5",
		});
		expect(config.agentThinkingLevels).toEqual({
			explorer: "low",
			cleaner: "low",
			documenter: "low",
			synthesizer: "low",
		});

		const saved = JSON.parse(readFileSync(path, "utf8"));
		expect(saved.enabledAgents).toHaveLength(BUILTIN_AGENT_NAMES.length);
		expect(saved.agentModels.synthesizer).toBe("anthropic/claude-haiku-4-5");

		// Reloading the persisted shape is a no-op: the adoption happened once.
		const reloaded = await loadConfig(path);
		expect(reloaded).toEqual(config);
	});

	it("keeps an explicitly disabled agent disabled once the config knows it", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-subagents-test-"));
		const path = join(dir, "pi-subagents.json");
		writeFileSync(path, JSON.stringify({
			enabledAgents: ["explorer", "worker", "reviewer"],
			knownAgents: [...BUILTIN_AGENT_NAMES],
		}), "utf8");

		const config = await loadConfig(path);
		expect(config.enabledAgents).toEqual(["explorer", "worker", "reviewer"]);

		const saved = JSON.parse(readFileSync(path, "utf8"));
		expect(saved.enabledAgents).toEqual(["explorer", "worker", "reviewer"]);
	});
});
