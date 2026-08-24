import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	BUILTIN_AGENT_NAMES,
	CLEANER_AUTO_ENABLED_FEATURE,
	CLEANER_DEFAULTED_FEATURE,
	CLEANER_INHERITED_FEATURE,
	DEFAULT_ENABLED_AGENTS,
	DEFAULT_IDLE_TIMEOUT_SEC,
	DEFAULT_MAX_CONCURRENCY,
	DEFAULT_MAX_FIX_ROUNDS,
	DEFAULT_MAX_RESULT_LINES,
	DEFAULT_THINKING_LEVEL,
	DOCUMENTER_AUTO_ENABLED_FEATURE,
	DOCUMENTER_DEFAULTED_FEATURE,
	DOCUMENTER_INHERITED_FEATURE,
	IDLE_TIMEOUT_SEC_LIMIT,
	MAX_CONCURRENCY_LIMIT,
	MAX_FIX_ROUNDS_LIMIT,
	MAX_RESULT_LINES_LIMIT,
	loadConfig,
	normalizeConfig,
	saveConfig,
} from "../src/config.ts";

const ROLE_MIGRATIONS_PROCESSED = [CLEANER_DEFAULTED_FEATURE, DOCUMENTER_DEFAULTED_FEATURE];

describe("normalizeConfig", () => {
	it("ships five built-ins but keeps documenter opt-in on a fresh install", () => {
		const config = normalizeConfig(undefined);
		expect(BUILTIN_AGENT_NAMES).toEqual(["explorer", "worker", "cleaner", "documenter", "reviewer"]);
		expect(DEFAULT_ENABLED_AGENTS).toEqual(["explorer", "worker", "cleaner", "reviewer"]);
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
		const config = normalizeConfig({
			enabledAgents: ["explorer", "worker", 42, null, "explorer"],
			announcedFeatures: ROLE_MIGRATIONS_PROCESSED,
		});
		expect(config.enabledAgents).toEqual(["explorer", "worker"]);
	});

	it("migrates the former built-in role name across config fields", () => {
		const config = normalizeConfig({
			enabledAgents: ["explore", "worker", "explorer"],
			agentModels: { explore: "anthropic/legacy" },
			agentThinkingLevels: { explore: "low" },
			announcedFeatures: ROLE_MIGRATIONS_PROCESSED,
		});
		expect(config.enabledAgents).toEqual(["explorer", "worker"]);
		expect(config.agentModels).toEqual({ explorer: "anthropic/legacy" });
		expect(config.agentThinkingLevels).toEqual({ explorer: "low" });
	});

	it("prefers valid explicit explorer settings over legacy keys", () => {
		const config = normalizeConfig({
			agentModels: {
				explore: "anthropic/legacy",
				explorer: "openai/current",
			},
			agentThinkingLevels: { explore: "low", explorer: "high" },
			announcedFeatures: ROLE_MIGRATIONS_PROCESSED,
		});
		expect(config.agentModels).toEqual({ explorer: "openai/current" });
		expect(config.agentThinkingLevels).toEqual({ explorer: "high" });
	});

	it("defaults cleaner on for pre-cleaner configs and inherits reviewer settings", () => {
		const config = normalizeConfig({
			enabledAgents: ["explorer", "worker", "reviewer"],
			agentModels: { reviewer: "anthropic/claude-sonnet-4-5" },
			agentThinkingLevels: { reviewer: "low" },
			announcedFeatures: [DOCUMENTER_DEFAULTED_FEATURE],
		});
		expect(config.enabledAgents).toEqual(["explorer", "worker", "cleaner", "reviewer"]);
		expect(config.agentModels).toEqual({
			reviewer: "anthropic/claude-sonnet-4-5",
			cleaner: "anthropic/claude-sonnet-4-5",
		});
		expect(config.agentThinkingLevels).toEqual({ reviewer: "low", cleaner: "low" });
		expect(config.announcedFeatures).toEqual([
			DOCUMENTER_DEFAULTED_FEATURE,
			CLEANER_DEFAULTED_FEATURE,
			CLEANER_AUTO_ENABLED_FEATURE,
			CLEANER_INHERITED_FEATURE,
		]);
	});

	it("stamps the reviewer inheritance only when settings were actually copied", () => {
		// Reviewer present with only a model override: that one setting is copied
		// and the inheritance stamp is set even though nothing else was.
		const modelOnly = normalizeConfig({
			enabledAgents: ["worker", "reviewer"],
			agentModels: { reviewer: "anthropic/claude-sonnet-4-5" },
			announcedFeatures: [DOCUMENTER_DEFAULTED_FEATURE],
		});
		expect(modelOnly.agentModels).toEqual({
			reviewer: "anthropic/claude-sonnet-4-5",
			cleaner: "anthropic/claude-sonnet-4-5",
		});
		expect(modelOnly.agentThinkingLevels).toEqual({});
		expect(modelOnly.announcedFeatures).toEqual([
			DOCUMENTER_DEFAULTED_FEATURE,
			CLEANER_DEFAULTED_FEATURE,
			CLEANER_AUTO_ENABLED_FEATURE,
			CLEANER_INHERITED_FEATURE,
		]);

		// Reviewer enabled but no overrides to copy: injection still happens, but
		// the inheritance stamp (and the notice's inheritance claim) must not.
		const noOverrides = normalizeConfig({
			enabledAgents: ["worker", "reviewer"],
			announcedFeatures: [DOCUMENTER_DEFAULTED_FEATURE],
		});
		expect(noOverrides.agentModels).toEqual({});
		expect(noOverrides.agentThinkingLevels).toEqual({});
		expect(noOverrides.announcedFeatures).toEqual([
			DOCUMENTER_DEFAULTED_FEATURE,
			CLEANER_DEFAULTED_FEATURE,
			CLEANER_AUTO_ENABLED_FEATURE,
		]);
	});

	it("appends cleaner when an old explicit list has no reviewer to inherit from", () => {
		const config = normalizeConfig({
			enabledAgents: ["worker"],
			announcedFeatures: [DOCUMENTER_DEFAULTED_FEATURE],
		});
		expect(config.enabledAgents).toEqual(["worker", "cleaner"]);
		expect(config.agentModels).toEqual({});
		expect(config.agentThinkingLevels).toEqual({});
		expect(config.announcedFeatures).toEqual([
			DOCUMENTER_DEFAULTED_FEATURE,
			CLEANER_DEFAULTED_FEATURE,
			CLEANER_AUTO_ENABLED_FEATURE,
		]);
	});

	it("stamps a config that already enables cleaner without injecting", () => {
		const config = normalizeConfig({
			enabledAgents: ["explorer", "worker", "cleaner", "reviewer"],
			announcedFeatures: [DOCUMENTER_DEFAULTED_FEATURE],
		});
		expect(config.enabledAgents).toEqual(["explorer", "worker", "cleaner", "reviewer"]);
		expect(config.announcedFeatures).toEqual([DOCUMENTER_DEFAULTED_FEATURE, CLEANER_DEFAULTED_FEATURE]);
	});

	it("respects a deliberate cleaner disable once the upgrade is stamped", () => {
		const existing = ["explorer", "worker", "reviewer"];
		const config = normalizeConfig({
			enabledAgents: existing,
			announcedFeatures: ROLE_MIGRATIONS_PROCESSED,
		});
		expect(config.enabledAgents).toEqual(existing);
		expect(config.announcedFeatures).toEqual(ROLE_MIGRATIONS_PROCESSED);
	});

	it("enables documenter for existing configs and inherits explorer routing", () => {
		const config = normalizeConfig({
			enabledAgents: ["explorer", "worker", "cleaner", "reviewer"],
			agentModels: { explorer: "anthropic/claude-haiku-4-5" },
			agentThinkingLevels: { explorer: "low" },
			announcedFeatures: [CLEANER_DEFAULTED_FEATURE],
		});
		expect(config.enabledAgents).toEqual(["explorer", "worker", "cleaner", "documenter", "reviewer"]);
		expect(config.agentModels).toEqual({
			explorer: "anthropic/claude-haiku-4-5",
			documenter: "anthropic/claude-haiku-4-5",
		});
		expect(config.agentThinkingLevels).toEqual({ explorer: "low", documenter: "low" });
		expect(config.announcedFeatures).toEqual([
			CLEANER_DEFAULTED_FEATURE,
			DOCUMENTER_DEFAULTED_FEATURE,
			DOCUMENTER_AUTO_ENABLED_FEATURE,
			DOCUMENTER_INHERITED_FEATURE,
		]);
	});

	it("does not claim documenter inheritance when explorer has no overrides", () => {
		const config = normalizeConfig({
			enabledAgents: ["worker", "reviewer"],
			announcedFeatures: [CLEANER_DEFAULTED_FEATURE],
		});
		expect(config.enabledAgents).toEqual(["worker", "documenter", "reviewer"]);
		expect(config.agentModels).toEqual({});
		expect(config.agentThinkingLevels).toEqual({});
		expect(config.announcedFeatures).toEqual([
			CLEANER_DEFAULTED_FEATURE,
			DOCUMENTER_DEFAULTED_FEATURE,
			DOCUMENTER_AUTO_ENABLED_FEATURE,
		]);
	});

	it("stamps existing documenter configs and respects a later disable", () => {
		const alreadyEnabled = normalizeConfig({
			enabledAgents: ["worker", "documenter", "reviewer"],
			announcedFeatures: [CLEANER_DEFAULTED_FEATURE],
		});
		expect(alreadyEnabled.enabledAgents).toEqual(["worker", "documenter", "reviewer"]);
		expect(alreadyEnabled.announcedFeatures).toEqual(ROLE_MIGRATIONS_PROCESSED);

		const disabled = normalizeConfig({
			enabledAgents: ["worker", "reviewer"],
			announcedFeatures: ROLE_MIGRATIONS_PROCESSED,
		});
		expect(disabled.enabledAgents).toEqual(["worker", "reviewer"]);
		expect(disabled.announcedFeatures).toEqual(ROLE_MIGRATIONS_PROCESSED);
	});

	it("honors an explicitly empty enabledAgents array", () => {
		const config = normalizeConfig({ enabledAgents: [] });
		expect(config.enabledAgents).toEqual([]);
		expect(config.announcedFeatures).toEqual(ROLE_MIGRATIONS_PROCESSED);
	});

	it("keeps only valid provider/model references in agentModels", () => {
		const config = normalizeConfig({
			agentModels: { explorer: "anthropic/claude-haiku-4-5", bad: "noslash", empty: "  " },
			announcedFeatures: ROLE_MIGRATIONS_PROCESSED,
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
			agentThinkingLevels: { explorer: "high", bad: "ultra", empty: "" },
			announcedFeatures: ROLE_MIGRATIONS_PROCESSED,
		});
		expect(config.agentThinkingLevels).toEqual({ explorer: "high" });
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
			CLEANER_DEFAULTED_FEATURE,
			DOCUMENTER_DEFAULTED_FEATURE,
			DOCUMENTER_AUTO_ENABLED_FEATURE,
		]);
		expect(normalizeConfig({}).announcedFeatures).toEqual([
			CLEANER_DEFAULTED_FEATURE,
			DOCUMENTER_DEFAULTED_FEATURE,
			DOCUMENTER_AUTO_ENABLED_FEATURE,
		]);
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

	it("persists schema upgrades and the explorer key migration", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-subagents-test-"));
		const path = join(dir, "pi-subagents.json");
		// A config written before the pool removal and explorer rename.
		writeFileSync(path, JSON.stringify({
			enabledAgents: ["explore"],
			agentModels: { explore: "anthropic/legacy" },
			agentThinkingLevels: { explore: "low" },
			thinkingLevel: "max",
			agentBackupModels: { explore: "openai/backup" },
		}), "utf8");

		const config = await loadConfig(path);
		expect(config.maxConcurrency).toBe(DEFAULT_MAX_CONCURRENCY);
		expect(config.enabledAgents).toEqual(["explorer", "cleaner", "documenter"]);
		expect(config.agentModels).toEqual({
			explorer: "anthropic/legacy",
			documenter: "anthropic/legacy",
		});
		expect(config.agentThinkingLevels).toEqual({ explorer: "low", documenter: "low" });

		const saved = JSON.parse(readFileSync(path, "utf8"));
		expect(saved.enabledAgents).toEqual(["explorer", "cleaner", "documenter"]);
		expect(saved.agentModels).toEqual({
			explorer: "anthropic/legacy",
			documenter: "anthropic/legacy",
		});
		expect(saved.agentThinkingLevels).toEqual({ explorer: "low", documenter: "low" });
		expect(saved).not.toHaveProperty("agentBackupModels");
		expect(saved).not.toHaveProperty("thinkingLevel");
		expect(saved.maxConcurrency).toBe(DEFAULT_MAX_CONCURRENCY);
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
		expect(config.enabledAgents).toEqual(["explorer", "cleaner", "documenter"]);
		expect(config.agentModels).toEqual({});

		const saved = JSON.parse(readFileSync(path, "utf8"));
		expect(saved.enabledAgents).toEqual(["explorer", "cleaner", "documenter"]);
		expect(saved.agentModels).toEqual({});
	});
});
