/**
 * Sub-agent result handling and native Pi CLI launch orchestration.
 *
 * The process transport lives in cli-run.ts: each attempt runs Pi's own CLI in
 * `--mode rpc` with a session retained after settlement, and settles on
 * `agent_settled`. This module owns selected-to-main model handoff,
 * capability-clamped thinking, accounting, and result formatting around those
 * attempts.
 */

import { createHash, randomUUID } from "node:crypto";
import { type Dirent, mkdirSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import type { AgentConfig } from "../delegation/agents.ts";
import { DEFAULT_THINKING_LEVEL, type ThinkingLevel } from "../configuration/config.ts";
import {
	emptyUsage,
	RunControl,
	type RunResult,
	type SubagentLiveEvent,
	type UsageStats,
} from "./run-control.ts";
import {
	currentSubagentDepth,
	findSessionFile,
	runCliAgentAttempt,
	sessionExists,
} from "./cli-run.ts";
import { writeTempOwnerMarker } from "../isolation/temp-hygiene.ts";

export {
	currentSubagentDepth,
	findSessionFile,
	RunControl,
	sessionExists,
};
export type { SubagentLiveEvent, UsageStats };

const SUBAGENT_THINKING_LEVEL: ThinkingLevel = DEFAULT_THINKING_LEVEL;
/** 0 disables the watchdog; dispatch supplies the configured timeout. */
const SUBAGENT_DEFAULT_IDLE_TIMEOUT_MS = 0;
export interface SingleResult extends RunResult {}

export interface SubagentDetails {
	mode: "single" | "parallel";
	results: SingleResult[];
}

/** Text of the newest assistant message that has any. A final answer may be
 * split into several text blocks (for example around interleaved thinking);
 * returning only the first block silently dropped the rest of the result. */
function getFinalOutput(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role !== "assistant") continue;
		const texts = msg.content.flatMap((part) => (part.type === "text" && part.text.trim() ? [part.text] : []));
		if (texts.length > 0) return texts.join("\n\n");
	}
	return "";
}

export const RESULT_LINE_MAX = 200;

export interface TruncatedOutput {
	text: string;
	truncated: boolean;
	shownLines: number;
	totalLines: number;
	widthClipped: boolean;
}

export function truncateResultOutput(output: string, maxLines: number): TruncatedOutput {
	const lines = output.split("\n");
	const totalLines = lines.length;
	const widthClipped = lines.some((line) => line.length > RESULT_LINE_MAX);
	if (totalLines <= maxLines && !widthClipped) {
		return { text: output, truncated: false, shownLines: totalLines, totalLines, widthClipped: false };
	}
	const kept = lines.slice(0, maxLines).map((line) =>
		line.length > RESULT_LINE_MAX ? `${line.slice(0, RESULT_LINE_MAX)}…` : line,
	);
	return { text: kept.join("\n"), truncated: true, shownLines: kept.length, totalLines, widthClipped };
}

const RESULT_ARTIFACT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1_000;
const RESULT_ARTIFACT_MAX_FILES_PER_PROJECT = 50;
// Explicit current prefix plus the strict timestamp/token convention used by 1.1.0.
const RESULT_ARTIFACT_NAME = /^(?:pi-subagent-\d{13,}-[0-9a-f]{12}|\d{13,}-[a-z0-9]{6})-[\w.-]+\.md$/;

/** Name of the single internal-state root under the pi agent directory. */
const PROJECT_ROOTS_DIR_NAME = "ferris-pi-subagents";

export function getSubagentsRoot(configPath: string): string {
	return join(dirname(configPath), PROJECT_ROOTS_DIR_NAME);
}

/** Per-project directory that groups every durable artifact of one checkout:
 * `<pi home>/ferris-pi-subagents/<project-slug-hash>/{sessions,worktrees,results}`.
 * Callers join the kind-specific subdirectory themselves. */
export function getProjectRoot(configPath: string, cwd?: string): string {
	return join(getSubagentsRoot(configPath), resultArtifactProjectKey(cwd));
}

interface ResultArtifactRetentionOptions {
	now?: number;
	maxAgeMs?: number;
	maxFilesPerProject?: number;
}

/** Remove stale and overflowing Markdown result artifacts from one project's
 * results directory, newest kept first. Unknown files and symlinks are never
 * touched. Runs on every artifact write, so an active project stays bounded
 * without ever deleting the result the current completion just linked. */
function pruneResultArtifacts(
	resultsDir: string,
	options: ResultArtifactRetentionOptions = {},
): void {
	const now = options.now ?? Date.now();
	const maxAgeMs = Math.max(0, options.maxAgeMs ?? RESULT_ARTIFACT_MAX_AGE_MS);
	const maxFiles = Math.max(0, Math.floor(options.maxFilesPerProject ?? RESULT_ARTIFACT_MAX_FILES_PER_PROJECT));
	let entries: Dirent[];
	try {
		entries = readdirSync(resultsDir, { withFileTypes: true });
	} catch {
		return;
	}
	const artifacts = entries
		.filter((entry) => entry.isFile() && !entry.isSymbolicLink() && RESULT_ARTIFACT_NAME.test(entry.name))
		.flatMap((entry) => {
			const path = join(resultsDir, entry.name);
			try {
				return [{ path, mtimeMs: statSync(path).mtimeMs }];
			} catch {
				return [];
			}
		})
		.sort((left, right) => right.mtimeMs - left.mtimeMs);

	for (const [index, artifact] of artifacts.entries()) {
		if (index < maxFiles && now - artifact.mtimeMs <= maxAgeMs) continue;
		try {
			rmSync(artifact.path, { force: true });
		} catch {
			// Retention is best-effort; result delivery must still succeed.
		}
	}
}

/** Apply result retention to every project under the durable root. The write
 * path only bounds the project being written to, so this is what ages out the
 * results of projects that are no longer producing any. */
export function sweepProjectResultArtifacts(
	durableRoot: string,
	options: ResultArtifactRetentionOptions = {},
): void {
	let projects: Dirent[];
	try {
		projects = readdirSync(durableRoot, { withFileTypes: true });
	} catch {
		return;
	}
	for (const project of projects) {
		if (!project.isDirectory() || project.isSymbolicLink()) continue;
		pruneResultArtifacts(join(durableRoot, project.name, "results"), options);
	}
}

function resultArtifactProjectKey(cwd?: string): string {
	if (!cwd) return "default";
	let ancestor = resolve(cwd);
	let canonical = ancestor;
	const missing: string[] = [];
	for (;;) {
		try {
			canonical = join(realpathSync.native(ancestor), ...missing);
			break;
		} catch {
			// Keep aliases in existing parents canonical when the checkout is
			// unavailable (for example macOS /var and Windows short paths).
			const parent = dirname(ancestor);
			if (parent === ancestor) break;
			missing.unshift(basename(ancestor));
			ancestor = parent;
		}
	}
	if (process.platform === "win32") canonical = canonical.toLowerCase();
	const slug = basename(canonical).replace(/[^\w.-]+/g, "_") || "project";
	const digest = createHash("sha256").update(canonical).digest("hex").slice(0, 12);
	return `${slug}-${digest}`;
}

export function writeResultArtifact(output: string, agentName: string, resultsRoot: string): string {
	mkdirSync(resultsRoot, { recursive: true });
	const safeName = agentName.replace(/[^\w.-]+/g, "_") || "agent";
	const unique = `pi-subagent-${Date.now()}-${randomUUID().replaceAll("-", "").slice(0, 12)}`;
	const filePath = join(resultsRoot, `${unique}-${safeName}.md`);
	writeFileSync(filePath, output, "utf8");
	pruneResultArtifacts(resultsRoot);
	return filePath;
}

export function isFailedResult(result: SingleResult): boolean {
	return result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
}

function lastAssistantMessage(messages: Message[]): Extract<Message, { role: "assistant" }> | undefined {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message.role === "assistant") return message;
	}
	return undefined;
}

export function isModelLevelFailure(result: SingleResult): boolean {
	if (!isFailedResult(result)) return false;
	if (result.stopReason === "aborted") return false;
	if (result.dispatchFailed) return false;
	if (result.integrationStatus === "retained") return false;
	if (result.errorMessage?.includes("idle timeout")) return true;

	// Classification belongs to the final assistant turn, not the whole attempt.
	// Earlier useful text or failed tool calls are retained session history and
	// must not hide a later provider error (for example a second-turn 503).
	const finalAssistant = lastAssistantMessage(result.messages);
	if (finalAssistant) {
		// Provider streams may preserve partial text on a terminal error. The stop
		// reason, not content emptiness, is the transport boundary; ordinary tool or
		// task failures settle with a non-error assistant stop reason.
		return finalAssistant.stopReason === "error";
	}

	if ((result.failedTools?.length ?? 0) > 0) return false;
	return result.activityObserved === true;
}

/** Runtime/assistant diagnostics, never an inference from individual failed tools. */
export function getResultError(result: SingleResult): string | undefined {
	if (result.exitCode === -1 || !isFailedResult(result)) return undefined;
	return result.errorMessage?.trim()
		|| lastAssistantMessage(result.messages)?.errorMessage?.trim()
		|| result.stderr.trim()
		|| (result.stopReason === "aborted"
			? "Subagent was aborted."
			: `Subagent failed (exit code ${result.exitCode}${result.stopReason ? `, stop reason ${result.stopReason}` : ""}); no failure reason was recorded.`);
}

export function getResultOutput(result: SingleResult): string {
	const error = getResultError(result);
	const output = getFinalOutput(result.messages);
	if (error && output) return `${error}\n\n--- Partial output ---\n${output}`;
	return error || output || "(no output)";
}

/** Model handoff preserves useful history, but main or siblings may have edited
 * the workspace since the selected model last read it. */
const RESUME_CONTINUATION_RULES =
	"Your earlier work — searches, reads, edits, and reasoning — is preserved in this session's history above; review it before acting. Do not redo searches, reads, or edits that already succeeded. The workspace may have changed while this thread was inactive: before editing a file, re-read it unless you read it during this continuation. The current cwd is authoritative; do not reuse paths to an earlier temporary worktree. Finish with the result-only handoff your role requires.";

/** The objective is a multi-line brief, so it gets its own block instead of
 * being spliced mid-sentence (where a trailing period also doubled up). */
export function buildResumePrompt(task: string, reason: string): string {
	return `You are resuming an earlier sub-agent session after ${reason}. ${RESUME_CONTINUATION_RULES}\n\nCurrent objective:\n${task.trim()}\n\nPick up exactly where you left off and finish it. Continue now.`;
}

/** Create a fresh private session directory under the given root. The owner
 * marker is what lets a later load tell a session this process still owns from
 * one a crash abandoned. */
async function createSessionDir(root: string): Promise<string> {
	await mkdir(root, { recursive: true });
	const dir = await mkdtemp(join(root, "pi-subagent-session-"));
	writeTempOwnerMarker(dir);
	return dir;
}

function buildFallbackResumeReason(fromModel?: string): string {
	return fromModel
		? `the selected model (${fromModel}) failed at the model/provider level, so the current main model is continuing`
		: "the selected model failed at the model/provider level, so the current main model is continuing";
}

export interface RunSingleOptions {
	defaultCwd: string;
	agent: AgentConfig;
	agentName: string;
	task: string;
	cwd?: string;
	thinkingLevel?: ThinkingLevel;
	/** Resolve the effective level for each runtime model candidate. */
	thinkingLevelForModel?: (modelRef?: string) => ThinkingLevel;
	idleTimeoutMs?: number;
	sessionDir?: string;
	sessionId?: string;
	/** Parent directory for a fresh session directory: the project-scoped
	 * sessions root, so retained sessions survive reloads and restarts. */
	sessionRoot: string;
	/** Project-scoped temporary prompt files, separate from retained sessions. */
	scratchRoot: string;
	/** Plain-text prompt passed to Pi over stdin. */
	stdinText?: string;
	/** Refresh parent-derived tools immediately before every selected model and
	 * selected-to-main fallback process is spawned. */
	resolveAgentForAttempt?: (agent: AgentConfig) => AgentConfig;
	signal?: AbortSignal;
	onLive?: (event: SubagentLiveEvent) => void;
	env?: NodeJS.ProcessEnv;
	/** Stable logical-generation controller shared across model attempts. */
	control?: RunControl;
	startupTimeoutMs?: number;
}

function controlledDisposition(options: RunSingleOptions, base?: SingleResult): SingleResult | undefined {
	const control = options.control;
	if (!control?.isStopRequested()) return undefined;
	const result: SingleResult = base ?? {
		agent: options.agentName,
		task: control.getObjective(),
		exitCode: 0,
		messages: [],
		stderr: "",
		usage: emptyUsage(),
		model: options.agent.model,
		thinking: options.thinkingLevel,
		sessionId: options.sessionId,
		sessionDir: options.sessionDir,
	};
	result.task = control.getObjective();
	result.exitCode = 1;
	result.stopReason = "aborted";
	result.errorMessage = control.getStopMessage();
	return result;
}

/** Spawn one native JSON CLI attempt and wait for stable settlement. */
async function runSingleAgent(options: RunSingleOptions): Promise<SingleResult> {
	const {
		agent,
		agentName,
		thinkingLevel = SUBAGENT_THINKING_LEVEL,
		idleTimeoutMs = SUBAGENT_DEFAULT_IDLE_TIMEOUT_MS,
		control,
	} = options;
	const disposition = controlledDisposition(options);
	if (disposition) return disposition;
	const objective = control?.getObjective() ?? options.task;
	const prompt = options.stdinText ?? `Task: ${objective}`;
	const result = await runCliAgentAttempt({
		defaultCwd: options.defaultCwd,
		agent,
		agentName,
		task: objective,
		cwd: options.cwd,
		thinkingLevel,
		idleTimeoutMs,
		sessionDir: options.sessionDir,
		sessionId: options.sessionId,
		scratchRoot: options.scratchRoot,
		prompt,
		signal: options.signal,
		onLive: options.onLive,
		env: options.env,
		control,
		startupTimeoutMs: options.startupTimeoutMs,
	});
	result.task = control?.getObjective() ?? result.task;
	return result;
}

/**
 * Run one logical generation on the selected model, then hand directly to the
 * current main model after any model/provider-level failure. A launch failure is returned to main without replaying an ambiguous prompt.
 * Both attempts resume the same retained Pi session.
 */
export async function runSingleAgentWithMainFallback(
	options: RunSingleOptions,
	mainFallbackRef?: string,
): Promise<SingleResult> {
	const agent = options.agent;
	const launchedRef = agent?.model;

	const sessionId = options.sessionId ?? randomUUID();
	const sessionDir = options.sessionDir ?? (await createSessionDir(options.sessionRoot));
	const baseOptions: RunSingleOptions = {
		...options, sessionDir, sessionId,
		...(options.sessionDir && options.stdinText === undefined
			? { stdinText: buildResumePrompt(options.task, "a follow-up was requested") }
			: {}),
	};
	if (!options.sessionDir) {
		// Surface the fresh session immediately so the dispatching thread can
		// persist a durable checkpoint before the child settles.
		try {
			options.onLive?.({ kind: "session", sessionId, sessionDir });
		} catch {
			/* never throw from event handling */
		}
	}

	const dispatchFailure = async (error: unknown): Promise<SingleResult> => {
		const errorMessage = error instanceof Error ? error.message : String(error);
		const hasSession = sessionExists(sessionDir, sessionId);
		if (!hasSession && !options.sessionDir) {
			await rm(sessionDir, { recursive: true, force: true }).catch(() => undefined);
		}
		return {
			agent: options.agentName,
			task: options.control?.getObjective() ?? options.task,
			exitCode: 1,
			messages: [],
			stderr: errorMessage,
			usage: emptyUsage(),
			model: options.agent.model,
			thinking: options.thinkingLevel,
			stopReason: "error",
			errorMessage,
			dispatchFailed: true,
			...(hasSession || options.sessionDir ? { sessionId, sessionDir } : {}),
		};
	};

	const runAttempt = async (opts: RunSingleOptions): Promise<SingleResult> => {
		const immediate = controlledDisposition(opts);
		if (immediate) return immediate;
		try {
			const attemptOptions = opts.resolveAgentForAttempt ? { ...opts, agent: opts.resolveAgentForAttempt(opts.agent) } : opts;
			const result = await runSingleAgent(attemptOptions);
			return controlledDisposition(opts, result) ?? result;
		} catch (error) {
			const failed = await dispatchFailure(error);
			return controlledDisposition(opts, failed) ?? failed;
		}
	};

	const selectedRef = launchedRef?.trim() || undefined;
	const normalizedMainRef = mainFallbackRef?.trim() || undefined;
	const candidates: Array<{ agent: AgentConfig; ref?: string }> = [
		{ agent, ref: selectedRef },
	];
	if (normalizedMainRef && normalizedMainRef !== selectedRef) {
		candidates.push({ agent: { ...agent, model: normalizedMainRef }, ref: normalizedMainRef });
	}

	let fallbackUsed = false;
	let result: SingleResult | undefined;
	const priorFailedTools: NonNullable<SingleResult["failedTools"]> = [];
	const priorUsage = emptyUsage();

	const retainAttemptDiagnostics = (attempt: SingleResult): void => {
		priorFailedTools.push(...(attempt.failedTools ?? []));
		priorUsage.input += attempt.usage.input;
		priorUsage.output += attempt.usage.output;
		priorUsage.cacheRead += attempt.usage.cacheRead;
		priorUsage.cacheWrite += attempt.usage.cacheWrite;
		priorUsage.cost += attempt.usage.cost;
		priorUsage.turns += attempt.usage.turns;
		priorUsage.contextTokens = attempt.usage.contextTokens || priorUsage.contextTokens;
	};

	const finish = async (settled: SingleResult): Promise<SingleResult> => {
		if (priorFailedTools.length > 0) {
			settled.failedTools = [...priorFailedTools, ...(settled.failedTools ?? [])];
		}
		if (
			priorUsage.turns || priorUsage.input || priorUsage.output || priorUsage.cacheRead ||
			priorUsage.cacheWrite || priorUsage.cost || priorUsage.contextTokens
		) {
			settled.usage = {
				input: priorUsage.input + settled.usage.input,
				output: priorUsage.output + settled.usage.output,
				cacheRead: priorUsage.cacheRead + settled.usage.cacheRead,
				cacheWrite: priorUsage.cacheWrite + settled.usage.cacheWrite,
				cost: priorUsage.cost + settled.usage.cost,
				turns: priorUsage.turns + settled.usage.turns,
				contextTokens: settled.usage.contextTokens || priorUsage.contextTokens,
			};
		}
		const persistedSession = sessionExists(sessionDir, sessionId);
		if (!settled.dispatchFailed || persistedSession || options.sessionDir) {
			settled.sessionId ??= sessionId;
			settled.sessionDir ??= sessionDir;
		} else {
			await rm(sessionDir, { recursive: true, force: true }).catch(() => undefined);
			settled.sessionId = undefined;
			settled.sessionDir = undefined;
		}
		settled.task = options.control?.getObjective() ?? settled.task;
		if (fallbackUsed && launchedRef) settled.modelFallbackFrom = launchedRef;
		options.control?.markSettled();
		return settled;
	};

	for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex++) {
		const candidate = candidates[candidateIndex];
		fallbackUsed ||= candidateIndex > 0;
		const previousModel = result?.model ?? candidates[candidateIndex - 1]?.ref;
		const candidateThinking = options.thinkingLevelForModel?.(candidate.ref) ?? options.thinkingLevel;
		const candidateOptions: RunSingleOptions = {
			...baseOptions,
			agent: candidate.agent,
			thinkingLevel: candidateThinking,
			...(candidateIndex > 0
				? {
					stdinText: buildResumePrompt(
						options.control?.getObjective() ?? options.task,
						buildFallbackResumeReason(previousModel),
					),
				}
				: {}),
		};
		try {
			options.onLive?.({
				kind: "model",
				model: candidate.ref,
				thinking: candidateThinking,
				...(candidateIndex > 0 && launchedRef ? { fallbackFrom: launchedRef } : {}),
			});
		} catch {
			/* never throw from event handling */
		}

		result = await runAttempt(candidateOptions);
		if (result.stopReason === "aborted") return finish(result);
		if (!isModelLevelFailure(result)) return finish(result);
		// Any model-level failure advances immediately to the sole fallback (the
		// current main model). Retain selected-attempt tool diagnostics and usage;
		// ordinary task/tool failures returned above without a handoff.
		if (candidateIndex < candidates.length - 1) retainAttemptDiagnostics(result);
	}

	return finish(result!);
}
