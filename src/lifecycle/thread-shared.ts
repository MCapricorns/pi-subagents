/** Shared contracts and coordination primitives for logical sub-agent threads. */

import { utimesSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentConfig } from "../delegation/agents.ts";
import { BUILTIN_AGENT_NAMES, type AgentName, type SubagentsConfig, type ThinkingLevel } from "../configuration/config.ts";
import { removeThreadRecord, threadRecordFromThread, upsertThreadRecord } from "./durable.ts";
import {
	availableModelsInScope,
	currentModelRef,
	findModelByRef,
	modelRef,
	resolveAgentModelRoute,
	resolveThinkingLevel,
} from "../configuration/models.ts";
import type { SubagentRuntime, SubagentThread } from "./runtime.ts";
import { MAX_CONCURRENT_SUBAGENTS } from "../execution/background.ts";
import { getProjectRoot, type SingleResult } from "../execution/spawn.ts";
import type { IsolationMode, WorktreeIsolation } from "../isolation/worktree.ts";

/** True while a logical thread holds one of the live concurrency slots.
 * Settling runs (child finished, only Git integration remains), stopped runs,
 * and restored parked records hold no live child process. */
function isConcurrencyActiveThread(
	thread: Pick<SubagentThread, "state" | "retired" | "lifecycleOperation">,
): boolean {
	if (thread.retired || thread.lifecycleOperation === "settle" || thread.lifecycleOperation === "stop") return false;
	return thread.state === "queued" || thread.state === "running" || thread.state === "interrupting";
}

export function dispatchCapacity(threads: Iterable<Pick<SubagentThread, "id" | "state" | "retired" | "lifecycleOperation">>) {
	const activeIds = new Set<number>();
	for (const thread of threads) {
		if (isConcurrencyActiveThread(thread)) activeIds.add(thread.id);
	}
	return { activeIds, available: Math.max(0, MAX_CONCURRENT_SUBAGENTS - activeIds.size) };
}

export function concurrencyAdmissionConflict(
	runtime: Pick<SubagentRuntime, "threads">,
	requestedCount: number,
): string | undefined {
	if (requestedCount > MAX_CONCURRENT_SUBAGENTS) {
		return `requested ${requestedCount} tasks, exceeding the maximum concurrency of ${MAX_CONCURRENT_SUBAGENTS}. Batch at most ${MAX_CONCURRENT_SUBAGENTS} independent, disjoint tasks at once; continue disjoint work in main and dispatch remaining phases after active runs finish.`;
	}
	const { activeIds, available } = dispatchCapacity(runtime.threads.values());
	if (requestedCount <= available) return undefined;
	const owners = [...activeIds].map((id) => `#${id}`).join(", ");
	if (available === 0) {
		return `concurrency limit of ${MAX_CONCURRENT_SUBAGENTS} active subagents is full (${owners} active). Do not duplicate their work; continue disjoint work in main until an active run finishes.`;
	}
	return `${activeIds.size}/${MAX_CONCURRENT_SUBAGENTS} subagents are already active (${owners}), leaving ${available} free slot${available === 1 ? "" : "s"} for ${requestedCount} requested tasks. Dispatch at most ${available} independent task${available === 1 ? "" : "s"} now, or continue disjoint work in main until active runs finish.`;
}

/** Control operations must never wait forever on a settling generation: the
 * queue task can legitimately spend minutes in worktree finalization (bounded
 * per-Git-command timeouts) or wait behind the managed repository lane. After
 * this deadline the control path owns the lifecycle synchronously and proceeds
 * while the stuck tail settles silently in the background. */
export const CONTROL_QUIESCE_TIMEOUT_MS = 20_000;

/** Resolve true when the promise settles, or false after the bounded deadline. */
export function quiesced(promise: Promise<unknown>, timeoutMs: number = CONTROL_QUIESCE_TIMEOUT_MS): Promise<boolean> {
	return Promise.race([
		promise.then(() => true, () => true),
		new Promise<boolean>((resolve) => {
			const timer = setTimeout(() => resolve(false), timeoutMs);
			timer.unref();
		}),
	]);
}

/** Best-effort recovery checkpoint. Interrupted work retains its artifacts;
 * settled work drops the thread record. A failed write never stops the live run. */
export function persistThreadCheckpoint(
	runtime: SubagentRuntime,
	thread: SubagentThread,
	state: "parked" | "completed" | "failed",
): void {
	if (state !== "parked" && thread.sessionDir) {
		// Transcript appends do not touch the directory. Start the follow-up
		// retention window at settlement, including slow isolation finalization.
		try {
			const now = new Date();
			utimesSync(thread.sessionDir, now, now);
		} catch {
			/* A missing or locked session must not prevent settlement. */
		}
	}
	const record = threadRecordFromThread(thread, state);
	const write = state === "parked"
		? upsertThreadRecord(runtime.configPath, record)
		: removeThreadRecord(runtime.configPath, record.durableId, thread.cwd);
	void write.catch(() => undefined);
}

/** Briefs name paths in the caller's checkout. Naming both roots lets an
 * isolated child map them into its worktree instead of editing the original. */
export function withWorktreeSystemPrompt(
	agent: AgentConfig,
	worktree: Pick<WorktreeIsolation, "originalRoot" | "worktreePath">,
): AgentConfig {
	const instructions = `You are running in a temporary detached Git worktree at ${worktree.worktreePath}, a snapshot of the original checkout ${worktree.originalRoot}. Work only inside this worktree: map every brief path under the original checkout to the same relative path here. Do not write to the original checkout, create another worktree, or copy/apply changes back manually. The runtime merges your tracked, deleted, and untracked changes after you finish.`;
	return { ...agent, systemPrompt: `${agent.systemPrompt.trimEnd()}\n\n${instructions}` };
}

export interface DispatchEnvironment {
	ctx: ExtensionContext;
	config: SubagentsConfig;
	agents: AgentConfig[];
}

/** Admission metadata for a fresh one-shot run. */
export interface StartBackgroundOptions {
	/** A private copy of a settled session used for a follow-up run. */
	resumeSession?: { sessionId: string; sessionDir: string };
	/** Historical evidence and the new instruction for a summary continuation.
	 * The logical task stays the same whichever history the parent chooses. */
	stdinText?: string;
	/** Omitted public isolation may fall back only when no Git baseline exists. */
	automaticIsolation?: boolean;
	/** Chosen by the tool call before the queue can start a fast child. */
	deliveryRoute?: "background" | "await";
}

export type StartBackgroundInternal = (
	agentName: string,
	task: string,
	cwd: string | undefined,
	isolation?: IsolationMode,
	options?: StartBackgroundOptions,
) => Promise<SingleResult>;

export interface ThreadLifecycleDeps {
	runtime: SubagentRuntime;
	runCtx?: ExtensionContext;
}

interface DispatchModelRoute {
	agent: AgentConfig;
	error?: string;
	thinkingLevel: ThinkingLevel;
}

export function resolveDispatchModelRoute(
	agent: AgentConfig,
	config: SubagentsConfig,
	ctx: ExtensionContext,
): DispatchModelRoute {
	if (!(BUILTIN_AGENT_NAMES as readonly string[]).includes(agent.name)) throw new Error(`Unknown subagent role: ${agent.name}`);
	const settings = config[agent.name as AgentName];
	const availableModels = availableModelsInScope(ctx);
	const mainRef = currentModelRef(ctx);
	const route = resolveAgentModelRoute({
		selectedRef: settings.model,
		mainRef,
		availableRefs: availableModels.map(modelRef),
	});
	const model = route.primaryRef === mainRef && ctx.model
		? ctx.model : findModelByRef(availableModels, route.primaryRef);
	return {
		agent: { ...agent, model: route.primaryRef },
		thinkingLevel: resolveThinkingLevel(model, settings.thinking),
		...(route.unavailableSelectedRef ? { error: `${agent.name} model ${route.unavailableSelectedRef} is unavailable in this session. Dispatch paused; restore availability or choose another model with /subagents-setup. No main-model worker was started.` } : {}),
	};
}

/** Project-scoped <projectRoot>/results for a completion's artifacts. */
export function projectResultsRoot(configPath: string, cwd: string | undefined): string {
	return join(getProjectRoot(configPath, cwd), "results");
}
