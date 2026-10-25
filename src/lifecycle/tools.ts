/** Read-only run inspection and destructive cancellation of one-shot runs. */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { existsSync } from "node:fs";
import { Type } from "typebox";
import { DEFAULT_MAX_RESULT_LINES } from "../configuration/config.ts";
import { removeThreadRecord } from "./durable.ts";
import { formatCompletionBlock, matchRunIds } from "../presentation/format.ts";
import { emptyUsage } from "../execution/rpc-control.ts";
import { formatDuration, formatTaskSummary, monitor, runWaitLabel } from "../presentation/monitor.ts";
import { persistRecoveryRecords, recoveryRecordFromFinalization } from "../isolation/recovery.ts";
import type { SubagentRuntime, SubagentThread } from "./runtime.ts";
import { CONTROL_QUIESCE_TIMEOUT_MS, projectResultsRoot, quiesced } from "./thread-shared.ts";
import { getResultError, type SingleResult } from "../execution/spawn.ts";
import {
	formatRetainedWorkflow,
	formatWorkflowStatus,
	readRetainedWorkflows,
	stopWorkflow,
	workflowStatus,
} from "../workflow/engine.ts";
import type { WorktreeFinalization } from "../isolation/worktree.ts";

function renderFirstLine(result: { content?: unknown }, label: string, theme: any): Text {
	const parts = (result.content ?? []) as Array<{ type: string; text?: string }>;
	const text = parts
		.map((part) => (typeof part.text === "string" ? part.text : ""))
		.join(" ")
		.trim();
	const firstLine = text.split("\n").find((line) => line.trim()) ?? "(no output)";
	return new Text(`${theme.fg("toolTitle", theme.bold(label))}${theme.fg("dim", firstLine.slice(0, 60))}`, 0, 0);
}

export function registerLookupTools(pi: ExtensionAPI, runtime: SubagentRuntime): void {
	pi.registerTool({
		name: "subagent_status",
		label: "Subagent Status",
		description: "Check live subagent progress without waiting or changing execution: state, elapsed time, an activity trail (what the run has been doing), and failure diagnostics. Omit id to list runs. Results arrive automatically in completion messages; use this to inspect progress, not as a polling loop.",
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
					isolation: thread.isolation,
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
			const workflowRuns = [...runtime.workflows.values()]
				.filter((run) => params.workflow === undefined || run.id === params.workflow)
				.sort((left, right) => left.id - right.id);
			const retainedWorkflows = (await readRetainedWorkflows(runtime, ctx?.cwd ?? process.cwd()).catch(() => []))
				.filter((record) => params.workflow === undefined || record.id === params.workflow)
				.filter((record) => !workflowRuns.some((run) => run.id === record.id));
			const workflowSections = [
				...workflowRuns.map((run) => formatWorkflowStatus(run).join("\n")),
				...retainedWorkflows.map((record) => formatRetainedWorkflow(record).join("\n")),
			];
			const sections = [text, ...workflowSections].filter((section) => section.trim().length > 0);
			const unknownWorkflow = params.workflow !== undefined && workflowRuns.length === 0 && retainedWorkflows.length === 0;
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
		description: "Destructively stop and retire one run by id/prefix, or all active runs with all: true. Delivers partial results; stopped runs cannot resume.",
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
			if (params.workflow !== undefined) {
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
			if (params.all === true) {
				for (const graph of [...runtime.workflows.values()]) {
					if (graph.state !== "running") continue;
					const cancelled = await stopWorkflow(runtime, graph, "Stopped by subagent_stop.");
					graphStops.push(
						`workflow #${graph.id} ${graph.name}${cancelled.length > 0 ? ` (${cancelled.length} node${cancelled.length === 1 ? "" : "s"} cancelled)` : ""}`,
					);
				}
			}
			const completionResults: SingleResult[] = [];
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

			if (targets.length === 0) {
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

			const claimed: Array<{
				runId: number;
				thread: SubagentThread;
				run: ReturnType<typeof monitor.findRun>;
				previousState: SubagentThread["state"];
				wasQueued: boolean;
				wasActive: boolean;
				generation: number;
				controller: AbortController | undefined;
				completion: Promise<void>;
				stopVersion: number;
				stopMessage: string;
			}> = [];
			for (const runId of targets) {
				const thread = runtime.threads.get(runId);
				if (!thread) continue;
				const previousState = thread.state;
				const wasQueued = previousState === "queued";
				const wasActive = thread.lifecycleOperation !== undefined || ["queued", "running", "interrupting"].includes(previousState);
				const stopVersion = ++thread.lifecycleVersion;
				thread.lifecycleOperation = "stop";
				thread.retired = true;
				thread.retireOnSettle = true;
				thread.state = "stopped";
				const stopMessage = wasQueued
					? "Stopped by subagent_stop before the run started."
					: wasActive ? "Stopped by subagent_stop."
						: previousState === "parked" ? "Stopped by subagent_stop from an interrupted checkpoint."
							: "Retired by subagent_stop.";
				claimed.push({
					runId, thread, run: monitor.findRun(runId), previousState, wasQueued, wasActive,
					generation: thread.generation,
					controller: thread.queueController,
					completion: thread.generationCompletion,
					stopVersion, stopMessage,
				});
			}

			// Interrupt every claimed generation before awaiting any one of them.
			// An isolated stop may need the repository lane for final integration;
			// cancelling all holders first prevents stop-all from waiting behind a
			// later shared workflow that this same operation has not interrupted yet.
			const interruptionPromises = claimed.map(({ thread, stopMessage, controller }) => {
				const stopping = thread.control.stop(stopMessage).catch(() => undefined);
				runtime.backgroundQueue.cancel(controller);
				return stopping;
			});

			const stopped: string[] = [];
			const retainedIntegration: string[] = [];
			const pendingIntegration: string[] = [];
			for (const [claimIndex, claim] of claimed.entries()) {
				const {
					runId,
					thread,
					run,
					previousState,
					wasQueued,
					wasActive,
					generation,
					controller,
					completion,
					stopVersion,
					stopMessage,
				} = claim;
				// Every wait here is bounded: the queue task can sit for minutes in
				// worktree finalization or behind the managed repository lane, and an
				// unkillable child can stall even the RPC-level stop. Stop owns the
				// lifecycle synchronously, so a stuck tail settles silently after we
				// proceed; none of its late paths can publish a second result.
				await quiesced(interruptionPromises[claimIndex]);
				if (!(await quiesced(completion))) runtime.backgroundQueue.cancel(controller);
				if (runtime.runControllers.get(runId) === controller) runtime.runControllers.delete(runId);
				if (thread.queueController === controller) thread.queueController = undefined;

				// Dispatch yields publication ownership as soon as stop claims the
				// lifecycle. Synthesize and publish the one aborted result here only when
				// this stop actually interrupted unfinished work.
				let stoppedResult: SingleResult | undefined;
				if (
					wasQueued ||
					previousState === "parked" ||
					!runtime.settledRuns.has(runId)
				) {
					const prior = thread.lastResult;
					stoppedResult = prior
						? {
							...prior,
							exitCode: 1,
							stopReason: "aborted",
							errorMessage: stopMessage,
							runId,
						}
						: {
							agent: thread.agentName,
							task: thread.task,
							exitCode: 1,
							messages: [],
							stderr: stopMessage,
							usage: emptyUsage(),
							model: run?.model,
							thinking: run?.thinking,
							projectCwd: thread.cwd,
							stopReason: "aborted",
							errorMessage: stopMessage,
							runId,
							isolation: thread.isolation,
						};
					const worktree = thread.worktree;
					let finalization: WorktreeFinalization | undefined;
					try {
						finalization = await Promise.race([
							thread.finalizeIsolation(generation, stoppedResult),
							new Promise<undefined>((resolve) => {
								const timer = setTimeout(() => resolve(undefined), CONTROL_QUIESCE_TIMEOUT_MS);
								if (typeof timer.unref === "function") timer.unref();
							}),
						]);
					} catch {
						/* an unexpected finalize rejection must not block the stop */
					}
					if (finalization === undefined) {
						// Integration is still settling in the background. Point a
						// durable recovery record at the artifacts so the isolated work
						// stays findable even if the background tail later fails; a
						// successful tail removes them and the record self-prunes.
						if (thread.isolation === "worktree" && worktree) {
							stoppedResult.integrationStatus = "pending";
							stoppedResult.integrationWorktreePath = worktree.worktreePath;
							await persistRecoveryRecords(runtime.configPath, [
								recoveryRecordFromFinalization(runId, {
									status: "retained",
									integrated: false,
									hadChanges: false,
									...(existsSync(worktree.worktreePath) ? { worktreePath: worktree.worktreePath } : {}),
									...(existsSync(worktree.patchPath) ? { patchPath: worktree.patchPath } : {}),
									error: "subagent_stop timed out waiting for worktree integration; it continues in the background",
								}),
							]).catch(() => undefined);
							pendingIntegration.push(`#${runId}`);
						}
					} else if (finalization.status === "retained") {
						retainedIntegration.push(`#${runId}`);
					}
					runtime.registerRunResult(runId, stoppedResult);
					thread.lastResult = stoppedResult;
				}
				monitor.setStatus(runId, "failed");
				if (stoppedResult) completionResults.push(stoppedResult);
				// Leave the terminal row for the footer; beginTurn sweeps it.
				runtime.retireThreadSession(thread);
				// The destructive retire removes the durable record with the session;
				// an id never resurrects after subagent_stop.
				await removeThreadRecord(runtime.configPath, runId, thread.cwd).catch(() => undefined);
				if (thread.lifecycleVersion === stopVersion && thread.lifecycleOperation === "stop") {
					thread.lifecycleOperation = undefined;
				}
				stopped.push(`#${runId} ${thread.agentName}${wasQueued ? " (queued)" : wasActive ? "" : ` (${previousState})`}`);
			}
			if (completionResults.length > 0) {
				runtime.sendCompletionGroup(completionResults.map((result) => ({
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
