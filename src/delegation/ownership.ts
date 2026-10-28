/** Shared writer admission for main tools, leaf runs, and reserved graph nodes. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { SubagentRuntime } from "../lifecycle/runtime.ts";
import type { PhaseLeaseSource } from "./prompt.ts";
import { findPhaseScopeOverlap, findWriterLeaseScopeOverlap, type PhaseScope, type PhaseScopeOverlap } from "./phase-scope.ts";

/** Pending nodes own their scope before a child has a run id. */
export function pendingWorkflowLeases(
	runtime: Pick<SubagentRuntime, "workflows">,
	excludeWorkflowId?: number,
): PhaseLeaseSource[] {
	const sources: PhaseLeaseSource[] = [];
	for (const graph of runtime.workflows.values()) {
		if (graph.state !== "running" || graph.id === excludeWorkflowId) continue;
		for (const node of graph.nodes) {
			if (node.state !== "pending" && !(node.state === "running" && node.runId === undefined)) continue;
			sources.push({
				id: graph.id,
				agentName: node.agent,
				task: node.task,
				phaseId: node.phaseId,
				cwd: node.cwd,
				state: "queued",
				scope: node.scope,
				workflow: { workflowId: graph.id, name: graph.name, nodeId: node.id },
			});
		}
	}
	return sources;
}

export interface WriterConflict {
	owner: string;
	overlap: PhaseScopeOverlap;
}

/** The graph may dispatch its own ordered nodes; all external writers must wait. */
export function findRuntimeWriterConflict(
	runtime: Pick<SubagentRuntime, "threads" | "workflows" | "mainWrites">,
	scope: PhaseScope,
	options: { excludeWorkflowId?: number; includeMain?: boolean } = {},
): WriterConflict | undefined {
	const active = findWriterLeaseScopeOverlap(scope, runtime.threads.values());
	if (active) return { owner: `run #${active.lease.id}`, overlap: active.overlap };
	const pending = findWriterLeaseScopeOverlap(scope, pendingWorkflowLeases(runtime, options.excludeWorkflowId));
	if (pending) {
		const source = pending.lease as PhaseLeaseSource;
		return { owner: `workflow #${source.workflow!.workflowId} node "${source.workflow!.nodeId}"`, overlap: pending.overlap };
	}
	if (options.includeMain !== false) {
		for (const write of runtime.mainWrites.values()) {
			const overlap = findPhaseScopeOverlap(scope, write.scope);
			if (overlap) return { owner: `main ${write.toolName}`, overlap };
		}
	}
	return undefined;
}

/** Match the native edit/write path conventions without importing private Pi APIs. */
function mainWriteScope(rawPath: string, cwd: string): PhaseScope {
	let path = rawPath.replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/gu, " ").replace(/^@/u, "");
	if (process.platform === "win32" && !path.includes("\\")) {
		path = path.replace(/^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/iu, (_match, drive: string, suffix = "") => `${drive}:/${suffix}`);
	}
	if (path === "~") path = homedir();
	else if (path.startsWith("~/") || (process.platform === "win32" && path.startsWith("~\\"))) path = resolve(homedir(), path.slice(2));
	if (path.startsWith("file://")) path = fileURLToPath(path);
	path = resolve(cwd, path);
	return { paths: [process.platform === "win32" ? path.toLowerCase() : path] };
}

/** Hooks also see edit/write calls nested inside codemode. Opaque shell commands
 * and custom tool effects cannot be inferred from a path declaration. */
export function registerMainOwnershipGuard(pi: ExtensionAPI, runtime: SubagentRuntime): void {
	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "edit" && event.toolName !== "write") return;
		if (typeof event.input.path !== "string" || !event.input.path) return;
		await runtime.durableRestore;
		if (!runtime.sessionActive) return { block: true, reason: "Parent session ended before this write could start." };
		const scope = mainWriteScope(event.input.path, ctx.cwd);
		const conflict = findRuntimeWriterConflict(runtime, scope, { includeMain: false });
		if (conflict) {
			return {
				block: true,
				reason: `Main ${event.toolName} blocked: ${conflict.owner} owns scope ${conflict.overlap.right}. Reuse its result; continue only disjoint work. To take over, stop the owner and wait for its writes and integration to settle. Do not bypass ownership with another tool.`,
			};
		}
		// Hold this claim through execution so a simultaneous delegation cannot
		// start in the gap between tool_call and the actual filesystem mutation.
		runtime.mainWrites.set(event.toolCallId, { toolName: event.toolName, scope });
	});
	pi.on("tool_execution_end", (event) => {
		runtime.mainWrites.delete(event.toolCallId);
	});
}
