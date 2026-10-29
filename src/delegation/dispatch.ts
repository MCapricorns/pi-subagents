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
import { formatUsage } from "../presentation/format.ts";
import {
	formatTaskSummary,
	monitor,
	statusIcon,
} from "../presentation/monitor.ts";
import { findDuplicateDispatch, formatParallelScopeAdmissionNote, formatPhaseLeaseReceipt } from "./prompt.ts";
import { findRuntimeWriterConflict } from "./ownership.ts";
import {
	findPhaseScopeOverlap,
	normalizePhaseId,
	normalizePhaseScope,
	PHASE_ID_MAX_LENGTH,
	PHASE_ID_PATTERN_SOURCE,
	type PhaseScope,
	type PhaseScopeInput,
} from "./phase-scope.ts";
import { findPendingWorkflowPhase, type SubagentRuntime, type SubagentThread } from "../lifecycle/runtime.ts";
import { cancelActiveWork } from "../lifecycle/cancellation.ts";
import { awaitRunResults, WaitSchema } from "../lifecycle/await-results.ts";
import { createDispatchCore, type DispatchCore } from "../lifecycle/dispatch-core.ts";
import {
	getResultOutput,
	isFailedResult,
	type SingleResult,
	type SubagentDetails,
} from "../execution/spawn.ts";
import { isWorktreeCapableAgent } from "../lifecycle/thread-shared.ts";
import type { IsolationMode } from "../isolation/worktree.ts";

const NON_BLANK_TASK_OPTIONS = { minLength: 1, pattern: "\\S" } as const;

const ISOLATION_DESCRIPTION =
	"Usually omit: writers use an automatic Git worktree when a committed HEAD is available; reading and review use the current directory. Override worktree to require isolation, or shared to write directly in the caller's checkout. Not a sandbox.";

export const IsolationSchema = Type.Optional(
	StringEnum(["shared", "worktree"] as const, { description: ISOLATION_DESCRIPTION }),
);

export const PhaseIdSchema = Type.Optional(Type.String({
	minLength: 1,
	maxLength: PHASE_ID_MAX_LENGTH,
	pattern: PHASE_ID_PATTERN_SOURCE,
	description: "Stable logical phase id. Reuse it when rewording the same phase. Equal normalized task+cwd also rejects duplicates, even with a different phaseId.",
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

/** Default when rendering without the live tool catalog. */
const WORKTREE_DEFAULT_AGENTS = new Set(["artisan"]);

/** Explicit overrides win. Implementation uses worktrees even for a single
 * task; reading and review stay in the current directory. */
export function defaultIsolationMode(
	agentName: string,
	requested?: IsolationMode,
	writeCapable = WORKTREE_DEFAULT_AGENTS.has(agentName),
): IsolationMode {
	if (requested) return requested;
	const readOnlyRole = ["scout", "sentinel", "skeptic"].includes(agentName);
	return writeCapable && !readOnlyRole ? "worktree" : "shared";
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
	runtime: SubagentRuntime,
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
	const leases = [...runtime.threads.values()];
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
		const conflict = findRuntimeWriterConflict(runtime, task.scope);
		if (conflict) {
			return `tasks[${task.index}] scope ${conflict.overlap.left} overlaps ${conflict.owner} scope ${conflict.overlap.right}`;
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
		description: "Delegate worthwhile bounded work for focused implementation, isolated research, parallel progress, or independent verification. Use tasks for independent phases and a built-in subagent_workflow when its fixed phases fit. Duplicate phases and declared writer overlaps with runs, pending nodes, or main writes are rejected before allocation. Scope is coordination metadata, not permissions. Omit isolation for automatic selection. Use wait:true for an immediate dependency; one-shot print/JSON sessions wait by default. Background results wake main to finish the task. Reuse completed work and handle gaps.",
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
			const wait = params.wait ?? (ctx.hasUI === false);
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
			if (signal?.aborted) throw new Error("Subagent dispatch cancelled before any run started.");
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
				const conflict = parallelAdmissionConflict(prepared, runtime);
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
							item.agent,
							item.isolation,
							catalogAgent ? isWorktreeCapableAgent(catalogAgent, toolInfos) : undefined,
						),
						{
							deliveryRoute: wait ? "await" : "background",
							phaseId: item.phaseId,
							scope: item.scope,
							writeCapable: item.writeCapable,
							automaticIsolation: item.isolation === undefined,
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
				if (wait) {
					const blocks = await awaitRunResults(runtime, startedIds, signal, DEFAULT_MAX_RESULT_LINES, ctx.cwd, makeProgress(makeDetails("parallel")(results)));
					if (signal?.aborted) await cancelActiveWork(runtime, "Parent run was cancelled.");
					else runtime.completeAwaitDelivery(startedIds);
					const resultText = failureLines.length > 0
						? `${blocks}\n\nLaunch failures:\n${failureLines.join("\n")}`
						: blocks;
					const text = `${resultText}\n\n${admissionNote}`;
					const settled = results.map((result) => result.runId === undefined ? result : runtime.settledRuns.get(result.runId) ?? result);
					return {
						content: [{ type: "text", text }],
						details: makeDetails("parallel")(settled),
						...(signal?.aborted || settled.some((result) => result.exitCode === -1 || isFailedResult(result)) ? { isError: true } : {}),
					};
				}
				const text = [
					phaseLeaseReceipt(startedIds, { mode: "parallel", declaredScopesComplete }),
					...(failureLines.length > 0 ? ["Launch failures:", ...failureLines] : []),
				].join("\n");
				return {
					content: [{ type: "text", text }],
					details: makeDetails("parallel")(results),
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
					single.agent,
					single.isolation,
					singleCatalogAgent ? isWorktreeCapableAgent(singleCatalogAgent, toolInfos) : undefined,
				),
				{
					deliveryRoute: wait ? "await" : "background",
					phaseId: single.phaseId,
					scope: single.scope,
					writeCapable: single.writeCapable,
					automaticIsolation: single.isolation === undefined,
				},
			);
			if (result.exitCode !== -1) {
				throw new Error(getResultOutput(result));
			}
			if (wait && result.runId !== undefined) {
				const blocks = await awaitRunResults(runtime, [result.runId], signal, DEFAULT_MAX_RESULT_LINES, ctx.cwd, makeProgress(makeDetails("single")([result])));
				if (signal?.aborted) await cancelActiveWork(runtime, "Parent run was cancelled.");
				else runtime.completeAwaitDelivery([result.runId]);
				const settled = runtime.settledRuns.get(result.runId);
				return {
					content: [{ type: "text", text: blocks }],
					details: makeDetails("single")([settled ?? result]),
					...(signal?.aborted || !settled || isFailedResult(settled) ? { isError: true } : {}),
				};
			}
			return {
				content: [{
					type: "text",
					text: phaseLeaseReceipt(result.runId === undefined ? [] : [result.runId], { mode: "single" }),
				}],
				details: makeDetails("single")([result]),
			};

		},

		renderCall(args, theme) {
			if (args.tasks && args.tasks.length > 0) {
				let text = `${theme.fg("toolTitle", theme.bold("subagent "))}${theme.fg("accent", `parallel (${args.tasks.length})`)}`;
				for (const t of args.tasks.slice(0, 4)) {
					const preview = formatTaskSummary(t.task, 48);
					const isolation = defaultIsolationMode(t.agent, t.isolation) === "worktree" ? " [worktree]" : "";
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
