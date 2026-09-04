/**
 * Thread controls around the subagent runtime: subagent_control
 * (steer/resume/park) and destructive subagent_stop. There is no status/poll
 * tool — completions carry each result (with an on-disk artifact when
 * truncated) and wake the main model, so waiting is never a tool call; the only
 * in-turn block is `wait: true` on a dispatch, for one-shot parents that exit
 * at end of turn.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { existsSync } from "node:fs";
import { Type } from "typebox";
import { DEFAULT_MAX_RESULT_LINES, loadConfig } from "../configuration/config.ts";
import { removeThreadRecord } from "./durable.ts";
import { formatCompletionBlock, matchRunIds } from "../presentation/format.ts";
import { emptyUsage } from "../execution/rpc-control.ts";
import { formatTaskSummary, formatUsageCompact, monitor } from "../presentation/monitor.ts";
import { persistRecoveryRecords, recoveryRecordFromFinalization } from "../isolation/recovery.ts";
import type { SubagentRuntime, SubagentThread } from "./runtime.ts";
import { CONTROL_QUIESCE_TIMEOUT_MS, persistThreadCheckpoint, projectResultsRoot, quiesced } from "./thread-shared.ts";
import { getResultOutput, type SingleResult } from "../execution/spawn.ts";
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
	const SubagentControlParams = Type.Object({
		action: StringEnum(["steer", "resume", "park"] as const, {
			description:
				"steer: send guidance to the running attempt (a settled or parked thread continues with it); resume: continue a parked or settled thread; park: pause a running thread at a stable checkpoint, keeping its session and worktree for a later resume.",
		}),
		id: Type.Integer({ minimum: 1, description: "Stable run id shown by subagent dispatch output." }),
		objective: Type.Optional(
			Type.String({ description: "Guidance for steer (required and nonblank), or an optional appended objective for resume. Ignored by park." }),
		),
	});

	/** A thread that a steer can continue instead of reject: it is not live, but
	 * its retained session can absorb the guidance as an appended objective. */
	type ContinuableState = "completed" | "failed" | "parked";

	pi.registerTool({
		name: "subagent_control",
		label: "Subagent Control",
		description: "Steer a running child with additional guidance (continuing it if it has settled or is parked), resume a parked/settled thread, or park a running thread at a stable checkpoint, by stable run id.",
		parameters: SubagentControlParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			// A thread parked by the previous process exists only once restore has
			// read the manifest; resuming before that would deny a live run id.
			await runtime.durableRestore;
			const thread = runtime.threads.get(params.id);
			if (!thread) {
				return { content: [{ type: "text", text: `No subagent thread matches run #${params.id}.` }], details: {} };
			}
			const nonBlank = (value: string | undefined): string | undefined => {
				const trimmed = value?.trim();
				return trimmed ? trimmed : undefined;
			};
			const textResult = (text: string) => ({ content: [{ type: "text" as const, text }], details: {} });
			/** Why the thread has no steerable/parkable running RPC attempt right now. */
			const inactiveReason = (): string | undefined => {
				// Park drives the control through `stopped` before it records the
				// checkpoint, so the operation is named ahead of the transient state.
				if (thread.lifecycleOperation === "park") return "parking";
				if (thread.lifecycleOperation === "stop" || thread.state === "stopped") return "stopped";
				if (thread.lifecycleOperation === "resume") return "resuming";
				if (thread.lifecycleOperation === "settle" || thread.state === "completed" || thread.state === "failed") {
					return `settled (${thread.state})`;
				}
				if (thread.state === "queued" || thread.state === "resuming") {
					const phase = thread.control.getPhase();
					return phase === "starting" || phase === "retrying" ? phase : thread.state;
				}
				return thread.state === "running" ? undefined : thread.state;
			};
			const resumeThread = async (
				objective: string | undefined,
				continuedFrom?: ContinuableState,
			) => {
				if (thread.retired) {
					return textResult(`Run #${thread.id} was retired by subagent_stop and has no resumable session.`);
				}
				if (
					thread.state !== "parked" &&
					thread.state !== "completed" &&
					thread.state !== "failed"
				) {
					return textResult(`Run #${thread.id} is ${thread.state}; it must be parked or settled before resume.`);
				}
				const requestedObjective = objective === undefined ? undefined : nonBlank(objective);
				if (objective !== undefined && !requestedObjective) {
					return textResult("resume objective must be non-blank when provided.");
				}
				const hadRetainedSession = Boolean(thread.sessionId && thread.sessionDir);
				const pending = await thread.resume(requestedObjective, ctx);
				if (pending.exitCode !== -1) return textResult(getResultOutput(pending));
				const currentObjective = formatTaskSummary(requestedObjective ?? thread.task, 80, false);
				const mode = requestedObjective
					? `appended objective: ${currentObjective}`
					: `continuing current objective: ${currentObjective}`;
				const context = hadRetainedSession ? "retained context reused" : "no prior child context";
				const prefix = continuedFrom
					? `Run #${thread.id} was already ${continuedFrom} before steering; resumed the same thread`
					: `Resumed run #${thread.id}`;
				return textResult(`${prefix}: ${mode}; ${context}.`);
			};
			/** Steering guidance for a thread that is no longer live continues the
			 * same thread with that guidance instead of being dropped, so the
			 * evidence is never re-bought by a second dispatch. */
			const continueSteer = async (objective: string) => {
				const continuable = (): ContinuableState | undefined =>
					thread.state === "completed" || thread.state === "failed" || thread.state === "parked"
						? thread.state
						: undefined;
				if (thread.lifecycleOperation === "settle" || (!continuable() && thread.control.getPhase() === "settled")) {
					if (!(await quiesced(thread.generationCompletion))) return undefined;
				}
				const state = continuable();
				if (!state || thread.lifecycleOperation) return undefined;
				return resumeThread(objective, state);
			};

			try {
				switch (params.action) {
					case "steer": {
						const objective = nonBlank(params.objective);
						if (!objective) {
							return textResult("steer objective must be non-blank.");
						}
						if (thread.retired) {
							return textResult(`Run #${thread.id} was retired by subagent_stop and cannot be steered.`);
						}
						const continued = await continueSteer(objective);
						if (continued) return continued;
						const unavailable = inactiveReason();
						if (unavailable) {
							return textResult(`Run #${thread.id} is ${unavailable}; only an active running RPC attempt can be steered. No guidance was sent.`);
						}
						const steered = await thread.control.steer(objective);
						if (!steered.accepted) {
							const resumed = await continueSteer(objective);
							if (resumed) return resumed;
							if (steered.reason === "no-active-attempt") {
								return textResult(`Run #${thread.id} is marked running but has no active RPC attempt; no guidance was sent.`);
							}
							return textResult(`Run #${thread.id} is ${steered.phase}; only an active running RPC attempt can be steered. No guidance was sent.`);
						}
						return textResult(`Steered run #${thread.id} with additional in-scope guidance; its original objective is unchanged.`);
					}
					case "resume": {
						return resumeThread(params.objective);
					}
					case "park": {
						if (thread.retired) {
							return textResult(`Run #${thread.id} was retired by subagent_stop and cannot be parked.`);
						}
						const unavailable = inactiveReason();
						if (unavailable) {
							return textResult(`Run #${thread.id} is ${unavailable}; only an active running RPC attempt can be parked. Use subagent_stop to discard a run that has not started.`);
						}
						if (!thread.sessionId || !thread.sessionDir) {
							return textResult(`Run #${thread.id} has no retained session yet; steer it or let it settle instead.`);
						}
						// Park interrupts the child at its next safe point but keeps the
						// session and worktree, so the thread returns to `parked`, not to a
						// failure. Claim synchronously like stop; the generation body sees
						// the claim and leaves publication to this path.
						const parkVersion = ++thread.lifecycleVersion;
						thread.lifecycleOperation = "park";
						const generation = thread.generation;
						const controller = thread.queueController;
						const completion = thread.generationCompletion;
						const ownsPark = (): boolean =>
							runtime.threads.get(thread.id) === thread &&
							thread.generation === generation &&
							thread.lifecycleVersion === parkVersion &&
							thread.lifecycleOperation === "park" &&
							!thread.retired;
						try {
							await quiesced(thread.control.stop("Parked by subagent_control at a stable checkpoint.").catch(() => undefined));
							if (!(await quiesced(completion))) runtime.backgroundQueue.cancel(controller);
							if (!ownsPark()) {
								return textResult(`Run #${thread.id} changed while it was being parked; no checkpoint was recorded by this call.`);
							}
							if (runtime.runControllers.get(thread.id) === controller) runtime.runControllers.delete(thread.id);
							if (thread.queueController === controller) thread.queueController = undefined;
							thread.state = "parked";
							monitor.setStatus(thread.id, "parked");
							thread.elapsedMs = monitor.getElapsedMs(thread.id) ?? thread.elapsedMs;
							persistThreadCheckpoint(runtime, thread, "parked");
							const run = monitor.findRun(thread.id);
							const usage = run ? formatUsageCompact(run.usage) : "";
							if (runtime.sessionActive) {
								ctx.ui.notify(`■ #${thread.id} ${run ? monitor.summarize(run) : thread.agentName} · parked`, "info");
							}
							const retained = thread.isolation === "worktree" ? "session and worktree" : "session";
							return textResult(
								`Parked run #${thread.id} (${thread.agentName}) at a stable checkpoint${usage ? ` after ${usage}` : ""}. Its retained ${retained} continue on subagent_control resume (optionally with an appended objective) or on steer; subagent_stop discards them.`,
							);
						} finally {
							if (thread.lifecycleVersion === parkVersion && thread.lifecycleOperation === "park") {
								thread.lifecycleOperation = undefined;
							}
						}
					}
				}
			} catch (error) {
				throw new Error(`Could not ${params.action} run #${thread.id}: ${error instanceof Error ? error.message : String(error)}`);
			}
		},

		renderCall(args, theme) {
			return new Text(`${theme.fg("toolTitle", theme.bold("subagent_control "))}${theme.fg("accent", `${args.action} #${args.id}`)}`, 0, 0);
		},
		renderResult(result, _options, theme) {
			return renderFirstLine(result, "subagent_control ", theme);
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
			// Start config I/O without yielding: every target below must be claimed
			// synchronously before a resume preflight can cross its next await.
			const configPromise = loadConfig(runtime.configPath).catch(() => undefined);
			const completionResults: SingleResult[] = [];
			const candidateIds = params.all === true
				? [...new Set([
					...runtime.runControllers.keys(),
					...[...runtime.threads.values()]
						.filter((thread) =>
							thread.lifecycleOperation !== undefined ||
							["queued", "resuming", "running", "interrupting"].includes(thread.state),
						)
						.map((thread) => thread.id),
				])]
				: [...runtime.threads.keys()];
			const targets =
				params.all === true
					? candidateIds
					: params.id !== undefined && params.id.trim() !== ""
						? matchRunIds(candidateIds, params.id.trim())
						: [];

			if (targets.length === 0) {
				const available = [...runtime.threads.keys()].map((id) => `#${id}`).join(", ");
				return {
					content: [{
						type: "text",
						text: params.all === true
							? "No active subagent runs to stop."
							: `No subagent thread matches "${params.id}".${available ? ` Known threads: ${available}.` : ""}`,
					}],
					details: {},
				};
			}

			const claimed: Array<{
				runId: number;
				thread: SubagentThread;
				run: ReturnType<typeof monitor.findRun>;
				previousState: SubagentThread["state"];
				wasQueued: boolean;
				wasResuming: boolean;
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
				const wasResuming = previousState === "resuming";
				const wasActive =
					thread.lifecycleOperation !== undefined ||
					["queued", "resuming", "running", "interrupting"].includes(previousState);
				const stopVersion = ++thread.lifecycleVersion;
				// Stop-all claims every target before the first await. This invalidates
				// all concurrent resume preflights as one synchronous operation.
				thread.lifecycleOperation = "stop";
				thread.retired = true;
				thread.retireOnSettle = true;
				thread.state = "stopped";
				const stopMessage = wasQueued
					? "Stopped by subagent_stop before the run started."
					: wasResuming
						? "Stopped by subagent_stop while resume was preparing."
						: wasActive
							? "Stopped by subagent_stop."
							: previousState === "parked"
								? "Stopped by subagent_stop from a parked checkpoint."
								: "Retired by subagent_stop.";
				claimed.push({
					runId,
					thread,
					run: monitor.findRun(runId),
					previousState,
					wasQueued,
					wasResuming,
					wasActive,
					generation: thread.generation,
					controller: thread.queueController,
					completion: thread.generationCompletion,
					stopVersion,
					stopMessage,
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
					wasResuming,
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
					wasResuming ||
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
						}
						pendingIntegration.push(`#${runId}`);
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
