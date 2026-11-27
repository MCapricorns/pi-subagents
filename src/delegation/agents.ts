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
export const BUILTIN_READ_ONLY_TOOL_NAMES = ["read", "grep", "find", "ls"] as const;
const BUILTIN_READ_ONLY_TOOL_SET: ReadonlySet<string> = new Set(BUILTIN_READ_ONLY_TOOL_NAMES);
export const SUBAGENT_TOOL_NAMES = [
	"subagent",
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
	sourceInfo?: Pick<ToolInfo["sourceInfo"], "source">;
};

/** Exposures callable through a script or `tool_search` without activation. */
const INDIRECT_EXPOSURES: ReadonlySet<string> = new Set(["codemode", "deferred"]);
/** Live tool metadata keyed by name for read-only checks. */
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
	if (tool.reachesTools || tool.annotations?.destructiveHint) return false;
	return tool.annotations?.readOnlyHint
		?? (BUILTIN_READ_ONLY_TOOL_SET.has(tool.name) && (tool.sourceInfo?.source ?? "builtin") === "builtin");
}

function isReadOnlyToolName(name: string, index: ToolInfoIndex): boolean {
	const info = index.get(name);
	return info ? isReadOnlyTool(info) : BUILTIN_READ_ONLY_TOOL_SET.has(name);
}

/** Resolve a child against the parent's active and callable indirect tools.
 * Inactive direct tools stay excluded. Researcher promotes only tools marked
 * read-only; pi-subagents controls are removed so children stay leaves. */
export function resolveAgentTools(
	agent: AgentConfig,
	activeToolNames: readonly string[],
	toolInfos?: readonly ToolMetadata[],
): AgentConfig {
	const active = new Set(activeToolNames.filter((tool) => !SUBAGENT_TOOL_NAME_SET.has(tool)));
	const toolIndex = indexToolInfos(toolInfos);
	const indirect = [...toolIndex.values()]
		.filter((tool) => tool.exposure && INDIRECT_EXPOSURES.has(tool.exposure) && !SUBAGENT_TOOL_NAME_SET.has(tool.name))
		.map((tool) => tool.name)
		.filter((name) => !active.has(name))
		.sort();
	if (agent.name !== "researcher") return { ...agent, tools: [...active, ...indirect] };
	// Researcher uses the live catalog's read-only classification. Codemode and
	// tool_search are excluded because they can reach tools outside that set.
	const activeNames = [...active];
	const tools = activeNames.filter((tool) => isReadOnlyToolName(tool, toolIndex));
	// The child explicitly activates these after registration, without giving
	// researcher an orchestrating tool that could also reach writers.
	if (activeNames.some((tool) => toolIndex.get(tool)?.reachesTools)) {
		tools.push(...indirect.filter((name) => isReadOnlyToolName(name, toolIndex)));
	}
	return { ...agent, tools };
}

/** The fixed built-in catalog, in setup order. */
export function loadBuiltinAgents(): AgentConfig[] {
	return BUILTIN_AGENTS.map((agent) => ({ ...agent }));
}

/** One-line catalog entry for system-prompt injection and error messages. */
export function formatCatalogEntry(agent: AgentConfig): string {
	return `- ${agent.name}: ${agent.description}`;
}
