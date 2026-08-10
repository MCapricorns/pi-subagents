/**
 * Lookup tools around the subagent runtime: subagent_wait (in-turn result
 * lookup, non-blocking by default), subagent_status (overview / full result by
 * id), and subagent_stop (cancel active runs).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { loadConfig } from "./config.ts";
import { emptyUsage, formatCompletionBlock, formatUsage, matchRunIds } from "./format.ts";
import {
	formatElapsed,
	formatUsageCompact,
	monitor,
	statusLabel,
} from "./monitor.ts";
import type { SubagentRuntime } from "./runtime.ts";
import { isFailedResult, type SingleResult } from "./spawn.ts";

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
	const SubagentWaitParams = Type.Object({
		id: Type.Optional(
			Type.String({
				description: "Run id or prefix shown in the subagent widget (#id). Omit to wait for all active runs in this session.",
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
		promptSnippet: "Look up a background subagent result in-turn (id: run id from the widget; omit for all). Non-blocking by default; pass timeoutMs to block.",
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
			const isActive = (run: { status: string; retained?: boolean }): boolean =>
				run.status === "queued" || run.status === "running" || run.retained === true;

			const requested = params.id?.trim();
			// A run that already settled resolves immediately with its result.
			if (requested) {
				const settledIds = matchRunIds([...runtime.settledRuns.keys()], requested);
				if (settledIds.length > 0) {
					return {
						content: [
							{ type: "text", text: settledIds.map((id) => formatCompletionBlock(runtime.settledRuns.get(id)!, config.maxResultLines, ctx.cwd)).join("\n\n") },
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
						if (!monitor.findRun(runId)) {
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
				outcome.result ? formatCompletionBlock(outcome.result, config.maxResultLines, ctx.cwd) : (outcome.note ?? "(no outcome)"),
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
	// with per-run details (id, agent, model, usage, elapsed, activity) so the
	// main agent can decide whether to wait, stop, or re-dispatch. Learned from
	// nicobailon/pi-subagents ({action:"status"} + status files): inspect before
	// you act, and report run ids when handing off.
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
			"List active background sub-agent runs (id, agent, model, usage, elapsed, current activity) and recently finished results.",
			"Pass id to read the full result of a finished run; pass no id for the overview.",
			"Use it to decide whether to subagent_wait, subagent_stop, or re-dispatch — never to poll: results arrive by themselves.",
		].join(" "),
		promptSnippet: "Inspect background subagents: active runs, finished results, full result by id.",
		promptGuidelines: [
			"Call subagent_status to see what is running and what already finished; the widget shows the same live state.",
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
							{ type: "text", text: settledIds.map((id) => formatCompletionBlock(runtime.settledRuns.get(id)!, config.maxResultLines, ctx.cwd)).join("\n\n") },
						],
						details: {},
					};
				}
				const runs = monitor.getRuns();
				const activeId = matchRunIds(runs.map((run) => run.id), requested)[0];
				const active = activeId === undefined ? undefined : runs.find((run) => run.id === activeId);
				if (active) {
					return {
						content: [
							{
								type: "text",
								text: `Run #${active.id} ${active.agent} is still active (${active.activity ?? statusLabel(active.status)}). Use subagent_wait to block for its result, or subagent_stop to cancel it.`,
							},
						],
						details: {},
					};
				}
				return { content: [{ type: "text", text: `No subagent run matches "${requested}".` }], details: {} };
			}

			const now = Date.now();
			const activeRuns = monitor.getRuns().filter(
				(run) => run.status === "queued" || run.status === "running" || run.retained,
			);
			const activeLines = activeRuns.map((run) => {
				const parts = [
					`#${run.id} ${run.agent}`,
					run.model ?? "?",
					formatUsageCompact(run.usage),
					formatElapsed(run, now),
				].filter(Boolean);
				return `- ${parts.join(" · ")} · ${run.activity ?? statusLabel(run.status)}`;
			});
			const completed = [...runtime.settledRuns.entries()].slice(-5);
			const completedLines = completed.map(([id, result]) => {
				const usage = formatUsage(result.usage);
				return `- #${id} ${result.agent} · ${isFailedResult(result) ? "failed" : "completed"}${usage ? ` · ${usage}` : ""}`;
			});

			const sections: string[] = [];
			sections.push(`### Active subagent runs (${activeRuns.length})`);
			sections.push(activeLines.length > 0 ? activeLines.join("\n") : "(none)");
			sections.push(`### Finished this session (${runtime.settledRuns.size})`);
			sections.push(completedLines.length > 0 ? completedLines.join("\n") : "(none)");
			sections.push("Pass a run id to subagent_status for the full result, or subagent_wait to block for an active run.");
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
				description: "Run id or prefix to stop (see the widget or subagent_status).",
			}),
		),
		all: Type.Optional(Type.Boolean({ description: "Stop every active run (default false)." })),
	});

	pi.registerTool({
		name: "subagent_stop",
		label: "Subagent Stop",
		description: [
			"Cancel one or more active background sub-agent runs: the child process is terminated and an aborted result (with partial output) is delivered.",
			"Pass id (run id or prefix) to stop one run, or all: true to stop every active run.",
		].join(" "),
		promptSnippet: "Stop a running background subagent (id from the widget/subagent_status; or all: true).",
		promptGuidelines: [
			"Stop a run when its task is obsolete, stuck, or superseded — do not leave it burning tokens.",
			"A stopped run reports as failed with 'aborted' and its partial output, so the next step knows it did not complete.",
		],
		parameters: SubagentStopParams,

		async execute(_toolCallId, params, _signal, _onUpdate) {
			const targets =
				params.all === true
					? [...runtime.runControllers.keys()]
					: params.id !== undefined && params.id.trim() !== ""
						? matchRunIds([...runtime.runControllers.keys()], params.id!.trim())
						: [];

			if (targets.length === 0) {
				const activeList = [...runtime.runControllers.keys()].map((id) => `#${id}`).join(", ");
				return {
					content: [
						{
							type: "text",
							text:
								params.all === true
									? "No active subagent runs to stop."
									: `No active subagent run matches "${params.id}".${activeList ? ` Active runs: ${activeList}.` : ""}`,
						},
					],
					details: {},
				};
			}

			const stopped: string[] = [];
			for (const runId of targets) {
				const run = monitor.findRun(runId);
				if (!run) {
					runtime.runControllers.delete(runId);
					continue;
				}
				// Abort before registering the synthetic result: abort() only marks the
				// queue entry (drain delivers the cancellation callback later), so the
				// has() re-check right after it distinguishes an entry that never ran
				// from one whose task already started under a stale "queued" status —
				// a started task owns its own (real, partial-output) result.
				const controller = runtime.runControllers.get(runId);
				controller?.abort();
				// A queued run never reaches the child-spawn code path, so its abort
				// goes through the queue's cancelled callback with no result object;
				// register a synthetic aborted result so subagent_wait resolves.
				if (run.status === "queued" && runtime.runControllers.has(runId)) {
					runtime.registerRunResult(runId, {
						agent: run.agent,
						agentSource: "builtin",
						task: run.task,
						exitCode: 1,
						messages: [],
						stderr: "Stopped by subagent_stop before the run started.",
						usage: emptyUsage(),
						model: run.model,
						thinking: run.thinking,
						stopReason: "aborted",
						errorMessage: "Stopped by subagent_stop before the run started.",
					});
				}
				stopped.push(`#${runId} ${run.agent}${run.status === "queued" ? " (queued)" : ""}`);
			}
			return {
				content: [
					{
						type: "text",
						text: `Stopped ${stopped.length} run${stopped.length === 1 ? "" : "s"}: ${stopped.join(", ")}. An aborted result (with partial output) is delivered.`,
					},
				],
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
