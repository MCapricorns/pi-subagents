/** Cancel work owned by a cancelled parent turn or an abandoned conversation branch.
 *
 * A run whose child already finished and is only integrating its worktree has
 * nothing left to cancel. On a parent cancellation it settles normally and its
 * real result, like any completion already held for delivery, reaches the next
 * user turn without waking the parent. Branch navigation abandons the
 * conversation, so it stops everything and discards results. */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { SubagentRuntime, SubagentThread } from "./runtime.ts";
import { stopThreads } from "./stop.ts";

const cancellations = new WeakMap<SubagentRuntime, Promise<void>>();

/** The child has settled and only Git integration and delivery remain. */
export function isSettlingThread(thread: SubagentThread): boolean {
	return !thread.retired && thread.lifecycleOperation === "settle";
}

export function cancelActiveWork(runtime: SubagentRuntime, reason: string, notifyParent = true): Promise<void> {
	const existing = cancellations.get(runtime);
	if (existing) return existing;
	runtime.suppressCompletions = true;
	if (notifyParent) runtime.deferPendingCompletions();
	runtime.discardCompletions();
	const threads = [...runtime.threads.values()];
	// Only a parent cancellation keeps finished work; an abandoned branch stops it.
	const keepSettling = notifyParent;
	if (keepSettling) for (const thread of threads.filter(isSettlingThread)) runtime.deferRunDelivery(thread.id);
	const activeThreads = threads
		.filter((thread) => !thread.retired && !(keepSettling && isSettlingThread(thread))
			&& (thread.lifecycleOperation !== undefined || ["queued", "running", "interrupting"].includes(thread.state)));
	const threadIds = activeThreads.map((thread) => thread.id);
	const done = stopThreads(runtime, threadIds, reason).then(() => {
		if (notifyParent && runtime.sessionActive && threadIds.length > 0) {
			runtime.recordCancellation(threadIds);
		}
	}).finally(() => {
		runtime.discardCompletions();
		runtime.suppressCompletions = false;
		cancellations.delete(runtime);
	});
	cancellations.set(runtime, done);
	return done;
}

export function registerCancellationHooks(pi: ExtensionAPI, runtime: SubagentRuntime): void {
	pi.on("agent_settled", (event) => event.aborted ? cancelActiveWork(runtime, "Parent run was cancelled.") : undefined);
	pi.on("session_before_tree", () => cancelActiveWork(runtime, "Parent navigated to another conversation branch.", false));
	// Pi emits session_shutdown for new/resume/fork/reload. The runtime's
	// shutdown path stops children, retains recovery evidence, and disables delivery.
}
