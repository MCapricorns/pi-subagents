import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	DEFAULT_ENABLED_AGENTS,
	DEFAULT_MAX_CONCURRENCY,
	DEFAULT_MAX_PARALLEL_TASKS,
	DEFAULT_MAX_SUBAGENT_DEPTH,
	DEFAULT_THINKING_LEVEL,
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
		expect(config.maxConcurrency).toBe(DEFAULT_MAX_CONCURRENCY);
		expect(config.maxParallelTasks).toBe(DEFAULT_MAX_PARALLEL_TASKS);
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

	it("accepts a boolean proactiveInjection", () => {
		expect(normalizeConfig({ proactiveInjection: false }).proactiveInjection).toBe(false);
		expect(normalizeConfig({ proactiveInjection: "nope" }).proactiveInjection).toBe(true);
	});

	it("validates agentScope", () => {
		expect(normalizeConfig({ agentScope: "both" }).agentScope).toBe("both");
		expect(normalizeConfig({ agentScope: "everywhere" }).agentScope).toBe("user");
	});

	it("clamps the numeric limits and rejects non-numbers", () => {
		const config = normalizeConfig({ maxConcurrency: 6, maxParallelTasks: 12 });
		expect(config.maxConcurrency).toBe(6);
		expect(config.maxParallelTasks).toBe(12);

		const clamped = normalizeConfig({ maxConcurrency: 0, maxParallelTasks: 999 });
		expect(clamped.maxConcurrency).toBe(1);
		expect(clamped.maxParallelTasks).toBe(32);

		const invalid = normalizeConfig({ maxConcurrency: "many", maxParallelTasks: Number.NaN });
		expect(invalid.maxConcurrency).toBe(DEFAULT_MAX_CONCURRENCY);
		expect(invalid.maxParallelTasks).toBe(DEFAULT_MAX_PARALLEL_TASKS);
	});

	it("accepts maxSubagentDepth including 0 (tool disabled)", () => {
		expect(normalizeConfig({ maxSubagentDepth: 0 }).maxSubagentDepth).toBe(0);
		expect(normalizeConfig({ maxSubagentDepth: 2.6 }).maxSubagentDepth).toBe(3);
		expect(normalizeConfig({ maxSubagentDepth: 99 }).maxSubagentDepth).toBe(4);
		expect(normalizeConfig({ maxSubagentDepth: "deep" }).maxSubagentDepth).toBe(DEFAULT_MAX_SUBAGENT_DEPTH);
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
		expect(config.maxParallelTasks).toBe(DEFAULT_MAX_PARALLEL_TASKS);
		expect(config.maxSubagentDepth).toBe(DEFAULT_MAX_SUBAGENT_DEPTH);

		const saved = JSON.parse(readFileSync(path, "utf8"));
		expect(saved.enabledAgents).toEqual(["explore"]);
		expect(saved.thinkingLevel).toBe("high");
		expect(saved.maxConcurrency).toBe(DEFAULT_MAX_CONCURRENCY);
		expect(saved.maxParallelTasks).toBe(DEFAULT_MAX_PARALLEL_TASKS);
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
