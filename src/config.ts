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

/** Every shipped role stays enabled. The setup wizard and load-time adopt both
 * force the full team on so a stale allow-list cannot hide scout, artisan, or
 * steward. */
export const REQUIRED_ENABLED_AGENTS = [...BUILTIN_AGENT_NAMES] as const;

/** Built-in agent names this package no longer ships. Loading an older config
 * prunes them from every record so the setup wizard, dispatch catalog, and
 * model-routing table never surface dead roles. Custom names stay untouched —
 * except one that reuses a removed built-in name, which this cleanup cannot
 * distinguish and deliberately treats as retired. */
export const REMOVED_BUILTIN_AGENT_NAMES = [
	"worker",
	"cleaner",
	"documenter",
	"synthesizer",
	"reviewer",
	"explorer",
	"executor",
] as const;

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
		remark: "Maps unfamiliar code. Returns exact paths and leads — never proof. Broad search, symbols, dependencies.",
	},
	artisan: {
		summary: "implement / fix",
		remark: "Writes the change. One deliverable: implement, fix, refactor, or test. Confirms a named defect before editing.",
	},
	steward: {
		summary: "tidy when needed",
		remark: "Use only when that work exists: evidence-first cleanup, docs/comment sync, or merging fan-out results.",
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
	/** Built-in names this config has already surfaced. A shipped agent outside
	 * this set is new in an upgrade: loadConfig enables it instead of leaving it
	 * dark behind a stale allow-list. Bookkeeping only — maintained automatically,
	 * and it is what keeps an explicit disable from being undone. */
	knownAgents: string[];
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
	/** One-shot session notice after a catalog migration; announcements clears it. */
	pendingSetupNotice?: string;
}

export const DEFAULT_CONFIG: SubagentsConfig = {
	enabledAgents: [...DEFAULT_ENABLED_AGENTS],
	knownAgents: [...BUILTIN_AGENT_NAMES],
	agentModels: {},
	agentThinkingLevels: {},
	maxResultLines: DEFAULT_MAX_RESULT_LINES,
	agentScope: "user",
	idleTimeoutSec: DEFAULT_IDLE_TIMEOUT_SEC,
};

export const FIRST_RUN_SETUP_HINT =
	"Run /subagents-setup: pick a model for scout, artisan, and steward. " +
	"scout maps code (leads, not proof). artisan implements, fixes, refactors, or tests. " +
	"steward tidies or merges only when that work exists. All three stay on. " +
	"Each role has a thinking default you can change in setup.";

export const TEAM_SETUP_NOTICE =
	"The team is now scout, artisan, and steward. Run /subagents-setup to pick a model for each; thinking has a role default you can change there.";

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

	// Known-agent bookkeeping starts empty for a parsed record (not the fresh
	// default) so loadConfig can still tell which shipped agents this config
	// has never seen. Every enabled name was necessarily surfaced.
	config.knownAgents = [];
	if (Array.isArray(raw.knownAgents)) {
		const names = raw.knownAgents.filter(
			(name): name is string => typeof name === "string" && name.trim().length > 0,
		);
		config.knownAgents = [...new Set(names.map((name) => name.trim()))];
	}
	for (const name of config.enabledAgents) {
		if (!config.knownAgents.includes(name)) config.knownAgents.push(name);
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

	if (typeof raw.pendingSetupNotice === "string" && raw.pendingSetupNotice.trim()) {
		config.pendingSetupNotice = raw.pendingSetupNotice.trim();
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

export function withRequiredAgents(enabled: readonly string[]): string[] {
	const next = [...enabled];
	for (const name of REQUIRED_ENABLED_AGENTS) {
		if (!next.includes(name)) next.push(name);
	}
	return next;
}

function forceRequiredAgents(config: SubagentsConfig): SubagentsConfig {
	const enabledAgents = withRequiredAgents(config.enabledAgents);
	const knownAgents = [...config.knownAgents];
	for (const name of REQUIRED_ENABLED_AGENTS) {
		if (!knownAgents.includes(name)) knownAgents.push(name);
	}
	return { ...config, enabledAgents, knownAgents };
}

/**
 * Drop every removed built-in role from an already-normalized config: enabled
 * and known lists, plus per-agent model and thinking routes. The schema-upgrade
 * persistence in loadConfig writes the pruned shape back to disk.
 */
function pruneRemovedBuiltins(config: SubagentsConfig): SubagentsConfig {
	const removed = new Set<string>(REMOVED_BUILTIN_AGENT_NAMES);
	const filter = (names: readonly string[]): string[] => names.filter((name) => !removed.has(name));
	const agentModels = { ...config.agentModels };
	const agentThinkingLevels = { ...config.agentThinkingLevels };
	for (const name of REMOVED_BUILTIN_AGENT_NAMES) {
		delete agentModels[name];
		delete agentThinkingLevels[name];
	}
	return {
		...config,
		enabledAgents: filter(config.enabledAgents),
		knownAgents: filter(config.knownAgents),
		agentModels,
		agentThinkingLevels,
	};
}

/**
 * A shipped agent the config has never recorded is new in this release; the
 * stale allow-list must not keep it dark. Enable it. Model and thinking stay
 * unset so the role default and current main model apply until setup.
 */
function adoptNewBuiltins(config: SubagentsConfig): { config: SubagentsConfig; fresh: string[] } {
	const known = new Set(config.knownAgents);
	const fresh = BUILTIN_AGENT_NAMES.filter((name) => !known.has(name));
	if (fresh.length === 0) return { config, fresh };
	return {
		config: {
			...config,
			enabledAgents: [...config.enabledAgents, ...fresh],
			knownAgents: [...known, ...fresh],
		},
		fresh,
	};
}

// --- v4 → current catalog migration. Delete this block in the next major. ---

const RENAMED_BUILTIN_AGENTS: Record<string, string> = {
	explorer: "scout",
	executor: "artisan",
};

function renameNameList(names: readonly string[]): { names: string[]; changed: boolean } {
	let changed = false;
	const out: string[] = [];
	for (const name of names) {
		const mapped = RENAMED_BUILTIN_AGENTS[name] ?? name;
		if (mapped !== name) changed = true;
		if (!out.includes(mapped)) out.push(mapped);
	}
	return { names: out, changed };
}

function renameKeyedRecord<T>(record: Record<string, T>): { record: Record<string, T>; changed: boolean } {
	let changed = false;
	const out: Record<string, T> = {};
	for (const [key, value] of Object.entries(record)) {
		const mapped = RENAMED_BUILTIN_AGENTS[key] ?? key;
		if (mapped !== key) changed = true;
		if (!(mapped in out)) out[mapped] = value;
	}
	return { record: out, changed };
}

/** Map retired built-in names onto the current catalog and keep their models
 * and thinking overrides. Isolated so the next major can delete it. */
function migrateRetiredBuiltinNames(config: SubagentsConfig): { config: SubagentsConfig; changed: boolean } {
	const enabled = renameNameList(config.enabledAgents);
	const known = renameNameList(config.knownAgents);
	const models = renameKeyedRecord(config.agentModels);
	const thinking = renameKeyedRecord(config.agentThinkingLevels);
	const changed = enabled.changed || known.changed || models.changed || thinking.changed;
	if (!changed) return { config, changed: false };
	return {
		changed: true,
		config: {
			...config,
			enabledAgents: enabled.names,
			knownAgents: known.names,
			agentModels: models.record,
			agentThinkingLevels: thinking.record,
		},
	};
}

// --- end v4 catalog migration ---

/**
 * Load config. A missing file is a normal state and yields the defaults (not an error).
 * A corrupt file also falls back to defaults rather than throwing, so startup never breaks.
 * A file from an older version (missing newer keys or holding extra keys) is
 * normalized and persisted back, so the on-disk config stays current. Built-in
 * agents the file has never seen are adopted. Retired built-in names are
 * renamed or pruned. Artisan and steward stay enabled.
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

	const renamed = migrateRetiredBuiltinNames(normalizeConfig(parsed));
	const adopted = adoptNewBuiltins(renamed.config);
	let config = forceRequiredAgents(pruneRemovedBuiltins(adopted.config));
	if ((renamed.changed || adopted.fresh.length > 0) && !config.pendingSetupNotice) {
		config = { ...config, pendingSetupNotice: TEAM_SETUP_NOTICE };
	}

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
