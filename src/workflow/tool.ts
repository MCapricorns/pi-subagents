/**
 * The subagent_workflow tool runs a built-in plan with named task inputs.
 * Scheduling, isolation, and independent acceptance are owned by the runtime.
 *
 * The graph is validated before anything starts (see plan.ts), so an invalid
 * plan costs zero child processes. Headless calls await the complete graph by
 * default; UI calls return a launch receipt and receive one completion message.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { isWriteCapableAgent, loadBuiltinAgents } from "../delegation/agents.ts";
import { defaultIsolationMode } from "../delegation/dispatch.ts";
import { findRuntimeWriterConflict } from "../delegation/ownership.ts";
import { loadConfig } from "../configuration/config.ts";
import type { SubagentRuntime } from "../lifecycle/runtime.ts";
import type { DispatchCore } from "../lifecycle/dispatch-core.ts";
import { cancelActiveWork } from "../lifecycle/cancellation.ts";
import { projectResultsRoot } from "../lifecycle/thread-shared.ts";
import { formatTaskSummary, monitor } from "../presentation/monitor.ts";
import { pruneWorkflowRecords } from "./durable.ts";
import {
	findOwnedPhases,
	formatWorkflowSummary,
	formatWorkflowStatus,
	persistInterruptedWorkflows,
	readRetainedWorkflows,
	startWorkflow,
	workflowStatus,
	type WorkflowStatusView,
} from "./engine.ts";
import { compileBuiltinWorkflow } from "./templates.ts";

const WorkflowParams = Type.Object({
	workflow: StringEnum(["code-review", "research", "migration"] as const, {
		description: "Built-in plan: code-review inspects a target; research answers a question; migration applies two planned slices. Every plan ends with independent acceptance.",
	}),
	wait: Type.Optional(Type.Boolean({
		description: "Wait for all nodes, integration, and independent acceptance, then return the final summary. Defaults to true in one-shot print/JSON sessions and false in TUI/RPC. Explicit false returns a launch receipt and delivers one background summary.",
	})),
	inputs: Type.Record(Type.String(), Type.String({ minLength: 1, pattern: "\\S" }), {
		description: "Named inputs. code-review: TARGET. research: QUESTION. migration: TARGET, CONTRACT, CORE_CHANGE, ADAPTER_CHANGE, CORE_SCOPE, CORE_TEST_SCOPE, ADAPTER_SCOPE, ADAPTER_TEST_SCOPE. Scope values are exact paths relative to cwd. Include existing evidence and done conditions in task inputs.",
	}),
});

export interface WorkflowToolDetails {
	workflow: WorkflowStatusView;
}

function launchReceipt(status: WorkflowStatusView): string {
	const started = status.nodes.filter((node) => node.runId !== undefined).length;
	const waiting = status.nodes.filter((node) => node.waitingFor).length;
	const starting = status.nodes.length - started - waiting;
	const lines = [
		"workflow #" + status.id + " " + status.name + " started · " + status.nodes.length + " node" + (status.nodes.length === 1 ? "" : "s") + " (" + started + " dispatched, " + starting + " starting, " + waiting + " waiting on dependencies)",
		...(status.description ? [status.description] : []),
		"",
		"Nodes:",
		...status.nodes.map((node) => {
			const parts = ["- " + node.id + " (" + node.agent + ")" + (node.kind === "acceptance" ? " · required independent acceptance" : "")];
			if (node.runId !== undefined) parts.push("run #" + node.runId);
			else if (node.waitingFor) parts.push("waits for " + node.waitingFor.join(", "));
			else parts.push(node.state);
			return parts.join(" · ");
		}),
		"",
		"Every node is owned by this graph, including nodes waiting on dependencies. Do not perform or redispatch their work in main or another agent. Required independent acceptance runs after all authored work settles and integrates, including failed branches; the graph succeeds only when all work and acceptance pass. The graph sends one summary; continue disjoint work or pause this turn until it arrives, then finish the requested outcome. A launch receipt is not task completion. Do not poll.",
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
			"Run a built-in workflow with named inputs: code-review, research, or migration. Custom graphs and workflow files are unsupported. The runtime schedules dependencies, integrates work, and requires an independent sentinel acceptance PASS. Pending nodes own their work; main must not duplicate it. Duplicate deliverables and writer conflicts reject the plan before dispatch. One-shot print/JSON calls wait by default; TUI/RPC calls run in the background. Set wait to override. Awaited calls return the summary once, after integration and acceptance. Use subagent for a single phase or independent tasks.",
		exposure: "model-only",
		executionMode: "parallel",
		annotations: {
			readOnlyHint: false,
			destructiveHint: true,
			idempotentHint: false,
			openWorldHint: true,
		},
		parameters: WorkflowParams,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			await runtime.durableRestore;
			monitor.beginTurn();
			const config = await loadConfig(runtime.configPath);
			// All built-in roles are always available; the live tool metadata decides
			// which of them is write-capable in this session.
			const agents = loadBuiltinAgents();
			const toolInfos = runtime.getToolInfos();
			core.setEnvironment({ ctx, config, agents });

			// Ignore empty legacy placeholders, which previously triggered ambiguous
			// source errors. A supplied custom definition is always rejected.
			const unsupported = Object.entries(params as Record<string, unknown>).filter(([key, value]) =>
				key !== "workflow" && key !== "inputs" && key !== "wait" && value !== undefined && value !== null && value !== ""
				&& !(Array.isArray(value) && value.length === 0),
			).map(([key]) => key);
			if (unsupported.length) throw new Error(`Custom workflow fields are unsupported: ${unsupported.join(", ")}. Use only workflow, inputs, and wait. No nodes were started.`);
			const workflow = compileBuiltinWorkflow(params.workflow, params.inputs, ctx.cwd, agents.map((agent) => agent.name));
			if (signal?.aborted) throw new Error("Workflow cancelled before any node started.");

			// Re-using a phase another owner holds fails the first node and blocks the
			// rest; reject the whole graph instead, with the owners named.
			const owned = findOwnedPhases(runtime, workflow);
			if (owned.length > 0) {
				const lines = owned.map((owner) =>
					"- node \"" + owner.nodeId + "\" → phase \"" + owner.phaseId + "\" is already owned by " + (owner.runId !== undefined ? "run #" + owner.runId : "workflow #" + owner.workflowId + " node " + owner.ownerNodeId) +
					" (" + owner.agent + ", " + owner.state + ")",
				);
				throw new Error(
					"Workflow \"" + workflow.name + "\" was not started: " + owned.length + " of " + workflow.nodes.length +
					" node" + (owned.length === 1 ? " reuses" : "s reuse") + " a phase this session already owns.\n" +
					lines.join("\n") +
					"\nInspect the owning run or workflow with subagent_status and reuse its evidence. Main handles follow-up work. Retire an interrupted run with subagent_stop({ id: \"<run id>\" }) only when discarding its retained session is intended. Different deliverables need different task inputs. No nodes were started.",
				);
			}

			for (const node of workflow.nodes) {
				const agent = agents.find((candidate) => candidate.name === node.agent)!;
				if (!node.scope || !isWriteCapableAgent(agent, toolInfos)) continue;
				const conflict = findRuntimeWriterConflict(runtime, node.scope);
				if (conflict) throw new Error(`Workflow node "${node.id}" scope ${conflict.overlap.left} overlaps ${conflict.owner} scope ${conflict.overlap.right}. No nodes were started.`);
			}

			const wait = params.wait ?? (ctx.hasUI === false);
			const resultsRoot = projectResultsRoot(runtime.configPath, ctx.cwd);
			const handle = startWorkflow(
				{
					runtime,
					startBackground: core.startBackground,
					resolveIsolation: (agentName) => {
						const agent = agents.find((candidate) => candidate.name === agentName);
						return defaultIsolationMode(
							agentName,
							undefined,
							agent ? isWriteCapableAgent(agent, toolInfos) : undefined,
						);
					},
					deliveryRoute: wait ? "await" : "background",
					resultsRoot,
					notify: (message, kind) => ctx.ui.notify(message, kind),
				},
				workflow,
			);
			if (wait) {
				let cancellation: Promise<void> | undefined;
				const onAbort = (): void => {
					cancellation ??= cancelActiveWork(runtime, "Parent run was cancelled.");
				};
				const emitProgress = (): void => {
					onUpdate?.({
						content: [{ type: "text", text: formatWorkflowStatus(handle.run).join("\n") }],
						details: { workflow: workflowStatus(handle.run) } satisfies WorkflowToolDetails,
					});
				};
				const unsubscribe = onUpdate ? monitor.subscribe(emitProgress) : undefined;
				try {
					signal?.addEventListener("abort", onAbort, { once: true });
					if (signal?.aborted) onAbort();
					emitProgress();
					const run = await handle.done;
					await cancellation;
					return {
						content: [{ type: "text", text: formatWorkflowSummary(run, resultsRoot) }],
						details: { workflow: workflowStatus(run) } satisfies WorkflowToolDetails,
						isError: run.state !== "completed",
					};
				} finally {
					signal?.removeEventListener("abort", onAbort);
					unsubscribe?.();
				}
			}
			const status = workflowStatus(handle.run);
			return {
				content: [{ type: "text", text: launchReceipt(status) }],
				details: { workflow: status } satisfies WorkflowToolDetails,
			};
		},

		renderCall(args, theme) {
			return new Text(
				theme.fg("toolTitle", theme.bold("subagent_workflow ")) + theme.fg("accent", args.workflow ?? "?"),
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
