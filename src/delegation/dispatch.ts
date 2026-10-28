/**
 * The `subagent` tool: dispatches the built-in roles as isolated pi child
 * processes, single or parallel.
 * Owns the public dispatch contract and
 * per-run status tracking. Stable thread generations, final integration, and
 * completion ownership live in thread-lifecycle.ts.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import { resolve } from "node:path";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { isWriteCapableAgent, loadBuiltinAgents, type AgentConfig, type ToolMetadata } from "./agents.ts";
import { DEFAULT_MAX_RESULT_LINES, loadConfig } from "../configuration/config.ts";
import { formatCompletionBlock, formatUsage } from "../presentation/format.ts";
import {
	formatTaskSummary,
	monitor,
	statusIcon,
	statusLabel,
} from "../presentation/monitor.ts";
import { findDuplicateDispatch, formatParallelScopeAdmissionNote, formatPhaseLeaseReceipt } from "./prompt.ts";
import {
	findPhaseScopeOverlap,
	findWriterLeaseScopeOverlap,
	normalizePhaseId,
	normalizePhaseScope,
	PHASE_ID_MAX_LENGTH,
	PHASE_ID_PATTERN_SOURCE,
	type PhaseScope,
	type PhaseScopeInput,
} from "./phase-scope.ts";
import { findPendingWorkflowPhase, type SubagentRuntime, type SubagentThread } from "../lifecycle/runtime.ts";
import { cancelActiveWork } from "../lifecycle/cancellation.ts";
import { createDispatchCore, type DispatchCore } from "../lifecycle/dispatch-core.ts";
import {
	getResultOutput,
	isFailedResult,
	type SingleResult,
	type SubagentDetails,
} from "../execution/spawn.ts";
import {
	isWorktreeCapableAgent,
	projectResultsRoot,
} from "../lifecycle/thread-shared.ts";
import type { IsolationMode } from "../isolation/worktree.ts";

const NON_BLANK_TASK_OPTIONS = { minLength: 1, pattern: "\\S" } as const;

const ISOLATION_DESCRIPTION =
	"Git isolation (not a sandbox): shared uses the caller's checkout; worktree creates a detached temporary worktree for write-capable agents only.";

export const IsolationSchema = Type.Optional(
	StringEnum(["shared", "worktree"] as const, { description: ISOLATION_DESCRIPTION }),
);

export const PhaseIdSchema = Type.Optional(Type.String({
	minLength: 1,
	maxLength: PHASE_ID_MAX_LENGTH,
	pattern: PHASE_ID_PATTERN_SOURCE,
	description: "Stable logical phase id. Reuse it when rewording the same phase; exact task+cwd is the fallback when omitted.",
}));
export const ScopeSchema = Type.Optional(Type.Object({
	paths: Type.Optional(Type.Array(Type.String({
		...NON_BLANK_TASK_OPTIONS,
		description: "Exact file or directory write claim resolved from the caller-facing cwd; wildcard * and ? are rejected, while other punctuation is literal.",
	}))),
	symbols: Type.Optional(Type.Array(Type.Object({
		path: Type.String({ ...NON_BLANK_TASK_OPTIONS, description: "Exact file path resolved from the caller-facing cwd." }),
		name: Type.String({ ...NON_BLANK_TASK_OPTIONS, description: "Exact symbol name claimed for writing." }),
	}))),
}, { description: "Declarative write-conflict metadata for admission, not filesystem permissions or a sandbox. If present, at least one valid claim is required." }));

const WaitSchema = Type.Optional(
	Type.Boolean({
		description:
			"Block until every run started by this call settles, then return each result exactly once in this tool response. Cancelling the parent stops its runs and suppresses background wake-ups. Intended for one-shot (pi -p) sessions or an immediate dependent step.",
	}),
);

const TASK_BRIEF_DESCRIPTION =
	"Complete brief: objective and done condition, relevant paths/symbols, known facts with citations when available, boundaries, and needed output. The child has no parent conversation.";

const TaskItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({
		...NON_BLANK_TASK_OPTIONS,
		description: TASK_BRIEF_DESCRIPTION,
	}),
	phaseId: PhaseIdSchema,
	scope: ScopeSchema,
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
	isolation: IsolationSchema,
});

const SubagentParams = Type.Object({
	agent: Type.Optional(Type.String({ description: "Name of the agent to invoke (single mode)" })),
	task: Type.Optional(
		Type.String({ ...NON_BLANK_TASK_OPTIONS, description: `${TASK_BRIEF_DESCRIPTION} (single mode)` }),
	),
	phaseId: PhaseIdSchema,
	scope: ScopeSchema,
	tasks: Type.Optional(Type.Array(TaskItem, { description: "Independently justified, disjoint phases for parallel execution" })),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process (single mode)" })),
	isolation: IsolationSchema,
	wait: WaitSchema,
});

/** Roles that default to worktree isolation in parallel dispatches even when
 * the live catalog cannot be consulted (render-only call sites). Custom
 * worktree-capable agents join them via the live catalog on the execute path. */
const WORKTREE_DEFAULT_AGENTS = new Set(["artisan"]);

/** Explicit isolation wins. Parallel writers default to detached worktrees
 * to keep their Git changes separate; shared runs may also start together. */
export function defaultIsolationMode(
	mode: "single" | "parallel",
	agentName: string,
	requested?: IsolationMode,
	writeCapable = WORKTREE_DEFAULT_AGENTS.has(agentName),
): IsolationMode {
	if (requested) return requested;
	return mode === "parallel" && writeCapable ? "worktree" : "shared";
}

interface PreparedDispatchTask {
	index: number;
	agent: string;
	task: string;
	cwd: string;
	phaseId?: string;
	scope?: PhaseScope;
	isolation?: IsolationMode;
	writeCapable: boolean;
}

function prepareDispatchTasks(
	tasks: ReadonlyArray<{ agent: string; task: string; cwd?: string; phaseId?: string; scope?: PhaseScopeInput; isolation?: IsolationMode }>,
	callerCwd: string,
	agents: readonly AgentConfig[],
	toolInfos?: readonly ToolMetadata[],
): PreparedDispatchTask[] {
	return tasks.map((item, index) => {
		const cwd = resolve(callerCwd, item.cwd ?? ".");
		const agent = agents.find((candidate) => candidate.name === item.agent);
		return {
			index,
			agent: item.agent,
			task: item.task,
			cwd,
			phaseId: normalizePhaseId(item.phaseId),
			scope: normalizePhaseScope(item.scope, cwd),
			isolation: item.isolation,
			writeCapable: agent ? isWriteCapableAgent(agent, toolInfos) : true,
		};
	});
}

function parallelAdmissionConflict(
	tasks: readonly PreparedDispatchTask[],
	threads: Iterable<SubagentThread>,
): string | undefined {
	for (let leftIndex = 0; leftIndex < tasks.length; leftIndex++) {
		for (let rightIndex = leftIndex + 1; rightIndex < tasks.length; rightIndex++) {
			const left = tasks[leftIndex]!;
			const right = tasks[rightIndex]!;
			const duplicate = findDuplicateDispatch([{
				id: left.index,
				agentName: left.agent,
				task: left.task,
				phaseId: left.phaseId,
				cwd: left.cwd,
				state: "queued",
			}], right.task, right.cwd, right.phaseId);
			if (duplicate) {
				return `deterministic duplicate between tasks[${left.index}] and tasks[${right.index}]`;
			}
		}
	}
	const leases = [...threads];
	for (const task of tasks) {
		const duplicate = findDuplicateDispatch(leases, task.task, task.cwd, task.phaseId);
		if (duplicate?.kind === "active") {
			return `tasks[${task.index}] duplicates active run #${duplicate.source.id} (${duplicate.source.agentName})`;
		}
		if (duplicate?.kind === "settled") {
			return `tasks[${task.index}] duplicates settled run #${duplicate.source.id} (${duplicate.source.agentName}); inspect it with subagent_status and handle follow-up work in main`;
		}
	}
	const writers = tasks.filter(
		(task): task is PreparedDispatchTask & { scope: PhaseScope } => task.writeCapable && task.scope !== undefined,
	);
	for (let leftIndex = 0; leftIndex < writers.length; leftIndex++) {
		for (let rightIndex = leftIndex + 1; rightIndex < writers.length; rightIndex++) {
			const left = writers[leftIndex]!;
			const right = writers[rightIndex]!;
			const overlap = findPhaseScopeOverlap(left.scope, right.scope);
			if (overlap) {
				return `tasks[${left.index}] scope ${overlap.left} overlaps tasks[${right.index}] scope ${overlap.right}`;
			}
		}
	}
	for (const task of writers) {
		const conflict = findWriterLeaseScopeOverlap(task.scope, leases);
		if (conflict) {
			return `tasks[${task.index}] scope ${conflict.overlap.left} overlaps run #${conflict.lease.id} scope ${conflict.overlap.right}`;
		}
	}
	return undefined;
}

/** One compact tool-card row: status, run id, agent, model route, thinking,
 * isolation, and usage. Shared by the single and parallel layouts. */
function formatResultRow(r: SingleResult, theme: Theme): string {
	const pending = r.exitCode === -1;
	const icon = statusIcon(pending ? "running" : isFailedResult(r) ? "failed" : "done", theme);
	const usage = formatUsage(r.usage);
	const model = `${r.model ?? "?"}${r.modelFallbackFrom ? ` (main after ${r.modelFallbackFrom} failed)` : ""}`;
	const isolation = r.isolation === "worktree" ? ` · worktree ${r.integrationStatus ?? "active"}` : "";
	const runId = r.runId === undefined ? "" : `${theme.fg("dim", `#${r.runId}`)} `;
	const meta = `· ${model}${r.thinking ? ` · thinking ${r.thinking}` : ""}${isolation}${pending ? " · background" : ""}${usage ? ` · ${usage}` : ""}`;
	return `${icon} ${runId}${theme.fg("accent", r.agent)} ${theme.fg("dim", meta)}`;
}

/** Awaited children report their usage per run and per model in the result
 * blocks below; nothing is attached to the tool result itself, because pi
 * folds tool-result usage into one session total — that merged every
 * model's spend into the main window's consumption line. */

/** In-turn wait for a fresh dispatch. Registration resolves it without a model-chosen
 * timer; parent abort ends the wait and cancels its owned work. */
async function awaitRunResults(
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
			return Promise.resolve({ note: `run #${runId} was interrupted; inspect retained work with subagent_status and finish it in main` });
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
					finish({ note: `run #${runId} was interrupted; inspect retained work with subagent_status and finish it in main` });
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
			const onAbort = (): void => finish({ note: `Parent wait cancelled for run #${runId}; automatic cancellation stops unfinished child work. No additional subagent_stop is needed.` });
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

export function registerSubagentTool(
	pi: ExtensionAPI,
	runtime: SubagentRuntime,
	core: DispatchCore = createDispatchCore(runtime),
): void {
	const { startBackground, makeDetails } = core;

	const phaseLeaseReceipt = (
		runIds: number[],
		options: { mode: "single" } | { mode: "parallel"; declaredScopesComplete: boolean },
	): string =>
		formatPhaseLeaseReceipt(
			runIds
				.map((runId) => runtime.threads.get(runId))
				.filter((thread): thread is SubagentThread => thread !== undefined),
			options,
		);

	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: "Start one-shot leaf runs when substantial bounded work benefits from parallel progress, context isolation, or independent verification enough to offset startup and integration. Keep small or tightly coupled tasks in main. Use tasks for independent phases; use subagent_workflow for known dependent phases. Duplicate phases and declared writer overlaps are rejected before allocation; scope does not prove independence or grant permissions. Parallel tasks without scope report `independence not verified`. Results arrive automatically, or in-turn with wait:true. Main handles incomplete work.",
		// Admission and lease reservation finish synchronously before child startup.
		// Awaited runs must not block unrelated dispatch calls.
		exposure: "model-only",
		executionMode: "parallel",
		annotations: {
			readOnlyHint: false,
			destructiveHint: true,
			idempotentHint: false,
			openWorldHint: true,
		},
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
			const agents = loadBuiltinAgents();
			// One admission snapshot: role boundaries and writer capability must
			// describe the same catalog the batch is validated against.
			const toolInfos = runtime.getToolInfos();
			core.setEnvironment({ ctx, config, agents });

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
			// each delegated phase. Independent child processes start without a cap.
			if (params.tasks && params.tasks.length > 0) {
				let prepared: PreparedDispatchTask[];
				try {
					prepared = prepareDispatchTasks(params.tasks, ctx.cwd, agents, toolInfos);
				} catch (error) {
					throw new Error(`Parallel admission rejected: ${error instanceof Error ? error.message : String(error)} No background tasks were started.`);
				}
				const pending = prepared.map((task) => findPendingWorkflowPhase(runtime, task.task, task.cwd, task.phaseId)).find(Boolean);
				if (pending) throw new Error(`Workflow #${pending.workflowId} node "${pending.nodeId}" already owns a requested phase. No runs were started.`);
				const conflict = parallelAdmissionConflict(prepared, runtime.threads.values());
				if (conflict) {
					throw new Error(`Parallel admission rejected: ${conflict}. No background tasks were started.`);
				}
				const declaredScopesComplete = prepared.every((item) => item.scope !== undefined);
				const admissionNote = formatParallelScopeAdmissionNote(declaredScopesComplete);
				// Duplicate and scope admission completes for the whole batch before any
				// startBackground call can allocate a run. Worktree preparation stays queued.
				const results = await Promise.all(prepared.map((item) => {
					const catalogAgent = agents.find((candidate) => candidate.name === item.agent);
					return startBackground(
						item.agent,
						item.task,
						item.cwd,
						defaultIsolationMode(
							"parallel",
							item.agent,
							item.isolation,
							catalogAgent ? isWorktreeCapableAgent(catalogAgent, toolInfos) : undefined,
						),
						{
							deliveryRoute: params.wait ? "await" : "background",
							phaseId: item.phaseId,
							scope: item.scope,
							writeCapable: item.writeCapable,
						},
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
					// Nothing was allocated, so there is no structured batch to keep.
					// Throwing marks the tool failed; a returned `isError` is for failures
					// that still carry details.
					throw new Error(`No subagents started.\n${failureLines.join("\n")}`);
				}
				if (params.wait) {
					const blocks = await awaitRunResults(runtime, startedIds, signal, DEFAULT_MAX_RESULT_LINES, ctx.cwd, makeProgress(makeDetails("parallel", true)(results)));
					if (signal?.aborted) await cancelActiveWork(runtime, "Parent run was cancelled.");
					else runtime.completeAwaitDelivery(startedIds);
					const resultText = failureLines.length > 0
						? `${blocks}\n\nLaunch failures:\n${failureLines.join("\n")}`
						: blocks;
					const text = `${resultText}\n\n${admissionNote}`;
					return {
						content: [{ type: "text", text }],
						details: makeDetails("parallel", true)(results),
					};
				}
				const text = [
					phaseLeaseReceipt(startedIds, { mode: "parallel", declaredScopesComplete }),
					...(failureLines.length > 0 ? ["Launch failures:", ...failureLines] : []),
				].join("\n");
				return {
					content: [{ type: "text", text }],
					details: makeDetails("parallel", true)(results),
				};
			}

			let single: PreparedDispatchTask;
			try {
				single = prepareDispatchTasks([{
					agent: params.agent as string,
					task: params.task as string,
					cwd: params.cwd,
					phaseId: params.phaseId,
					scope: params.scope,
					isolation: params.isolation as IsolationMode | undefined,
				}], ctx.cwd, agents, toolInfos)[0]!;
			} catch (error) {
				throw new Error(`Dispatch admission rejected: ${error instanceof Error ? error.message : String(error)}`);
			}
			const singleCatalogAgent = agents.find((candidate) => candidate.name === single.agent);
			const result = await startBackground(
				single.agent,
				single.task,
				single.cwd,
				defaultIsolationMode(
					"single",
					single.agent,
					single.isolation,
					singleCatalogAgent ? isWorktreeCapableAgent(singleCatalogAgent, toolInfos) : undefined,
				),
				{
					deliveryRoute: params.wait ? "await" : "background",
					phaseId: single.phaseId,
					scope: single.scope,
					writeCapable: single.writeCapable,
				},
			);
			if (result.exitCode !== -1) {
				throw new Error(getResultOutput(result));
			}
			if (params.wait && result.runId !== undefined) {
				const blocks = await awaitRunResults(runtime, [result.runId], signal, DEFAULT_MAX_RESULT_LINES, ctx.cwd, makeProgress(makeDetails("single", true)([result])));
				if (signal?.aborted) await cancelActiveWork(runtime, "Parent run was cancelled.");
				else runtime.completeAwaitDelivery([result.runId]);
				return {
					content: [{ type: "text", text: blocks }],
					details: makeDetails("single", true)([result]),
				};
			}
			return {
				content: [{
					type: "text",
					text: phaseLeaseReceipt(result.runId === undefined ? [] : [result.runId], { mode: "single" }),
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

			const title = theme.fg("toolTitle", theme.bold("subagent "));
			if (details.mode === "single") {
				return new Text(`${title}${formatResultRow(details.results[0]!, theme)}`, 0, 0);
			}
			// Parallel mode: header + one compact line per agent
			const lines = [
				`${title}${theme.fg("accent", `parallel (${details.results.length})`)}`,
				...details.results.map((r) => `  ${formatResultRow(r, theme)}`),
			];
			return new Text(lines.join("\n"), 0, 0);
		},
	});
}
