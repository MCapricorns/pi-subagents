/** Cancel work owned by a cancelled parent turn or an abandoned conversation branch. */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { SubagentRuntime } from "./runtime.ts";
import { stopThreads } from "./stop.ts";

const cancellations = new WeakMap<SubagentRuntime, Promise<void>>();

export function cancelActiveWork(runtime: SubagentRuntime, reason: string, notifyParent = true): Promise<void> {
	const existing = cancellations.get(runtime);
	if (existing) return existing;
	runtime.suppressCompletions = true;
	runtime.discardCompletions();
	const activeThreads = [...runtime.threads.values()]
		.filter((thread) => !thread.retired && (thread.lifecycleOperation !== undefined || ["queued", "running", "interrupting"].includes(thread.state)));
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
