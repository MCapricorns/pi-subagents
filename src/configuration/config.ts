/** Independent role settings. Legacy configuration is replaced with defaults; a broken current file is kept until setup repairs it. */

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { replaceManifestFile, withManifestMutation } from "../isolation/manifest-mutation.ts";

const CONFIG_VERSION = 2;
export const BUILTIN_AGENT_NAMES = ["researcher", "worker"] as const;
export type AgentName = (typeof BUILTIN_AGENT_NAMES)[number];
const THINKING_LEVEL_VALUES = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVEL_VALUES)[number];
export const DEFAULT_THINKING_LEVEL: ThinkingLevel = "medium";
export const DEFAULT_MAX_RESULT_LINES = 40;
export const DEFAULT_IDLE_TIMEOUT_SEC = 1800;

interface AgentSettings {
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

function isObject(raw: unknown): raw is Record<string, unknown> {
	return typeof raw === "object" && raw !== null && !Array.isArray(raw);
}

function isCurrentVersion(raw: unknown): raw is Record<string, unknown> {
	return isObject(raw) && raw.version === CONFIG_VERSION;
}

export function normalizeConfig(raw: unknown): SubagentsConfig {
	const config: SubagentsConfig = { version: CONFIG_VERSION, researcher: { ...DEFAULT_AGENT_SETTINGS }, worker: { ...DEFAULT_AGENT_SETTINGS } };
	if (!isCurrentVersion(raw)) return config;
	for (const role of BUILTIN_AGENT_NAMES) {
		const settings = raw[role];
		if (!isObject(settings)) continue;
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

async function readStoredConfig(configPath: string): Promise<{ exists: boolean; raw?: unknown; parseError?: Error }> {
	let text: string;
	try {
		text = await readFile(configPath, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { exists: false };
		throw error;
	}
	const clean = text.startsWith("\uFEFF") ? text.slice(1) : text;
	try {
		return { exists: true, raw: JSON.parse(clean) };
	} catch (error) {
		return { exists: true, parseError: error instanceof Error ? error : new Error(String(error)) };
	}
}

/** Replace settings atomically. Callers own the mutation queue. */
async function writeConfig(config: SubagentsConfig, configPath: string): Promise<void> {
	await mkdir(dirname(configPath), { recursive: true });
	const temporaryPath = configPath + "." + process.pid + "." + Date.now() + ".tmp";
	try {
		await writeFile(temporaryPath, JSON.stringify(config, null, 2) + "\n", "utf8");
		await replaceManifestFile(temporaryPath, configPath);
	} finally {
		await rm(temporaryPath, { force: true }).catch(() => undefined);
	}
}

type ConfigInitialization = "created" | "reset" | "replaced-unreadable" | "repaired";

/** Called at startup and setup. A reset affects this config file only, never recovery artifacts.
 * Legacy shapes are always replaced (the upgrade path). An unreadable file or an invalid
 * current-version field is kept at startup so dispatch fails closed instead of silently
 * following main; only an explicit `repair` (setup) rewrites it, keeping every valid field. */
export async function initializeConfig(
	configPath: string = getConfigPath(),
	options: { repair?: boolean } = {},
): Promise<ConfigInitialization | undefined> {
	return withManifestMutation(configPath, async () => {
		const stored = await readStoredConfig(configPath);
		if (stored.parseError) {
			if (!options.repair) return undefined;
			await writeConfig(normalizeConfig(undefined), configPath);
			return "replaced-unreadable";
		}
		if (isCurrentVersion(stored.raw)) {
			const raw = stored.raw;
			const normalized = normalizeConfig(raw);
			const invalid = BUILTIN_AGENT_NAMES.some((role) => {
				const settings = raw[role];
				return !isObject(settings) || (settings.model !== undefined && !normalized[role].model);
			});
			if (!options.repair || !invalid) return undefined;
			await writeConfig(normalized, configPath);
			return "repaired";
		}
		await writeConfig(normalizeConfig(undefined), configPath);
		return stored.exists ? "reset" : "created";
	});
}

/** Dispatch reads are side-effect free; startup owns initialization and its user notice. */
export async function loadConfig(configPath: string = getConfigPath()): Promise<SubagentsConfig> {
	const stored = await readStoredConfig(configPath);
	if (!stored.exists) return normalizeConfig(undefined);
	const raw = stored.raw;
	if (!isCurrentVersion(raw) || BUILTIN_AGENT_NAMES.some((role) => !isObject(raw[role]))) {
		throw new Error("Subagent settings are invalid or unsupported. Repair the file or run /subagents-setup to replace it with the current configuration.");
	}
	const config = normalizeConfig(raw);
	for (const role of BUILTIN_AGENT_NAMES) {
		if ((raw[role] as Record<string, unknown>).model !== undefined && !config[role].model) {
			throw new Error(`Invalid ${role} model reference. Use provider/model-id, remove model to explicitly follow main, or run /subagents-setup to clear it.`);
		}
	}
	return config;
}

export async function updateConfig(configPath: string, update: (config: SubagentsConfig) => void): Promise<void> {
	await withManifestMutation(configPath, async () => {
		const config = await loadConfig(configPath);
		update(config);
		await writeConfig(normalizeConfig(config), configPath);
	});
}

export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
