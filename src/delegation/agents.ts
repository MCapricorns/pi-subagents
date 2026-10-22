/**
 * Agent discovery.
 *
 * Agents are Markdown files (YAML frontmatter + body-as-system-prompt) loaded from
 * three scopes with override priority  builtin < user < project  (same `name` wins
 * at the higher scope). Discovery is re-run on every invocation so editing a file or
 * dropping a new one takes effect mid-session without a reload.
 *
 *   builtin : builtin-agents.ts           (shipped as code with this extension)
 *   user    : <agentDir>/agents           (~/.pi/agent/agents)
 *   project : <cwd...>/.pi/agents         (nearest, walking up)
 */

import { type Dirent, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir, parseFrontmatter, type ToolInfo } from "@earendil-works/pi-coding-agent";
import { type AgentScope, BUILTIN_AGENT_NAMES } from "../configuration/config.ts";
import { BUILTIN_AGENTS } from "./builtin-agents.ts";
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
/** Pi's own retrieval builtins. They carry no annotations, so they are the only
 * names that are read-only without the host saying so. */
const BUILTIN_READ_ONLY_TOOL_NAMES = ["read", "grep", "find", "ls"] as const;
const BUILTIN_READ_ONLY_TOOL_SET: ReadonlySet<string> = new Set(BUILTIN_READ_ONLY_TOOL_NAMES);
export const SUBAGENT_TOOL_NAMES = [
	"subagent",
	"subagent_status",
	"subagent_stop",
] as const;
const SUBAGENT_TOOL_NAME_SET = new Set<string>(SUBAGENT_TOOL_NAMES);

/** The parts of pi's `ToolInfo` that decide whether a tool is safe for a
 * read-only role. Live `pi.getAllTools()` entries satisfy it structurally. */
export type ToolMetadata = Pick<ToolInfo, "name" | "annotations" | "reachesTools"> & {
	/** How the model reaches the tool; absent metadata is treated as declared. */
	exposure?: ToolInfo["exposure"];
};

/** Exposures reached through a script or `tool_search` instead of a declaration.
 * The session can call these, so a child can be given them directly. */
const INDIRECT_EXPOSURES: ReadonlySet<string> = new Set(["codemode", "deferred"]);
/** Live tool metadata keyed by name. Read-only and write capability come from it
 * instead of a maintained list of extension or MCP tool names. */
type ToolInfoIndex = ReadonlyMap<string, ToolMetadata>;

function indexToolInfos(toolInfos?: readonly ToolMetadata[]): ToolInfoIndex {
	return new Map((toolInfos ?? []).map((info) => [info.name, info]));
}

/** Whether a tool is proven read-only. Extension and MCP tools prove it with
 * `annotations.readOnlyHint`; the built-in retrieval tools are known safe. A tool
 * that reaches other tools can always reach a writer, so codemode, tool_search,
 * shells, and this package's own controls are never read-only for a role. */
function isReadOnlyTool(tool: ToolMetadata): boolean {
	if (SHELL_TOOL_NAMES.has(tool.name) || SUBAGENT_TOOL_NAME_SET.has(tool.name)) return false;
	if (tool.reachesTools) return false;
	return tool.annotations?.readOnlyHint === true || BUILTIN_READ_ONLY_TOOL_SET.has(tool.name);
}

function isReadOnlyToolName(name: string, index: ToolInfoIndex): boolean {
	const info = index.get(name);
	return info ? isReadOnlyTool(info) : BUILTIN_READ_ONLY_TOOL_SET.has(name);
}

/** Resolve every child against the parent's live tool selection. Roles without
 * an allowlist inherit the complete active set. Explicit lists are strict: they
 * keep only declared tools that are active in the parent, with shell adaptation.
 * Active extension/SDK tools are never added implicitly. A read-only role keeps
 * every active tool that is proven read-only, so retrieval extensions and MCP
 * servers work without naming them in a role file. pi-subagents controls are
 * always removed so children stay leaves.
 *
 * A declared shell is one slot, so it resolves to one shell: the parent's, and
 * the host-native one when the parent runs both. A child never inherits a shell
 * the parent does not have. */
export function resolveAgentTools(
	agent: AgentConfig,
	activeToolNames: readonly string[],
	toolInfos?: readonly ToolMetadata[],
): AgentConfig {
	const active = [...new Set(activeToolNames)].filter((tool) => !SUBAGENT_TOOL_NAME_SET.has(tool));
	const toolIndex = indexToolInfos(toolInfos);
	// Scout is a hard read-only boundary, so its surface is derived: an override's
	// declared list is dropped and the live catalog alone decides what stays, so
	// the role can never widen past what the host proves read-only. Codemode and
	// tool_search are excluded here because they reach other tools.
	if (agent.name === "scout") {
		const tools = active.filter((tool) => isReadOnlyToolName(tool, toolIndex));
		// A read-only tool the session reaches through codemode or tool_search is
		// part of the same capability, and the child can be handed it directly.
		// Declaring it is the only way to give scout an MCP server it cannot
		// reconfigure, without also giving it a tool that reaches a writer.
		if (active.some((tool) => toolIndex.get(tool)?.reachesTools)) {
			const indirect = [...toolIndex.values()]
				.filter((tool) => typeof tool.exposure === "string" && INDIRECT_EXPOSURES.has(tool.exposure) && isReadOnlyTool(tool))
				.map((tool) => tool.name)
				.filter((name) => !tools.includes(name))
				.sort();
			tools.push(...indirect);
		}
		return { ...agent, tools };
	}
	if (!agent.tools) return { ...agent, tools: active };
	const declaredTools = agent.tools;
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
 * For explicit allowlists only proven read-only tools count as safe: shells,
 * tool-reaching tools, and tools without a read-only annotation stay mutable. */
export function isWriteCapableAgent(
	agent: Pick<AgentConfig, "name" | "tools">,
	toolInfos?: readonly ToolMetadata[],
): boolean {
	if (agent.name === "scout") return false;
	if (agent.name === "artisan") return true;
	if (!agent.tools) return true;
	const toolIndex = indexToolInfos(toolInfos);
	return agent.tools.some((tool) => !isReadOnlyToolName(tool, toolIndex));
}

/** Agents shipped with the package and surfaced by the setup overlay. They are
 * code, not files: a user or project role with the same name still overrides
 * them through discovery. */
export function loadBuiltinAgents(): AgentConfig[] {
	return BUILTIN_AGENTS.map((agent) => ({
		...agent,
		source: "builtin" as const,
		filePath: `builtin:${agent.name}`,
	}));
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
}

/**
 * Discover agents across scopes and apply the enabled-name filter.
 * Override priority for the same name: project > user > builtin.
 *
 * The returned order is canonical — built-ins in BUILTIN_AGENT_NAMES order,
 * then custom agents by name — so every catalog the user sees (setup rows,
 * system-prompt list) renders the same regardless of readdir or toggle order.
 */
export function discoverAgents(cwd: string, options: DiscoverOptions = {}): { agents: AgentConfig[] } {
	const scope = options.scope ?? "user";
	const projectAgentsDir = findNearestProjectAgentsDir(cwd);

	const builtin = loadBuiltinAgents();
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

	const builtinRank = new Map<string, number>(BUILTIN_AGENT_NAMES.map((name, index) => [name, index]));
	return {
		agents: agents.sort(
			(left, right) =>
				(builtinRank.get(left.name) ?? BUILTIN_AGENT_NAMES.length) -
					(builtinRank.get(right.name) ?? BUILTIN_AGENT_NAMES.length) ||
				left.name.localeCompare(right.name),
		),
	};
}

/** One-line catalog entry for system-prompt injection and error messages. */
export function formatCatalogEntry(agent: AgentConfig): string {
	return `- ${agent.name}: ${agent.description}`;
}
