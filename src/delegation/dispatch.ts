/**
 * The `subagent` tool: dispatches the built-in roles as isolated pi child
 * processes, single or parallel.
 * Owns the public dispatch contract and
 * per-run status tracking. Stable thread generations, final integration, and
 * completion ownership live in thread-lifecycle.ts.
 */

import { resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";
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
	getResultError,
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
	"Self-contained brief with the outcome, acceptance criteria, relevant paths, known evidence, write boundaries, checks, and when to return for replanning. The child has no parent conversation.";

const agentSchema = (description: string) => stringEnum(BUILTIN_AGENT_NAMES, { description });

const TaskItem = Type.Object({
	agent: agentSchema("Role that runs this task"),
	task: Type.String({
		...NON_BLANK_TASK_OPTIONS,
		description: TASK_BRIEF_DESCRIPTION,
	}),
	cwd: Type.Optional(Type.String({ description: "Working directory for this task. Relative paths resolve from the batch cwd." })),
	isolation: IsolationSchema,
});

const SubagentParams = Type.Object({
	agent: Type.Optional(agentSchema("Role that runs the task (single mode)")),
	task: Type.Optional(
		Type.String({ ...NON_BLANK_TASK_OPTIONS, description: `${TASK_BRIEF_DESCRIPTION} (single mode)` }),
	),
	tasks: Type.Optional(Type.Array(TaskItem, {
		minItems: 1,
		maxItems: MAX_CONCURRENT_SUBAGENTS,
		description: `Batch independent phases here, up to ${MAX_CONCURRENT_SUBAGENTS} active runs total. Omit top-level agent and task when using tasks.`,
	})),
	cwd: Type.Optional(Type.String({ description: "Working directory for a single run or base directory for a batch. Relative to the parent session cwd." })),
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
	defaultIsolation: IsolationMode | undefined,
): PreparedDispatchTask[] {
	return tasks.map((item, index) => ({
		index,
		agent: item.agent,
		task: item.task,
		cwd: resolve(callerCwd, item.cwd ?? "."),
		isolation: item.isolation ?? defaultIsolation,
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

function formatResultRow(result: SingleResult, theme: Theme, awaited = false): string {
	const pending = result.exitCode === -1;
	const failed = !pending && isFailedResult(result);
	const status = pending ? (awaited ? "incomplete" : "accepted")
		: failed ? (result.runId === undefined ? "not started" : "failed") : "done";
	const icon = statusIcon(pending ? (awaited ? "parked" : "queued") : failed ? "failed" : "done", theme);
	const identity = result.runId === undefined ? result.agent : `#${result.runId} ${result.agent}`;
	const error = getResultError(result);
	const isolation = result.isolation === "worktree" ? `worktree ${result.integrationStatus ?? "pending"}` : undefined;
	const meta = [result.model, result.thinking && `thinking ${result.thinking}`, isolation, formatUsage(result.usage)].filter(Boolean);
	const summary = `${icon} ${theme.fg("accent", identity)} · ${status}`;
	return error ? `${summary} · ${theme.fg("error", formatTaskSummary(error, 120, false))}`
		: meta.length ? `${summary}${theme.fg("dim", ` · ${meta.join(" · ")}`)}` : summary;
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
		description: `Dispatch one bounded phase with agent and task, or batch independent phases with tasks (${MAX_CONCURRENT_SUBAGENTS} active slots total). Researcher retrieves evidence and worker implements and verifies. Assign disjoint write scopes and reuse results from owned phases. Background runs deliver automatically after integration. Main reviews the evidence and owns acceptance.`,
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
			const { agent, task, tasks } = params;
			if (tasks !== undefined && (tasks.length === 0 || agent !== undefined || task !== undefined)) {
				throw new Error("Provide a non-empty tasks array for a batch and omit top-level agent and task. No runs were started.");
			}
			if (tasks === undefined && (agent === undefined || task === undefined)) {
				throw new Error("Provide { agent, task } for a single run or { tasks: [...] } for a batch. No runs were started.");
			}
			const mode = tasks === undefined ? "single" : "parallel";
			const baseCwd = resolve(ctx.cwd, params.cwd ?? ".");
			const prepared = prepareDispatchTasks(tasks ?? [{ agent: agent!, task: task! }], baseCwd, params.isolation);
			const blank = prepared.find((item) => item.task.trim().length === 0);
			if (blank) {
				const field = mode === "single" ? "task" : `tasks[${blank.index}].task`;
				throw new Error(`${field} must contain at least one non-whitespace character. No runs were started.`);
			}
			const wait = params.wait ?? (ctx.hasUI === false);
			// Run ids are allocated below; restore raises the allocator above every
			// id a durable record still owns, so a dispatch racing it could hand a
			// fresh run the id of a parked thread and overwrite its record.
			await runtime.durableRestore;
			const config = await loadConfig(runtime.configPath);
			if (signal?.aborted) throw new Error("Subagent dispatch cancelled before any run started.");
			if (mode === "parallel") {
				const conflict = parallelAdmissionConflict(prepared, runtime);
				if (conflict) {
					throw new Error(`Parallel admission rejected: ${conflict} No background tasks were started.`);
				}
			}

			monitor.beginTurn();
			core.setEnvironment({ ctx, config, agents: loadBuiltinAgents() });
			// Reserve the whole batch in this turn before any other tool admission runs.
			const results = await Promise.all(prepared.map((item) => startBackground(
				item.agent, item.task, item.cwd,
				defaultIsolationMode(item.agent, item.isolation),
				{
					deliveryRoute: wait ? "await" : "background",
					automaticIsolation: item.isolation === undefined,
				},
			)));
			const ids = results.flatMap((result) => result.exitCode === -1 && result.runId !== undefined ? [result.runId] : []);
			const failures = results.flatMap((result, index) => {
				if (result.exitCode === -1) return [];
				const reason = getResultOutput(result).trim() || "Unknown startup failure.";
				return [`- tasks[${index}] (${result.agent}) failed to start: ${reason.replace(/\n/g, "\n  ")}`];
			});
			if (ids.length === 0) {
				throw new Error(mode === "single" ? getResultOutput(results[0]!) : `No subagents started.\n${failures.join("\n")}`);
			}
			const failureNotes = failures.length ? `\n\nLaunch failures:\n${failures.join("\n")}` : "";
			const details = makeDetails(mode)(results);
			if (!wait) return { content: [{ type: "text", text: phaseLeaseReceipt(ids) + failureNotes }], details };

			const blocks = await awaitRunResults(runtime, ids, signal, DEFAULT_MAX_RESULT_LINES, ctx.cwd, onUpdate
				? (text) => onUpdate({ content: [{ type: "text", text }], details }) : undefined);
			if (signal?.aborted) await cancelActiveWork(runtime, "Parent run was cancelled.");
			else runtime.completeAwaitDelivery(ids);
			const settled = results.map((result) => result.runId === undefined ? result : runtime.settledRuns.get(result.runId) ?? result);
			return {
				content: [{ type: "text", text: blocks + failureNotes }],
				details: { ...makeDetails(mode)(settled), awaited: true },
				...(signal?.aborted || settled.some(isFailedResult) ? { isError: true } : {}),
			};
		},

		renderCall(args, theme) {
			if (args.tasks && args.tasks.length > 0) {
				let text = `${theme.fg("toolTitle", theme.bold("subagent "))}${theme.fg("accent", `parallel (${args.tasks.length})`)}`;
				for (const t of args.tasks.slice(0, MAX_CONCURRENT_SUBAGENTS)) {
					const preview = formatTaskSummary(t.task, 48);
					const isolation = defaultIsolationMode(t.agent, t.isolation ?? args.isolation) === "worktree" ? " [worktree]" : "";
					text += `\n  ${theme.fg("accent", t.agent)}${theme.fg("dim", isolation)} ${theme.fg("dim", preview)}`;
				}
				if (args.tasks.length > MAX_CONCURRENT_SUBAGENTS) text += `\n  ${theme.fg("dim", `… +${args.tasks.length - MAX_CONCURRENT_SUBAGENTS} more`)}`;
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

		renderResult(result, options, theme) {
			const details = result.details as SubagentDetails | undefined;
			if (options.isPartial || options.expanded || !details?.results.length) {
				const text = stripVTControlCharacters(result.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n"));
				return new Text(options.isPartial ? theme.fg("muted", text) : text, 0, 0);
			}
			return new Text(details.results.map((run) => formatResultRow(run, theme, details.awaited)).join("\n"), 0, 0);
		},
	});
}
