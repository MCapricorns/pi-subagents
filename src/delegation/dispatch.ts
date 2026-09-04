/**
 * The `subagent` tool: dispatches enabled built-in and custom roles as
 * isolated pi child processes, single or parallel.
 * Owns the public dispatch contract and
 * per-run status tracking. Stable thread generations, final integration, and
 * completion ownership live in thread-lifecycle.ts.
 */

import { StringEnum, type Usage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { discoverAgents } from "./agents.ts";
import { loadConfig } from "../configuration/config.ts";
import { formatCompletionBlock, formatUsage } from "../presentation/format.ts";
import {
	formatTaskSummary,
	formatToolActivity,
	monitor,
	statusIcon,
	statusLabel,
	sumUsage,
	type RunWaitReason,
} from "../presentation/monitor.ts";
import { formatPhaseLeaseReceipt } from "./prompt.ts";
import type { SubagentRuntime, SubagentThread } from "../lifecycle/runtime.ts";
import { createBackgroundDispatcher } from "../lifecycle/thread-lifecycle.ts";
import {
	getResultOutput,
	isFailedResult,
	type SingleResult,
	type SubagentDetails,
	type SubagentLiveEvent,
	type UsageStats,
} from "../execution/spawn.ts";
import {
	isWorktreeCapableAgent,
	persistThreadCheckpoint,
	projectResultsRoot,
	runInManagedRepositoryLane,
	type DispatchEnvironment,
} from "../lifecycle/thread-shared.ts";
import type { IsolationMode } from "../isolation/worktree.ts";

export { isWorktreeCapableAgent, runInManagedRepositoryLane };

const NON_BLANK_TASK_OPTIONS = { minLength: 1, pattern: "\\S" } as const;

const ISOLATION_DESCRIPTION =
	"Filesystem isolation: shared uses the caller's working tree; worktree creates a detached temporary Git worktree (write-capable agents, including artisan and steward, only)";

const IsolationSchema = Type.Optional(
	StringEnum(["shared", "worktree"] as const, { description: ISOLATION_DESCRIPTION }),
);

const WaitSchema = Type.Optional(
	Type.Boolean({
		description:
			"Block until every run started by this call settles, then return each result exactly once in this tool response. If the tool call is aborted, undelivered results fall back to completion messages. Intended for one-shot (pi -p) sessions or an immediate dependent step.",
	}),
);

const TASK_BRIEF_DESCRIPTION =
	"Complete brief for one substantial self-contained phase; the child has no memory of this conversation. State the objective and done condition, exact paths/symbols, facts already established (with citations) so it starts there, boundaries, and the expected output shape.";

const TaskItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({
		...NON_BLANK_TASK_OPTIONS,
		description: TASK_BRIEF_DESCRIPTION,
	}),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
	isolation: IsolationSchema,
});

const SubagentParams = Type.Object({
	agent: Type.Optional(Type.String({ description: "Name of the agent to invoke (single mode)" })),
	task: Type.Optional(
		Type.String({ ...NON_BLANK_TASK_OPTIONS, description: `${TASK_BRIEF_DESCRIPTION} (single mode)` }),
	),
	tasks: Type.Optional(Type.Array(TaskItem, { description: "Independently justified, disjoint phases for parallel execution" })),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process (single mode)" })),
	isolation: IsolationSchema,
	wait: WaitSchema,
});

/** Roles that default to worktree isolation in parallel dispatches even when
 * the live catalog cannot be consulted (render-only call sites). Custom
 * worktree-capable agents join them via the live catalog on the execute path. */
const WORKTREE_DEFAULT_AGENTS = new Set(["artisan", "steward"]);

/** Resolve the default isolation for a dispatch. Precedence: an explicit
 * per-call request, then the role's own frontmatter declaration (`worktree`
 * honored for write-capable roles only; `shared` always), then the parallel
 * write default — parallel write-capable agents get a detached worktree
 * because shared writers serialize on the repository lane, so defaulting them
 * to shared would turn one parallel batch into a convoy that also parks
 * process slots. */
export function defaultIsolationMode(
	mode: "single" | "parallel",
	agentName: string,
	requested?: IsolationMode,
	writeCapable = WORKTREE_DEFAULT_AGENTS.has(agentName),
	declared?: IsolationMode,
): IsolationMode {
	if (requested) return requested;
	if (declared === "shared") return "shared";
	if (declared === "worktree" && writeCapable) return "worktree";
	return mode === "parallel" && writeCapable ? "worktree" : "shared";
}

/** Map the child's own usage tally onto pi's tool-result `Usage`, so sub-agent
 * token spend lands in the parent's footer, /session, and RPC session totals
 * instead of being invisible. Only the total cost is known here: a child
 * reports one cost number, not a per-bucket split. */
function toToolUsage(stats: UsageStats): Usage {
	return {
		input: stats.input,
		output: stats.output,
		cacheRead: stats.cacheRead,
		cacheWrite: stats.cacheWrite,
		totalTokens: stats.input + stats.output + stats.cacheRead + stats.cacheWrite,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: stats.cost },
	};
}

/** Usage of the runs awaited in-turn. Omitted entirely in the background path:
 * those children have not finished when the tool returns, so any number there
 * would be a fabrication. */
function toolUsage(runtime: SubagentRuntime, runIds: number[]): { usage?: Usage } {
	const parts = runIds
		.map((id) => runtime.settledRuns.get(id)?.usage)
		.filter((usage): usage is UsageStats => usage !== undefined);
	return parts.length > 0 ? { usage: toToolUsage(sumUsage(parts)) } : {};
}

/** In-turn wait behind dispatch `wait: true` — the escape hatch for one-shot
 * `pi -p` parents that exit at end of turn or an immediate dependent step: hold
 * the call until every run it started settles, then hand back result blocks. No
 * timer: a waiter resolves the moment its run's result registers (children
 * are bounded by the idle watchdog), an already-parked run answers
 * immediately with its resume handle, and the turn's abort signal remains the
 * escape hatch. */
export async function awaitRunResults(
	runtime: SubagentRuntime,
	runIds: number[],
	signal: AbortSignal | undefined,
	maxResultLines: number,
	fallbackCwd: string,
	onProgress?: (text: string) => void,
): Promise<string> {
	const waitForRun = (runId: number): Promise<{ result?: SingleResult; note?: string }> => {
		const already = runtime.settledRuns.get(runId);
		if (already) return Promise.resolve({ result: already });
		if (monitor.findRun(runId)?.status === "parked") {
			return Promise.resolve({ note: `run #${runId} is parked at a stable checkpoint; use subagent_control resume to continue it` });
		}
		return new Promise((resolve) => {
			let done = false;
			let unsub: (() => void) | undefined;
			const cleanup = (): void => {
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
			if (signal?.aborted) onAbort();
			else signal?.addEventListener("abort", onAbort, { once: true });
		});
	};
	// One shared subscription drives the progress line: each waiter already
	// subscribes for its own settlement, and the tool card wants a single
	// rolled-up line rather than one per run.
	let lastProgress: string | undefined;
	const emitProgress = onProgress
		? (): void => {
			const parts = runIds.map((id) => {
				const settled = runtime.settledRuns.get(id);
				if (settled) return `#${id} ${isFailedResult(settled) ? "failed" : "done"}`;
				const live = monitor.findRun(id);
				return live ? `#${id} ${statusLabel(live.status)}` : `#${id} …`;
			});
			const text = `Waiting in-turn on ${runIds.length} run${runIds.length === 1 ? "" : "s"} · ${parts.join(", ")}`;
			// The monitor notifies on every usage and activity change; this line
			// names only statuses, so most notifications leave it identical.
			if (text === lastProgress) return;
			lastProgress = text;
			onProgress(text);
		}
		: undefined;
	const progressUnsub = emitProgress ? monitor.subscribe(emitProgress) : undefined;
	emitProgress?.();
	try {
		const outcomes = await Promise.all(runIds.map(waitForRun));
		return outcomes.map((outcome) =>
			outcome.result
				? formatCompletionBlock(outcome.result, maxResultLines, { resultRoot: projectResultsRoot(runtime.configPath, outcome.result.projectCwd ?? fallbackCwd) })
				: (outcome.note ?? "(no outcome)"),
		).join("\n\n");
	} finally {
		progressUnsub?.();
	}
}

export function registerSubagentTool(pi: ExtensionAPI, runtime: SubagentRuntime): void {
	// Latest dispatch environment. The dispatcher is created once per process so
	// restored threads can resume before any dispatch has run; each execute
	// refreshes the fallback context, config, and agent catalog it resolves.
	const environmentRef: { current: DispatchEnvironment | undefined } = { current: undefined };

	// Terminal rows stay in the monitor until the next beginTurn so the footer
	// can count them beside siblings that are still live. The widget ignores
	// them. A second finishRun for the same endedAt is a no-op; a resume
	// clears endedAt, so the next settlement notifies again.
	const publishedEndedAt = new Map<number, number>();
	const finishRun = (
		runId: number,
		status: "done" | "failed",
		opts?: { silent?: boolean },
	): void => {
		const run = monitor.findRun(runId);
		if (!run) return;
		monitor.setStatus(runId, status); // stamps endedAt for the elapsed time
		const endedAt = monitor.findRun(runId)?.endedAt;
		if (endedAt !== undefined && publishedEndedAt.get(runId) === endedAt) return;
		if (endedAt !== undefined) publishedEndedAt.set(runId, endedAt);
		if (opts?.silent || !runtime.sessionActive) return;
		const icon = status === "done" ? "✓" : "✗";
		environmentRef.current?.ctx.ui.notify(`${icon} #${run.id} ${monitor.summarize(run)}`, status === "done" ? "info" : "error");
	};

	// Live sub-agent activity → concise one-line status ("thinking",
	// "read src/index.ts", ...), never a raw args blob. The live handler
	// only updates monitor state; the queue task owns terminal removal,
	// notification, and lifecycle decisions.
	const makeLiveHandler =
		(runId: number, generation?: number) =>
		(e: SubagentLiveEvent): void => {
			if (generation !== undefined && runtime.threads.get(runId)?.generation !== generation) return;
			switch (e.kind) {
				case "status":
					monitor.setStatus(runId, e.status);
					// A fresh running segment refreshes the durable checkpoint (session
					// path plus child pids) so a crash mid-generation still restores.
					if (e.status === "running") {
						const thread = runtime.threads.get(runId);
						if (thread?.sessionId && thread.sessionDir) {
							persistThreadCheckpoint(runtime, thread, "parked");
						}
					}
					break;
				case "model":
					monitor.setModel(runId, e.model, e.fallbackFrom);
					monitor.setThinking(runId, e.thinking);
					break;
				case "usage":
					monitor.setUsage(runId, e.usage, e.model);
					break;
				case "session": {
					runtime.retainSession({ sessionDir: e.sessionDir });
					const thread = runtime.threads.get(runId);
					if (thread && (generation === undefined || runtime.threads.get(runId)?.generation === generation)) {
						thread.sessionId = e.sessionId;
						thread.sessionDir = e.sessionDir;
						persistThreadCheckpoint(runtime, thread, "parked");
					}
					break;
				}
				case "tool_start":
					monitor.recordToolStart(runId, e.toolName, formatToolActivity(e.toolName, e.args));
					break;
				case "tool_end":
					monitor.recordToolEnd(runId, e.toolName, e.isError);
					break;
				case "thinking":
					monitor.setActivity(runId, "thinking");
					break;
				case "text":
					// A text delta is model output, not a filesystem write.
					monitor.setActivity(runId, "responding");
					break;
			}
		};

	const makeDetails =
		(mode: "single" | "parallel", background = false) =>
		(results: SingleResult[]): SubagentDetails => ({ mode, results, background });

	const phaseLeaseReceipt = (runIds: number[]): string =>
		formatPhaseLeaseReceipt(
			runIds
				.map((runId) => runtime.threads.get(runId))
				.filter((thread): thread is SubagentThread => thread !== undefined),
		);

	/** Pacing note appended to dispatch confirmations whenever runs are actually
	 * waiting. Slot waits and repository-lane waits are stated separately with
	 * the real capacity: a lane-serialized shared writer or a starting child
	 * must never read as an exhausted pool. Empty when nothing is waiting. */
	const queuePacingNote = (): string => {
		const runs = monitor.getRuns();
		const queuedWith = (reason: RunWaitReason): number =>
			runs.filter((run) => run.status === "queued" && run.waitReason === reason).length;
		const slotWaiting = queuedWith("process-slot");
		const laneWaiting = queuedWith("repository-lane");
		if (slotWaiting === 0 && laneWaiting === 0) return "";
		const executing = runs.filter((run) =>
			run.status === "running" || run.status === "interrupting" || (run.status === "queued" && run.waitReason === "starting"),
		).length;
		const capacity = runtime.backgroundQueue.capacity;
		const freeSlots = Math.max(0, capacity - runtime.backgroundQueue.activeCount);
		const parts = [`${executing} running`];
		if (slotWaiting > 0) {
			parts.push(`${slotWaiting} waiting for a free process slot (capacity ${capacity}); they start automatically as slots free`);
		}
		if (laneWaiting > 0) {
			parts.push(
				`${laneWaiting} shared-checkout writer${laneWaiting === 1 ? "" : "s"} waiting for the repository write lane — write serialization, not slot capacity` +
					(slotWaiting === 0 ? ` (${freeSlots} of ${capacity} slots free; parallel writers avoid the lane via worktree isolation)` : ""),
			);
		}
		return ` Pacing: ${parts.join(" · ")}.`;
	};

	const startBackground = createBackgroundDispatcher({
		runtime,
		getEnvironment: () => {
			if (!environmentRef.current) {
				throw new Error("pi-subagents dispatch environment is not ready yet.");
			}
			return environmentRef.current;
		},
		finishRun,
		makeLiveHandler,
		makeDetails,
	});
	runtime.dispatcher = startBackground;

	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: "Start paid leaf runs for broad reconnaissance or substantial self-contained work. Each normalized task+cwd owns its phase: an exact duplicate of an active run is rejected, and one of a finished run with retained context is rejected in favor of subagent_control resume. Batch scopes must be independent. wait:true returns results in-turn; otherwise completions wake main. Parallel writers default to detached Git worktrees; isolation:'shared' serializes same-repository writes.",
		parameters: SubagentParams,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			// `wait: true` holds this call for minutes and would otherwise show a
			// blank card; the background path returns at once and has nothing to
			// stream. Frames carry the final details shape because renderResult
			// falls back to "(no output)" without it.
			const makeProgress = (details: SubagentDetails): ((text: string) => void) | undefined =>
				onUpdate ? (text: string): void => onUpdate({ content: [{ type: "text", text }], details }) : undefined;
			// Run ids are allocated below; restore raises the allocator above every
			// id a durable record still owns, so a dispatch racing it could hand a
			// fresh run the id of a parked thread and overwrite its record.
			await runtime.durableRestore;
			monitor.beginTurn();
			const config = await loadConfig(runtime.configPath);

			const discovery = discoverAgents(ctx.cwd, {
				scope: config.agentScope,
				enabledNames: config.enabledAgents,
				projectTrusted: ctx.isProjectTrusted?.() === true,
			});
			const agents = discovery.agents;
			// Refresh the dispatcher's fallback environment so control operations
			// (resume of restored threads) never run on a stale context.
			environmentRef.current = { ctx, config, agents };

			const hasTasks = (params.tasks?.length ?? 0) > 0;
			const hasSingle = Boolean(params.agent) && params.task !== undefined;

			const catalog = agents.map((a) => a.name).join(", ") || "none";

			if (Number(hasTasks) + Number(hasSingle) !== 1) {
				return {
					content: [
						{
							type: "text",
							text: `Invalid parameters. Provide exactly one mode: single {agent, task} or parallel {tasks: [...]}. Enabled agents: ${catalog}.`,
						},
					],
					details: makeDetails("single")([]),
				};
			}

			if (hasTasks) {
				const blankTaskIndex = params.tasks?.findIndex(({ task }) => task.trim().length === 0) ?? -1;
				if (blankTaskIndex !== -1) {
					return {
						content: [
							{
								type: "text",
								text: `Invalid parameters. tasks[${blankTaskIndex}].task must contain at least one non-whitespace character. No background tasks were started. Enabled agents: ${catalog}.`,
							},
						],
						details: makeDetails("parallel")([]),
					};
				}
			} else if (params.task?.trim().length === 0) {
				return {
					content: [
						{
							type: "text",
							text: `Invalid parameters. task must contain at least one non-whitespace character. Enabled agents: ${catalog}.`,
						},
					],
					details: makeDetails("single")([]),
				};
			}

			// Sub-agents run detached from the foreground turn: the editor stays
			// available for disjoint orchestration while the launch receipt leases
			// each delegated phase. The queue paces child processes without changing
			// phase ownership or requiring a per-call task cap.
			if (params.tasks && params.tasks.length > 0) {
				// Admission is synchronous and ordered; slow worktree preparation belongs
				// to the bounded queue. Promise.all preserves caller result order while no
				// item waits for a sibling's filesystem setup.
				const results = await Promise.all(params.tasks.map((item) => {
					const catalogAgent = agents.find((candidate) => candidate.name === item.agent);
					return startBackground(
						item.agent,
						item.task,
						item.cwd,
						defaultIsolationMode(
							"parallel",
							item.agent,
							item.isolation as IsolationMode | undefined,
							catalogAgent ? isWorktreeCapableAgent(catalogAgent) : undefined,
							catalogAgent?.isolation,
						),
						{ deliveryRoute: params.wait ? "await" : "background" },
					);
				}));
				const startedRuns = results.filter((result) => result.exitCode === -1);
				const started = startedRuns.length;
				const startedIds = startedRuns
					.map((result) => result.runId)
					.filter((id): id is number => id !== undefined);
				const failureLines = results.flatMap((result, index) => {
					if (result.exitCode === -1) return [];
					const reason = getResultOutput(result).trim() || "unknown startup failure";
					return [
						`- tasks[${index}] (${params.tasks![index]!.agent}) failed to start: ${reason.replace(/\n/g, "\n  ")}`,
					];
				});
				if (started === 0) {
					// Pi marks custom-tool failures only when execute throws; returning an
					// `isError` property is still a successful AgentToolResult.
					throw new Error(`No subagents started.\n${failureLines.join("\n")}`);
				}
				if (params.wait) {
					const blocks = await awaitRunResults(runtime, startedIds, signal, config.maxResultLines, ctx.cwd, makeProgress(makeDetails("parallel", true)(results)));
					if (signal?.aborted) runtime.fallbackAwaitDelivery(startedIds);
					else runtime.completeAwaitDelivery(startedIds);
					const text = failureLines.length > 0
						? `${blocks}\n\nLaunch failures:\n${failureLines.join("\n")}`
						: blocks;
					return {
						content: [{ type: "text", text }],
						details: makeDetails("parallel", true)(results),
						...toolUsage(runtime, startedIds),
					};
				}
				const text = [
					phaseLeaseReceipt(startedIds),
					...(failureLines.length > 0 ? ["Launch failures:", ...failureLines] : []),
				].join("\n") + queuePacingNote();
				return {
					content: [{ type: "text", text }],
					details: makeDetails("parallel", true)(results),
				};
			}

			const singleCatalogAgent = agents.find((candidate) => candidate.name === params.agent);
			const result = await startBackground(
				params.agent as string,
				params.task as string,
				params.cwd,
				defaultIsolationMode(
					"single",
					params.agent as string,
					params.isolation as IsolationMode | undefined,
					singleCatalogAgent ? isWorktreeCapableAgent(singleCatalogAgent) : undefined,
					singleCatalogAgent?.isolation,
				),
				{ deliveryRoute: params.wait ? "await" : "background" },
			);
			if (result.exitCode !== -1) {
				throw new Error(getResultOutput(result));
			}
			if (params.wait && result.runId !== undefined) {
				const blocks = await awaitRunResults(runtime, [result.runId], signal, config.maxResultLines, ctx.cwd, makeProgress(makeDetails("single", true)([result])));
				if (signal?.aborted) runtime.fallbackAwaitDelivery([result.runId]);
				else runtime.completeAwaitDelivery([result.runId]);
				return {
					content: [{ type: "text", text: blocks }],
					details: makeDetails("single", true)([result]),
					...toolUsage(runtime, [result.runId]),
				};
			}
			return {
				content: [{
					type: "text",
					text: phaseLeaseReceipt(result.runId === undefined ? [] : [result.runId]) + queuePacingNote(),
				}],
				details: makeDetails("single", true)([result]),
			};

		},

		renderCall(args, theme) {
			if (args.tasks && args.tasks.length > 0) {
				let text = `${theme.fg("toolTitle", theme.bold("subagent "))}${theme.fg("accent", `parallel (${args.tasks.length})`)}`;
			for (const t of args.tasks.slice(0, 4)) {
				const preview = formatTaskSummary(t.task, 48);
				const isolation = defaultIsolationMode("parallel", t.agent, t.isolation) === "worktree" ? " [worktree]" : "";
				text += `\n  ${theme.fg("accent", t.agent)}${theme.fg("dim", isolation)} ${theme.fg("dim", preview)}`;
			}
				if (args.tasks.length > 4) text += `\n  ${theme.fg("dim", `… +${args.tasks.length - 4} more`)}`;
				return new Text(text, 0, 0);
			}
			const task: string = args.task ?? "";
			const preview = formatTaskSummary(task, 60);
			const isolation = args.isolation === "worktree" ? " [worktree]" : "";
			return new Text(
				`${theme.fg("toolTitle", theme.bold("subagent "))}${theme.fg("accent", args.agent ?? "?")}${theme.fg("dim", `${isolation}`)} ${theme.fg("dim", preview)}`,
				0,
				0,
			);
		},

		renderResult(result, _options, theme) {
			const details = result.details as SubagentDetails | undefined;
			if (!details || details.results.length === 0) return new Text(theme.fg("dim", "(no output)"), 0, 0);

			if (details.mode === "single") {
				const r = details.results[0];
				const pending = r.exitCode === -1;
				const icon = statusIcon(pending ? "running" : isFailedResult(r) ? "failed" : "done", theme);
				const usage = formatUsage(r.usage);
				const model = `${r.model ?? "?"}${r.modelFallbackFrom ? ` (main after ${r.modelFallbackFrom} failed)` : ""}`;
				const isolation = r.isolation === "worktree" ? ` · worktree ${r.integrationStatus ?? "active"}` : "";
				const runId = r.runId === undefined ? "" : `${theme.fg("dim", `#${r.runId}`)} `;
				const line = `${theme.fg("toolTitle", theme.bold("subagent "))}${icon} ${runId}${theme.fg("accent", r.agent)} ${theme.fg("dim", `· ${model}${r.thinking ? ` · thinking ${r.thinking}` : ""}${isolation}${pending ? " · background" : ""}${usage ? ` · ${usage}` : ""}`)}`;
				return new Text(line, 0, 0);
			}

			// Parallel mode: header + one compact line per agent
			const lines: string[] = [
				`${theme.fg("toolTitle", theme.bold("subagent "))}${theme.fg("accent", `parallel (${details.results.length})`)}`,
			];
			for (const r of details.results) {
				const pending = r.exitCode === -1;
				const icon = statusIcon(pending ? "running" : isFailedResult(r) ? "failed" : "done", theme);
				const usage = formatUsage(r.usage);
				const model = `${r.model ?? "?"}${r.modelFallbackFrom ? ` (main after ${r.modelFallbackFrom} failed)` : ""}`;
				const isolation = r.isolation === "worktree" ? ` · worktree ${r.integrationStatus ?? "active"}` : "";
				const runId = r.runId === undefined ? "" : `${theme.fg("dim", `#${r.runId}`)} `;
				lines.push(`  ${icon} ${runId}${theme.fg("accent", r.agent)} ${theme.fg("dim", `· ${model}${r.thinking ? ` · thinking ${r.thinking}` : ""}${isolation}${pending ? " · background" : ""}${usage ? ` · ${usage}` : ""}`)}`);
			}
			return new Text(lines.join("\n"), 0, 0);
		},
	});
}
