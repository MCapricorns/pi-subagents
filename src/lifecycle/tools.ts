/** Run inspection, steering, completed-run follow-ups, and destructive cancellation. */

import { randomUUID } from "node:crypto";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { DEFAULT_MAX_RESULT_LINES, loadConfig } from "../configuration/config.ts";
import { loadBuiltinAgents } from "../delegation/agents.ts";
import { findSessionFile, getProjectRoot, getResultOutput, sessionExists } from "../execution/spawn.ts";
import { writeTempOwnerMarker } from "../isolation/temp-hygiene.ts";
import type { DispatchCore } from "./dispatch-core.ts";
import { stopThreads } from "./stop.ts";
import { formatCompletionBlock, matchRunIds } from "../presentation/format.ts";
import { emptyUsage } from "../execution/run-control.ts";
import { formatDuration, formatTaskSummary, monitor, runWaitLabel } from "../presentation/monitor.ts";
import type { SubagentRuntime, SubagentThread } from "./runtime.ts";
import { projectResultsRoot } from "./thread-shared.ts";
import { getResultError } from "../execution/spawn.ts";
import {
	formatRetainedWorkflow,
	formatWorkflowStatus,
	readRetainedWorkflows,
	stopWorkflow,
	workflowStatus,
} from "../workflow/engine.ts";

function renderFirstLine(result: { content?: unknown }, label: string, theme: any): Text {
	const parts = (result.content ?? []) as Array<{ type: string; text?: string }>;
	const text = parts
		.map((part) => (typeof part.text === "string" ? part.text : ""))
		.join(" ")
		.trim();
	const firstLine = text.split("\n").find((line) => line.trim()) ?? "(no output)";
	return new Text(`${theme.fg("toolTitle", theme.bold(label))}${theme.fg("dim", firstLine.slice(0, 60))}`, 0, 0);
}

/** Files a finished run read or changed, recovered from its recorded tool
 * calls. A new child cannot see that history, so naming the paths is the
 * difference between a useful brief and a blind restart. */
function touchedPaths(messages: readonly Message[] | undefined): string[] {
	const paths = new Set<string>();
	const visit = (value: unknown, depth: number): void => {
		if (depth > 3 || !value || typeof value !== "object") return;
		for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
			if (/^(path|paths|file|files|file_path|target|pattern)$/u.test(key)) {
				for (const candidate of Array.isArray(child) ? child : [child]) {
					if (typeof candidate === "string" && candidate.length <= 200 && /[\\/.]/u.test(candidate)) paths.add(candidate);
				}
				continue;
			}
			visit(child, depth + 1);
		}
	};
	for (const message of messages ?? []) {
		const content = (message as { content?: unknown }).content;
		if (Array.isArray(content)) for (const part of content) visit(part, 0);
	}
	return [...paths].slice(0, 20);
}

/** Brief for a summary follow-up: what the run was asked, what it delivered,
 * which files it touched, and the new instruction — bounded so a long result
 * cannot become the whole context. */
function buildSummaryFollowUp(thread: SubagentThread, message: string): string {
	const prior = thread.lastResult ? getResultOutput(thread.lastResult) : "(no recorded result)";
	const bounded = prior.length > 4_000 ? prior.slice(0, 4_000) + "\n…(truncated; read the files for detail)" : prior;
	const files = touchedPaths(thread.lastResult?.messages);
	return [
		`Earlier run #${thread.id} (${thread.agentName}) was briefed with:`,
		formatTaskSummary(thread.task, 1_200, false),
		"",
		"It finished with:",
		bounded,
		...(files.length ? ["", "Files it touched:", files.map((path) => `- ${path}`).join("\n")] : []),
		"",
		"Continue with this instruction:",
		message,
		"",
		"You did not witness the earlier session. Verify the files before relying on them, and state any assumption this summary does not support.",
	].join("\n");
}

export function registerLookupTools(pi: ExtensionAPI, runtime: SubagentRuntime, dispatchCore?: DispatchCore): void {
	pi.registerTool({
		name: "subagent_status",
		label: "Subagent Status",
		description: "Inspect run or workflow ownership, progress, and failures. An exact run id also returns its retained result so completed work can be reused. Omit id to list runs. Results arrive automatically; do not poll.",
		exposure: "model-only",
		executionMode: "parallel",
		annotations: {
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		},
		parameters: Type.Object({
			id: Type.Optional(Type.Integer({ minimum: 1, description: "Exact run id; omit to list all runs in this parent session." })),
			workflow: Type.Optional(Type.Integer({ minimum: 1, description: "Workflow graph id; omit to list every graph in this parent session." })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			await runtime.durableRestore;
			const threads = [...runtime.threads.values()]
				.filter((thread) => params.id === undefined || thread.id === params.id)
				.sort((left, right) => left.id - right.id);
			const runs = threads.map((thread) => {
				const live = monitor.findRun(thread.id);
				const result = runtime.settledRuns.get(thread.id) ?? thread.lastResult;
				const state = thread.lifecycleOperation === "stop" ? "interrupting"
					: thread.retired ? "stopped"
					: thread.lifecycleOperation === "settle" ? "settling"
					: thread.state === "parked" ? "interrupted" : thread.state;
				return {
					id: thread.id,
					agent: thread.agentName,
					phaseId: thread.phaseId,
					cwd: thread.cwd,
					executionCwd: thread.executionCwd,
					scope: thread.scope,
					taskSummary: formatTaskSummary(thread.task, 80, false),
					state,
					waitReason: state === "queued" ? live?.waitReason : undefined,
					activity: live?.activity,
					recentActivity: live?.recentActivity ?? [],
					elapsedMs: monitor.getElapsedMs(thread.id) ?? thread.elapsedMs,
					model: live?.model ?? result?.model,
					thinking: live?.thinking ?? result?.thinking ?? thread.thinkingLevel,
					usage: { ...(live?.usage ?? result?.usage ?? emptyUsage()) },
					exitCode: result?.exitCode,
					stopReason: result?.stopReason,
					errorMessage: result ? getResultError(result) : state === "failed" ? "No failure reason was recorded." : undefined,
					resultFile: result?.resultFile,
					sessionDir: thread.retired ? undefined : thread.sessionDir ?? result?.sessionDir,
					followUpContext: state === "completed"
						? thread.sessionDir && thread.sessionId && sessionExists(thread.sessionDir, thread.sessionId) ? "session" : "summary"
						: undefined,
					isolation: thread.isolation,
					isolationNote: result?.isolationNote,
					integrationStatus: live?.integrationStatus ?? result?.integrationStatus ?? thread.worktree?.state,
					integrationError: result?.integrationError,
					integrationWorktreePath: result?.integrationWorktreePath ?? (state === "interrupted" ? thread.worktree?.worktreePath : undefined),
					integrationPatchPath: result?.integrationPatchPath,
				};
			});
			const text = runs.length === 0
				? params.id === undefined ? "No subagent runs in this parent session." : `No subagent run matches #${params.id}.`
				: runs.map((run) => {
					const wait = run.waitReason ? ` — ${runWaitLabel({ status: "queued", waitReason: run.waitReason })}` : "";
					const lines = [`#${run.id} ${run.agent} · ${run.state} · ${formatDuration(run.elapsedMs)}${wait}`, `  task: ${run.taskSummary}`];
					if (run.phaseId) lines.push(`  phase: ${run.phaseId}`);
					if (run.scope) lines.push(`  scope: ${JSON.stringify(run.scope)}`);
					if (run.isolationNote) lines.push(`  isolation: ${run.isolationNote}`);
					if (run.followUpContext) lines.push(`  follow-up: ${run.followUpContext}${run.followUpContext === "summary" ? " (retained session unavailable)" : " available"}`);
					// The trail is the progress answer: what the run has been doing,
					// newest last. It replaces pointing the parent at child session
					// files, which it cannot usefully read mid-run.
					const trail = [...run.recentActivity];
					if (run.activity && trail[trail.length - 1] !== run.activity) trail.push(run.activity);
					if (trail.length > 0) lines.push(`  activity: ${trail.slice(-4).join(" · ")}`);
					if (run.errorMessage) lines.push(`  error: ${formatTaskSummary(run.errorMessage, 300, false)}`);
					// Only actionable paths: the full-result file (set when the
					// completion was truncated) and retained recovery artifacts.
					const paths = [
						run.resultFile ? `full result: ${run.resultFile}` : undefined,
						run.integrationWorktreePath ? `retained worktree: ${run.integrationWorktreePath}` : undefined,
						run.integrationPatchPath ? `retained patch: ${run.integrationPatchPath}` : undefined,
					].filter(Boolean);
					if (paths.length > 0) lines.push(`  ${paths.join("\n  ")}`);
					return lines.join("\n");
				}).join("\n");
			// Workflow graphs are reported beside individual runs: which nodes have
			// started, which one is waiting on a dependency, and what a graph that
			// outlived its session left behind.
			const workflowId = params.id === undefined ? params.workflow : undefined;
			const workflowRuns = [...runtime.workflows.values()]
				.filter((run) => workflowId === undefined || run.id === workflowId)
				.sort((left, right) => left.id - right.id);
			const retainedWorkflows = (await readRetainedWorkflows(runtime, ctx?.cwd ?? process.cwd()).catch(() => []))
				.filter((record) => workflowId === undefined || record.id === workflowId)
				.filter((record) => !workflowRuns.some((run) => run.id === record.id));
			const workflowSections = params.id === undefined ? [
				...workflowRuns.map((run) => formatWorkflowStatus(run).join("\n")),
				...retainedWorkflows.map((record) => formatRetainedWorkflow(record).join("\n")),
			] : [];
			const selected = params.id === undefined ? undefined : runtime.threads.get(params.id);
			const retainedResult = selected ? runtime.settledRuns.get(selected.id) ?? selected.lastResult : undefined;
			const evidence = retainedResult && retainedResult.exitCode !== -1
				? retainedResult.resultFile
					? `Read the retained result: ${retainedResult.resultFile}`
					: formatCompletionBlock(retainedResult, DEFAULT_MAX_RESULT_LINES, { resultRoot: projectResultsRoot(runtime.configPath, selected!.cwd) })
				: "";
			const sections = [text, ...workflowSections, evidence].filter((section) => section.trim().length > 0);
			const unknownWorkflow = workflowId !== undefined && workflowRuns.length === 0 && retainedWorkflows.length === 0;
			return {
				content: [{
					type: "text",
					text: unknownWorkflow
						? `No workflow graph matches #${params.workflow} in this parent session.`
						: sections.join("\n\n"),
				}],
				details: {
					runs,
					workflows: workflowRuns.map(workflowStatus),
					retainedWorkflows,
				},
				...((params.id !== undefined && runs.length === 0) || unknownWorkflow ? { isError: true } : {}),
			};
		},
		renderCall(args, theme) {
			return new Text(`${theme.fg("toolTitle", theme.bold("subagent_status "))}${theme.fg("accent", args.id === undefined ? "all" : `#${args.id}`)}`, 0, 0);
		},
		renderResult(result, options, theme) {
			if (options.expanded) return new Text(result.content.map((part) => part.type === "text" ? part.text : "").join("\n"), 0, 0);
			return renderFirstLine(result, "subagent_status ", theme);
		},
	});

	pi.registerTool({
		name: "subagent_message",
		label: "Subagent Message",
		description: "Send a steering message to a running subagent, or continue a successfully completed run. Omit context or use \"auto\" to reuse its retained session when available and otherwise start from a bounded summary, reporting the fallback. Use \"session\" only when full history is required; missing history is an error. Use \"summary\" for a new next step with only the earlier objective, result, and touched files. Session copies preserve history and the provider cache key; summary runs have neither. Steering is acknowledged as queued, not necessarily acted on.",
		exposure: "model-only",
		executionMode: "sequential",
		parameters: Type.Object({
			id: Type.Integer({ minimum: 1, description: "Exact run id in this parent session." }),
			message: Type.String({ minLength: 1, pattern: "\\S", description: "Additional instruction or follow-up question." }),
			context: Type.Optional(Type.String({ enum: ["auto", "session", "summary"], description: "auto (default) uses the retained session when available, otherwise a bounded summary and reports the fallback. session requires the full retained history and fails if unavailable. summary always starts fresh with the earlier objective, result, and touched files; no history or cache reuse." })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			await runtime.durableRestore;
			const thread = runtime.threads.get(params.id);
			const fail = (message: string) => ({ content: [{ type: "text" as const, text: message }], details: {}, isError: true });
			if (_signal?.aborted) return fail("Subagent message cancelled before delivery.");
			if (!thread || thread.retired) return fail(`No available run matches #${params.id} in this session.`);
			if (thread.state === "running" && !thread.lifecycleOperation) {
				try {
					await thread.control.steer(params.message);
					return { content: [{ type: "text" as const, text: `Steering queued for #${thread.id}; it has not necessarily been acted on yet.` }], details: { id: thread.id } };
				} catch (error) { return fail(`Could not send to #${thread.id}: ${error instanceof Error ? error.message : String(error)}`); }
			}
			if (thread.state !== "completed" || thread.lifecycleOperation) {
				const state = thread.state === "parked" ? "interrupted" : thread.state;
				const terminal = !thread.lifecycleOperation && ["parked", "failed", "stopped"].includes(thread.state);
				return fail(`Run #${thread.id} is ${state}; ${terminal
					? "inspect retained results with subagent_status and handle unfinished work in main. This run cannot be continued with subagent_message."
					: "messages require a running or successfully completed run. Results arrive automatically."}`);
			}
			if (!dispatchCore) return fail("Follow-up dispatch is unavailable in this process.");
			const context = params.context ?? "auto";
			const sourceFile = context !== "summary" && thread.sessionDir && thread.sessionId
				? findSessionFile(thread.sessionDir, thread.sessionId) : undefined;
			if (context === "session" && !sourceFile) {
				return fail(`Run #${thread.id} has no available session to continue; use context: "auto" or "summary" for a bounded summary without the earlier history.`);
			}
			let fallbackReason = context === "auto" && !sourceFile ? "Retained session is unavailable." : undefined;
			let copyDir: string | undefined;
			try {
				dispatchCore.setEnvironment({ ctx, config: await loadConfig(runtime.configPath), agents: loadBuiltinAgents() });
				if (sourceFile) {
					const root = join(getProjectRoot(runtime.configPath, thread.cwd), "sessions");
					await mkdir(root, { recursive: true });
					copyDir = await mkdtemp(join(root, "pi-subagent-session-"));
					writeTempOwnerMarker(copyDir);
					try {
						await copyFile(sourceFile, join(copyDir, basename(sourceFile)));
					} catch (error) {
						const code = (error as NodeJS.ErrnoException).code;
						if (context !== "auto" || (code !== "ENOENT" && code !== "ENOTDIR")) throw error;
						await rm(copyDir, { recursive: true, force: true });
						copyDir = undefined;
						fallbackReason = "Retained session became unavailable before it could be copied.";
					}
				}
				if (_signal?.aborted) throw new Error("Follow-up cancelled before dispatch.");
				if (thread.retired || thread.lifecycleOperation || thread.state !== "completed") throw new Error("The source run changed while the follow-up was prepared.");
				const selectedContext = copyDir ? "session" : "summary";
				const task = copyDir
					? `Follow-up to run #${thread.id} (${randomUUID()}):\n${params.message}`
					: buildSummaryFollowUp(thread, params.message);
				const result = await dispatchCore.startBackground(thread.agentName, task, thread.cwd, thread.isolation, {
					phaseId: `followup:${thread.id}:${randomUUID()}`, scope: thread.scope,
					...(copyDir ? { resumeSession: { sessionId: thread.sessionId!, sessionDir: copyDir } } : {}),
				});
				if (result.runId === undefined) throw new Error(result.errorMessage || "Follow-up dispatch failed.");
				copyDir = undefined;
				const contextNote = selectedContext === "session" ? "its retained session" : "a summary only";
				return {
					content: [{ type: "text" as const, text: `Started follow-up #${result.runId} from #${thread.id} with ${contextNote}${fallbackReason ? ` (${fallbackReason})` : ""}; results arrive automatically.` }],
					details: { id: result.runId, sourceId: thread.id, context: selectedContext, ...(fallbackReason ? { fallbackReason } : {}) },
				};
			} catch (error) {
				if (copyDir) await rm(copyDir, { recursive: true, force: true }).catch(() => undefined);
				return fail(`Could not continue #${thread.id}: ${error instanceof Error ? error.message : String(error)}`);
			}
		},
	});

	// Cancel one or more active runs: aborts the queue controller, which
	// terminates the child and delivers an aborted result (with whatever partial
	// output it produced) so the main agent always knows the run stopped.
	const SubagentStopParams = Type.Object({
		id: Type.Optional(
			Type.String({
				description: "Run id or prefix to stop (see subagent dispatch output).",
			}),
		),
		all: Type.Optional(Type.Boolean({ description: "Stop every active run and every running workflow (default false)." })),
		workflow: Type.Optional(Type.Integer({
			minimum: 1,
			description: "Stop this workflow graph: no dependent node starts and running nodes are cancelled.",
		})),
	});

	pi.registerTool({
		name: "subagent_stop",
		label: "Subagent Stop",
		description: "Destructively stop and retire one run by id/prefix, one workflow by workflow id, or this session’s active runs and workflows with all: true. all takes precedence over id and workflow; id takes precedence over workflow. Other Pi sessions and projects are not targeted. Delivers partial results; stopped runs cannot resume.",
		exposure: "model-only",
		executionMode: "sequential",
		annotations: {
			readOnlyHint: false,
			destructiveHint: true,
			idempotentHint: true,
			openWorldHint: false,
		},
		parameters: SubagentStopParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			await runtime.durableRestore;
			// A graph stop owns its own lifecycle: dependents must not start, and the
			// graph's own summary reports what had already completed. Stopping the
			// nodes one by one first would let the runner dispatch the next layer.
			if (params.all !== true && !params.id?.trim() && params.workflow !== undefined) {
				const graph = runtime.workflows.get(params.workflow);
				if (!graph) {
					const known = [...runtime.workflows.keys()].map((id) => `#${id}`).join(", ");
					return {
						content: [{
							type: "text",
							text: `No workflow graph matches #${params.workflow}.${known ? ` Known graphs: ${known}.` : ""}`,
						}],
						details: {},
					};
				}
				const cancelled = await stopWorkflow(runtime, graph, "Stopped by subagent_stop.");
				return {
					content: [{
						type: "text",
						text: `Stopped workflow #${graph.id} ${graph.name}${cancelled.length > 0 ? `; cancelled ${cancelled.map((id) => `#${id}`).join(", ")}` : "; no node had started"}. Its summary reports the completed work, and each node keeps its own run evidence.`,
					}],
					details: {},
				};
			}
			const graphStops: string[] = [];
			const graphStopPromises: Array<Promise<void>> = [];
			const graphRunIds = new Set<number>();
			if (params.all === true) {
				const graphs = [...runtime.workflows.values()].filter((graph) => graph.state === "running");
				for (const graph of graphs) for (const node of graph.nodes) { if (node.runId !== undefined) graphRunIds.add(node.runId); }
				graphStopPromises.push(...graphs.map(async (graph) => {
					const cancelled = await stopWorkflow(runtime, graph, "Stopped by subagent_stop.");
					graphStops.push(
						`workflow #${graph.id} ${graph.name}${cancelled.length > 0 ? ` (${cancelled.length} node${cancelled.length === 1 ? "" : "s"} cancelled)` : ""}`,
					);
				}));
			}
			const candidateIds = params.all === true
				? [...new Set([
					...runtime.runControllers.keys(),
					...[...runtime.threads.values()]
						.filter((thread) => thread.lifecycleOperation !== undefined || ["queued", "running", "interrupting"].includes(thread.state))
						.map((thread) => thread.id),
				])]
				: [...runtime.threads.keys()];
			const targets = params.all === true
				? candidateIds
				: params.id?.trim() ? matchRunIds(candidateIds, params.id.trim()) : [];
			const threadTargets = targets.filter((id) => !graphRunIds.has(id));

			if (threadTargets.length === 0) {
				await Promise.all(graphStopPromises);
				const available = [...runtime.threads.keys()].map((id) => `#${id}`).join(", ");
				if (graphStops.length > 0) {
					return {
						content: [{ type: "text", text: `Stopped ${graphStops.length} workflow${graphStops.length === 1 ? "" : "s"}: ${graphStops.join(", ")}.` }],
						details: {},
					};
				}
				return {
					content: [{ type: "text", text: params.all === true
						? "No active subagent runs to stop."
						: `No subagent thread matches "${params.id}".${available ? ` Known threads: ${available}.` : ""}` }],
					details: {},
				};
			}

			const stopping = stopThreads(runtime, threadTargets);
			await Promise.all(graphStopPromises);
			const { stopped, retainedIntegration, pendingIntegration, completionResults } = await stopping;
			if (completionResults.length > 0) {
				runtime.sendCompletionGroup(completionResults.filter((result) => !runtime.threads.get(result.runId!)?.workflow).map((result) => ({
					agent: result.agent,
					block: formatCompletionBlock(result, DEFAULT_MAX_RESULT_LINES, { resultRoot: projectResultsRoot(runtime.configPath, result.projectCwd ?? ctx.cwd) }),
					triggerTurn: true,
					usage: result.usage,
				})));
				runtime.completionBatcher.flush();
			}
			return {
				content: [{
					type: "text",
					text: `${graphStops.length > 0 ? `Stopped ${graphStops.length} workflow${graphStops.length === 1 ? "" : "s"}: ${graphStops.join(", ")}. ` : ""}Stopped ${stopped.length} thread${stopped.length === 1 ? "" : "s"}: ${stopped.join(", ")}. Retained sessions were retired; worktree changes are integrated on settlement.${retainedIntegration.length > 0 ? ` Integration failed for ${retainedIntegration.join(", ")}; inspect its result for retained recovery paths.` : ""}${pendingIntegration.length > 0 ? ` Integration is still settling in the background for ${pendingIntegration.join(", ")}; a recovery record was persisted in case it fails.` : ""}`,
				}],
				details: {},
			};
		},

		renderCall(args, theme) {
			return new Text(
				`${theme.fg("toolTitle", theme.bold("subagent_stop "))}${theme.fg("accent", args.all === true ? "all" : args.id ? `#${args.id}` : "?")}`,
				0,
				0,
			);
		},

		renderResult(result, _options, theme) {
			return renderFirstLine(result, "subagent_stop ", theme);
		},
	});
}
