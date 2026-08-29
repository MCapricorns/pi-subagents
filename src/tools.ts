/**
 * Thread controls and lookup tools around the subagent runtime:
 * subagent_control (resume), subagent_wait (in-turn
 * result lookup), subagent_status, and destructive subagent_stop.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { existsSync } from "node:fs";
import { Type } from "typebox";
import { DEFAULT_MAX_RESULT_LINES, loadConfig } from "./config.ts";
import { removeThreadRecord } from "./durable.ts";
import { formatCompletionBlock, formatUsage, matchRunIds } from "./format.ts";
import { emptyUsage } from "./rpc-run.ts";
import {
	formatTaskSummary,
	isRunActiveStatus,
	monitor,
	runLabel,
	statusLabel,
	type RunStatus,
} from "./monitor.ts";
import { persistRecoveryRecords, recoveryRecordFromFinalization } from "./recovery.ts";
import type { SubagentRuntime, SubagentThread } from "./runtime.ts";
import { CONTROL_QUIESCE_TIMEOUT_MS, projectResultsRoot, quiesced } from "./thread-lifecycle.ts";
import { getResultOutput, isFailedResult, type SingleResult } from "./spawn.ts";
import type { WorktreeFinalization } from "./worktree.ts";

/** In-turn result lookup. Dispatch already ended the turn and results arrive as
 * wake-up messages, so the default must NOT block: a settled run returns its
 * result immediately, a still-active run returns a "still running — end your
 * turn" note and the model finishes (the completion then wakes it). Blocking
 * is opt-in via an explicit timeoutMs — a long default would hold the turn
 * hostage for nothing, since the result arrives on its own either way. */
const SUBAGENT_WAIT_DEFAULT_TIMEOUT_MS = 0;

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
		action: StringEnum(["resume"] as const, {
			description: "Control operation for the logical sub-agent thread.",
		}),
		id: Type.Integer({ minimum: 1, description: "Stable run id shown by subagent dispatch/status output." }),
		objective: Type.Optional(
			Type.String({ description: "Optional appended objective for resume. Omit to continue the current retained objective." }),
		),
	});

	pi.registerTool({
		name: "subagent_control",
		label: "Subagent Control",
		description: [
			"Resume an existing sub-agent thread by stable run id.",
			"resume restarts a parked, completed, or failed retained thread with the same run id and cumulative active time; omit objective to continue the current goal, or provide one to append it to retained context and make it the displayed current goal.",
			"Threads parked or interrupted by a shutdown/reload are restorable; use subagent_stop for destructive cancellation.",
		].join(" "),
		promptSnippet: "Resume a parked or settled subagent thread with its retained context.",
		promptGuidelines: [
			"Use subagent_control resume to continue a parked/settled thread on the same run id. Resume without objective keeps the current goal; resume with objective appends that goal to retained context.",
			"Use subagent_stop only for destructive cancellation; it retires that thread's retained session.",
		],
		parameters: SubagentControlParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const thread = runtime.threads.get(params.id);
			if (!thread) {
				return { content: [{ type: "text", text: `No subagent thread matches run #${params.id}.` }], details: {} };
			}
			const nonBlank = (value: string | undefined): string | undefined => {
				const trimmed = value?.trim();
				return trimmed ? trimmed : undefined;
			};

			try {
				switch (params.action) {
					case "resume": {
						if (thread.retired) {
							return { content: [{ type: "text", text: `Run #${thread.id} was retired by subagent_stop and has no resumable session.` }], details: {} };
						}
						if (!(["parked", "completed", "failed"] as const).includes(thread.state as any)) {
							return { content: [{ type: "text", text: `Run #${thread.id} is ${thread.state}; it must be parked or settled before resume.` }], details: {} };
						}
						const objective = params.objective === undefined ? undefined : nonBlank(params.objective);
						if (params.objective !== undefined && !objective) {
							return { content: [{ type: "text", text: "resume objective must be non-blank when provided." }], details: {} };
						}
						const hadRetainedSession = Boolean(thread.sessionId && thread.sessionDir);
						const pending = await thread.resume(objective, ctx);
						if (pending.exitCode !== -1) {
							return { content: [{ type: "text", text: getResultOutput(pending) }], details: {} };
						}
						const currentObjective = formatTaskSummary(objective ?? thread.task, 80, false);
						const mode = objective
							? `appended objective: ${currentObjective}`
							: `continuing current objective: ${currentObjective}`;
						const context = hadRetainedSession
							? "the same retained session and prior context are preserved"
							: "no prior child session existed, so only the logical run and objective are continued";
						return { content: [{ type: "text", text: `Resumed run #${thread.id}, ${mode}; ${context}, and cumulative active time is preserved. It runs in the background — keep working; the result resumes you automatically.` }], details: {} };
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

	const SubagentWaitParams = Type.Object({
		id: Type.Optional(
			Type.String({
				description: "Run id or prefix shown by subagent dispatch/status output. Omit to wait for all active runs in this session.",
			}),
		),
		timeoutMs: Type.Optional(
			Type.Number({
				description: `Block for up to this many milliseconds and report the still-running runs. Default ${SUBAGENT_WAIT_DEFAULT_TIMEOUT_MS}: no blocking — settled runs return their result immediately, active runs return a note telling the model to end its turn.`,
			}),
		),
	});

	pi.registerTool({
		name: "subagent_wait",
		label: "Subagent Wait",
		description: [
			"Look up background sub-agent run(s) and return their results.",
			"PREFER NOT CALLING THIS: dispatching already ended your turn and results arrive as a message that wakes you automatically.",
			"By default it does NOT block: a settled run returns its result immediately; a still-active run returns a 'still running — end your turn' note.",
			"Pass an explicit timeoutMs ONLY when you must stay in the turn and need the result right now (sequential dependent steps).",
			"NEVER sleep, poll, or wait with bash to get a sub-agent result: end the turn, or call this tool.",
			"The same result is also delivered as a completion message that resumes the main agent, so you may see it twice (once here, once as a wake-up) — that is expected, not a duplicate.",
		].join(" "),
		promptSnippet: "Look up a background subagent result in-turn (id: run id from dispatch/status output; omit for all). Non-blocking by default; pass timeoutMs to block.",
		promptGuidelines: [
			"Do NOT call subagent_wait to hold the turn: results arrive as wake-up messages automatically. The default call is a non-blocking lookup — settled results return immediately, active runs return a note telling you to end your turn.",
			"Pass an explicit timeoutMs only when you must keep the turn AND the next step depends on the result right now — e.g. the user asked you to wait for it.",
			"Never use bash sleep/timeout/polling to wait for a sub-agent — it blocks the turn and delays result delivery.",
			"If subagent_wait times out, end the turn and wait for the wake-up message, or call it again with a longer timeoutMs.",
		],
		parameters: SubagentWaitParams,

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const config = await loadConfig(runtime.configPath);
			// A non-finite or negative timeout would produce a nonsensical note
			// ("timed out after Infinitys") or an instant "timeout" that was never
			// asked for; fall back to the default. Zero is honored as an immediate
			// give-up (clamped to 1ms below).
			const timeoutMs =
				typeof params.timeoutMs === "number" && Number.isFinite(params.timeoutMs) && params.timeoutMs >= 0
					? params.timeoutMs
					: SUBAGENT_WAIT_DEFAULT_TIMEOUT_MS;
			const isActive = (run: { status: RunStatus }): boolean => isRunActiveStatus(run.status);

			const requested = params.id?.trim();
			// A run that already settled resolves immediately with its result.
			if (requested) {
				const settledIds = matchRunIds([...runtime.settledRuns.keys()], requested);
				if (settledIds.length > 0) {
					return {
						content: [
							{ type: "text", text: settledIds.map((id) => {
								const result = runtime.settledRuns.get(id)!;
								return formatCompletionBlock(result, config.maxResultLines, { resultRoot: projectResultsRoot(runtime.configPath, result.projectCwd ?? ctx.cwd) });
							}).join("\n\n") },
						],
						details: {},
					};
				}
			}

			const activeRuns = monitor.getRuns().filter(isActive);
			const targetIds = requested ? matchRunIds(activeRuns.map((run) => run.id), requested) : activeRuns.map((run) => run.id);
			const targets = activeRuns.filter((run) => targetIds.includes(run.id));
			if (targets.length === 0) {
				const activeList = activeRuns.map((run) => `#${run.id} ${run.agent}`).join(", ");
				return {
					content: [
						{
							type: "text",
							text: requested
								? `No active subagent run matches "${requested}".${activeList ? ` Active runs: ${activeList}.` : ""}`
								: `No active subagent runs${activeList ? ` (active: ${activeList})` : " right now"}.`,
						},
					],
					details: {},
				};
			}

			const waitForRun = (runId: number): Promise<{ result?: SingleResult; note?: string }> => {
				const already = runtime.settledRuns.get(runId);
				if (already) return Promise.resolve({ result: already });
				return new Promise((resolve) => {
					let done = false;
					let timer: ReturnType<typeof setTimeout> | undefined;
					let unsub: (() => void) | undefined;
					const cleanup = (): void => {
						if (timer) clearTimeout(timer);
						if (unsub) unsub();
						signal?.removeEventListener("abort", onAbort);
						const listeners = runtime.settledListeners.get(runId);
						if (listeners) {
							listeners.delete(onSettled);
							if (listeners.size === 0) runtime.settledListeners.delete(runId);
						}
					};
					const finish = (outcome: { result?: SingleResult; note?: string }): void => {
						if (done) return;
						done = true;
						cleanup();
						resolve(outcome);
					};
					const onSettled = (result: SingleResult): void => finish({ result });
					const onMonitor = (): void => {
						const current = runtime.settledRuns.get(runId);
						if (current) {
							finish({ result: current });
							return;
						}
						const live = monitor.findRun(runId);
						if (live?.status === "parked") {
							finish({ note: `run #${runId} was parked at a stable checkpoint; use subagent_control resume to continue it` });
							return;
						}
						if (!live) {
							// Removal is followed synchronously by registerRunResult in the
							// finishing task; re-check on the next tick so the result wins.
							setTimeout(() => {
								const late = runtime.settledRuns.get(runId);
								if (late) finish({ result: late });
								else finish({ note: `run #${runId} was removed before its result was recorded (cancelled or session ended)` });
							}, 0);
						}
					};
					const onAbort = (): void => finish({ note: "wait aborted" });
					let listeners = runtime.settledListeners.get(runId);
					if (!listeners) {
						listeners = new Set();
						runtime.settledListeners.set(runId, listeners);
					}
					listeners.add(onSettled);
					unsub = monitor.subscribe(onMonitor);
					timer = setTimeout(
						() =>
							finish({
								note:
									timeoutMs === 0
										? `run #${runId} is still active — end your turn: the result will wake you (or call subagent_wait again with an explicit timeoutMs to block)`
										: `wait timed out after ${Math.round(timeoutMs / 1000)}s — run #${runId} is still active; call subagent_wait again or end the turn (the result will wake you when ready)`,
							}),
						Math.max(1, timeoutMs),
					);
					if (signal?.aborted) onAbort();
					else signal?.addEventListener("abort", onAbort, { once: true });
				});
			};

			const outcomes = await Promise.all(targets.map((run) => waitForRun(run.id)));
			const blocks = outcomes.map((outcome) =>
				outcome.result
					? formatCompletionBlock(outcome.result, config.maxResultLines, { resultRoot: projectResultsRoot(runtime.configPath, outcome.result.projectCwd ?? ctx.cwd) })
					: (outcome.note ?? "(no outcome)"),
			);
			return { content: [{ type: "text", text: blocks.join("\n\n") }], details: {} };
		},

		renderCall(args, theme) {
			const target = args.id ? `#${args.id}` : "all";
			return new Text(`${theme.fg("toolTitle", theme.bold("subagent_wait "))}${theme.fg("accent", target)}`, 0, 0);
		},

		renderResult(result, _options, theme) {
			return renderFirstLine(result, "subagent_wait ", theme);
		},
	});

	// Status overview: what is running right now and what finished this session,
	// with per-run details (id, role, model, usage, elapsed, activity).
	const SubagentStatusParams = Type.Object({
		id: Type.Optional(
			Type.String({
				description: "Run id or prefix to show the full result for (must already be finished; use subagent_wait to block on an active run).",
			}),
		),
	});

	pi.registerTool({
		name: "subagent_status",
		label: "Subagent Status",
		description: [
			"List active background sub-agent runs (id, role, model, thinking, usage, elapsed, current activity) and recently finished results.",
			"Pass id to read the full result of a finished run; pass no id for the overview.",
			"Use it to decide whether to subagent_wait, subagent_stop, or re-dispatch — never to poll: results arrive by themselves.",
		].join(" "),
		promptSnippet: "Inspect background subagents: active runs, finished results, full result by id.",
		promptGuidelines: [
			"Call subagent_status to see what is running and what already finished.",
			"Never poll subagent_status in a loop to wait for a run: end the turn (you will be woken) or call subagent_wait.",
			"A finished run's id stays available for the session; its full result is one subagent_status call away.",
		],
		parameters: SubagentStatusParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const config = await loadConfig(runtime.configPath);
			const requested = params.id?.trim();

			if (requested) {
				const settledIds = matchRunIds([...runtime.settledRuns.keys()], requested);
				if (settledIds.length > 0) {
					return {
						content: [
							{
								type: "text",
								text: settledIds
									.map((id) => formatCompletionBlock(
										runtime.settledRuns.get(id)!,
										config.maxResultLines,
										{ failedToolDetails: true, resultRoot: projectResultsRoot(runtime.configPath, runtime.settledRuns.get(id)!.projectCwd ?? ctx.cwd) },
									))
									.join("\n\n"),
							},
						],
						details: {},
					};
				}
				const runs = monitor.getRuns();
				const activeId = matchRunIds(runs.map((run) => run.id), requested)[0];
				const active = activeId === undefined ? undefined : runs.find((run) => run.id === activeId);
				if (active) {
					const parked = active.status === "parked";
					const activeThread = runtime.threads.get(active.id);
					const managedDownstream =
						activeThread?.state === "running" && activeThread.control.getPhase() === "settled";
					const activeChild = runs.find((run) =>
						run.parentRunId === active.id && isRunActiveStatus(run.status)
					);
					const owner = active.managedWorkflow ? `${active.agent} workflow` : active.agent;
					const retainedStage = active.managedWorkflow && activeThread?.agentName !== active.agent
						? activeThread?.agentName
						: undefined;
					const metadata = [
						activeThread?.isolation === "worktree" ? `worktree ${active.integrationStatus ?? activeThread.worktree?.state ?? "active"}` : undefined,
					].filter(Boolean).join(" · ");
					const stageStatus = activeChild
						? monitor.summarize(activeChild)
						: active.activity ?? statusLabel(active.status);
					return {
						content: [
							{
								type: "text",
								text: parked
									? `Run #${active.id} ${owner} is parked with retained${retainedStage ? ` ${retainedStage} stage` : ""} context${metadata ? ` (${metadata})` : ""}. Use subagent_control resume to restart it, or subagent_stop to retire it.`
									: managedDownstream
										? `Run #${active.id} ${owner} is in a managed downstream stage (${stageStatus}${metadata ? ` · ${metadata}` : ""}). Use subagent_wait for its result or subagent_stop to cancel it.`
										: `Run #${active.id} ${owner} is still active (${active.activity ?? statusLabel(active.status)}${metadata ? ` · ${metadata}` : ""}). Use subagent_wait to block for its result or subagent_stop to cancel it.`,
							},
						],
						details: {},
					};
				}
				return { content: [{ type: "text", text: `No subagent run matches "${requested}".` }], details: {} };
			}

			const activeRuns = monitor.getRuns().filter(
				(run) => isRunActiveStatus(run.status),
			);
			const activeLines = activeRuns.map((run) => {
				const thread = runtime.threads.get(run.id);
				const parts = [
					`#${run.id} ${monitor.summarize(run)}`,
					run.label,
					run.activity ?? statusLabel(run.status),
				].filter(Boolean);
				return `- ${parts.join(" · ")}`;
			});
			const parkedThreads = [...runtime.threads.values()].filter((thread) => thread.state === "parked");
			const parkedLines = parkedThreads.map((thread) => {
				const run = monitor.findRun(thread.id);
				const owner = run?.managedWorkflow ? `${run.agent} workflow` : run?.agent ?? thread.agentName;
				const retainedStage = run?.managedWorkflow && thread.agentName !== run.agent
					? ` · retained stage ${thread.agentName}`
					: "";
				const isolation = thread.isolation === "worktree" ? ` · worktree ${thread.worktree?.state ?? "active"}` : "";
				return `- #${thread.id} ${owner} · ${run?.label ?? runLabel(thread.task)} · parked${thread.sessionDir ? " · context retained" : " · not started"}${retainedStage}${isolation}`;
			});
			const completed = [...runtime.settledRuns.entries()].slice(-5);
			const completedLines = completed.map(([id, result]) => {
				const usage = formatUsage(result.usage);
				const label = runLabel(result.task);
				const model = result.modelFallbackFrom
					? `${result.model ?? "?"} (main after ${result.modelFallbackFrom} failed)`
					: (result.model ?? "?");
				const isolation = result.isolation === "worktree" ? ` · worktree ${result.integrationStatus ?? "unknown"}` : "";
				return `- #${id} ${result.agent}${label ? ` · ${label}` : ""} · ${isFailedResult(result) ? "failed" : "completed"} · ${model}${isolation}${usage ? ` · ${usage}` : ""}`;
			});

			const sections: string[] = [];
			const queuedCount = activeRuns.filter((run) => run.status === "queued").length;
			const runningCount = activeRuns.length - queuedCount;
			const pacing = queuedCount > 0
				? `${runningCount} running · ${queuedCount} queued for a free process slot`
				: `${runningCount} running`;
			sections.push(`### Active subagent runs (${pacing}; process capacity ${runtime.backgroundQueue.capacity} — queued runs start automatically, dispatch is never capped)`);
			sections.push(activeLines.length > 0 ? activeLines.join("\n") : "(none)");
			sections.push(`### Parked subagent threads (${parkedThreads.length})`);
			sections.push(parkedLines.length > 0 ? parkedLines.join("\n") : "(none)");
			sections.push(`### Finished this session (${runtime.settledRuns.size})`);
			sections.push(completedLines.length > 0 ? completedLines.join("\n") : "(none)");
			sections.push("Pass a run id to subagent_status for the full result, use subagent_control to resume a settled thread, or subagent_wait for active work.");
			return { content: [{ type: "text", text: sections.join("\n\n") }], details: {} };
		},

		renderCall(args, theme) {
			return new Text(
				`${theme.fg("toolTitle", theme.bold("subagent_status "))}${theme.fg("accent", args.id ? `#${args.id}` : "overview")}`,
				0,
				0,
			);
		},

		renderResult(result, _options, theme) {
			return renderFirstLine(result, "subagent_status ", theme);
		},
	});

	// Cancel one or more active runs: aborts the queue controller, which
	// terminates the child and delivers an aborted result (with whatever partial
	// output it produced) so the main agent always knows the run stopped.
	const SubagentStopParams = Type.Object({
		id: Type.Optional(
			Type.String({
				description: "Run id or prefix to stop (see subagent dispatch output or subagent_status).",
			}),
		),
		all: Type.Optional(Type.Boolean({ description: "Stop every active run (default false)." })),
	});

	pi.registerTool({
		name: "subagent_stop",
		label: "Subagent Stop",
		description: [
			"Destructively stop a sub-agent thread: terminate active work, deliver its aborted partial result, and retire any retained session so it cannot be resumed.",
			"Pass id (run id or prefix) to stop one active, parked, or completed thread; all: true stops every active run.",
		].join(" "),
		promptSnippet: "Stop a running background subagent (id from dispatch output/subagent_status; or all: true).",
		promptGuidelines: [
			"Stop a run when its task is obsolete, stuck, or superseded — do not leave it burning tokens.",
			"A stopped run reports as failed with 'aborted' and its partial output, so the next step knows it did not complete.",
		],
		parameters: SubagentStopParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
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
				monitor.removeRun(runId);
				runtime.retireThreadSession(thread);
				// The destructive retire removes the durable record with the session;
				// an id never resurrects after subagent_stop.
				await removeThreadRecord(runtime.configPath, runId).catch(() => undefined);
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
