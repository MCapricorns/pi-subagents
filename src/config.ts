/**
 * Configuration load/save for pi-subagents.
 *
 * Config lives at <agentDir>/pi-subagents.json (agentDir defaults to ~/.pi/agent
 * and honors PI_CODING_AGENT_DIR). Parsing is defensive: invalid fields fall back
 * to defaults instead of throwing, so a hand-edited or partially-written file can
 * never break the extension at runtime.
 *
 * Schema upgrades happen transparently on load: a config written by an older
 * version (missing newer keys or containing invalid
 * values) is normalized and persisted back with the new fields filled in.
 */

import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir, withFileMutationQueue } from "@earendil-works/pi-coding-agent";

/** Full catalog of agents shipped with the package (selectable in /subagents-setup). */
export const BUILTIN_AGENT_NAMES = ["explorer", "worker", "cleaner", "documenter", "reviewer"] as const;

/** Agents enabled out of the box on a fresh install. Documenter remains an
 * explicit setup choice; existing non-empty configs receive it via migration. */
export const DEFAULT_ENABLED_AGENTS: readonly string[] = ["explorer", "worker", "cleaner", "reviewer"];

export const AGENT_SCOPE_VALUES = ["user", "project", "both"] as const;
export type AgentScope = (typeof AGENT_SCOPE_VALUES)[number];

const LEGACY_EXPLORER_NAME = "explore";
const EXPLORER_NAME = "explorer";
const CLEANER_NAME = "cleaner";
const DOCUMENTER_NAME = "documenter";
const REVIEWER_NAME = "reviewer";

/**
 * Stamps recorded in `announcedFeatures` by the one-time upgrade that defaults
 * cleaner on for configs written before it shipped. The first marks a config as
 * processed, so a later deliberate disable is not undone; the second records
 * that cleaner was actually injected, so session start can tell the user once;
 * the third records that reviewer model/thinking settings were actually copied,
 * so that notice never claims an inheritance that did not happen.
 */
export const CLEANER_DEFAULTED_FEATURE = "cleanerDefaulted";
export const CLEANER_AUTO_ENABLED_FEATURE = "cleanerAutoEnabled";
export const CLEANER_INHERITED_FEATURE = "cleanerInheritedReviewer";

/** One-time upgrade stamps for the pre-commit documenter role. Existing
 * non-empty configs gain it before reviewer and inherit explorer routing; fresh
 * installs keep it off until setup explicitly enables it. */
export const DOCUMENTER_DEFAULTED_FEATURE = "documenterDefaulted";
export const DOCUMENTER_AUTO_ENABLED_FEATURE = "documenterAutoEnabled";
export const DOCUMENTER_INHERITED_FEATURE = "documenterInheritedExplorer";

function migrateAgentName(name: string): string {
	return name === LEGACY_EXPLORER_NAME ? EXPLORER_NAME : name;
}

/** Thinking levels accepted by pi's `--thinking` option. */
export const THINKING_LEVEL_VALUES = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVEL_VALUES)[number];
export const DEFAULT_THINKING_LEVEL: ThinkingLevel = "high";

/** How many lines of a sub-agent result the completion message may carry. Default: 80. */
export const DEFAULT_MAX_RESULT_LINES = 80;
/** Upper bound accepted for maxResultLines (defensive clamp). */
export const MAX_RESULT_LINES_LIMIT = 2000;

const CONFIG_FILE_NAME = "pi-subagents.json";

/** How many sub-agent processes may run at once, and how many tasks one parallel `subagent` call may contain. Default: 4. */
export const DEFAULT_MAX_CONCURRENCY = 4;
/** Upper bound accepted for maxConcurrency (defensive clamp). */
export const MAX_CONCURRENCY_LIMIT = 16;
/**
 * Maximum worker fixes after REVIEW_FAIL. Each fix is followed by a reviewer
 * re-review; this cap does not suppress the post-writer review gate or the
 * final documentation sync. 0 disables fixes. Default: 2.
 */
export const DEFAULT_MAX_FIX_ROUNDS = 2;
/** Upper bound accepted for maxFixRounds (defensive clamp). 0 disables the loop. */
export const MAX_FIX_ROUNDS_LIMIT = 5;

/**
 * Default idle timeout in seconds: a sub-agent whose stdout (JSON event stream)
 * goes silent for this long is terminated; a selected model then hands the
 * retained session to current main. 0 disables the watchdog. Default: 90.
 */
export const DEFAULT_IDLE_TIMEOUT_SEC = 90;
/** Upper bound accepted for idleTimeoutSec (defensive clamp). 0 disables. */
export const IDLE_TIMEOUT_SEC_LIMIT = 600;

export interface SubagentsConfig {
	/** Agent names that are discoverable and injected. Fresh-install default: explorer, worker, cleaner, reviewer. */
	enabledAgents: string[];
	/** Per-agent model override, keyed by agent name, as "provider/model-id". */
	agentModels: Record<string, string>;
	/** Optional per-agent thinking preference. Runtime clamps it to the effective model's supported levels. */
	agentThinkingLevels: Record<string, ThinkingLevel>;
	/**
	 * When a standalone review passes (REVIEW_PASS verdict), deliver it without
	 * waking the main agent. Managed workflows always wake once at final delivery.
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
	 * Maximum worker fixes after REVIEW_FAIL. Every fix receives the full review,
	 * then a re-review runs; one final documentation sync follows the settled
	 * chain and does not consume this budget. 0 disables fixes. Default: 2.
	 */
	maxFixRounds: number;
	/**
	 * Idle timeout in seconds: a sub-agent whose stdout (JSON event stream) goes
	 * silent for this long is terminated; a configured agent model then hands
	 * off to the current main model. 0 disables the idle watchdog. Default: 90.
	 */
	idleTimeoutSec: number;
	/**
	 * One-time feature announcements already shown to the user, plus schema
	 * upgrade stamps (e.g. the cleaner default-enable upgrade). Persisted so
	 * notices and migrations never repeat.
	 */
	announcedFeatures: string[];
}

export const DEFAULT_CONFIG: SubagentsConfig = {
	enabledAgents: [...DEFAULT_ENABLED_AGENTS],
	agentModels: {},
	agentThinkingLevels: {},
	notifyOnReviewPass: false,
	maxResultLines: DEFAULT_MAX_RESULT_LINES,
	proactiveInjection: true,
	agentScope: "user",
	maxConcurrency: DEFAULT_MAX_CONCURRENCY,
	maxFixRounds: DEFAULT_MAX_FIX_ROUNDS,
	idleTimeoutSec: DEFAULT_IDLE_TIMEOUT_SEC,
	announcedFeatures: [],
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
	const config = defaultConfig();
	if (!isRecord(raw)) return config;

	if (Array.isArray(raw.enabledAgents)) {
		const names = raw.enabledAgents.filter(
			(name): name is string => typeof name === "string" && name.trim().length > 0,
		);
		// An explicitly empty array is honored. Rename the former built-in key and
		// deduplicate when a config already contains both spellings.
		config.enabledAgents = [...new Set(names.map((name) => migrateAgentName(name.trim())))];
	}

	if (isRecord(raw.agentModels)) {
		const entries = Object.entries(raw.agentModels);
		// A valid explicit new key wins regardless of JSON property order.
		for (const [rawKey, value] of entries) {
			const key = rawKey.trim();
			if (key !== LEGACY_EXPLORER_NAME && isModelReference(value)) {
				config.agentModels[key] = value.trim();
			}
		}
		if (!Object.hasOwn(config.agentModels, EXPLORER_NAME)) {
			const legacy = entries.find(([key, value]) =>
				key.trim() === LEGACY_EXPLORER_NAME && isModelReference(value)
			);
			if (legacy && isModelReference(legacy[1])) config.agentModels[EXPLORER_NAME] = legacy[1].trim();
		}
	}

	if (isRecord(raw.agentThinkingLevels)) {
		const entries = Object.entries(raw.agentThinkingLevels);
		for (const [rawKey, value] of entries) {
			const key = rawKey.trim();
			if (
				key !== LEGACY_EXPLORER_NAME &&
				typeof value === "string" &&
				(THINKING_LEVEL_VALUES as readonly string[]).includes(value)
			) {
				config.agentThinkingLevels[key] = value as ThinkingLevel;
			}
		}
		if (!Object.hasOwn(config.agentThinkingLevels, EXPLORER_NAME)) {
			const legacy = entries.find(([key, value]) =>
				key.trim() === LEGACY_EXPLORER_NAME &&
				typeof value === "string" &&
				(THINKING_LEVEL_VALUES as readonly string[]).includes(value)
			);
			if (legacy) config.agentThinkingLevels[EXPLORER_NAME] = legacy[1] as ThinkingLevel;
		}
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

	// 0 disables worker fixes, not the initial managed docs/review workflow.
	if (typeof raw.maxFixRounds === "number" && Number.isFinite(raw.maxFixRounds)) {
		config.maxFixRounds = Math.max(0, Math.min(MAX_FIX_ROUNDS_LIMIT, Math.round(raw.maxFixRounds)));
	}

	// 0 disables the idle watchdog; otherwise clamp to [0, upper].
	if (typeof raw.idleTimeoutSec === "number" && Number.isFinite(raw.idleTimeoutSec)) {
		config.idleTimeoutSec = Math.max(0, Math.min(IDLE_TIMEOUT_SEC_LIMIT, Math.round(raw.idleTimeoutSec)));
	}

	if (Array.isArray(raw.announcedFeatures)) {
		config.announcedFeatures = raw.announcedFeatures.filter(
			(feature): feature is string => typeof feature === "string" && feature.trim().length > 0,
		);
	}

	// One-time upgrade for configs written before cleaner shipped: a non-empty
	// explicit enabledAgents list gets cleaner defaulted on (inserted before
	// reviewer, matching the fresh-install order) and inherits the reviewer's
	// configured model and thinking level — its closest peer. The stamps make
	// the upgrade idempotent and keep a later deliberate disable from being undone.
	if (!config.announcedFeatures.includes(CLEANER_DEFAULTED_FEATURE)) {
		config.announcedFeatures.push(CLEANER_DEFAULTED_FEATURE);
		if (config.enabledAgents.length > 0 && !config.enabledAgents.includes(CLEANER_NAME)) {
			const reviewerIndex = config.enabledAgents.indexOf(REVIEWER_NAME);
			config.enabledAgents.splice(reviewerIndex === -1 ? config.enabledAgents.length : reviewerIndex, 0, CLEANER_NAME);
			config.announcedFeatures.push(CLEANER_AUTO_ENABLED_FEATURE);
			let inherited = false;
			if (!config.agentModels[CLEANER_NAME] && config.agentModels[REVIEWER_NAME]) {
				config.agentModels[CLEANER_NAME] = config.agentModels[REVIEWER_NAME];
				inherited = true;
			}
			if (!config.agentThinkingLevels[CLEANER_NAME] && config.agentThinkingLevels[REVIEWER_NAME]) {
				config.agentThinkingLevels[CLEANER_NAME] = config.agentThinkingLevels[REVIEWER_NAME];
				inherited = true;
			}
			// An old explicit list may have no reviewer overrides to copy; only the
			// copied case is stamped so the one-time notice stays accurate.
			if (inherited) config.announcedFeatures.push(CLEANER_INHERITED_FEATURE);
		}
	}

	if (!config.announcedFeatures.includes(DOCUMENTER_DEFAULTED_FEATURE)) {
		config.announcedFeatures.push(DOCUMENTER_DEFAULTED_FEATURE);
		if (config.enabledAgents.length > 0 && !config.enabledAgents.includes(DOCUMENTER_NAME)) {
			const reviewerIndex = config.enabledAgents.indexOf(REVIEWER_NAME);
			config.enabledAgents.splice(
				reviewerIndex === -1 ? config.enabledAgents.length : reviewerIndex,
				0,
				DOCUMENTER_NAME,
			);
			config.announcedFeatures.push(DOCUMENTER_AUTO_ENABLED_FEATURE);
			let inherited = false;
			if (!config.agentModels[DOCUMENTER_NAME] && config.agentModels[EXPLORER_NAME]) {
				config.agentModels[DOCUMENTER_NAME] = config.agentModels[EXPLORER_NAME];
				inherited = true;
			}
			if (!config.agentThinkingLevels[DOCUMENTER_NAME] && config.agentThinkingLevels[EXPLORER_NAME]) {
				config.agentThinkingLevels[DOCUMENTER_NAME] = config.agentThinkingLevels[EXPLORER_NAME];
				inherited = true;
			}
			if (inherited) config.announcedFeatures.push(DOCUMENTER_INHERITED_FEATURE);
		}
	}

	return config;
}

function defaultConfig(): SubagentsConfig {
	return {
		...DEFAULT_CONFIG,
		enabledAgents: [...DEFAULT_CONFIG.enabledAgents],
		agentModels: {},
		agentThinkingLevels: {},
		announcedFeatures: [],
	};
}

/**
 * Load config. A missing file is a normal state and yields the defaults (not an error).
 * A corrupt file also falls back to defaults rather than throwing, so startup never breaks.
 * A file from an older version (missing newer keys or holding extra keys) is
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
	// (new version) or dropped invalid ones.
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
