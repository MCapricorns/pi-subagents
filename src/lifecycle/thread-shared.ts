/** Shared contracts and coordination primitives for logical sub-agent threads. */

import { realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isWriteCapableAgent, type AgentConfig } from "../delegation/agents.ts";
import type { PhaseScope } from "../delegation/phase-scope.ts";
import { roleThinkingLevel, type SubagentsConfig, type ThinkingLevel } from "../configuration/config.ts";
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
import { getProjectRoot, type SingleResult } from "../execution/spawn.ts";
import { resolveRepositoryRoot, type IsolationMode } from "../isolation/worktree.ts";

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
			if (typeof timer.unref === "function") timer.unref();
		}),
	]);
}

const managedRepositoryRootTails = new Map<string, Promise<void>>();

async function canonicalManagedRepositoryRoot(cwd: string): Promise<string> {
	try {
		// Repository identity does not depend on HEAD: empty repositories must
		// serialize root and nested cwd requests under the same lane too.
		return await resolveRepositoryRoot(cwd);
	} catch {
		try {
			return await realpath(resolve(cwd));
		} catch {
			return resolve(cwd);
		}
	}
}

/** Run one operation under the canonical original-repository lane.
 *
 * Shared write-capable generations use the abortable overload for their whole
 * run. Isolated generations use the non-abortable overload only for their
 * final worktree apply, so model work remains parallel while the original
 * checkout mutation cannot race a shared writer.
 */
export async function runInManagedRepositoryLane<T>(
	cwd: string,
	task: () => Promise<T>,
): Promise<T>;
export async function runInManagedRepositoryLane<T>(
	cwd: string,
	task: () => Promise<T>,
	signal: AbortSignal,
): Promise<T | undefined>;
export async function runInManagedRepositoryLane<T>(
	cwd: string,
	task: () => Promise<T>,
	signal?: AbortSignal,
): Promise<T | undefined> {
	if (signal?.aborted) return undefined;
	const root = await canonicalManagedRepositoryRoot(cwd);
	const key = process.platform === "win32" ? root.toLowerCase() : root;
	const previous = managedRepositoryRootTails.get(key) ?? Promise.resolve();
	let release!: () => void;
	const gate = new Promise<void>((resolveGate) => {
		release = resolveGate;
	});
	const tail = previous.catch(() => undefined).then(() => gate);
	managedRepositoryRootTails.set(key, tail);
	let onAbort: (() => void) | undefined;
	try {
		if (signal) {
			await Promise.race([
				previous.catch(() => undefined),
				new Promise<void>((resolveAborted) => {
					if (signal.aborted) resolveAborted();
					else {
						onAbort = resolveAborted;
						signal.addEventListener("abort", onAbort, { once: true });
					}
				}),
			]);
		} else {
			await previous.catch(() => undefined);
		}
		if (signal?.aborted) return undefined;
		return await task();
	} finally {
		if (signal && onAbort) signal.removeEventListener("abort", onAbort);
		release();
		// An aborted waiter may finish before the prior owner. Keep its chained
		// tail installed until that owner also settles, otherwise a newcomer could
		// observe an empty map and race the still-running workflow.
		void tail.then(() => {
			if (managedRepositoryRootTails.get(key) === tail) managedRepositoryRootTails.delete(key);
		});
	}
}

/** Best-effort recovery checkpoint. Interrupted work retains its artifacts;
 * settled work drops the thread record. A failed write never stops the live run. */
export function persistThreadCheckpoint(
	runtime: SubagentRuntime,
	thread: SubagentThread,
	state: "parked" | "completed" | "failed",
): void {
	const write = state === "parked"
		? upsertThreadRecord(runtime.configPath, threadRecordFromThread(thread, state))
		: removeThreadRecord(runtime.configPath, thread.id, thread.cwd);
	void write.catch(() => undefined);
}

const WORKTREE_ISOLATION_INSTRUCTIONS =
	"You are running in a temporary detached Git worktree. Work only in the current cwd; do not create another worktree or manually copy/apply changes to the original checkout. The parent dispatcher will integrate your tracked, deleted, and untracked changes when this thread finally settles.";

export function withWorktreeSystemPrompt(agent: AgentConfig): AgentConfig {
	return {
		...agent,
		systemPrompt: `${agent.systemPrompt.trimEnd()}\n\n${WORKTREE_ISOLATION_INSTRUCTIONS}`.trim(),
	};
}

/** Only write-capable agents can run in an isolated worktree. Sentinel reviews
 * the caller's uncommitted diff, which a detached worktree cannot contain. */
export function isWorktreeCapableAgent(agent: AgentConfig): boolean {
	return agent.name !== "sentinel" && isWriteCapableAgent(agent);
}

export interface DispatchEnvironment {
	ctx: ExtensionContext;
	config: SubagentsConfig;
	agents: AgentConfig[];
}

/** Admission metadata for a fresh one-shot run. */
export interface StartBackgroundOptions {
	phaseId?: string;
	scope?: PhaseScope;
	/** A false hint cannot downgrade a live write-capable role. */
	writeCapable?: boolean;
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
	mainFallbackRef?: string;
	thinkingLevel: ThinkingLevel;
	thinkingLevelForModel: (ref?: string) => ThinkingLevel;
}

export function resolveDispatchModelRoute(
	agent: AgentConfig,
	config: SubagentsConfig,
	ctx: ExtensionContext,
): DispatchModelRoute {
	const availableModels = availableModelsInScope(ctx);
	const mainRef = currentModelRef(ctx);
	const route = resolveAgentModelRoute({
		selectedRef: config.agentModels[agent.name],
		mainRef,
		availableRefs: availableModels.map(modelRef),
	});
	// A `/subagents-setup` override wins; otherwise the role default. No
	// per-call or frontmatter thinking.
	const preferred =
		config.agentThinkingLevels[agent.name] ?? roleThinkingLevel(agent.name);
	const thinkingLevelForModel = (ref?: string): ThinkingLevel => {
		const model = ref === mainRef && ctx.model
			? ctx.model
			: findModelByRef(availableModels, ref);
		return resolveThinkingLevel(model, preferred);
	};
	return {
		agent: { ...agent, model: route.primaryRef },
		mainFallbackRef: route.mainFallbackRef,
		thinkingLevel: thinkingLevelForModel(route.primaryRef),
		thinkingLevelForModel,
	};
}

/** Project-scoped <projectRoot>/results for a completion's artifacts. */
export function projectResultsRoot(configPath: string, cwd: string | undefined): string {
	return join(getProjectRoot(configPath, cwd), "results");
}
