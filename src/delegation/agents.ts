/**
 * Agent catalog and tool resolution.
 *
 * The catalog consists of the built-in roles shipped as code in
 * builtin-agents.ts. All are always enabled; there are no
 * user or project role files and nothing to discover on disk. The rest of this
 * module resolves each role against the parent's live tool surface.
 */

import type { ToolInfo } from "@earendil-works/pi-coding-agent";
import { BUILTIN_AGENTS } from "./builtin-agents.ts";

export interface AgentConfig {
	name: string;
	description: string;
	tools?: string[];
	/** Model ref this run was routed to; filled in by dispatch. */
	model?: string;
	systemPrompt: string;
}

const SHELL_TOOL_NAMES = new Set(["bash", "powershell"]);
/** Pi's own retrieval builtins. They carry no annotations, so they are the only
 * names that are read-only without the host saying so. */
const BUILTIN_READ_ONLY_TOOL_NAMES = ["read", "grep", "find", "ls"] as const;
const BUILTIN_READ_ONLY_TOOL_SET: ReadonlySet<string> = new Set(BUILTIN_READ_ONLY_TOOL_NAMES);
export const SUBAGENT_TOOL_NAMES = [
	"subagent",
	"subagent_workflow",
	"subagent_status",
	"subagent_message",
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

/** Resolve a child against the parent's live tool selection. Broad roles
 * inherit the complete active set. A read-only role keeps every active tool
 * that is proven read-only, so retrieval extensions and MCP servers work
 * without being named anywhere. pi-subagents controls are always removed so
 * children stay leaves. */
export function resolveAgentTools(
	agent: AgentConfig,
	activeToolNames: readonly string[],
	toolInfos?: readonly ToolMetadata[],
): AgentConfig {
	const active = [...new Set(activeToolNames)].filter((tool) => !SUBAGENT_TOOL_NAME_SET.has(tool));
	const toolIndex = indexToolInfos(toolInfos);
	if (agent.name !== "scout") return { ...agent, tools: active };
	// Scout is a hard read-only boundary, so its surface is derived from the
	// live catalog alone — the role can never widen past what the host proves
	// read-only. Codemode and tool_search are excluded because they reach other
	// tools.
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

/** Filesystem-write capability used by worktree admission and writer-scope
 * safety. Scout is a hard read-only boundary. An unresolved tools list means
 * the child inherits arbitrary active tools and is therefore mutable; for a
 * resolved list only proven read-only tools count as safe — shells,
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

/** The fixed built-in catalog, in setup order. */
export function loadBuiltinAgents(): AgentConfig[] {
	return BUILTIN_AGENTS.map((agent) => ({ ...agent }));
}

/** One-line catalog entry for system-prompt injection and error messages. */
export function formatCatalogEntry(agent: AgentConfig): string {
	return `- ${agent.name}: ${agent.description}`;
}
