/**
 * Shared background-dispatch machinery used by both delegation tools.
 *
 * The `subagent` tool and the workflow runner start children through the same
 * dispatcher, live-activity projection, terminal-notification path, and tool-card
 * details builder. Keeping them here means a workflow node is an ordinary
 * managed run: same queue pacing, isolation, admission, durable checkpointing,
 * and completion accounting.
 */

import { createBackgroundDispatcher } from "./thread-lifecycle.ts";
import { getResultError, type SingleResult, type SubagentDetails, type SubagentLiveEvent } from "../execution/spawn.ts";
import { formatTaskSummary, formatToolActivity, monitor } from "../presentation/monitor.ts";
import type { StartBackgroundInternal, DispatchEnvironment } from "./thread-shared.ts";
import { persistThreadCheckpoint } from "./thread-shared.ts";
import type { SubagentRuntime } from "./runtime.ts";

export interface DispatchCore {
	/** Publish the context/config/catalog a dispatch needs; every fresh call refreshes it. */
	setEnvironment(environment: DispatchEnvironment): void;
	startBackground: StartBackgroundInternal;
	/** Stamp a terminal monitor state and toast the result once. */
	finishRun: (runId: number, status: "done" | "failed", opts?: { silent?: boolean }) => void;
	makeLiveHandler: (runId: number, generation?: number) => (event: SubagentLiveEvent) => void;
	makeDetails: (mode: "single" | "parallel", background?: boolean) => (results: SingleResult[]) => SubagentDetails;
}

export function createDispatchCore(runtime: SubagentRuntime): DispatchCore {
	const environmentRef: { current: DispatchEnvironment | undefined } = { current: undefined };

	// Terminal rows stay in the monitor until the next beginTurn so the footer
	// can count them beside siblings that are still live. The widget ignores
	// them. Repeated publication of the same settlement is a no-op.
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
		const result = runtime.threads.get(runId)?.lastResult;
		const error = status === "failed" ? result ? getResultError(result) : "No failure reason was recorded." : undefined;
		environmentRef.current?.ctx.ui.notify(
			`${icon} #${run.id} ${monitor.summarize(run)}${error ? ` · ${formatTaskSummary(error, 300, false)}` : ""}`,
			status === "done" ? "info" : "error",
		);
	};

	// Live sub-agent activity → concise one-line status ("thinking",
	// "read src/index.ts", ...), never a raw args blob. The live handler
	// only updates monitor state; the queue task owns terminal removal,
	// notification, and lifecycle decisions.
	const makeLiveHandler = (runId: number, generation?: number) => {
		// Every child turn reports "running"; the manifest is rewritten only when
		// what it records for recovery (session path, child pids) actually changed.
		let checkpointKey: string | undefined;
		return (e: SubagentLiveEvent): void => {
			if (generation !== undefined && runtime.threads.get(runId)?.generation !== generation) return;
			switch (e.kind) {
				case "status":
					monitor.setStatus(runId, e.status);
					// A fresh running segment refreshes the durable checkpoint (session
					// path plus child pids) so a crash mid-generation still restores.
					if (e.status === "running") {
						const thread = runtime.threads.get(runId);
						if (thread?.sessionId && thread.sessionDir) {
							const key = `${thread.sessionDir}\0${thread.control.getChildPids().join(",")}`;
							if (key !== checkpointKey) {
								checkpointKey = key;
								persistThreadCheckpoint(runtime, thread, "parked");
							}
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
	};

	const makeDetails =
		(mode: "single" | "parallel", background = false) =>
		(results: SingleResult[]): SubagentDetails => ({ mode, results, background });

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

	return {
		setEnvironment: (environment) => {
			environmentRef.current = environment;
		},
		startBackground,
		finishRun,
		makeLiveHandler,
		makeDetails,
	};
}
