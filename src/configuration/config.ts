/** Independent role settings. Unsupported configuration is replaced with defaults. */

import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getAgentDir, withFileMutationQueue } from "@earendil-works/pi-coding-agent";

export const CONFIG_VERSION = 2;
export const BUILTIN_AGENT_NAMES = ["researcher", "worker"] as const;
export type AgentName = (typeof BUILTIN_AGENT_NAMES)[number];
const THINKING_LEVEL_VALUES = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVEL_VALUES)[number];
export const DEFAULT_THINKING_LEVEL: ThinkingLevel = "medium";
export const DEFAULT_MAX_RESULT_LINES = 40;
export const DEFAULT_IDLE_TIMEOUT_SEC = 1800;

export interface AgentSettings {
	/** Missing follows the main model. */
	model?: string;
	thinking: ThinkingLevel;
}

export type SubagentsConfig = { version: typeof CONFIG_VERSION } & Record<AgentName, AgentSettings>;

export const DEFAULT_AGENT_SETTINGS: Readonly<AgentSettings> = Object.freeze({ thinking: DEFAULT_THINKING_LEVEL });
export const DEFAULT_CONFIG: Readonly<SubagentsConfig> = {
	version: CONFIG_VERSION,
	researcher: DEFAULT_AGENT_SETTINGS,
	worker: DEFAULT_AGENT_SETTINGS,
};

export function getConfigPath(agentDir: string = getAgentDir()): string {
	return join(agentDir, "pi-subagents.json");
}

function isCurrentConfig(raw: unknown): raw is Record<string, unknown> {
	return typeof raw === "object" && raw !== null && !Array.isArray(raw)
		&& (raw as Record<string, unknown>).version === CONFIG_VERSION
		&& BUILTIN_AGENT_NAMES.every((role) => {
			const settings = (raw as Record<string, unknown>)[role];
			return typeof settings === "object" && settings !== null && !Array.isArray(settings);
		});
}

export function normalizeConfig(raw: unknown): SubagentsConfig {
	const config: SubagentsConfig = { version: CONFIG_VERSION, researcher: { ...DEFAULT_AGENT_SETTINGS }, worker: { ...DEFAULT_AGENT_SETTINGS } };
	if (!isCurrentConfig(raw)) return config;
	for (const role of BUILTIN_AGENT_NAMES) {
		const settings = raw[role] as Record<string, unknown>;
		if (typeof settings.model === "string") {
			const model = settings.model.trim();
			const slash = model.indexOf("/");
			if (slash > 0 && slash < model.length - 1 && !/\s/u.test(model)) config[role].model = model;
		}
		if (typeof settings.thinking === "string" && (THINKING_LEVEL_VALUES as readonly string[]).includes(settings.thinking)) {
			config[role].thinking = settings.thinking as ThinkingLevel;
		}
	}
	return config;
}

async function readStoredConfig(configPath: string): Promise<{ exists: boolean; raw?: unknown }> {
	let text: string;
	try {
		text = await readFile(configPath, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { exists: false };
		throw error;
	}
	try {
		return { exists: true, raw: JSON.parse(text) };
	} catch {
		return { exists: true };
	}
}

/** Replace settings atomically. Callers own the mutation queue. */
async function writeConfig(config: SubagentsConfig, configPath: string): Promise<void> {
	await mkdir(dirname(configPath), { recursive: true });
	const temporaryPath = configPath + "." + process.pid + "." + Date.now() + ".tmp";
	try {
		await writeFile(temporaryPath, JSON.stringify(config, null, 2) + "\n", "utf8");
		await rename(temporaryPath, configPath);
	} finally {
		await rm(temporaryPath, { force: true }).catch(() => undefined);
	}
}

/** Called at startup and setup. A reset affects this config file only, never recovery artifacts. */
export async function initializeConfig(configPath: string = getConfigPath()): Promise<"created" | "reset" | undefined> {
	return withFileMutationQueue(configPath, async () => {
		const stored = await readStoredConfig(configPath);
		const raw = stored.raw;
		if (isCurrentConfig(raw) && BUILTIN_AGENT_NAMES.every((role) =>
			(raw[role] as Record<string, unknown>).model === undefined || normalizeConfig(raw)[role].model)) return undefined;
		await writeConfig(normalizeConfig(undefined), configPath);
		return stored.exists ? "reset" : "created";
	});
}

/** Dispatch reads are side-effect free; startup owns initialization and its user notice. */
export async function loadConfig(configPath: string = getConfigPath()): Promise<SubagentsConfig> {
	const stored = await readStoredConfig(configPath);
	if (!stored.exists) return normalizeConfig(undefined);
	if (!isCurrentConfig(stored.raw)) {
		throw new Error("Subagent settings are invalid or unsupported. Run /subagents-setup to initialize the current configuration.");
	}
	const config = normalizeConfig(stored.raw);
	for (const role of BUILTIN_AGENT_NAMES) {
		if ((stored.raw[role] as Record<string, unknown>).model !== undefined && !config[role].model) {
			throw new Error(`Invalid ${role} model reference. Use provider/model-id or remove model to explicitly follow main.`);
		}
	}
	return config;
}

export async function saveConfig(config: SubagentsConfig, configPath: string = getConfigPath()): Promise<void> {
	await withFileMutationQueue(configPath, () => writeConfig(normalizeConfig(config), configPath));
}

export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
