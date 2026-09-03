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
export const BUILTIN_AGENT_NAMES = ["scout", "artisan", "steward"] as const;

/** Agents enabled out of the box on a fresh install. */
export const DEFAULT_ENABLED_AGENTS: readonly string[] = [...BUILTIN_AGENT_NAMES];

export const AGENT_SCOPE_VALUES = ["user", "project", "both"] as const;
export type AgentScope = (typeof AGENT_SCOPE_VALUES)[number];

/** Thinking levels accepted by pi's `--thinking` option. */
export const THINKING_LEVEL_VALUES = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVEL_VALUES)[number];
export const DEFAULT_THINKING_LEVEL: ThinkingLevel = "medium";

/** Role-owned default reasoning strength. A `/subagents-setup` override wins;
 * there is no per-call or frontmatter thinking. */
export function roleThinkingLevel(agentName: string): ThinkingLevel {
	switch (agentName) {
		case "scout":
			return "low";
		case "artisan":
			return "high";
		case "steward":
			return "medium";
		default:
			return DEFAULT_THINKING_LEVEL;
	}
}

/** Short responsibility line shown next to each built-in in setup lists. */
export interface AgentProfile {
	/** A few words for picker rows. */
	summary: string;
	/** What this role owns, for first-run copy and the configure step. */
	remark: string;
}

export const AGENT_PROFILES: Record<(typeof BUILTIN_AGENT_NAMES)[number], AgentProfile> = {
	scout: {
		summary: "read-only recon",
		remark: "Broad or unknown reconnaissance. Returns decisive citations as leads, never proof.",
	},
	artisan: {
		summary: "implement / fix",
		remark: "Owns implementation, code refactors, and directly affected tests/docs; a disproved defect means zero edits.",
	},
	steward: {
		summary: "pre-commit finish",
		remark: "Cleans a completed broad or multi-writer diff and synchronizes cross-cutting docs/comments without changing behavior.",
	},
};

export function agentProfile(name: string): AgentProfile | undefined {
	return (AGENT_PROFILES as Record<string, AgentProfile | undefined>)[name];
}

/** How many lines of a sub-agent result the completion message may carry.
 * Default: 40 — wide fan-outs multiply completion blocks, so deliveries stay
 * compact and the full text lives in the on-disk result artifact. */
export const DEFAULT_MAX_RESULT_LINES = 40;
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
	/** Agent names that are discoverable and injected. Fresh-install default: every built-in agent. */
	enabledAgents: string[];
	/** Per-agent model override, keyed by agent name, as "provider/model-id". */
	agentModels: Record<string, string>;
	/** Optional per-agent thinking override from `/subagents-setup`. Missing =
	 * the role default from `roleThinkingLevel`. */
	agentThinkingLevels: Record<string, ThinkingLevel>;
	/**
	 * Max lines of a sub-agent result carried in the completion message. Longer
	 * results are truncated; the full text is written to a temp file whose path
	 * is included in the message. Default: 80.
	 */
	maxResultLines: number;
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
	maxResultLines: DEFAULT_MAX_RESULT_LINES,
	agentScope: "user",
	idleTimeoutSec: DEFAULT_IDLE_TIMEOUT_SEC,
};

export const FIRST_RUN_SETUP_HINT =
	"Run /subagents-setup to choose enabled roles and pick their models. " +
	"Keep orchestration on the strongest main model; prefer an efficient model for scout and steward. " +
	"Scout handles clustered broad reconnaissance, artisan implements with affected tests/docs, " +
	"and steward finishes completed broad or multi-writer changes before commit.";

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

	const maxResultLines = clampCount(raw.maxResultLines, MAX_RESULT_LINES_LIMIT);
	if (maxResultLines !== undefined) config.maxResultLines = maxResultLines;

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
 * Valid fields are normalized and unknown fields are omitted when the config is saved.
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

	// Persist the canonical shape when invalid or unknown fields were omitted.
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
