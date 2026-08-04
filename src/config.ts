/**
 * Configuration load/save for pi-subagents.
 *
 * Config lives at <agentDir>/pi-subagents.json (agentDir defaults to ~/.pi/agent
 * and honors PI_CODING_AGENT_DIR). Parsing is defensive: invalid fields fall back
 * to defaults instead of throwing, so a hand-edited or partially-written file can
 * never break the extension at runtime.
 *
 * Schema upgrades happen transparently on load: a config written by an older
 * version (missing newer keys, holding removed agents, or containing invalid
 * values) is normalized and persisted back with the new fields filled in.
 */

import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir, withFileMutationQueue } from "@earendil-works/pi-coding-agent";

/** Full catalog of agents shipped with the package (selectable in /subagents-setup). */
export const BUILTIN_AGENT_NAMES = ["explore", "worker", "reviewer"] as const;
export type BuiltinAgentName = (typeof BUILTIN_AGENT_NAMES)[number];

/** Agents enabled out of the box. */
export const DEFAULT_ENABLED_AGENTS: readonly string[] = ["explore", "worker", "reviewer"];

/**
 * Agents that used to ship but were removed. normalizeConfig strips them from
 * enabledAgents/agentModels so upgraded installs clean their config automatically
 * (the schema-upgrade save in loadConfig then persists the cleanup).
 */
export const REMOVED_AGENT_NAMES: readonly string[] = ["plan"];

export const AGENT_SCOPE_VALUES = ["user", "project", "both"] as const;
export type AgentScope = (typeof AGENT_SCOPE_VALUES)[number];

/** Thinking levels accepted by pi's `--thinking` option. */
export const THINKING_LEVEL_VALUES = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVEL_VALUES)[number];
export const DEFAULT_THINKING_LEVEL: ThinkingLevel = "high";

/** How many lines of a sub-agent result the completion message may carry. Default: 80. */
export const DEFAULT_MAX_RESULT_LINES = 80;
/** Upper bound accepted for maxResultLines (defensive clamp). */
export const MAX_RESULT_LINES_LIMIT = 2000;

export const CONFIG_FILE_NAME = "pi-subagents.json";

/** How many sub-agent processes may run at once, and how many tasks one parallel `subagent` call may contain. Default: 4. */
export const DEFAULT_MAX_CONCURRENCY = 4;
/** Upper bound accepted for maxConcurrency (defensive clamp). */
export const MAX_CONCURRENCY_LIMIT = 16;
/**
 * How many automatic worker→reviewer fix rounds run when a reviewer returns
 * REVIEW_FAIL before waking the main agent. 0 disables the auto-fix loop
 * (the main agent is woken to dispatch fixes itself). Default: 2.
 */
export const DEFAULT_MAX_FIX_ROUNDS = 2;
/** Upper bound accepted for maxFixRounds (defensive clamp). 0 disables the loop. */
export const MAX_FIX_ROUNDS_LIMIT = 5;

export interface SubagentsConfig {
	/** Agent names that are discoverable and injected. Default: explore, worker, reviewer. */
	enabledAgents: string[];
	/** Per-agent model override, keyed by agent name, as "provider/model-id". */
	agentModels: Record<string, string>;
	/** Per-agent thinking-level override, keyed by agent name. */
	agentThinkingLevels: Record<string, ThinkingLevel>;
	/** Thinking level for sub-agents without a per-agent override or frontmatter default. Default: "high". */
	thinkingLevel: ThinkingLevel;
	/**
	 * When a review passes (REVIEW_PASS verdict), deliver it without waking the
	 * main agent. Disabled by default so passing reviews still resume orchestration.
	 */
	notifyOnReviewPass: boolean;
	/**
	 * Max lines of a sub-agent result carried in the completion message. Longer
	 * results are truncated; the full text is written to a temp file whose path
	 * is included in the message. Default: 80.
	 */
	maxResultLines: number;
	/** Whether to inject the delegation directive into the parent system prompt. Default: true. */
	proactiveInjection: boolean;
	/** Which agent directories to discover from. Default: "user". */
	agentScope: AgentScope;
	/** Max sub-agent processes running at once (extra work queues) and the max tasks
	 * one parallel `subagent` call may contain. Default: 4. */
	maxConcurrency: number;
	/**
	 * Auto-fix rounds when a reviewer returns REVIEW_FAIL: the extension dispatches
	 * a worker (briefed with the review's concrete findings) then a reviewer
	 * re-review, repeating up to this many times before waking the main agent with
	 * the full chain. 0 disables it (the main agent handles fixes itself).
	 * Default: 2.
	 */
	maxFixRounds: number;
}

export const DEFAULT_CONFIG: SubagentsConfig = {
	enabledAgents: [...DEFAULT_ENABLED_AGENTS],
	agentModels: {},
	agentThinkingLevels: {},
	thinkingLevel: DEFAULT_THINKING_LEVEL,
	notifyOnReviewPass: false,
	maxResultLines: DEFAULT_MAX_RESULT_LINES,
	proactiveInjection: true,
	agentScope: "user",
	maxConcurrency: DEFAULT_MAX_CONCURRENCY,
	maxFixRounds: DEFAULT_MAX_FIX_ROUNDS,
};

export function getConfigPath(agentDir: string = getAgentDir()): string {
	return join(agentDir, CONFIG_FILE_NAME);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAgentScope(value: unknown): value is AgentScope {
	return typeof value === "string" && (AGENT_SCOPE_VALUES as readonly string[]).includes(value);
}

function isModelReference(value: unknown): value is string {
	if (typeof value !== "string") return false;
	const normalized = value.trim();
	const slash = normalized.indexOf("/");
	return slash > 0 && slash < normalized.length - 1 && !/\s/u.test(normalized);
}

/** Clamp a raw value to a positive integer within [1, upper]; undefined when invalid. */
function clampCount(value: unknown, upper: number): number | undefined {
	if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
	return Math.max(1, Math.min(upper, Math.round(value)));
}

/**
 * Merge a raw parsed JSON value over the defaults, dropping invalid fields.
 * Exported for tests.
 */
export function normalizeConfig(raw: unknown): SubagentsConfig {
	if (!isRecord(raw)) return { ...DEFAULT_CONFIG, enabledAgents: [...DEFAULT_CONFIG.enabledAgents] };

	const config: SubagentsConfig = {
		enabledAgents: [...DEFAULT_CONFIG.enabledAgents],
		agentModels: {},
		agentThinkingLevels: {},
		thinkingLevel: DEFAULT_CONFIG.thinkingLevel,
		notifyOnReviewPass: DEFAULT_CONFIG.notifyOnReviewPass,
		maxResultLines: DEFAULT_CONFIG.maxResultLines,
		proactiveInjection: DEFAULT_CONFIG.proactiveInjection,
		agentScope: DEFAULT_CONFIG.agentScope,
		maxConcurrency: DEFAULT_CONFIG.maxConcurrency,
		maxFixRounds: DEFAULT_CONFIG.maxFixRounds,
	};

	if (Array.isArray(raw.enabledAgents)) {
		const names = raw.enabledAgents.filter(
			(name): name is string => typeof name === "string" && name.trim().length > 0,
		);
		// An explicitly empty array is honored (disables all agents); otherwise keep valid names.
		// Agents removed from the package (e.g. plan) are stripped from upgraded configs.
		config.enabledAgents = [...new Set(names.map((name) => name.trim()))].filter(
			(name) => !REMOVED_AGENT_NAMES.includes(name),
		);
	}

	if (isRecord(raw.agentModels)) {
		for (const [key, value] of Object.entries(raw.agentModels)) {
			if (REMOVED_AGENT_NAMES.includes(key.trim())) continue;
			if (isModelReference(value)) config.agentModels[key.trim()] = value.trim();
		}
	}

	if (isRecord(raw.agentThinkingLevels)) {
		for (const [key, value] of Object.entries(raw.agentThinkingLevels)) {
			if (REMOVED_AGENT_NAMES.includes(key.trim())) continue;
			if (
				typeof value === "string" &&
				(THINKING_LEVEL_VALUES as readonly string[]).includes(value)
			) {
				config.agentThinkingLevels[key.trim()] = value as ThinkingLevel;
			}
		}
	}

	if (typeof raw.thinkingLevel === "string" && (THINKING_LEVEL_VALUES as readonly string[]).includes(raw.thinkingLevel)) {
		config.thinkingLevel = raw.thinkingLevel as ThinkingLevel;
	}

	if (typeof raw.notifyOnReviewPass === "boolean") {
		config.notifyOnReviewPass = raw.notifyOnReviewPass;
	}

	const maxResultLines = clampCount(raw.maxResultLines, MAX_RESULT_LINES_LIMIT);
	if (maxResultLines !== undefined) config.maxResultLines = maxResultLines;

	if (typeof raw.proactiveInjection === "boolean") {
		config.proactiveInjection = raw.proactiveInjection;
	}

	if (isAgentScope(raw.agentScope)) {
		config.agentScope = raw.agentScope;
	}

	const maxConcurrency = clampCount(raw.maxConcurrency, MAX_CONCURRENCY_LIMIT);
	if (maxConcurrency !== undefined) config.maxConcurrency = maxConcurrency;

	// Schema migration: maxParallelTasks (pre-0.13) merged into maxConcurrency.
	// Take the larger of the two so an upgraded config never loses capacity it
	// was explicitly given; the old key is dropped on the persisted save.
	const legacyParallelTasks = clampCount(raw.maxParallelTasks, MAX_CONCURRENCY_LIMIT);
	if (legacyParallelTasks !== undefined && legacyParallelTasks > config.maxConcurrency) {
		config.maxConcurrency = legacyParallelTasks;
	}

	// 0 disables the auto-fix loop (main agent handles fixes itself).
	if (typeof raw.maxFixRounds === "number" && Number.isFinite(raw.maxFixRounds)) {
		config.maxFixRounds = Math.max(0, Math.min(MAX_FIX_ROUNDS_LIMIT, Math.round(raw.maxFixRounds)));
	}

	return config;
}

function defaultConfig(): SubagentsConfig {
	return {
		...DEFAULT_CONFIG,
		enabledAgents: [...DEFAULT_CONFIG.enabledAgents],
		agentModels: {},
		agentThinkingLevels: {},
	};
}

/**
 * Load config. A missing file is a normal state and yields the defaults (not an error).
 * A corrupt file also falls back to defaults rather than throwing, so startup never breaks.
 * A file from an older version (missing newer keys or holding removed agents) is
 * normalized and persisted back, so the on-disk config stays current.
 */
export async function loadConfig(configPath: string = getConfigPath()): Promise<SubagentsConfig> {
	let text: string;
	try {
		text = await readFile(configPath, "utf8");
	} catch {
		// Missing or unreadable: fall back to defaults but do not crash startup.
		return defaultConfig();
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return defaultConfig();
	}

	const config = normalizeConfig(parsed);

	// Schema upgrade: persist the normalized shape when the file gained fields
	// (new version) or dropped invalid/removed ones.
	if (JSON.stringify(config) !== JSON.stringify(parsed)) {
		try {
			await saveConfig(config, configPath);
		} catch {
			// Non-fatal: keep the in-memory config for this run.
		}
	}

	return config;
}

/**
 * Synchronous load for the extension's init-time decisions (e.g. the recursion
 * guard). Runs before any async context is available; never migrates or saves.
 */
export function loadConfigSync(configPath: string = getConfigPath()): SubagentsConfig {
	try {
		return normalizeConfig(JSON.parse(readFileSync(configPath, "utf8")));
	} catch {
		return defaultConfig();
	}
}

/**
 * Save config atomically (temp file + rename) serialized through pi's per-file
 * mutation queue so concurrent writers cannot interleave.
 */
export async function saveConfig(
	config: SubagentsConfig,
	configPath: string = getConfigPath(),
): Promise<void> {
	const normalized = normalizeConfig(config);
	await mkdir(dirname(configPath), { recursive: true });
	await withFileMutationQueue(configPath, async () => {
		const temporaryPath = `${configPath}.${process.pid}.${Date.now()}.tmp`;
		try {
			await writeFile(temporaryPath, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
			await rename(temporaryPath, configPath);
		} finally {
			await rm(temporaryPath, { force: true }).catch(() => undefined);
		}
	});
}

export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
