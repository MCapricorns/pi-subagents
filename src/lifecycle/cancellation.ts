/** Cancel work owned by a cancelled parent turn or an abandoned conversation branch.
 *
 * A run whose child already finished and is only integrating its worktree has
 * nothing left to cancel. On a parent cancellation it settles normally and its
 * real result, like any completion already held for delivery, reaches the next
 * user turn without waking the parent. Branch navigation abandons the
 * conversation, so it stops everything and discards results. */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { formatDuration, formatTaskSummary } from "../presentation/monitor.ts";
import { formatUsage } from "../presentation/format.ts";
import { CANCELLATION_STATS_ENTRY, type SubagentRuntime, type SubagentThread } from "./runtime.ts";
import { stopThreads } from "./stop.ts";

const cancellations = new WeakMap<SubagentRuntime, Promise<void>>();

interface CancellationOptions {
	context?: Pick<ExtensionContext, "mode" | "ui">;
	notifyParent?: boolean;
}

function showTuiNotice(context: CancellationOptions["context"], text: string): void {
	if (context?.mode !== "tui") return;
	try {
		context.ui.notify(text, "info");
	} catch {
		/* The terminal may have closed during cancellation. */
	}
}

function formatStoppedRun(runtime: SubagentRuntime, thread: SubagentThread): string {
	const result = runtime.settledRuns.get(thread.id);
	return [
		`#${thread.id} ${thread.agentName}`,
		formatDuration(thread.elapsedMs),
		result?.model ? formatTaskSummary(result.model, 60, false) : undefined,
		result && formatUsage(result.usage),
		result?.integrationStatus && `worktree ${result.integrationStatus.replaceAll("_", " ")}`,
	].filter(Boolean).join(" · ");
}

/** The child has settled and only Git integration and delivery remain. */
export function isSettlingThread(thread: SubagentThread): boolean {
	return !thread.retired && thread.lifecycleOperation === "settle";
}

export function cancelActiveWork(
	runtime: SubagentRuntime,
	reason: string,
	{ context, notifyParent = true }: CancellationOptions = {},
): Promise<void> {
	const existing = cancellations.get(runtime);
	if (existing) return existing;
	runtime.suppressCompletions = true;
	const deferredCount = notifyParent ? runtime.deferPendingCompletions() : 0;
	runtime.discardCompletions();
	const threads = [...runtime.threads.values()];
	// Only a parent cancellation keeps finished work; an abandoned branch stops it.
	const settlingThreads = notifyParent ? threads.filter(isSettlingThread) : [];
	for (const thread of settlingThreads) runtime.deferRunDelivery(thread.id);
	const activeThreads = threads
		.filter((thread) => !thread.retired && !(notifyParent && isSettlingThread(thread))
			&& (thread.lifecycleOperation !== undefined || ["queued", "running", "interrupting"].includes(thread.state)));
	const threadIds = activeThreads.map((thread) => thread.id);
	const runCount = `${threadIds.length} subagent run${threadIds.length === 1 ? "" : "s"}`;
	const done = stopThreads(runtime, threadIds, reason).then(() => {
		if (notifyParent && runtime.sessionActive && threadIds.length > 0) {
			const stats = context?.mode === "tui"
				? [`Stopped ${runCount}`, ...activeThreads.map((thread) => formatStoppedRun(runtime, thread))]
				: undefined;
			runtime.recordCancellation(threadIds, stats);
		}
	}).finally(() => {
		runtime.discardCompletions();
		runtime.suppressCompletions = false;
		cancellations.delete(runtime);
	});
	cancellations.set(runtime, done);
	if (notifyParent && runtime.sessionActive) {
		const notices: string[] = [];
		if (threadIds.length) notices.push(`Stopping ${runCount} · ${threadIds.map((id) => `#${id}`).join(", ")}`);
		for (const thread of settlingThreads) {
			const progress = thread.isolation === "worktree" ? "applying worktree changes" : "finalizing its result";
			notices.push(`#${thread.id} ${thread.agentName} finished and is ${progress}.`);
		}
		if (deferredCount) notices.push(`${deferredCount} completed subagent result${deferredCount === 1 ? "" : "s"} ready for your next message.`);
		if (notices.length) showTuiNotice(context, notices.join("\n"));
	}
	return done;
}

export function registerCancellationHooks(pi: ExtensionAPI, runtime: SubagentRuntime): void {
	pi.registerEntryRenderer<string[]>(CANCELLATION_STATS_ENTRY, (entry, _options, theme) => {
		if (!Array.isArray(entry.data) || !entry.data.length) return undefined;
		const [title, ...runs] = entry.data;
		return new Text([theme.bold(title!), ...runs].join("\n"), 0, 0);
	});
	pi.on("agent_settled", (event, context) => event.aborted ? cancelActiveWork(runtime, "Parent run was cancelled.", { context }) : undefined);
	pi.on("session_before_tree", () => cancelActiveWork(runtime, "Parent navigated to another conversation branch.", { notifyParent: false }));
	// Pi emits session_shutdown for new/resume/fork/reload. The runtime's
	// shutdown path stops children, retains recovery evidence, and disables delivery.
}
