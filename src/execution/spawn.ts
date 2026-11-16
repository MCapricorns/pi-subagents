/**
 * Sub-agent result handling and native Pi CLI launch orchestration.
 *
 * The process transport lives in cli-run.ts: each attempt runs Pi's own CLI in
 * `--mode rpc` with a session retained after settlement, and settles on
 * `agent_settled`. This module owns retained sessions and result handling.
 * Worker failures return to main without starting a more expensive model.
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

/** A continuation preserves useful history, but main or siblings may have edited
 * the workspace since the selected model last read it. */
const RESUME_CONTINUATION_RULES =
	"Use the earlier session history as evidence. The current objective below takes precedence over earlier task requests; preserve earlier constraints unless it changes them. Reuse relevant completed work and checks. The workspace may have changed while this thread was inactive: before editing a file, re-read it unless you read it during this continuation. The current cwd is authoritative; do not reuse paths to an earlier temporary worktree. Finish with the result-only handoff your role requires.";

/** The objective is a multi-line brief, so it gets its own block instead of
 * being spliced mid-sentence (where a trailing period also doubled up). */
export function buildResumePrompt(task: string, reason: string): string {
	return `You are resuming an earlier sub-agent session after ${reason}. ${RESUME_CONTINUATION_RULES}\n\nCurrent objective:\n${task.trim()}\n\nComplete the remaining work for this objective.`;
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

export interface RunSingleOptions {
	defaultCwd: string;
	agent: AgentConfig;
	agentName: string;
	task: string;
	cwd?: string;
	thinkingLevel?: ThinkingLevel;
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
	/** Refresh parent-derived tools immediately before the worker is spawned. */
	resolveAgentBeforeLaunch?: (agent: AgentConfig) => AgentConfig;
	signal?: AbortSignal;
	onLive?: (event: SubagentLiveEvent) => void;
	env?: NodeJS.ProcessEnv;
	/** Stable logical-generation controller for startup, steering, and cancellation. */
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

/** Run one generation on the chosen worker, preserving its session for follow-ups. */
export async function runWorker(options: RunSingleOptions): Promise<SingleResult> {
	const sessionId = options.sessionId ?? randomUUID();
	const sessionDir = options.sessionDir ?? (await createSessionDir(options.sessionRoot));
	const baseOptions: RunSingleOptions = {
		...options, sessionDir, sessionId,
		...(options.sessionDir && options.stdinText === undefined
			? { stdinText: buildResumePrompt(options.task, "a follow-up was requested") }
			: {}),
	};
	try {
		if (!options.sessionDir) options.onLive?.({ kind: "session", sessionId, sessionDir });
		options.onLive?.({ kind: "model", model: options.agent.model, thinking: options.thinkingLevel });
	} catch {
		/* never throw from event handling */
	}
	let result: SingleResult;
	try {
		result = controlledDisposition(baseOptions) ?? await runSingleAgent({
			...baseOptions,
			agent: options.resolveAgentBeforeLaunch?.(options.agent) ?? options.agent,
		});
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error);
		result = {
			agent: options.agentName, task: options.task, exitCode: 1,
			messages: [], stderr: errorMessage, usage: emptyUsage(),
			model: options.agent.model, thinking: options.thinkingLevel,
			stopReason: "error", errorMessage, dispatchFailed: true,
		};
	}
	result = controlledDisposition(baseOptions, result) ?? result;
	if (!result.dispatchFailed || sessionExists(sessionDir, sessionId) || options.sessionDir) {
		result.sessionId ??= sessionId;
		result.sessionDir ??= sessionDir;
	} else {
		await rm(sessionDir, { recursive: true, force: true }).catch(() => undefined);
		result.sessionId = undefined;
		result.sessionDir = undefined;
	}
	result.task = options.control?.getObjective() ?? result.task;
	options.control?.markSettled();
	return result;
}
