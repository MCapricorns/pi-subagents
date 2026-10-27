/** Cancel work owned by a cancelled parent turn or an abandoned conversation branch. */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { stopWorkflow } from "../workflow/engine.ts";
import type { SubagentRuntime } from "./runtime.ts";
import { stopThreads } from "./stop.ts";

const cancellations = new WeakMap<SubagentRuntime, Promise<void>>();

export function cancelActiveWork(runtime: SubagentRuntime, reason: string): Promise<void> {
	const existing = cancellations.get(runtime);
	if (existing) return existing;
	runtime.suppressCompletions = true;
	runtime.discardCompletions();
	// Start every interruption before awaiting cleanup: a worktree's integration
	// may need a repository lane held by a different shared writer.
	const graphs = [...runtime.workflows.values()].filter((graph) => graph.state === "running");
	const graphStops = graphs.map(async (graph) => { await stopWorkflow(runtime, graph, reason); await graph.done; });
	const threadIds = [...runtime.threads.values()]
		.filter((thread) => !thread.workflow && (thread.lifecycleOperation !== undefined || ["queued", "running", "interrupting"].includes(thread.state)))
		.map((thread) => thread.id);
	const done = Promise.all([...graphStops, stopThreads(runtime, threadIds, reason)]).then(() => undefined).finally(() => {
		runtime.discardCompletions();
		runtime.suppressCompletions = false;
		cancellations.delete(runtime);
	});
	cancellations.set(runtime, done);
	return done;
}

export function registerCancellationHooks(pi: ExtensionAPI, runtime: SubagentRuntime): void {
	pi.on("agent_settled", (event) => event.aborted ? cancelActiveWork(runtime, "Parent run was cancelled.") : undefined);
	pi.on("session_before_tree", () => cancelActiveWork(runtime, "Parent navigated to another conversation branch."));
	// Pi emits session_shutdown for new/resume/fork/reload. The runtime's
	// shutdown path stops children, retains recovery evidence, and disables delivery.
}
