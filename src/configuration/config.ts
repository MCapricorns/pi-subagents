/** Versioned worker settings. Legacy role configurations are replaced, never migrated. */

import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getAgentDir, withFileMutationQueue } from "@earendil-works/pi-coding-agent";

export const CONFIG_VERSION = 1;
export const BUILTIN_AGENT_NAMES = ["scout", "artisan"] as const;
const THINKING_LEVEL_VALUES = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVEL_VALUES)[number];
export const DEFAULT_THINKING_LEVEL: ThinkingLevel = "medium";
export const DEFAULT_MAX_RESULT_LINES = 40;
export const DEFAULT_IDLE_TIMEOUT_SEC = 1800;

export interface SubagentsConfig {
	version: typeof CONFIG_VERSION;
	/** One worker model for both implementation and read-only research. Missing follows main. */
	model?: string;
	thinking: ThinkingLevel;
}

export const DEFAULT_CONFIG: Readonly<SubagentsConfig> = {
	version: CONFIG_VERSION,
	thinking: DEFAULT_THINKING_LEVEL,
};

export function getConfigPath(agentDir: string = getAgentDir()): string {
	return join(agentDir, "pi-subagents.json");
}

function isCurrentConfig(raw: unknown): raw is Record<string, unknown> {
	return typeof raw === "object" && raw !== null && !Array.isArray(raw)
		&& (raw as Record<string, unknown>).version === CONFIG_VERSION;
}

export function normalizeConfig(raw: unknown): SubagentsConfig {
	const config: SubagentsConfig = { ...DEFAULT_CONFIG };
	if (!isCurrentConfig(raw)) return config;
	if (typeof raw.model === "string") {
		const model = raw.model.trim();
		const slash = model.indexOf("/");
		if (slash > 0 && slash < model.length - 1 && !/\s/u.test(model)) config.model = model;
	}
	if (typeof raw.thinking === "string" && (THINKING_LEVEL_VALUES as readonly string[]).includes(raw.thinking)) {
		config.thinking = raw.thinking as ThinkingLevel;
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

/** Prepare the replacement before removing a legacy file. Callers own the mutation queue. */
async function writeConfig(config: SubagentsConfig, configPath: string, removeLegacy = false): Promise<void> {
	await mkdir(dirname(configPath), { recursive: true });
	const temporaryPath = configPath + "." + process.pid + "." + Date.now() + ".tmp";
	try {
		await writeFile(temporaryPath, JSON.stringify(config, null, 2) + "\n", "utf8");
		if (removeLegacy) await rm(configPath, { force: true });
		await rename(temporaryPath, configPath);
	} finally {
		await rm(temporaryPath, { force: true }).catch(() => undefined);
	}
}

/** Called at startup and setup. A reset affects this config file only, never recovery artifacts. */
export async function initializeConfig(configPath: string = getConfigPath()): Promise<"created" | "reset" | undefined> {
	return withFileMutationQueue(configPath, async () => {
		const stored = await readStoredConfig(configPath);
		if (isCurrentConfig(stored.raw) && (stored.raw.model === undefined || normalizeConfig(stored.raw).model)) return undefined;
		await writeConfig({ ...DEFAULT_CONFIG }, configPath, stored.exists);
		return stored.exists ? "reset" : "created";
	});
}

/** Dispatch reads are side-effect free; startup owns initialization and its user notice. */
export async function loadConfig(configPath: string = getConfigPath()): Promise<SubagentsConfig> {
	const stored = await readStoredConfig(configPath);
	if (!stored.exists) return { ...DEFAULT_CONFIG };
	if (!isCurrentConfig(stored.raw)) {
		throw new Error("Worker settings are invalid or incompatible. Run /subagents-setup to initialize the new configuration.");
	}
	const config = normalizeConfig(stored.raw);
	if (stored.raw.model !== undefined && !config.model) {
		throw new Error("Invalid worker model reference. Use provider/model-id or remove model to explicitly follow main.");
	}
	return config;
}

export async function saveConfig(config: SubagentsConfig, configPath: string = getConfigPath()): Promise<void> {
	await withFileMutationQueue(configPath, () => writeConfig(normalizeConfig(config), configPath));
}

export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
