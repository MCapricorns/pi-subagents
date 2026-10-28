/**
 * Configuration load/save for pi-subagents.
 *
 * Config lives at <agentDir>/pi-subagents.json (agentDir defaults to ~/.pi/agent
 * and honors PI_CODING_AGENT_DIR). The only user-tunable surface is the model
 * and thinking level per role; all built-in roles are always enabled and
 * every operational default is a constant. Parsing is defensive: invalid
 * fields fall back to defaults instead of throwing, so a hand-edited or
 * partially-written file can never break the extension at runtime. Unknown
 * top-level keys from older versions are dropped; unknown role keys are retained
 * and legacy role names migrated. The normalized shape is persisted on load.
 */

import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getAgentDir, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { migrateStoredRoleKeys } from "./role-migration.ts";

/** Full catalog of agents shipped with the package; all of them always run. */
export const BUILTIN_AGENT_NAMES = ["scout", "artisan", "sentinel", "skeptic"] as const;

/** Thinking levels accepted by pi's `--thinking` option. */
const THINKING_LEVEL_VALUES = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVEL_VALUES)[number];
export const DEFAULT_THINKING_LEVEL: ThinkingLevel = "medium";

/** Role-owned default reasoning strength. A `/subagents-setup` override wins;
 * there is no per-call thinking. */
export function roleThinkingLevel(agentName: string): ThinkingLevel {
	switch (agentName) {
		case "scout":
			return "low";
		case "artisan":
		case "sentinel":
		case "skeptic":
			return "high";
		default:
			return DEFAULT_THINKING_LEVEL;
	}
}

/** Responsibility line shown for a built-in's selected setup row. */
export interface AgentProfile {
	/** What this role owns, shown for its selected setup row. */
	remark: string;
}

export const AGENT_PROFILES: Record<(typeof BUILTIN_AGENT_NAMES)[number], AgentProfile> = {
	scout: {
		remark: "Bounded code, documentation, or web research with citations. No commands or edits.",
	},
	artisan: {
		remark: "Implement one substantial change with its tests and verification.",
	},
	sentinel: {
		remark: "Inspect an implementation or diff against requirements and callers for defects and regressions. No edits.",
	},
	skeptic: {
		remark: "Test a named claim, design assumption, or review finding with counterexamples and focused checks. No edits.",
	},
};

export function agentProfile(name: string): AgentProfile | undefined {
	return (AGENT_PROFILES as Record<string, AgentProfile | undefined>)[name];
}

/** How many lines of a sub-agent result the completion message may carry.
 * Wide fan-outs multiply completion blocks, so deliveries stay compact and the
 * full text lives in the on-disk result artifact. */
export const DEFAULT_MAX_RESULT_LINES = 40;

const CONFIG_FILE_NAME = "pi-subagents.json";

/** Idle timeout in seconds: a sub-agent whose stdout (JSON event stream) goes
 * silent for this long is terminated; a configured agent model then hands
 * off to the current main model. */
export const DEFAULT_IDLE_TIMEOUT_SEC = 1800;

export interface SubagentsConfig {
	/** Per-agent model override, keyed by agent name, as "provider/model-id". */
	agentModels: Record<string, string>;
	/** Optional per-agent thinking override from `/subagents-setup`. Missing =
	 * the role default from `roleThinkingLevel`. */
	agentThinkingLevels: Record<string, ThinkingLevel>;
}

/** The default every load starts from; `defaultConfig` keeps the shape in one place. */
export const DEFAULT_CONFIG: SubagentsConfig = defaultConfig();

export function getConfigPath(agentDir: string = getAgentDir()): string {
	return join(agentDir, CONFIG_FILE_NAME);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isModelReference(value: unknown): value is string {
	if (typeof value !== "string") return false;
	const normalized = value.trim();
	const slash = normalized.indexOf("/");
	return slash > 0 && slash < normalized.length - 1 && !/\s/u.test(normalized);
}

/**
 * Merge a raw parsed JSON value over the defaults, dropping invalid fields and
 * migrating legacy role names after validation so valid canonical values win.
 * Exported for tests.
 */
export function normalizeConfig(raw: unknown): SubagentsConfig {
	const config = defaultConfig();
	if (!isRecord(raw)) return config;

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

	config.agentModels = migrateStoredRoleKeys(config.agentModels);
	config.agentThinkingLevels = migrateStoredRoleKeys(config.agentThinkingLevels);
	return config;
}

function defaultConfig(): SubagentsConfig {
	return {
		agentModels: {},
		agentThinkingLevels: {},
	};
}

/**
 * Load config. A missing file is a normal state and yields the defaults (not an error).
 * A corrupt file also falls back to defaults rather than throwing, so startup never breaks.
 * Valid fields are normalized and unknown fields are omitted when the config is saved.
 */
export async function loadConfig(
	configPath: string = getConfigPath(),
): Promise<SubagentsConfig> {
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
