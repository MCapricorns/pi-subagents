import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { describe, it, type TestContext } from "node:test";
import {
	BUILTIN_AGENT_NAMES,
	DEFAULT_IDLE_TIMEOUT_SEC,
	DEFAULT_MAX_RESULT_LINES,
	loadConfig,
	normalizeConfig,
	roleThinkingLevel,
	saveConfig,
} from "../src/configuration/config.ts";

describe("catalog", () => {
	it("ships scout and artisan", () => {
		assert.deepEqual(BUILTIN_AGENT_NAMES, ["scout", "artisan"]);
	});

	it("assigns a role thinking default and leaves other names on medium", () => {
		assert.equal(roleThinkingLevel("scout"), "low");
		assert.equal(roleThinkingLevel("artisan"), "high");
		assert.equal(roleThinkingLevel("custom"), "medium");
	});
});

describe("normalizeConfig", () => {
	it("starts empty on a fresh install", () => {
		const config = normalizeConfig(undefined);
		assert.deepEqual(config.agentModels, {});
		assert.deepEqual(config.agentThinkingLevels, {});
	});

	it("keeps only valid provider/model references in agentModels", () => {
		const config = normalizeConfig({
			agentModels: { scout: "anthropic/claude-haiku-4-5", bad: "noslash", empty: "  " },
		});
		assert.deepEqual(config.agentModels, { scout: "anthropic/claude-haiku-4-5" });
	});

	it("keeps only valid thinking levels in agentThinkingLevels", () => {
		const config = normalizeConfig({
			agentThinkingLevels: { artisan: "high", bad: "ultra", empty: "" },
		});
		assert.deepEqual(config.agentThinkingLevels, { artisan: "high" });
	});

	it("drops removed config-file options from older versions", () => {
		const config = normalizeConfig({
			enabledAgents: ["artisan"],
			knownAgents: ["scout", "artisan"],
			agentScope: "both",
			maxResultLines: 12,
			maxConcurrentAgents: 3,
			idleTimeoutSec: 60,
			agentModels: { artisan: "anthropic/primary" },
		});
		assert.deepEqual(config, {
			agentModels: { artisan: "anthropic/primary" },
			agentThinkingLevels: {},
		});
	});

	it("keeps the operational defaults as constants", () => {
		assert.equal(DEFAULT_MAX_RESULT_LINES, 40);
		assert.equal(DEFAULT_IDLE_TIMEOUT_SEC, 1800);
	});
});

describe("loadConfig", () => {
	function tempDir(t: TestContext): string {
		const dir = mkdtempSync(join(tmpdir(), "pi-subagents-test-"));
		t.after(() => rmSync(dir, { recursive: true, force: true }));
		return dir;
	}

	it("returns defaults when the file is missing", async (t) => {
		const dir = tempDir(t);
		const config = await loadConfig(join(dir, "does-not-exist.json"));
		assert.deepEqual(config, { agentModels: {}, agentThinkingLevels: {} });
	});

	it("falls back to defaults on corrupt JSON instead of throwing", async (t) => {
		const dir = tempDir(t);
		const path = join(dir, "corrupt.json");
		writeFileSync(path, "{ not json", "utf8");
		const config = await loadConfig(path);
		assert.deepEqual(config, { agentModels: {}, agentThinkingLevels: {} });
	});

	it("persists the canonical shape without obsolete or unknown keys", async (t) => {
		const dir = tempDir(t);
		const path = join(dir, "pi-subagents.json");
		writeFileSync(path, JSON.stringify({
			enabledAgents: ["artisan"],
			agentModels: { artisan: "anthropic/primary" },
			agentThinkingLevels: { artisan: "high" },
			unknownKey: true,
		}), "utf8");

		const config = await loadConfig(path);
		assert.equal(config.agentModels.artisan, "anthropic/primary");
		assert.equal(config.agentThinkingLevels.artisan, "high");

		const saved = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
		assert.ok(!("unknownKey" in saved));
		assert.ok(!("enabledAgents" in saved));
	});

	it("round-trips selected models and thinking preferences", async (t) => {
		const dir = tempDir(t);
		const path = join(dir, "pi-subagents.json");
		await saveConfig(normalizeConfig({
			agentModels: { artisan: "anthropic/primary" },
			agentThinkingLevels: { artisan: "high" },
		}), path);
		const loaded = await loadConfig(path);
		assert.deepEqual(loaded.agentModels, { artisan: "anthropic/primary" });
		assert.deepEqual(loaded.agentThinkingLevels, { artisan: "high" });
	});
});
