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
import { type AgentScope } from "../configuration/config.ts";
import type { IsolationMode } from "../isolation/worktree.ts";

export type AgentSource = "builtin" | "user" | "project";

export interface AgentConfig {
	name: string;
	description: string;
	tools?: string[];
	/** Model ref this run was routed to; filled in by dispatch, never declared by the agent file. */
	model?: string;
	/** Role-declared default isolation (frontmatter `isolation`); an explicit
	 * per-call request wins, and `worktree` applies to write-capable roles only. */
	isolation?: IsolationMode;
	systemPrompt: string;
	source: AgentSource;
	filePath: string;
}

const SHELL_TOOL_NAMES = new Set(["bash", "powershell"]);
/** The shell that actually fits the host: PowerShell on Windows, Bash elsewhere.
 * Only used to break a tie when the parent has both enabled — a parent running a
 * single shell is followed as configured, whatever it is. */
const NATIVE_SHELL_TOOL = process.platform === "win32" ? "powershell" : "bash";
const READ_ONLY_TOOL_NAMES = new Set([
	"read",
	"grep",
	"find",
	"ls",
	"anchor_grep",
	"web_search",
	"fetch_content",
	"resolve-library-id",
	"query-docs",
]);
export const SUBAGENT_TOOL_NAMES = [
	"subagent",
	"subagent_control",
	"subagent_stop",
	"subagent_risk",
] as const;
const SUBAGENT_TOOL_NAME_SET = new Set<string>(SUBAGENT_TOOL_NAMES);

/** Resolve every child against the parent's live tool selection. Roles without
 * an allowlist inherit the complete active set. Explicit lists are strict: they
 * keep only declared tools that are active in the parent, with shell adaptation.
 * Active extension/SDK tools are never added implicitly. pi-subagents controls
 * are always removed so children stay leaves.
 *
 * A declared shell is one slot, so it resolves to one shell: the parent's, and
 * the host-native one when the parent runs both. A child never inherits a shell
 * the parent does not have. */
export function resolveAgentTools(
	agent: AgentConfig,
	activeToolNames: readonly string[],
): AgentConfig {
	const active = [...new Set(activeToolNames)].filter((tool) => !SUBAGENT_TOOL_NAME_SET.has(tool));
	if (!agent.tools) {
		return { ...agent, tools: agent.name === "scout" ? active.filter((tool) => READ_ONLY_TOOL_NAMES.has(tool)) : active };
	}
	const declaredTools = agent.name === "scout"
		? agent.tools.filter((tool) => READ_ONLY_TOOL_NAMES.has(tool))
		: agent.tools;
	const activeSet = new Set(active);

	const parentShellTools = active.filter((tool) => SHELL_TOOL_NAMES.has(tool));
	const activeShellTools = parentShellTools.length > 1 && parentShellTools.includes(NATIVE_SHELL_TOOL)
		? [NATIVE_SHELL_TOOL]
		: parentShellTools;
	const tools: string[] = [];
	let shellAdapted = false;
	for (const tool of declaredTools) {
		if (SUBAGENT_TOOL_NAME_SET.has(tool)) continue;
		if (SHELL_TOOL_NAMES.has(tool)) {
			if (!shellAdapted) tools.push(...activeShellTools);
			shellAdapted = true;
		} else if (activeSet.has(tool) && !tools.includes(tool)) {
			tools.push(tool);
		}
	}
	return { ...agent, tools };
}

/** Filesystem-write capability used by worktree admission and repository-lane
 * safety. Scout is a hard read-only boundary even with a project override.
 * Omitted allowlists inherit arbitrary active tools and are therefore mutable.
 * For explicit allowlists, only the canonical retrieval tools are proven
 * read-only; shells and unknown custom tools are conservatively mutable. */
export function isWriteCapableAgent(
	agent: Pick<AgentConfig, "name" | "tools">,
): boolean {
	if (agent.name === "scout") return false;
	if (agent.name === "artisan" || agent.name === "steward") return true;
	if (!agent.tools) return true;
	return agent.tools.some((tool) => !READ_ONLY_TOOL_NAMES.has(tool));
}

const here = dirname(fileURLToPath(import.meta.url));
/** <package>/agents — the agents shipped with this extension. */
export const BUILTIN_AGENTS_DIR = join(here, "..", "..", "agents");

/** Agents shipped with the package and surfaced by the setup overlay. */
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
		const rawIsolation = str(frontmatter.isolation)?.trim();
		const isolation = rawIsolation === "worktree" || rawIsolation === "shared"
			? (rawIsolation as IsolationMode)
			: undefined;

		agents.push({
			name,
			description,
			tools: tools && tools.length > 0 ? tools : undefined,
			...(isolation ? { isolation } : {}),
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
