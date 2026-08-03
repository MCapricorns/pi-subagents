/**
 * Configuration load/save for pi-subagents.
 *
 * Config lives at <agentDir>/pi-subagents.json (agentDir defaults to ~/.pi/agent
 * and honors PI_CODING_AGENT_DIR). Parsing is defensive: invalid fields fall back
 * to defaults instead of throwing, so a hand-edited or partially-written file can
 * never break the extension at runtime.
 */

import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getAgentDir, withFileMutationQueue } from "@earendil-works/pi-coding-agent";

/** Full catalog of agents shipped with the package (selectable in /subagents-setup). */
export const BUILTIN_AGENT_NAMES = ["explore", "plan", "worker", "reviewer"] as const;
export type BuiltinAgentName = (typeof BUILTIN_AGENT_NAMES)[number];

/** Agents enabled out of the box. `plan` ships but is opt-in: a worker plans internally. */
export const DEFAULT_ENABLED_AGENTS: readonly string[] = ["explore", "worker", "reviewer"];

export const AGENT_SCOPE_VALUES = ["user", "project", "both"] as const;
export type AgentScope = (typeof AGENT_SCOPE_VALUES)[number];

/** Thinking levels accepted by pi's `--thinking` option. */
export const THINKING_LEVEL_VALUES = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVEL_VALUES)[number];
export const DEFAULT_THINKING_LEVEL: ThinkingLevel = "max";

export const CONFIG_FILE_NAME = "pi-subagents.json";

export interface SubagentsConfig {
	/** Agent names that are discoverable and injected. Default: explore, worker, reviewer. */
	enabledAgents: string[];
	/** Per-agent model override, keyed by agent name, as "provider/model-id". */
	agentModels: Record<string, string>;
	/** Thinking level passed to every sub-agent. Default: "max". */
	thinkingLevel: ThinkingLevel;
	/** Whether to inject the delegation directive into the parent system prompt. Default: true. */
	proactiveInjection: boolean;
	/** Which agent directories to discover from. Default: "user". */
	agentScope: AgentScope;
}

export const DEFAULT_CONFIG: SubagentsConfig = {
	enabledAgents: [...DEFAULT_ENABLED_AGENTS],
	agentModels: {},
	thinkingLevel: DEFAULT_THINKING_LEVEL,
	proactiveInjection: true,
	agentScope: "user",
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

/**
 * Merge a raw parsed JSON value over the defaults, dropping invalid fields.
 * Exported for tests.
 */
export function normalizeConfig(raw: unknown): SubagentsConfig {
	if (!isRecord(raw)) return { ...DEFAULT_CONFIG, enabledAgents: [...DEFAULT_CONFIG.enabledAgents] };

	const config: SubagentsConfig = {
		enabledAgents: [...DEFAULT_CONFIG.enabledAgents],
		agentModels: {},
		thinkingLevel: DEFAULT_CONFIG.thinkingLevel,
		proactiveInjection: DEFAULT_CONFIG.proactiveInjection,
		agentScope: DEFAULT_CONFIG.agentScope,
	};

	if (Array.isArray(raw.enabledAgents)) {
		const names = raw.enabledAgents.filter(
			(name): name is string => typeof name === "string" && name.trim().length > 0,
		);
		// An explicitly empty array is honored (disables all agents); otherwise keep valid names.
		config.enabledAgents = [...new Set(names.map((name) => name.trim()))];
	}

	if (isRecord(raw.agentModels)) {
		for (const [key, value] of Object.entries(raw.agentModels)) {
			if (isModelReference(value)) config.agentModels[key.trim()] = value.trim();
		}
	}

	if (typeof raw.thinkingLevel === "string" && (THINKING_LEVEL_VALUES as readonly string[]).includes(raw.thinkingLevel)) {
		config.thinkingLevel = raw.thinkingLevel as ThinkingLevel;
	}

	if (typeof raw.proactiveInjection === "boolean") {
		config.proactiveInjection = raw.proactiveInjection;
	}

	if (isAgentScope(raw.agentScope)) {
		config.agentScope = raw.agentScope;
	}

	return config;
}

/**
 * Load config. A missing file is a normal state and yields the defaults (not an error).
 * A corrupt file also falls back to defaults rather than throwing, so startup never breaks.
 */
export async function loadConfig(configPath: string = getConfigPath()): Promise<SubagentsConfig> {
	let text: string;
	try {
		text = await readFile(configPath, "utf8");
	} catch (error) {
		if (isNodeError(error) && error.code === "ENOENT") {
			return { ...DEFAULT_CONFIG, enabledAgents: [...DEFAULT_CONFIG.enabledAgents] };
		}
		// Unreadable for another reason: fall back to defaults but do not crash startup.
		return { ...DEFAULT_CONFIG, enabledAgents: [...DEFAULT_CONFIG.enabledAgents] };
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return { ...DEFAULT_CONFIG, enabledAgents: [...DEFAULT_CONFIG.enabledAgents] };
	}

	return normalizeConfig(parsed);
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

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error;
}

export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
