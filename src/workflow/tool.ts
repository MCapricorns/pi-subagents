/**
 * The subagent_workflow tool: declare a dependency graph of sub-agent phases
 * once and let the runtime dispatch dependents as prerequisites settle.
 *
 * The graph is validated before anything starts (see plan.ts), so an invalid
 * plan costs zero child processes. A valid plan returns a launch receipt
 * immediately; one completion message summarises the whole graph.
 */

import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { isWriteCapableAgent, loadBuiltinAgents } from "../delegation/agents.ts";
import { defaultIsolationMode, IsolationSchema, PhaseIdSchema, ScopeSchema } from "../delegation/dispatch.ts";
import { loadConfig } from "../configuration/config.ts";
import { resolveSubagentConcurrency } from "../execution/background.ts";
import type { SubagentRuntime } from "../lifecycle/runtime.ts";
import type { DispatchCore } from "../lifecycle/dispatch-core.ts";
import { projectResultsRoot } from "../lifecycle/thread-shared.ts";
import { formatTaskSummary, monitor } from "../presentation/monitor.ts";
import { pruneWorkflowRecords } from "./durable.ts";
import {
	persistInterruptedWorkflows,
	readRetainedWorkflows,
	startWorkflow,
	workflowStatus,
	type WorkflowStatusView,
} from "./engine.ts";
import { resolveWorkflowDefinition } from "./files.ts";
import { compileWorkflow, WORKFLOW_NODE_ID_MAX_LENGTH, type WorkflowPlanInput } from "./plan.ts";

const WorkflowNodeSchema = Type.Object({
	id: Type.String({
		minLength: 1,
		maxLength: WORKFLOW_NODE_ID_MAX_LENGTH,
		pattern: "^[A-Za-z][A-Za-z0-9._-]*$",
		description: "Stable node id. Dependents name it in dependsOn and in result placeholders.",
	}),
	agent: Type.String({ minLength: 1, description: "Name of an enabled agent." }),
	task: Type.String({
		minLength: 1,
		pattern: "\\S",
		description:
			"Self-contained brief. {{<dependency-id>}} interpolates an upstream node's answer; {{<id>.status}}, {{<id>.runId}} and {{<id>.error}} interpolate facts. Only declared dependencies may be referenced.",
	}),
	dependsOn: Type.Optional(
		Type.Array(Type.String({ minLength: 1 }), {
			description: "Node ids that must complete before this one starts. Omit for a node that starts immediately.",
		}),
	),
	phaseId: PhaseIdSchema,
	scope: ScopeSchema,
	cwd: Type.Optional(Type.String({ description: "Working directory for this node; defaults to the caller cwd." })),
	isolation: IsolationSchema,
});

const WorkflowParams = Type.Object({
	name: Type.Optional(
		Type.String({
			maxLength: 60,
			description: "Workflow name: shown in the widget and status, and the namespace for derived phase ids.",
		}),
	),
	description: Type.Optional(Type.String({ description: "One line stating what the graph delivers." })),
	nodes: Type.Optional(
		Type.Array(WorkflowNodeSchema, { description: "Inline graph. Mutually exclusive with workflow/file." }),
	),
	workflow: Type.Optional(
		Type.String({ description: "Name of a saved workflow under .pi/workflows/ or ~/.pi/agent/workflows/." }),
	),
	file: Type.Optional(
		Type.String({ description: "Workflow definition file (JSON, or Markdown with a json fenced block)." }),
	),
});

export interface WorkflowToolDetails {
	workflow: WorkflowStatusView;
	runIds: number[];
}

function launchReceipt(status: WorkflowStatusView): string {
	const started = status.nodes.filter((node) => !node.waitingFor && node.state === "running").length;
	const waiting = status.nodes.filter((node) => node.state === "pending").length;
	const lines = [
		"workflow #" + status.id + " " + status.name + " started · " + status.nodes.length + " node" + (status.nodes.length === 1 ? "" : "s") + " (" + started + " started, " + waiting + " waiting on dependencies)",
		...(status.description ? [status.description] : []),
		"",
		"Nodes:",
		...status.nodes.map((node) => {
			const parts = ["- " + node.id + " (" + node.agent + ")"];
			if (node.runId !== undefined) parts.push("run #" + node.runId);
			else if (node.waitingFor) parts.push("waits for " + node.waitingFor.join(", "));
			else parts.push(node.state);
			return parts.join(" · ");
		}),
		"",
		"The graph dispatches each dependent the moment its prerequisites settle, with no further dispatch from you. One summary arrives when the whole graph settles; continue disjoint work or end your turn, and do not poll. maxConcurrentAgents paces nodes, so a wide graph queues instead of refusing.",
	];
	return lines.join("\n");
}

/** Compact tool-card view: header plus node rows. */
function formatWorkflowStatusLines(status: WorkflowStatusView, theme: Theme, maxNodes: number): string[] {
	const header =
		theme.fg("toolTitle", theme.bold("workflow #" + status.id + " ")) +
		theme.fg("accent", status.name) +
		" " +
		theme.fg("dim", status.state);
	const lines = [header];
	for (const node of status.nodes.slice(0, maxNodes)) {
		const id = node.runId === undefined ? "—" : "#" + node.runId;
		const detail = node.waitingFor
			? "waits for " + node.waitingFor.join(", ")
			: node.error
				? "error: " + formatTaskSummary(node.error, 60, false)
				: node.activity
					? node.activity
					: node.state;
		lines.push(
			"  " + theme.fg("dim", id.padEnd(6)) + theme.fg("accent", node.id) + " " +
				theme.fg("dim", "(" + node.agent + ") " + detail),
		);
	}
	if (status.nodes.length > maxNodes) lines.push(theme.fg("dim", "  … +" + (status.nodes.length - maxNodes) + " more nodes"));
	return lines;
}

export function registerWorkflowTool(pi: ExtensionAPI, runtime: SubagentRuntime, core: DispatchCore): void {
	// A graph the session ends under keeps its shape on disk for the next
	// session's recovery notice.
	runtime.shutdownHooks.push(() => persistInterruptedWorkflows(runtime));

	pi.registerTool({
		name: "subagent_workflow",
		label: "Subagent Workflow",
		description:
			"Run a dependency graph of sub-agent phases: declare nodes with dependsOn, and the runtime dispatches each dependent as soon as its prerequisites settle and a process slot frees. Use it when a request has several phases with real ordering (map, then parallel changes, then a gate) and you would otherwise dispatch wave after wave by hand. One summary arrives when the graph settles. Nodes are ordinary one-shot runs; main still owns integration, the final gate, and release.",
		exposure: "model-only",
		executionMode: "sequential",
		annotations: {
			readOnlyHint: false,
			destructiveHint: true,
			idempotentHint: false,
			openWorldHint: true,
		},
		parameters: WorkflowParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			await runtime.durableRestore;
			monitor.beginTurn();
			const config = await loadConfig(runtime.configPath);
			runtime.backgroundQueue.setConcurrency(resolveSubagentConcurrency());
			// Both built-in roles are always available; the live tool metadata decides
			// which of them is write-capable in this session.
			const agents = loadBuiltinAgents();
			const toolInfos = runtime.getToolInfos();
			core.setEnvironment({ ctx, config, agents });

			const hasInline = (params.nodes?.length ?? 0) > 0;
			const hasReference = Boolean(params.workflow?.trim() || params.file?.trim());
			if (hasInline === hasReference) {
				throw new Error(
					"Provide exactly one graph source: inline nodes, or a saved workflow/file. No nodes were started.",
				);
			}

			let plan: WorkflowPlanInput = {
				...(params.name ? { name: params.name } : {}),
				...(params.description ? { description: params.description } : {}),
				nodes: params.nodes ?? [],
			};
			let fallbackName = params.name ?? "workflow";
			if (hasReference) {
				const resolved = resolveWorkflowDefinition(
					ctx.cwd,
					{ ...(params.workflow ? { name: params.workflow } : {}), ...(params.file ? { path: params.file } : {}) },
					{ projectTrusted: ctx.isProjectTrusted?.() === true },
				);
				if (resolved.error || !resolved.definition) {
					throw new Error((resolved.error ?? "workflow definition could not be read") + ". No nodes were started.");
				}
				const definition = resolved.definition;
				plan = {
					name: definition.plan.name ?? definition.name,
					...(definition.plan.description ?? params.description
						? { description: definition.plan.description ?? params.description }
						: {}),
					nodes: definition.plan.nodes,
				};
				fallbackName = definition.name;
			}

			let workflow;
			try {
				workflow = compileWorkflow(plan, ctx.cwd, agents.map((agent) => agent.name), { fallbackName });
			} catch (error) {
				throw new Error(
					"Workflow rejected before any node started:\n" + (error instanceof Error ? error.message : String(error)),
				);
			}

			const handle = startWorkflow(
				{
					runtime,
					startBackground: core.startBackground,
					resolveIsolation: (agentName) => {
						const agent = agents.find((candidate) => candidate.name === agentName);
						return defaultIsolationMode(
							"parallel",
							agentName,
							undefined,
							agent ? isWriteCapableAgent(agent, toolInfos) : undefined,
						);
					},
					resultsRoot: projectResultsRoot(runtime.configPath, ctx.cwd),
					notify: (message, kind) => ctx.ui.notify(message, kind),
				},
				workflow,
			);
			const status = workflowStatus(handle.run);
			return {
				content: [{ type: "text", text: launchReceipt(status) }],
				details: {
					workflow: status,
					runIds: status.nodes.flatMap((node) => (node.runId === undefined ? [] : [node.runId])),
				} satisfies WorkflowToolDetails,
			};
		},

		renderCall(args, theme) {
			const count = args.nodes?.length ?? 0;
			const label = args.name ?? args.workflow ?? args.file ?? "inline";
			const graph = count > 0 ? " " + count + " nodes" : "";
			return new Text(
				theme.fg("toolTitle", theme.bold("subagent_workflow ")) + theme.fg("accent", label) + theme.fg("dim", graph),
				0,
				0,
			);
		},

		renderResult(result, options, theme) {
			const details = result.details as WorkflowToolDetails | undefined;
			if (!details?.workflow) return new Text(theme.fg("dim", "(no output)"), 0, 0);
			const status = details.workflow;
			const lines = formatWorkflowStatusLines(status, theme, options.expanded ? status.nodes.length : 6);
			return new Text(lines.join("\n"), 0, 0);
		},
	});
}

/** Session start: drop stale graph records and tell the user what the previous
 * session left unfinished. */
export async function restoreWorkflowState(runtime: SubagentRuntime, ctx: ExtensionContext): Promise<void> {
	await pruneWorkflowRecords(runtime.configPath).catch(() => undefined);
	const retained = await readRetainedWorkflows(runtime, ctx.cwd).catch(() => []);
	if (retained.length === 0) return;
	const summary = retained
		.slice(0, 3)
		.map((record) => {
			const done = record.nodes.filter((node) => node.state === "completed").length;
			return "#" + record.id + " " + record.name + " (" + done + "/" + record.nodes.length + " nodes completed)";
		})
		.join("; ");
	ctx.ui.notify(
		"pi-subagents: " + retained.length + " unfinished workflow" + (retained.length === 1 ? "" : "s") +
			" retained — " + summary + ". Inspect with subagent_status; main finishes the work.",
		"info",
	);
}
