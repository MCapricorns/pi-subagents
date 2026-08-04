import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	DEFAULT_ENABLED_AGENTS,
	DEFAULT_MAX_CONCURRENCY,
	DEFAULT_MAX_FIX_ROUNDS,
	DEFAULT_MAX_RESULT_LINES,
	DEFAULT_MAX_SUBAGENT_DEPTH,
	DEFAULT_THINKING_LEVEL,
	MAX_CONCURRENCY_LIMIT,
	MAX_FIX_ROUNDS_LIMIT,
	MAX_RESULT_LINES_LIMIT,
	loadConfig,
	normalizeConfig,
} from "../src/config.ts";

describe("normalizeConfig", () => {
	it("returns defaults for non-object input", () => {
		const config = normalizeConfig(undefined);
		expect(config.enabledAgents).toEqual([...DEFAULT_ENABLED_AGENTS]);
		expect(config.proactiveInjection).toBe(true);
		expect(config.agentScope).toBe("user");
		expect(config.agentModels).toEqual({});
		expect(config.agentThinkingLevels).toEqual({});
		expect(config.thinkingLevel).toBe(DEFAULT_THINKING_LEVEL);
		expect(config.notifyOnReviewPass).toBe(false);
		expect(config.maxConcurrency).toBe(DEFAULT_MAX_CONCURRENCY);
		expect(config.maxSubagentDepth).toBe(DEFAULT_MAX_SUBAGENT_DEPTH);
	});

	it("keeps valid enabledAgents and drops non-strings", () => {
		const config = normalizeConfig({ enabledAgents: ["explore", "worker", 42, null, "explore"] });
		expect(config.enabledAgents).toEqual(["explore", "worker"]);
	});

	it("strips removed agents from upgraded configs", () => {
		const config = normalizeConfig({
			enabledAgents: ["explore", "plan", "worker"],
			agentModels: { plan: "anthropic/claude-haiku-4-5", worker: "openai/gpt-5" },
			agentThinkingLevels: { plan: "high", worker: "medium" },
		});
		expect(config.enabledAgents).toEqual(["explore", "worker"]);
		expect(config.agentModels).toEqual({ worker: "openai/gpt-5" });
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

	it("accepts maxSubagentDepth including 0 (tool disabled)", () => {
		expect(normalizeConfig({ maxSubagentDepth: 0 }).maxSubagentDepth).toBe(0);
		expect(normalizeConfig({ maxSubagentDepth: 2.6 }).maxSubagentDepth).toBe(3);
		expect(normalizeConfig({ maxSubagentDepth: 99 }).maxSubagentDepth).toBe(4);
		expect(normalizeConfig({ maxSubagentDepth: "deep" }).maxSubagentDepth).toBe(DEFAULT_MAX_SUBAGENT_DEPTH);
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

	it("persists schema upgrades: missing new fields are filled in and saved back", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-subagents-test-"));
		const path = join(dir, "pi-subagents.json");
		// A config written by an older version, without the numeric limits.
		writeFileSync(path, JSON.stringify({ enabledAgents: ["explore"], thinkingLevel: "high" }), "utf8");

		const config = await loadConfig(path);
		expect(config.maxConcurrency).toBe(DEFAULT_MAX_CONCURRENCY);
		expect(config.maxSubagentDepth).toBe(DEFAULT_MAX_SUBAGENT_DEPTH);

		const saved = JSON.parse(readFileSync(path, "utf8"));
		expect(saved.enabledAgents).toEqual(["explore"]);
		expect(saved.thinkingLevel).toBe("high");
		expect(saved.maxConcurrency).toBe(DEFAULT_MAX_CONCURRENCY);
		expect(saved.maxSubagentDepth).toBe(DEFAULT_MAX_SUBAGENT_DEPTH);
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
