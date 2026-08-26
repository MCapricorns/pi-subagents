/**
 * Configuration load/save for pi-subagents.
 *
 * Config lives at <agentDir>/pi-subagents.json (agentDir defaults to ~/.pi/agent
 * and honors PI_CODING_AGENT_DIR). Parsing is defensive: invalid fields fall back
 * to defaults instead of throwing, so a hand-edited or partially-written file can
 * never break the extension at runtime. Unknown keys from older versions are
 * dropped and the normalized shape persisted back on load.
 */

import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getAgentDir, withFileMutationQueue } from "@earendil-works/pi-coding-agent";

/** Full catalog of agents shipped with the package (selectable in /subagents-setup). */
export const BUILTIN_AGENT_NAMES = ["explorer", "worker", "cleaner", "documenter", "reviewer"] as const;

/** Agents enabled out of the box on a fresh install. */
export const DEFAULT_ENABLED_AGENTS: readonly string[] = ["explorer", "worker", "cleaner", "reviewer"];

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

const CONFIG_FILE_NAME = "pi-subagents.json";

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
	/**
	 * Idle timeout in seconds: a sub-agent whose stdout (JSON event stream) goes
	 * silent for this long is terminated; a configured agent model then hands
	 * off to the current main model. 0 disables the idle watchdog. Default: 90.
	 */
	idleTimeoutSec: number;
}

export const DEFAULT_CONFIG: SubagentsConfig = {
	enabledAgents: [...DEFAULT_ENABLED_AGENTS],
	agentModels: {},
	agentThinkingLevels: {},
	notifyOnReviewPass: false,
	maxResultLines: DEFAULT_MAX_RESULT_LINES,
	proactiveInjection: true,
	agentScope: "user",
	idleTimeoutSec: DEFAULT_IDLE_TIMEOUT_SEC,
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
		// An explicitly empty array is honored; duplicates collapse.
		config.enabledAgents = [...new Set(names.map((name) => name.trim()))];
	}

	if (isRecord(raw.agentModels)) {
		for (const [rawKey, value] of Object.entries(raw.agentModels)) {
			const key = rawKey.trim();
			if (key !== "" && isModelReference(value)) {
				config.agentModels[key] = value.trim();
			}
		}
	}

	if (isRecord(raw.agentThinkingLevels)) {
		for (const [rawKey, value] of Object.entries(raw.agentThinkingLevels)) {
			const key = rawKey.trim();
			if (
				key !== "" &&
				typeof value === "string" &&
				(THINKING_LEVEL_VALUES as readonly string[]).includes(value)
			) {
				config.agentThinkingLevels[key] = value as ThinkingLevel;
			}
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

	// 0 disables the idle watchdog; otherwise clamp to [0, upper].
	if (typeof raw.idleTimeoutSec === "number" && Number.isFinite(raw.idleTimeoutSec)) {
		config.idleTimeoutSec = Math.max(0, Math.min(IDLE_TIMEOUT_SEC_LIMIT, Math.round(raw.idleTimeoutSec)));
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
