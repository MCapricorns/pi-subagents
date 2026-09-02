import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	BUILTIN_AGENT_NAMES,
	DEFAULT_ENABLED_AGENTS,
	DEFAULT_IDLE_TIMEOUT_SEC,
	DEFAULT_MAX_RESULT_LINES,
	FIRST_RUN_SETUP_HINT,
	IDLE_TIMEOUT_SEC_LIMIT,
	MAX_RESULT_LINES_LIMIT,
	REQUIRED_ENABLED_AGENTS,
	TEAM_SETUP_NOTICE,
	loadConfig,
	normalizeConfig,
	roleThinkingLevel,
	saveConfig,
	withRequiredAgents,
} from "../src/config.ts";

describe("catalog", () => {
	it("ships three built-ins and keeps all of them on", () => {
		assert.deepEqual(BUILTIN_AGENT_NAMES, ["scout", "artisan", "steward"]);
		assert.deepEqual(DEFAULT_ENABLED_AGENTS, [...BUILTIN_AGENT_NAMES]);
		assert.deepEqual(REQUIRED_ENABLED_AGENTS, [...BUILTIN_AGENT_NAMES]);
		assert.deepEqual(withRequiredAgents([]), ["scout", "artisan", "steward"]);
		assert.deepEqual(withRequiredAgents(["scout"]), ["scout", "artisan", "steward"]);
	});

	it("assigns a role thinking default and leaves custom names on medium", () => {
		assert.equal(roleThinkingLevel("scout"), "low");
		assert.equal(roleThinkingLevel("artisan"), "high");
		assert.equal(roleThinkingLevel("steward"), "medium");
		assert.equal(roleThinkingLevel("custom"), "medium");
	});
});

describe("normalizeConfig", () => {
	it("enables the full team on a fresh install", () => {
		const config = normalizeConfig(undefined);
		assert.deepEqual(config.enabledAgents, [...DEFAULT_ENABLED_AGENTS]);
		assert.deepEqual(config.knownAgents, [...BUILTIN_AGENT_NAMES]);
		assert.equal(config.agentScope, "user");
		assert.deepEqual(config.agentModels, {});
		assert.deepEqual(config.agentThinkingLevels, {});
	});

	it("seeds knownAgents from enabledAgents and keeps explicit entries", () => {
		const config = normalizeConfig({ enabledAgents: ["artisan"], knownAgents: ["scout", 42, "artisan"] });
		assert.deepEqual(config.enabledAgents, ["artisan"]);
		assert.deepEqual(config.knownAgents, ["scout", "artisan"]);
		assert.deepEqual(normalizeConfig({}).knownAgents, [...BUILTIN_AGENT_NAMES]);
	});

	it("drops the removed tuning keys instead of honoring them", () => {
		const config = normalizeConfig({
			maxConcurrency: 9,
			maxFixRounds: 0,
			announcedFeatures: ["x"],
			notifyOnReviewPass: true,
		});
		assert.ok(!("maxConcurrency" in config));
		assert.ok(!("maxFixRounds" in config));
		assert.ok(!("announcedFeatures" in config));
		assert.ok(!("notifyOnReviewPass" in config));
	});

	it("keeps valid enabledAgents and drops non-strings", () => {
		const config = normalizeConfig({
			enabledAgents: ["scout", "artisan", 42, null, "scout"],
		});
		assert.deepEqual(config.enabledAgents, ["scout", "artisan"]);
	});

	it("honors an explicitly empty enabledAgents array before load-time force", () => {
		assert.deepEqual(normalizeConfig({ enabledAgents: [] }).enabledAgents, []);
	});

	it("keeps only valid provider/model references in agentModels", () => {
		const config = normalizeConfig({
			agentModels: { scout: "anthropic/claude-haiku-4-5", bad: "noslash", empty: "  " },
		});
		assert.deepEqual(config.agentModels, { scout: "anthropic/claude-haiku-4-5" });
	});

	it("defaults maxResultLines to 40 and clamps invalid values", () => {
		assert.equal(DEFAULT_MAX_RESULT_LINES, 40);
		assert.equal(normalizeConfig({ maxResultLines: 200 }).maxResultLines, 200);
		assert.equal(normalizeConfig({ maxResultLines: 99_999 }).maxResultLines, MAX_RESULT_LINES_LIMIT);
		assert.equal(normalizeConfig({ maxResultLines: "many" }).maxResultLines, DEFAULT_MAX_RESULT_LINES);
	});

	it("keeps only valid thinking levels in agentThinkingLevels", () => {
		const config = normalizeConfig({
			agentThinkingLevels: { artisan: "high", bad: "ultra", empty: "" },
		});
		assert.deepEqual(config.agentThinkingLevels, { artisan: "high" });
	});

	it("validates agentScope", () => {
		assert.equal(normalizeConfig({ agentScope: "both" }).agentScope, "both");
		assert.equal(normalizeConfig({ agentScope: "everywhere" }).agentScope, "user");
	});

	it("defaults idleTimeoutSec to 90 and clamps to [0, 600]", () => {
		assert.equal(DEFAULT_IDLE_TIMEOUT_SEC, 90);
		assert.equal(normalizeConfig({}).idleTimeoutSec, 90);
		assert.equal(normalizeConfig({ idleTimeoutSec: 0 }).idleTimeoutSec, 0);
		assert.equal(normalizeConfig({ idleTimeoutSec: 120 }).idleTimeoutSec, 120);
		assert.equal(normalizeConfig({ idleTimeoutSec: 999 }).idleTimeoutSec, IDLE_TIMEOUT_SEC_LIMIT);
		assert.equal(normalizeConfig({ idleTimeoutSec: 45.6 }).idleTimeoutSec, 46);
		assert.equal(normalizeConfig({ idleTimeoutSec: "off" }).idleTimeoutSec, DEFAULT_IDLE_TIMEOUT_SEC);
	});
});

describe("loadConfig migration", () => {
	it("returns defaults when the file is missing", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-subagents-test-"));
		const config = await loadConfig(join(dir, "does-not-exist.json"));
		assert.deepEqual(config.enabledAgents, [...DEFAULT_ENABLED_AGENTS]);
	});

	it("falls back to defaults on corrupt JSON instead of throwing", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-subagents-test-"));
		const path = join(dir, "corrupt.json");
		writeFileSync(path, "{ not json", "utf8");
		const config = await loadConfig(path);
		assert.deepEqual(config.enabledAgents, [...DEFAULT_ENABLED_AGENTS]);
		assert.equal(config.agentScope, "user");
	});

	it("renames explorer/executor, adopts steward, and keeps their model and thinking", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-subagents-test-"));
		const path = join(dir, "pi-subagents.json");
		writeFileSync(path, JSON.stringify({
			enabledAgents: ["explorer", "executor", "worker"],
			knownAgents: ["explorer", "executor", "worker"],
			agentModels: {
				explorer: "anthropic/claude-haiku-4-5",
				executor: "anthropic/claude-sonnet-4-5",
			},
			agentThinkingLevels: { explorer: "low", executor: "high" },
			maxConcurrency: 12,
		}), "utf8");

		const config = await loadConfig(path);
		assert.deepEqual(config.enabledAgents, ["scout", "artisan", "steward"]);
		assert.deepEqual([...config.knownAgents].sort(), ["artisan", "scout", "steward"]);
		assert.deepEqual(config.agentModels, {
			scout: "anthropic/claude-haiku-4-5",
			artisan: "anthropic/claude-sonnet-4-5",
		});
		assert.deepEqual(config.agentThinkingLevels, { scout: "low", artisan: "high" });
		assert.equal(config.pendingSetupNotice, TEAM_SETUP_NOTICE);
		assert.ok(FIRST_RUN_SETUP_HINT.includes("/subagents-setup"));

		const saved = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
		assert.deepEqual(saved.enabledAgents, ["scout", "artisan", "steward"]);
		assert.deepEqual(saved.agentModels, {
			scout: "anthropic/claude-haiku-4-5",
			artisan: "anthropic/claude-sonnet-4-5",
		});
		assert.ok(!("explorer" in (saved.agentModels as object)));
		assert.ok(!("executor" in (saved.agentModels as object)));
		assert.ok(!("maxConcurrency" in saved));
	});

	it("forces a disabled scout back on and does not copy scout's model onto steward", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-subagents-test-"));
		const path = join(dir, "pi-subagents.json");
		writeFileSync(path, JSON.stringify({
			enabledAgents: ["artisan"],
			knownAgents: ["scout", "artisan"],
			agentModels: { scout: "anthropic/claude-haiku-4-5" },
		}), "utf8");

		const config = await loadConfig(path);
		assert.ok(config.enabledAgents.includes("scout"));
		assert.ok(config.enabledAgents.includes("artisan"));
		assert.ok(config.enabledAgents.includes("steward"));
		assert.equal(config.agentModels.steward, undefined);
		assert.equal(config.agentModels.scout, "anthropic/claude-haiku-4-5");
	});

	it("round-trips selected models and thinking preferences under the new names", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-subagents-test-"));
		const path = join(dir, "pi-subagents.json");
		const config = normalizeConfig({
			enabledAgents: [...BUILTIN_AGENT_NAMES],
			knownAgents: [...BUILTIN_AGENT_NAMES],
			agentModels: { artisan: "anthropic/primary" },
			agentThinkingLevels: { artisan: "high" },
		});
		await saveConfig(config, path);
		const loaded = await loadConfig(path);
		assert.deepEqual(loaded.agentModels, { artisan: "anthropic/primary" });
		assert.deepEqual(loaded.agentThinkingLevels, { artisan: "high" });
	});
});
