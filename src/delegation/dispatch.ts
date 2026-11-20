/**
 * The `subagent` tool: dispatches the built-in roles as isolated pi child
 * processes, single or parallel.
 * Owns the public dispatch contract and
 * per-run status tracking. Stable thread generations, final integration, and
 * completion ownership live in thread-lifecycle.ts.
 */

import { resolve } from "node:path";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { loadBuiltinAgents } from "./agents.ts";
import { BUILTIN_AGENT_NAMES, DEFAULT_MAX_RESULT_LINES, loadConfig } from "../configuration/config.ts";
import { stringEnum } from "../configuration/schema.ts";
import { formatUsage } from "../presentation/format.ts";
import {
	formatTaskSummary,
	monitor,
	statusIcon,
} from "../presentation/monitor.ts";
import { duplicateDispatchRemedy, findDuplicateDispatch, formatPhaseLeaseReceipt } from "./prompt.ts";
import type { SubagentRuntime, SubagentThread } from "../lifecycle/runtime.ts";
import { cancelActiveWork } from "../lifecycle/cancellation.ts";
import { awaitRunResults, WaitSchema } from "../lifecycle/await-results.ts";
import { createDispatchCore, type DispatchCore } from "../lifecycle/dispatch-core.ts";
import { concurrencyAdmissionConflict } from "../lifecycle/thread-shared.ts";
import { MAX_CONCURRENT_SUBAGENTS } from "../execution/background.ts";
import {
	getResultOutput,
	isFailedResult,
	type SingleResult,
	type SubagentDetails,
} from "../execution/spawn.ts";
import type { IsolationMode } from "../isolation/worktree.ts";

const NON_BLANK_TASK_OPTIONS = { minLength: 1, pattern: "\\S" } as const;

const ISOLATION_DESCRIPTION =
	"Usually omit: implementation uses an automatic Git worktree when a committed HEAD is available; read-only research uses the current directory. Override worktree to require isolation, or shared to write directly in the caller's checkout. Not a sandbox.";

const IsolationSchema = Type.Optional(
	stringEnum(["shared", "worktree"] as const, { description: ISOLATION_DESCRIPTION }),
);

const TASK_BRIEF_DESCRIPTION =
	"Self-contained plan: outcome and acceptance criteria, relevant paths, known evidence, write boundaries, required checks, when to return for re-planning, and compact expected output. The worker has no parent conversation.";

const agentSchema = (description: string) => stringEnum(BUILTIN_AGENT_NAMES, { description });

const TaskItem = Type.Object({
	agent: agentSchema("Role that runs this task"),
	task: Type.String({
		...NON_BLANK_TASK_OPTIONS,
		description: TASK_BRIEF_DESCRIPTION,
	}),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
	isolation: IsolationSchema,
});

const SubagentParams = Type.Object({
	agent: Type.Optional(agentSchema("Role that runs the task (single mode)")),
	task: Type.Optional(
		Type.String({ ...NON_BLANK_TASK_OPTIONS, description: `${TASK_BRIEF_DESCRIPTION} (single mode)` }),
	),
	tasks: Type.Optional(Type.Array(TaskItem, {
		maxItems: MAX_CONCURRENT_SUBAGENTS,
		description: `Up to ${MAX_CONCURRENT_SUBAGENTS} independent, disjoint phases to execute concurrently in one batch (max ${MAX_CONCURRENT_SUBAGENTS} active subagents total). Batch independent work together instead of dispatching one by one.`,
	})),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process (single mode)" })),
	isolation: Type.Optional(stringEnum(["shared", "worktree"] as const, {
		description: `${ISOLATION_DESCRIPTION} In parallel mode this is the default for tasks that omit their own isolation.`,
	})),
	wait: WaitSchema,
});

/** Explicit overrides win. Implementation uses a worktree even for a single
 * task; research and review stay in the current directory. */
export function defaultIsolationMode(agentName: string, requested?: IsolationMode): IsolationMode {
	return requested ?? (agentName === "worker" ? "worktree" : "shared");
}

interface PreparedDispatchTask {
	index: number;
	agent: string;
	task: string;
	cwd: string;
	isolation?: IsolationMode;
}

function prepareDispatchTasks(
	tasks: ReadonlyArray<{ agent: string; task: string; cwd?: string; isolation?: IsolationMode }>,
	callerCwd: string,
): PreparedDispatchTask[] {
	return tasks.map((item, index) => ({
		index,
		agent: item.agent,
		task: item.task,
		cwd: resolve(callerCwd, item.cwd ?? "."),
		isolation: item.isolation,
	}));
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
				cwd: left.cwd,
				state: "queued",
			}], right.task, right.cwd);
			if (duplicate) {
				return `deterministic duplicate between tasks[${left.index}] and tasks[${right.index}]; merge them into one brief or make them disjoint.`;
			}
		}
	}
	const leases = [...runtime.threads.values()];
	for (const task of tasks) {
		const duplicate = findDuplicateDispatch(leases, task.task, task.cwd);
		if (duplicate) {
			const owner = duplicate.source;
			return `tasks[${task.index}] duplicates ${duplicate.kind} run #${owner.id} (${owner.agentName}). ${duplicateDispatchRemedy(owner)}`;
		}
	}
	return concurrencyAdmissionConflict(runtime, tasks.length);
}

/** One compact tool-card row: status, run id, agent, model route, thinking,
 * isolation, and usage. Shared by the single and parallel layouts. */
function formatResultRow(r: SingleResult, theme: Theme): string {
	const pending = r.exitCode === -1;
	const icon = statusIcon(pending ? "running" : isFailedResult(r) ? "failed" : "done", theme);
	const usage = formatUsage(r.usage);
	const model = r.model ?? "?";
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

	const phaseLeaseReceipt = (runIds: number[]): string =>
		formatPhaseLeaseReceipt(
			runIds
				.map((runId) => runtime.threads.get(runId))
				.filter((thread): thread is SubagentThread => thread !== undefined),
		);

	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: `Dispatch workers to execute main's plan (at most ${MAX_CONCURRENT_SUBAGENTS} active subagents concurrently): worker implements and verifies; researcher retrieves read-only evidence. Main reviews integrated changes and owns acceptance. Batch independent phases in one parallel tasks call (up to ${MAX_CONCURRENT_SUBAGENTS}) so they run together — never serialize independent work one by one, overlap writers, or repeat a leased scope in main or another subagent. Duplicate phases are rejected before allocation. Omit isolation for automatic selection. Omit wait (background by default) so main continues disjoint work immediately while subagents run; completions wake main automatically. Use wait:true only when no disjoint main work remains and planning requires the result (print/JSON sessions wait by default).`,
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
			const deliverAwaited = async (mode: "single" | "parallel", results: SingleResult[], ids: number[], failures: string[] = []) => {
				const blocks = await awaitRunResults(runtime, ids, signal, DEFAULT_MAX_RESULT_LINES, ctx.cwd, makeProgress(makeDetails(mode)(results)));
				if (signal?.aborted) await cancelActiveWork(runtime, "Parent run was cancelled.");
				else runtime.completeAwaitDelivery(ids);
				const settled = results.map((result) => result.runId === undefined ? result : runtime.settledRuns.get(result.runId) ?? result);
				return {
					content: [{ type: "text" as const, text: blocks + (failures.length ? `\n\nLaunch failures:\n${failures.join("\n")}` : "") }],
					details: makeDetails(mode)(settled),
					...(signal?.aborted || settled.some((result) => result.exitCode === -1 || isFailedResult(result)) ? { isError: true } : {}),
				};
			};
			// Run ids are allocated below; restore raises the allocator above every
			// id a durable record still owns, so a dispatch racing it could hand a
			// fresh run the id of a parked thread and overwrite its record.
			await runtime.durableRestore;
			monitor.beginTurn();
			const config = await loadConfig(runtime.configPath);
			const agents = loadBuiltinAgents();
			if (signal?.aborted) throw new Error("Subagent dispatch cancelled before any run started.");
			core.setEnvironment({ ctx, config, agents });

			const tasks = params.tasks ?? [];
			const hasTasks = tasks.length > 0;
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
				const blankTaskIndex = tasks.findIndex(({ task }) => task.trim().length === 0);
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

			// Sub-agents run detached from the foreground turn: the editor and main
			// remain free for disjoint work while the launch receipt leases each phase.
			// Up to MAX_CONCURRENT_SUBAGENTS independent child processes run concurrently.
			if (hasTasks) {
				const prepared = prepareDispatchTasks(
					tasks.map((item) => ({ ...item, isolation: item.isolation ?? params.isolation })),
					ctx.cwd,
				);
				const conflict = parallelAdmissionConflict(prepared, runtime);
				if (conflict) {
					throw new Error(`Parallel admission rejected: ${conflict} No background tasks were started.`);
				}
				// Duplicate admission completes for the whole batch before any
				// startBackground call can allocate a run. Worktree preparation stays queued.
				const results = await Promise.all(prepared.map((item) => startBackground(
					item.agent,
					item.task,
					item.cwd,
					defaultIsolationMode(item.agent, item.isolation),
					{
						deliveryRoute: wait ? "await" : "background",
						automaticIsolation: item.isolation === undefined,
					},
				)));
				const startedRuns = results.filter((result) => result.exitCode === -1);
				const started = startedRuns.length;
				const startedIds = startedRuns
					.map((result) => result.runId)
					.filter((id): id is number => id !== undefined);
				const failureLines = results.flatMap((result, index) => {
					if (result.exitCode === -1) return [];
					const reason = getResultOutput(result).trim() || "unknown startup failure";
					return [
						`- tasks[${index}] (${tasks[index]!.agent}) failed to start: ${reason.replace(/\n/g, "\n  ")}`,
					];
				});
				if (started === 0) {
					// Nothing was allocated, so there is no structured batch to keep.
					// Throwing marks the tool failed; a returned `isError` is for failures
					// that still carry details.
					throw new Error(`No subagents started.\n${failureLines.join("\n")}`);
				}
				if (wait) return deliverAwaited("parallel", results, startedIds, failureLines);
				const text = [
					phaseLeaseReceipt(startedIds),
					...(failureLines.length > 0 ? ["Launch failures:", ...failureLines] : []),
				].join("\n");
				return {
					content: [{ type: "text", text }],
					details: makeDetails("parallel")(results),
				};
			}

			const single = prepareDispatchTasks([{
				agent: params.agent as string,
				task: params.task as string,
				cwd: params.cwd,
				isolation: params.isolation as IsolationMode | undefined,
			}], ctx.cwd)[0]!;
			const result = await startBackground(
				single.agent,
				single.task,
				single.cwd,
				defaultIsolationMode(single.agent, single.isolation),
				{
					deliveryRoute: wait ? "await" : "background",
					automaticIsolation: single.isolation === undefined,
				},
			);
			if (result.exitCode !== -1) {
				throw new Error(getResultOutput(result));
			}
			if (wait && result.runId !== undefined) {
				return deliverAwaited("single", [result], [result.runId]);
			}
			return {
				content: [{
					type: "text",
					text: phaseLeaseReceipt(result.runId === undefined ? [] : [result.runId]),
				}],
				details: makeDetails("single")([result]),
			};

		},

		renderCall(args, theme) {
			if (args.tasks && args.tasks.length > 0) {
				let text = `${theme.fg("toolTitle", theme.bold("subagent "))}${theme.fg("accent", `parallel (${args.tasks.length})`)}`;
				for (const t of args.tasks.slice(0, 4)) {
					const preview = formatTaskSummary(t.task, 48);
					const isolation = defaultIsolationMode(t.agent, t.isolation ?? args.isolation) === "worktree" ? " [worktree]" : "";
					text += `\n  ${theme.fg("accent", t.agent)}${theme.fg("dim", isolation)} ${theme.fg("dim", preview)}`;
				}
				if (args.tasks.length > 4) text += `\n  ${theme.fg("dim", `… +${args.tasks.length - 4} more`)}`;
				return new Text(text, 0, 0);
			}
			const task: string = args.task ?? "";
			const preview = formatTaskSummary(task, 60);
			const isolation = defaultIsolationMode(args.agent ?? "", args.isolation) === "worktree" ? " [worktree]" : "";
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
