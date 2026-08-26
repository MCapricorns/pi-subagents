/**
 * The `subagent` tool: dispatches explorer/worker/cleaner/documenter/reviewer agents as isolated pi
 * child processes, single or parallel. Owns the public dispatch contract,
 * per-run status tracking, managed worker/cleaner → reviewer workflows with a
 * conditional documenter, bounded worker/reviewer fix rounds, and internal
 * step launching. Stable
 * thread generations, final integration, and completion ownership live in
 * thread-lifecycle.ts.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { Type } from "typebox";
import { discoverAgents, resolveAgentTools, type AgentConfig } from "./agents.ts";
import { loadConfig } from "./config.ts";
import { formatUsage, queuedResult } from "./format.ts";
import {
	buildFinalDocumenterBrief,
	buildFinalReviewBrief,
	buildFixTaskBrief,
	buildReReviewBrief,
	documentationDisposition,
	type ChainStep,
	type ManagedWorkflowOutcome,
} from "./fixloop.ts";
import {
	formatTaskSummary,
	formatToolActivity,
	monitor,
	statusIcon,
	type RunChainMeta,
	type WorkflowStage,
	type WorkflowStageStatus,
} from "./monitor.ts";
import type { SubagentRuntime } from "./runtime.ts";
import {
	getResultOutput,
	isFailedResult,
	reviewVerdict,
	runSingleAgentWithMainFallback,
	type SingleResult,
	type SubagentDetails,
	type SubagentLiveEvent,
} from "./spawn.ts";
import {
	createBackgroundDispatcher,
	resolveDispatchModelRoute,
	withWorktreeSystemPrompt,
	type ManagedWorkflowRequest,
} from "./thread-lifecycle.ts";
import { resolveRepositoryRoot, type IsolationMode } from "./worktree.ts";

export { FORK_CONTINUATION_PROMPT, isWorktreeCapableAgent } from "./thread-lifecycle.ts";

const NON_BLANK_TASK_OPTIONS = { minLength: 1, pattern: "\\S" } as const;

const ISOLATION_DESCRIPTION =
	"Filesystem isolation: shared uses the caller's working tree; worktree creates a detached temporary Git worktree (write-capable agents, including worker, cleaner, and documenter, only)";

const IsolationSchema = Type.Optional(
	StringEnum(["shared", "worktree"] as const, { description: ISOLATION_DESCRIPTION }),
);

const TaskItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({
		...NON_BLANK_TASK_OPTIONS,
		description: "Self-contained task to delegate (the agent has no memory of this conversation)",
	}),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
	isolation: IsolationSchema,
});

const SubagentParams = Type.Object({
	agent: Type.Optional(Type.String({ description: "Name of the agent to invoke (single mode)" })),
	task: Type.Optional(
		Type.String({ ...NON_BLANK_TASK_OPTIONS, description: "Self-contained task to delegate (single mode)" }),
	),
	tasks: Type.Optional(Type.Array(TaskItem, { description: "Array of {agent, task} for parallel execution" })),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process (single mode)" })),
	isolation: IsolationSchema,
});

export function defaultIsolationMode(mode: "single" | "parallel", agentName: string, requested?: IsolationMode): IsolationMode {
	if (requested) return requested;
	return mode === "parallel" && agentName === "worker" ? "worktree" : "shared";
}

function workflowStageStatus(result: SingleResult): WorkflowStageStatus {
	if (isFailedResult(result)) return "failed";
	if (result.agent !== "reviewer") return "done";
	const verdict = reviewVerdict(getResultOutput(result));
	if (verdict === "fail") return "changes";
	return verdict === "pass" ? "done" : "failed";
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
 * Shared managed generations use the abortable overload for their complete
 * writer/reviewer workflow. Isolated generations use the non-abortable overload
 * only for their final worktree apply, so model work remains parallel while the
 * original checkout mutation cannot race a shared writer or reviewer snapshot.
 */
async function runInManagedRepositoryLane<T>(
	cwd: string,
	task: () => Promise<T>,
): Promise<T>;
async function runInManagedRepositoryLane<T>(
	cwd: string,
	task: () => Promise<T>,
	signal: AbortSignal,
): Promise<T | undefined>;
async function runInManagedRepositoryLane<T>(
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

export function registerSubagentTool(pi: ExtensionAPI, runtime: SubagentRuntime): void {
	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: [
			"Dispatch enabled specialized agents as isolated leaf Pi child processes, singly or in parallel; keep small known-target work in the main thread with direct tools.",
			"Built-ins: explorer for broad read-only reconnaissance (a retrieval index, never a gate); worker for implementation; cleaner as a separate explicitly authorized cleanup/removal/simplification/deduplication entry; documenter for explicit docs/comments work or conditional final diff sync; reviewer for generic read-only assessments and independent code gates.",
			"Work starts in the background. Successful worker/cleaner runs keep one enabled reviewer gate and bounded fix loop; documenter runs afterward only when REVIEW_PASS reports DOCUMENTATION: NEEDED or omits the marker, with a reviewer-disabled fallback. A top-level documenter delivers directly. Results resume the main agent and are already shown, so do not poll, duplicate downstream roles, or restate them.",
			"Single tasks default to shared; parallel workers default to detached Git worktrees. Only write-capable agents can use worktree isolation, and failures never fall back silently to shared.",
			"A selected-model or provider failure continues the retained session on the current main model; ordinary tool/task failures do not.",
			"Use subagent_control to steer/retarget an active top-level child, park/stop a managed downstream stage, or resume/fork retained context by stable run id.",
		].join(" "),
		promptSnippet:
			"Dispatch isolated background agents for broad recon, self-contained implementation, authorized cleanup, explicit docs, or independent review; keep small known-target work on direct tools. Worker/cleaner gates and only needed/conservative docs sync run automatically, results resume automatically, and each workflow delivers once.",
		parameters: SubagentParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			monitor.beginTurn();
			const config = await loadConfig(runtime.configPath);
			// Pick up concurrency changes from /subagents-setup without a restart.
			runtime.backgroundQueue.setConcurrency(config.maxConcurrency);

			// Finished runs leave the active monitor immediately. Their final findings
			// are sent as a custom message that starts a follow-up turn.
			const finishRun = (
				runId: number,
				status: "done" | "failed",
				opts?: { silent?: boolean },
			): void => {
				monitor.setStatus(runId, status); // stamps endedAt for the elapsed time
				const run = monitor.removeRun(runId);
				if (!run) return; // already finished — stay idempotent
				if (opts?.silent || !runtime.sessionActive) return;
				const icon = status === "done" ? "✓" : "✗";
				ctx.ui.notify(`${icon} #${run.id} ${monitor.summarize(run)}`, status === "done" ? "info" : "error");
			};

			// Live sub-agent activity → concise one-line status ("thinking",
			// "read src/index.ts", ...), never a raw args blob. The live handler
			// only updates monitor state; the queue task / launchInWorkflow owns
			// terminal removal, notification, and downstream workflow decisions.
			const makeLiveHandler =
				(runId: number, generation?: number) =>
				(e: SubagentLiveEvent): void => {
					if (generation !== undefined && runtime.threads.get(runId)?.generation !== generation) return;
					switch (e.kind) {
						case "status":
							monitor.setStatus(runId, e.status);
							break;
						case "model":
							monitor.setModel(runId, e.model, e.fallbackFrom);
							monitor.setThinking(runId, e.thinking);
							break;
						case "usage":
							monitor.setUsage(runId, e.usage, e.model);
							break;
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

			const discovery = discoverAgents(ctx.cwd, {
				scope: config.agentScope,
				enabledNames: config.enabledAgents,
				projectTrusted: ctx.isProjectTrusted?.() === true,
			});
			const agents = discovery.agents;

			const hasTasks = (params.tasks?.length ?? 0) > 0;
			const hasSingle = Boolean(params.agent) && params.task !== undefined;

			const makeDetails =
				(mode: "single" | "parallel", background = false) =>
				(results: SingleResult[]): SubagentDetails => ({ mode, results, background });

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
				const blankTaskIndex = params.tasks?.findIndex(({ task }) => task.trim().length === 0) ?? -1;
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

			/** Launch one workflow-internal child in a fresh model context. It sees the
			 * parent's exact repository/worktree state and is registered by its own id,
			 * but never enters top-level lifecycle policy or completion delivery. */
			const launchInWorkflow = async (
				request: ManagedWorkflowRequest,
				agentName: string,
				task: string,
				meta: RunChainMeta,
			): Promise<{ runId: number; result: SingleResult }> => {
				const discoveredAgent = request.agents.find((candidate) => candidate.name === agentName);
				if (!discoveredAgent) {
					throw new Error(`Managed workflow requires enabled agent "${agentName}", but discovery did not provide it.`);
				}
				const resolveLiveAgentTools = (candidate: AgentConfig): AgentConfig =>
					resolveAgentTools({ ...candidate, tools: discoveredAgent.tools }, runtime.getActiveTools());
				const agent = resolveLiveAgentTools(discoveredAgent);
				// Workflow policy (fix-round caps, agents) stays fixed for the chain,
				// but model/thinking routes are re-read per stage so config edits
				// apply to stages that have not launched yet.
				const stageConfig = await loadConfig(runtime.configPath).catch(() => request.config);
				const resolvedRoute = resolveDispatchModelRoute(agent, stageConfig, request.ctx);
				const route = request.isolation === "worktree"
					? { ...resolvedRoute, agent: withWorktreeSystemPrompt(resolvedRoute.agent) }
					: resolvedRoute;
				const thinkingLevel = route.thinkingLevel;
				const runId = monitor.addRun(agent.name, task, route.agent.model, thinkingLevel, {
					...meta,
					isolation: request.isolation,
					...(request.worktreeId ? { worktreeId: request.worktreeId } : {}),
				});
				const onLive = makeLiveHandler(runId);
				try {
					const result = await runSingleAgentWithMainFallback(
						{
							defaultCwd: request.executionCwd,
							cwd: request.executionCwd,
							agent: route.agent,
							resolveAgentForAttempt: resolveLiveAgentTools,
							agentName,
							task,
							thinkingLevel,
							thinkingLevelForModel: route.thinkingLevelForModel,
							signal: request.signal,
							onLive,
							makeDetails: makeDetails("single", true),
							idleTimeoutMs: stageConfig.idleTimeoutSec * 1000,
						},
						route.mainFallbackRef,
					);
					result.runId = runId;
					result.projectCwd = request.projectCwd;
					result.isolation = request.isolation;
					runtime.retainSession(result);
					monitor.setModel(runId, result.model, result.modelFallbackFrom);
					monitor.setThinking(runId, result.thinking);
					finishRun(runId, isFailedResult(result) ? "failed" : "done", { silent: true });
					runtime.registerRunResult(runId, result);
					return { runId, result };
				} catch (error) {
					finishRun(runId, "failed", { silent: true });
					const errorMessage = error instanceof Error ? error.message : String(error);
					const crashed: SingleResult = {
						...queuedResult(route.agent, task, thinkingLevel),
						runId,
						projectCwd: request.projectCwd,
						isolation: request.isolation,
						exitCode: 1,
						stderr: errorMessage,
						stopReason: request.signal.aborted ? "aborted" : "error",
						errorMessage,
						dispatchFailed: true,
					};
					runtime.registerRunResult(runId, crashed);
					return { runId, result: crashed };
				}
			};

			/** Drop any in-flight internal row. Normal internal settlement already
			 * removes rows; this is a cancellation/crash guard. */
			const removeWorkflowGroup = (groupId: string): void => {
				for (const run of [...monitor.getRuns()]) {
					if (run.groupId === groupId) monitor.removeRun(run.id);
				}
			};

			/** Run every downstream role inline under the parent generation's queue
			 * controller. That gives park/stop/shutdown one lifecycle owner and keeps
			 * isolated worktrees unintegrated until the final reviewer settles. */
			const runManagedWorkflow = async (
				request: ManagedWorkflowRequest,
			): Promise<ManagedWorkflowOutcome> => {
				const initialStepRunId = monitor.reserveRunId();
				const initialStepResult: SingleResult = {
					...request.initialResult,
					runId: initialStepRunId,
				};
				runtime.registerRunResult(initialStepRunId, initialStepResult);
				const steps: ChainStep[] = [{
					runId: initialStepRunId,
					result: initialStepResult,
					relation: request.plan.initialRelation,
				}];
				const enabled = (name: string): boolean =>
					request.agents.some((candidate) => candidate.name === name);
				const canContinue = (): boolean => runtime.sessionActive && !request.signal.aborted;

				// Keep a live parent-owned projection because settled internal rows are
				// intentionally removed. Only real/currently planned stages enter it.
				const initialStageRelation = initialStepResult.agent === "worker"
					? "implement"
					: initialStepResult.agent === "cleaner"
						? "cleanup"
						: "review";
				const workflowStages: WorkflowStage[] = [{
					agent: initialStepResult.agent,
					relation: initialStageRelation,
					status: workflowStageStatus(initialStepResult),
				}];
				let reviewStage: WorkflowStage | undefined;
				if (request.plan.kind === "post-writer" && enabled("reviewer")) {
					reviewStage = { agent: "reviewer", relation: "review", status: "pending" };
					workflowStages.push(reviewStage);
				}
				let documentationStage: WorkflowStage | undefined;
				if (enabled("documenter")) {
					documentationStage = { agent: "documenter", relation: "docs", status: "pending" };
					workflowStages.push(documentationStage);
				}
				const publishWorkflowStages = (): void => {
					monitor.setWorkflowStages(request.parentRunId, workflowStages);
				};
				const insertBeforeDocumentation = (stage: WorkflowStage): void => {
					const documentationIndex = documentationStage
						? workflowStages.indexOf(documentationStage)
						: -1;
					if (documentationIndex === -1) workflowStages.push(stage);
					else workflowStages.splice(documentationIndex, 0, stage);
				};
				const removeDocumentationStage = (): void => {
					if (!documentationStage) return;
					const index = workflowStages.indexOf(documentationStage);
					if (index !== -1) workflowStages.splice(index, 1);
					documentationStage = undefined;
					publishWorkflowStages();
				};
				publishWorkflowStages();

				const launchStep = async (
					agentName: string,
					task: string,
					relation: string,
					projection: {
						stage?: WorkflowStage;
						timelineRelation?: string;
						childRelation?: string;
					} = {},
				): Promise<SingleResult> => {
					if (!enabled(agentName)) {
						throw new Error(`Managed workflow cannot launch disabled or missing agent "${agentName}".`);
					}
					const stage: WorkflowStage = projection.stage ?? {
						agent: agentName,
						relation: projection.timelineRelation ?? relation,
						status: "pending",
					};
					if (!projection.stage) insertBeforeDocumentation(stage);
					stage.status = "active";
					publishWorkflowStages();
					try {
						const step = await launchInWorkflow(request, agentName, task, {
							groupId: request.groupId,
							relationLabel: projection.childRelation ?? relation,
							parentRunId: request.parentRunId,
						});
						stage.status = workflowStageStatus(step.result);
						publishWorkflowStages();
						request.rememberLatest(step.result);
						steps.push({ ...step, relation });
						return step.result;
					} catch (error) {
						stage.status = "failed";
						publishWorkflowStages();
						throw error;
					}
				};

				/** Bounded worker → reviewer fix rounds. A conditional documentation sync
				 * deliberately stays out of the rounds: code fixes would invalidate it,
				 * and the terminal review classifies whether the settled diff needs one. */
				const runFixRounds = async (
					triggeringReviewer: SingleResult,
				): Promise<{ lastReview?: SingleResult; lastWorker?: SingleResult }> => {
					let lastReviewer = triggeringReviewer;
					const outcome: { lastReview?: SingleResult; lastWorker?: SingleResult } = {};
					for (let round = 1; round <= request.config.maxFixRounds; round++) {
						if (!canContinue()) break;
						const fixRelation = `fix ${round}/${request.config.maxFixRounds}`;
						const workerResult = await launchStep(
							"worker",
							buildFixTaskBrief(lastReviewer, round, request.config.maxFixRounds),
							`fix round ${round}`,
							{ timelineRelation: fixRelation, childRelation: fixRelation },
						);
						if (isFailedResult(workerResult) || !canContinue()) break;
						outcome.lastWorker = workerResult;

						const reReviewRelation = `re-review ${round}/${request.config.maxFixRounds}`;
						const reviewResult = await launchStep(
							"reviewer",
							buildReReviewBrief(lastReviewer, round, workerResult, {
								documenterPending: enabled("documenter"),
							}),
							`re-review round ${round}`,
							{ timelineRelation: reReviewRelation, childRelation: reReviewRelation },
						);
						if (isFailedResult(reviewResult) || !canContinue()) break;
						outcome.lastReview = reviewResult;
						const verdict = reviewVerdict(getResultOutput(reviewResult));
						// REVIEW_PASS settles. No verdict is advisory/malformed and must never
						// trigger another writer. Only an explicit REVIEW_FAIL consumes a fix.
						if (verdict !== "fail") break;
						lastReviewer = reviewResult;
					}
					return outcome;
				};

				/** Run the low-cost final documentation sync only when the terminal REVIEW_PASS
				 * reports drift or omits the new marker. A failed process, missing verdict, or
				 * REVIEW_FAIL never writes docs. With no reviewer, retain the conservative
				 * writer → documenter fallback. */
				const runFinalDocumentation = async (
					lastWriterResult: SingleResult | undefined,
					finalReviewResult: SingleResult | undefined,
				): Promise<void> => {
					if (!canContinue() || !enabled("documenter")) return;
					if (lastWriterResult?.agent === "documenter") {
						removeDocumentationStage();
						return;
					}
					if (finalReviewResult) {
						if (isFailedResult(finalReviewResult)) {
							removeDocumentationStage();
							return;
						}
						const reviewOutput = getResultOutput(finalReviewResult);
						if (
							reviewVerdict(reviewOutput) !== "pass" ||
							documentationDisposition(reviewOutput) === "clean"
						) {
							removeDocumentationStage();
							return;
						}
					}
					documentationStage ??= { agent: "documenter", relation: "docs", status: "pending" };
					if (!workflowStages.includes(documentationStage)) workflowStages.push(documentationStage);
					await launchStep(
						"documenter",
						buildFinalDocumenterBrief(lastWriterResult, finalReviewResult),
						"final documentation sync",
						{ stage: documentationStage },
					);
				};

				try {
					// Park/stop/shutdown may win after the top-level child settles but
					// before this continuation starts. Preserve that stable checkpoint and
					// never create an already-aborted downstream child.
					if (!canContinue()) return { kind: request.plan.kind, steps };
					if (request.plan.kind === "auto-fix") {
						const fixOutcome = await runFixRounds(initialStepResult);
						await runFinalDocumentation(fixOutcome.lastWorker, fixOutcome.lastReview ?? initialStepResult);
					} else if (request.plan.kind === "review-pass-sync") {
						// The direct passing review already gated the pending code. Its
						// disposition requested (or conservatively defaulted to) one docs sync.
						await runFinalDocumentation(undefined, initialStepResult);
					} else if (enabled("reviewer")) {
						const gateReview = await launchStep(
							"reviewer",
							buildFinalReviewBrief(initialStepResult, { documenterPending: enabled("documenter") }),
							"final review",
							{ stage: reviewStage },
						);
						let fixOutcome: Awaited<ReturnType<typeof runFixRounds>> = {};
						if (
							!isFailedResult(gateReview) &&
							canContinue() &&
							reviewVerdict(getResultOutput(gateReview)) === "fail" &&
							enabled("worker") &&
							request.config.maxFixRounds > 0
						) {
							fixOutcome = await runFixRounds(gateReview);
						}
						await runFinalDocumentation(
							fixOutcome.lastWorker ?? initialStepResult,
							fixOutcome.lastReview ?? gateReview,
						);
					} else {
						// No gate configured: the documenter is the only downstream stage.
						await runFinalDocumentation(initialStepResult, undefined);
					}
					return { kind: request.plan.kind, steps };
				} finally {
					removeWorkflowGroup(request.groupId);
				}
			};

			const startBackground = createBackgroundDispatcher({
				runtime,
				ctx,
				config,
				agents,
				finishRun,
				makeLiveHandler,
				makeDetails,
				runManagedWorkflow,
				runInManagedRepositoryLane,
			});

			// Sub-agents intentionally detach from the foreground turn. This makes the
			// editor available immediately; completion messages later wake the main agent.
			if (params.tasks && params.tasks.length > 0) {
				if (params.tasks.length > config.maxConcurrency) {
					return {
						content: [
							{
								type: "text",
								text: `Too many parallel tasks (${params.tasks.length}). Max is ${config.maxConcurrency} (configurable via /subagents-setup).`,
							},
						],
						details: makeDetails("parallel", true)([]),
					};
				}

				const results: SingleResult[] = [];
				// Preserve caller order (and deterministic completion batching) while
				// preparing each isolated filesystem before its queue entry can start.
				for (const item of params.tasks) {
					results.push(await startBackground(
						item.agent,
						item.task,
						item.cwd,
						defaultIsolationMode("parallel", item.agent, item.isolation as IsolationMode | undefined),
					));
				}
				const startedRuns = results.filter((result) => result.exitCode === -1);
				const started = startedRuns.length;
				const startedRefs = startedRuns.map((result) =>
					result.runId === undefined ? result.agent : `#${result.runId} ${result.agent}`,
				);
				const failureLines = results.flatMap((result, index) => {
					if (result.exitCode === -1) return [];
					const reason = getResultOutput(result).trim() || "unknown startup failure";
					return [
						`- tasks[${index}] (${params.tasks![index]!.agent}) failed to start: ${reason.replace(/\n/g, "\n  ")}`,
					];
				});
				if (started === 0) {
					// Pi marks custom-tool failures only when execute throws; returning an
					// `isError` property is still a successful AgentToolResult.
					throw new Error(`No background subagents were started.\n${failureLines.join("\n")}`);
				}
				const text = [
					`Started ${started} background subagent${started === 1 ? "" : "s"}: ${startedRefs.join(", ")}. Results will automatically resume the main agent when ready.`,
					...(failureLines.length > 0
						? [`${failureLines.length} task${failureLines.length === 1 ? "" : "s"} failed before launch:`, ...failureLines]
						: []),
				].join("\n");
				return {
					content: [{ type: "text", text }],
					details: makeDetails("parallel", true)(results),
					terminate: true,
				};
			}

			const result = await startBackground(
				params.agent as string,
				params.task as string,
				params.cwd,
				defaultIsolationMode("single", params.agent as string, params.isolation as IsolationMode | undefined),
			);
			if (result.exitCode !== -1) {
				throw new Error(getResultOutput(result));
			}
			const runRef = result.runId === undefined ? result.agent : `#${result.runId} ${result.agent}`;
			return {
				content: [{ type: "text", text: `Started ${runRef} in the background. Its result will automatically resume the main agent when ready.` }],
				details: makeDetails("single", true)([result]),
				terminate: true,
			};

		},

		renderCall(args, theme) {
			if (args.tasks && args.tasks.length > 0) {
				let text = `${theme.fg("toolTitle", theme.bold("subagent "))}${theme.fg("accent", `parallel (${args.tasks.length})`)}`;
				for (const t of args.tasks.slice(0, 4)) {
					const preview = formatTaskSummary(t.task, 48);
					const isolation = defaultIsolationMode("parallel", t.agent, t.isolation) === "worktree" ? " [worktree]" : "";
					text += `\n  ${theme.fg("accent", t.agent)}${theme.fg("dim", isolation)} ${theme.fg("dim", preview)}`;
				}
				if (args.tasks.length > 4) text += `\n  ${theme.fg("dim", `… +${args.tasks.length - 4} more`)}`;
				return new Text(text, 0, 0);
			}
			const task: string = args.task ?? "";
			const preview = formatTaskSummary(task, 60);
			const isolation = args.isolation === "worktree" ? " [worktree]" : "";
			return new Text(
				`${theme.fg("toolTitle", theme.bold("subagent "))}${theme.fg("accent", args.agent ?? "?")}${theme.fg("dim", isolation)} ${theme.fg("dim", preview)}`,
				0,
				0,
			);
		},

		renderResult(result, _options, theme) {
			const details = result.details as SubagentDetails | undefined;
			if (!details || details.results.length === 0) return new Text(theme.fg("dim", "(no output)"), 0, 0);

			if (details.mode === "single") {
				const r = details.results[0];
				const pending = r.exitCode === -1;
				const icon = statusIcon(pending ? "running" : isFailedResult(r) ? "failed" : "done", theme);
				const usage = formatUsage(r.usage);
				const model = `${r.model ?? "?"}${r.modelFallbackFrom ? ` (main after ${r.modelFallbackFrom} failed)` : ""}`;
				const isolation = r.isolation === "worktree" ? ` · worktree ${r.integrationStatus ?? "active"}` : "";
				const runId = r.runId === undefined ? "" : `${theme.fg("dim", `#${r.runId}`)} `;
				const line = `${theme.fg("toolTitle", theme.bold("subagent "))}${icon} ${runId}${theme.fg("accent", r.agent)} ${theme.fg("dim", `· ${model}${r.thinking ? ` · thinking ${r.thinking}` : ""}${isolation}${pending ? " · background" : ""}${usage ? ` · ${usage}` : ""}`)}`;
				return new Text(line, 0, 0);
			}

			// Parallel mode: header + one compact line per agent
			const lines: string[] = [
				`${theme.fg("toolTitle", theme.bold("subagent "))}${theme.fg("accent", `parallel (${details.results.length})`)}`,
			];
			for (const r of details.results) {
				const pending = r.exitCode === -1;
				const icon = statusIcon(pending ? "running" : isFailedResult(r) ? "failed" : "done", theme);
				const usage = formatUsage(r.usage);
				const model = `${r.model ?? "?"}${r.modelFallbackFrom ? ` (main after ${r.modelFallbackFrom} failed)` : ""}`;
				const isolation = r.isolation === "worktree" ? ` · worktree ${r.integrationStatus ?? "active"}` : "";
				const runId = r.runId === undefined ? "" : `${theme.fg("dim", `#${r.runId}`)} `;
				lines.push(`  ${icon} ${runId}${theme.fg("accent", r.agent)} ${theme.fg("dim", `· ${model}${r.thinking ? ` · thinking ${r.thinking}` : ""}${isolation}${pending ? " · background" : ""}${usage ? ` · ${usage}` : ""}`)}`);
			}
			return new Text(lines.join("\n"), 0, 0);
		},
	});
}
