/**
 * Agent discovery.
 *
 * Agents are Markdown files (YAML frontmatter + body-as-system-prompt) loaded from
 * three scopes with override priority  builtin < user < project  (same `name` wins
 * at the higher scope). Discovery is re-run on every invocation so editing a file or
 * dropping a new one takes effect mid-session without a reload.
 *
 *   builtin : <package>/agents            (shipped with this extension)
 *   user    : <agentDir>/agents           (~/.pi/agent/agents)
 *   project : <cwd...>/.pi/agents         (nearest, walking up)
 */

import { type Dirent, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_DIR_NAME, getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { THINKING_LEVEL_VALUES, type AgentScope, type ThinkingLevel } from "./config.ts";

export type AgentSource = "builtin" | "user" | "project";

export interface AgentConfig {
	name: string;
	description: string;
	tools?: string[];
	/** Model ref this run was routed to; filled in by dispatch, never declared by the agent file. */
	model?: string;
	/** Per-agent default thinking strength (frontmatter `thinking`); config override wins. */
	thinking?: ThinkingLevel;
	systemPrompt: string;
	source: AgentSource;
	filePath: string;
}

const SHELL_TOOL_NAMES = new Set(["bash", "powershell"]);
const PI_BUILTIN_TOOL_NAMES = new Set(["read", "bash", "powershell", "edit", "write", "grep", "find", "ls"]);
export const SUBAGENT_TOOL_NAMES = [
	"subagent",
	"subagent_control",
	"subagent_stop",
] as const;
const SUBAGENT_TOOL_NAME_SET = new Set<string>(SUBAGENT_TOOL_NAMES);

/** Resolve every child against the parent's live tool selection. Roles without
 * an allowlist inherit the complete active set. Explicit lists keep only their
 * declared Pi built-ins, adapt an existing shell slot, and gain active extension/
 * SDK tools. pi-subagents controls are always removed so children stay leaves. */
export function resolveAgentTools(
	agent: AgentConfig,
	activeToolNames: readonly string[],
): AgentConfig {
	const active = [...new Set(activeToolNames)].filter((tool) => !SUBAGENT_TOOL_NAME_SET.has(tool));
	if (!agent.tools) return { ...agent, tools: active };

	const activeShellTools = active.filter((tool) => SHELL_TOOL_NAMES.has(tool));
	const tools: string[] = [];
	let shellAdapted = false;
	for (const tool of agent.tools) {
		if (SHELL_TOOL_NAMES.has(tool)) {
			if (!shellAdapted) tools.push(...activeShellTools);
			shellAdapted = true;
		} else if (PI_BUILTIN_TOOL_NAMES.has(tool) && !tools.includes(tool)) {
			tools.push(tool);
		}
	}
	for (const tool of active) {
		if (PI_BUILTIN_TOOL_NAMES.has(tool) || tools.includes(tool)) continue;
		tools.push(tool);
	}
	return { ...agent, tools };
}

/** Filesystem-write capability used by worktree admission and repository-lane
 * safety. Built-in read-only role names remain read-only even when overridden;
 * an omitted tool list inherits the parent's active set, so it counts as
 * write-capable unless the parent itself is read-only. */
export function isWriteCapableAgent(
	agent: Pick<AgentConfig, "name" | "tools">,
): boolean {
	if (agent.name === "explorer" || agent.name === "reviewer") return false;
	if (agent.name === "worker") return true;
	if (!agent.tools) return true;
	return agent.tools.includes("edit") || agent.tools.includes("write");
}

const here = dirname(fileURLToPath(import.meta.url));
/** <package>/agents — the agents shipped with this extension. */
export const BUILTIN_AGENTS_DIR = join(here, "..", "agents");

/** Agents shipped with the package (used by the setup wizard for per-agent defaults). */
export function loadBuiltinAgents(): AgentConfig[] {
	return loadAgentsFromDir(BUILTIN_AGENTS_DIR, "builtin");
}

function loadAgentsFromDir(dir: string, source: AgentSource): AgentConfig[] {
	const agents: AgentConfig[] = [];
	if (!existsSync(dir)) return agents;

	let entries: Dirent[];
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return agents;
	}

	for (const entry of entries) {
		if (!entry.name.endsWith(".md")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;

		const filePath = join(dir, entry.name);
		let content: string;
		try {
			content = readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}

		const { frontmatter, body } = parseFrontmatter<Record<string, string>>(content);
		// YAML values are not guaranteed strings; anything non-string is invalid for these fields.
		const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
		const name = str(frontmatter.name);
		const description = str(frontmatter.description);
		// name + description are required; skip malformed files silently.
		if (!name || !description) continue;

		const rawTools = str(frontmatter.tools);
		const tools = rawTools
			?.split(",")
			.map((t) => t.trim())
			.filter(Boolean);
		const rawThinking = str(frontmatter.thinking)?.trim();
		const thinking = (THINKING_LEVEL_VALUES as readonly string[]).includes(rawThinking ?? "")
			? (rawThinking as ThinkingLevel)
			: undefined;

		agents.push({
			name,
			description,
			tools: tools && tools.length > 0 ? tools : undefined,
			...(thinking ? { thinking } : {}),
			systemPrompt: body,
			source,
			filePath,
		});
	}

	return agents;
}

function isDirectory(p: string): boolean {
	try {
		return statSync(p).isDirectory();
	} catch {
		return false;
	}
}

function findNearestProjectAgentsDir(cwd: string): string | null {
	let currentDir = cwd;
	while (true) {
		const candidate = join(currentDir, CONFIG_DIR_NAME, "agents");
		if (isDirectory(candidate)) return candidate;
		const parentDir = dirname(currentDir);
		if (parentDir === currentDir) return null;
		currentDir = parentDir;
	}
}

export interface DiscoverOptions {
	/** Which directories to read from. Default: "user". */
	scope?: AgentScope;
	/** If provided, only agents whose name is listed are returned. */
	enabledNames?: readonly string[];
	/** Project-controlled prompts are loaded only after Pi trusts the project. */
	projectTrusted?: boolean;
	/** Override the built-in agents directory (used by tests). */
	builtinDir?: string;
}

/**
 * Discover agents across scopes and apply the enabled-name filter.
 * Override priority for the same name: project > user > builtin.
 */
export function discoverAgents(cwd: string, options: DiscoverOptions = {}): { agents: AgentConfig[] } {
	const scope = options.scope ?? "user";
	const builtinDir = options.builtinDir ?? BUILTIN_AGENTS_DIR;
	const projectAgentsDir = findNearestProjectAgentsDir(cwd);

	const builtin = loadAgentsFromDir(builtinDir, "builtin");
	const user = scope === "project" ? [] : loadAgentsFromDir(join(getAgentDir(), "agents"), "user");
	const project =
		scope === "user" || !projectAgentsDir || options.projectTrusted !== true
			? []
			: loadAgentsFromDir(projectAgentsDir, "project");

	// Merge with override priority builtin < user < project.
	const byName = new Map<string, AgentConfig>();
	for (const agent of builtin) byName.set(agent.name, agent);
	for (const agent of user) byName.set(agent.name, agent);
	for (const agent of project) byName.set(agent.name, agent);

	let agents = Array.from(byName.values());

	if (options.enabledNames !== undefined) {
		const enabled = new Set(options.enabledNames);
		agents = agents.filter((agent) => enabled.has(agent.name));
	}

	return { agents };
}

/** One-line catalog entry for system-prompt injection and error messages. */
export function formatCatalogEntry(agent: AgentConfig): string {
	return `- ${agent.name}: ${agent.description}`;
}
