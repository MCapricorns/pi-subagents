/** Read-only run inspection and destructive cancellation of one-shot runs. */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { existsSync } from "node:fs";
import { Type } from "typebox";
import { DEFAULT_MAX_RESULT_LINES, loadConfig } from "../configuration/config.ts";
import { removeThreadRecord } from "./durable.ts";
import { formatCompletionBlock, matchRunIds } from "../presentation/format.ts";
import { emptyUsage } from "../execution/rpc-control.ts";
import { formatDuration, formatTaskSummary, monitor } from "../presentation/monitor.ts";
import { persistRecoveryRecords, recoveryRecordFromFinalization } from "../isolation/recovery.ts";
import type { SubagentRuntime, SubagentThread } from "./runtime.ts";
import { CONTROL_QUIESCE_TIMEOUT_MS, projectResultsRoot, quiesced } from "./thread-shared.ts";
import { getResultError, type SingleResult } from "../execution/spawn.ts";
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
		description: "Read current-session run states without waiting or changing execution. Omit id to list runs, or pass an exact numeric id for progress, elapsed time, failure diagnostics, and retained result/recovery paths. Completions arrive automatically; use this for inspection, not a polling loop.",
		parameters: Type.Object({
			id: Type.Optional(Type.Integer({ minimum: 1, description: "Exact run id; omit to list all runs in this parent session." })),
		}),
		async execute(_toolCallId, params) {
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
					const parts = [`#${run.id} ${run.agent}`, run.state, formatDuration(run.elapsedMs)];
					if (run.waitReason) parts.push(`wait: ${run.waitReason}`);
					if (run.activity) parts.push(run.activity);
					if (run.errorMessage) parts.push(formatTaskSummary(run.errorMessage, 300, false));
					const paths = [
						run.resultFile ? `Result: ${run.resultFile}` : undefined,
						run.sessionDir ? `Session: ${run.sessionDir}` : undefined,
						run.integrationWorktreePath ? `Retained worktree: ${run.integrationWorktreePath}` : undefined,
						run.integrationPatchPath ? `Retained patch: ${run.integrationPatchPath}` : undefined,
					].filter(Boolean);
					return `${parts.join(" · ")}\n  ${run.taskSummary}${paths.length ? `\n  ${paths.join("\n  ")}` : ""}`;
				}).join("\n");
			return {
				content: [{ type: "text", text }],
				details: { runs },
				...(params.id !== undefined && runs.length === 0 ? { isError: true } : {}),
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
		all: Type.Optional(Type.Boolean({ description: "Stop every active run (default false)." })),
	});

	pi.registerTool({
		name: "subagent_stop",
		label: "Subagent Stop",
		description: "Stop and retire one child thread by run id/prefix, or every active thread with all: true.",
		parameters: SubagentStopParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			await runtime.durableRestore;
			// Claim every target before awaiting process cleanup or configuration I/O.
			const configPromise = loadConfig(runtime.configPath).catch(() => undefined);
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
				const maxResultLines = (await configPromise)?.maxResultLines ?? DEFAULT_MAX_RESULT_LINES;
				runtime.sendCompletionGroup(completionResults.map((result) => ({
					agent: result.agent,
					block: formatCompletionBlock(result, maxResultLines, { resultRoot: projectResultsRoot(runtime.configPath, result.projectCwd ?? ctx.cwd) }),
					triggerTurn: true,
					usage: result.usage,
				})));
				runtime.completionBatcher.flush();
			}
			return {
				content: [{
					type: "text",
					text: `Stopped ${stopped.length} thread${stopped.length === 1 ? "" : "s"}: ${stopped.join(", ")}. Retained sessions were retired; worktree changes are integrated on settlement.${retainedIntegration.length > 0 ? ` Integration failed for ${retainedIntegration.join(", ")}; inspect its result for retained recovery paths.` : ""}${pendingIntegration.length > 0 ? ` Integration is still settling in the background for ${pendingIntegration.join(", ")}; a recovery record was persisted in case it fails.` : ""}`,
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
