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
	IDLE_TIMEOUT_SEC_LIMIT,
	MAX_RESULT_LINES_LIMIT,
	loadConfig,
	normalizeConfig,
	roleThinkingLevel,
	saveConfig,
	type SubagentsConfig,
} from "../src/configuration/config.ts";

describe("catalog", () => {
	it("ships four built-ins and enables them by default", () => {
		assert.deepEqual(BUILTIN_AGENT_NAMES, ["scout", "artisan", "steward", "sentinel"]);
		assert.deepEqual(DEFAULT_ENABLED_AGENTS, [...BUILTIN_AGENT_NAMES]);
	});

	it("assigns a role thinking default and leaves custom names on medium", () => {
		assert.equal(roleThinkingLevel("scout"), "low");
		assert.equal(roleThinkingLevel("artisan"), "high");
		assert.equal(roleThinkingLevel("steward"), "medium");
		assert.equal(roleThinkingLevel("sentinel"), "high");
		assert.equal(roleThinkingLevel("custom"), "medium");
	});

});

describe("normalizeConfig", () => {
	it("enables the full team on a fresh install", () => {
		const config = normalizeConfig(undefined);
		assert.deepEqual(config.enabledAgents, [...DEFAULT_ENABLED_AGENTS]);
		assert.equal(config.agentScope, "user");
		assert.deepEqual(config.knownAgents, [...BUILTIN_AGENT_NAMES]);
		assert.deepEqual(config.agentModels, {});
		assert.deepEqual(config.agentThinkingLevels, {});
	});

	it("keeps valid enabledAgents and drops non-strings", () => {
		const config = normalizeConfig({
			enabledAgents: ["scout", "artisan", 42, null, "scout"],
		});
		assert.deepEqual(config.enabledAgents, ["scout", "artisan"]);
	});

	it("honors an explicitly empty enabledAgents array", () => {
		const config = normalizeConfig({ enabledAgents: [] });
		assert.deepEqual(config.enabledAgents, []);
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

describe("loadConfig", () => {
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

	it("persists the canonical supported fields without unknown keys", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-subagents-test-"));
		const path = join(dir, "pi-subagents.json");
		writeFileSync(path, JSON.stringify({
			enabledAgents: ["artisan"],
			knownAgents: [...BUILTIN_AGENT_NAMES],
			agentModels: { artisan: "anthropic/primary" },
			agentThinkingLevels: { artisan: "high" },
			unknownKey: true,
		}), "utf8");

		const config = await loadConfig(path);
		assert.deepEqual(config.enabledAgents, ["artisan"]);
		assert.deepEqual(config.knownAgents, [...BUILTIN_AGENT_NAMES]);
		assert.equal(config.agentModels.artisan, "anthropic/primary");
		assert.equal(config.agentThinkingLevels.artisan, "high");

		const saved = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
		assert.ok(!("unknownKey" in saved));
	});

	it("adopts sentinel once for configs written before it shipped and keeps a deliberate disable", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-subagents-test-"));
		const path = join(dir, "pi-subagents.json");
		writeFileSync(path, JSON.stringify({
			enabledAgents: ["scout", "custom-worker"],
			knownAgents: ["scout", "artisan", "steward", "custom-worker"],
			agentModels: { "custom-worker": "anthropic/custom" },
		}), "utf8");

		const adopted = await loadConfig(path);
		assert.deepEqual(adopted.enabledAgents, ["scout", "custom-worker", "sentinel"]);
		assert.deepEqual(adopted.knownAgents, ["scout", "artisan", "steward", "custom-worker", "sentinel"]);
		assert.deepEqual(adopted.agentModels, { "custom-worker": "anthropic/custom" });
		const saved = JSON.parse(readFileSync(path, "utf8")) as SubagentsConfig;
		assert.deepEqual(saved.enabledAgents, adopted.enabledAgents);
		assert.deepEqual(saved.knownAgents, adopted.knownAgents);

		await saveConfig({ ...adopted, enabledAgents: ["scout", "custom-worker"] }, path);
		const disabled = await loadConfig(path);
		assert.deepEqual(disabled.enabledAgents, ["scout", "custom-worker"]);
		assert.ok(disabled.knownAgents.includes("sentinel"));
	});

	it("treats a config without adoption tracking as the original three-role catalog", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-subagents-test-"));
		const path = join(dir, "pi-subagents.json");
		writeFileSync(path, JSON.stringify({ enabledAgents: ["artisan"] }), "utf8");

		const config = await loadConfig(path);
		assert.deepEqual(config.enabledAgents, ["artisan", "sentinel"]);
		assert.deepEqual(config.knownAgents, ["scout", "artisan", "steward", "sentinel"]);
	});

	it("round-trips selected models and thinking preferences", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-subagents-test-"));
		const path = join(dir, "pi-subagents.json");
		const config = normalizeConfig({
			enabledAgents: [...BUILTIN_AGENT_NAMES],
			agentModels: { artisan: "anthropic/primary" },
			agentThinkingLevels: { artisan: "high" },
		});
		await saveConfig(config, path);
		const loaded = await loadConfig(path);
		assert.deepEqual(loaded.agentModels, { artisan: "anthropic/primary" });
		assert.deepEqual(loaded.agentThinkingLevels, { artisan: "high" });
	});
});
