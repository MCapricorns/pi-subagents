/**
 * Durable thread state: one manifest per project, inside that project's durable
 * root beside its sessions and worktrees, letting interrupted (parked)
 * sub-agent threads survive pi reloads and restarts. The durable state root
 * also keeps their retained sessions and isolated worktrees out of the OS temp
 * directory.
 *
 * Only parked threads are ever recorded: a thread that settles normally drops
 * its record, so a manifest file exists exactly while unfinished work needs it
 * and disappears on its own. Records are small path/state snapshots, never
 * full transcripts; the retained Pi session files and worktrees they point at
 * remain the actual context. Writes are atomic (tmp+rename) and serialized
 * through the same withFileMutationQueue as the recovery manifest.
 */

import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { existsSync, type Dirent, readdirSync, statSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { uptime } from "node:os";
import { dirname, join } from "node:path";
import type { UsageStats } from "./rpc-run.ts";
import type { SubagentThread } from "./runtime.ts";
import { getResultOutput, isFailedResult, getProjectRoot, PROJECT_ROOTS_DIR_NAME, type SingleResult } from "./spawn.ts";
import {
	isPathInside,
	restoreWorktreeIsolation,
	type IsolationMode,
	normalizeWorktreeSnapshot,
	worktreeSnapshot,
	type WorktreeSnapshot,
} from "./worktree.ts";

export const THREADS_MANIFEST_FILE_NAME = "pi-subagents-threads.json";
const THREADS_MANIFEST_VERSION = 1;

/** Project directories whose newest file has not been touched for this long
 * are deleted wholesale on load, so per-project sessions/worktrees/results
 * can never accumulate forever. Parked threads' manifest references always
 * win over the age rule. */
export const PROJECT_ROOT_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1_000;

/** Fixed retention: parked work (which may hold unintegrated changes) stops
 * being resumable after a month. Older manifests may still carry settled
 * records from previous versions; restore discards them on sight. */
export const PARKED_RECORD_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1_000;

/** Result excerpts are for status display after restore, not full transcripts. */
const RESULT_SUMMARY_MAX_CHARS = 4_000;

/** Boot-id comparisons allow this much slack. Uptime is reported at
 * second granularity and wall-clock adjustments (NTP steps, suspend accounting
 * that differs per platform) move the derived timestamp a little between
 * processes. A reboot moves it by the whole previous uptime, so the distinction
 * that matters here survives a tolerance this wide. */
const BOOT_ID_TOLERANCE_MS = 60_000;

export interface ThreadResultSummary {
	agent: string;
	task: string;
	exitCode: number;
	failed: boolean;
	stopReason?: string;
	usage: UsageStats;
	model?: string;
	thinking?: string;
	output: string;
}

export interface ThreadRecord {
	runId: number;
	createdAt: number;
	updatedAt: number;
	generation: number;
	agentName: string;
	task: string;
	cwd: string;
	executionCwd: string;
	thinkingLevel?: string;
	isolation: IsolationMode;
	state: "parked" | "completed" | "failed";
	elapsedMs: number;
	sessionId?: string;
	sessionDir?: string;
	worktree?: WorktreeSnapshot;
	childPids: number[];
	/** Boot this record's `childPids` were observed in; see `isCurrentBoot`. */
	bootId?: number;
	resultSummary?: ThreadResultSummary;
}

/** Approximate timestamp of the machine's current boot. */
export function currentBootId(now = Date.now()): number {
	return Math.round(now - uptime() * 1_000);
}

/** Whether a record's `childPids` can still name processes of this boot. Pids
 * are only unique within a boot: after a restart the same number belongs to
 * whatever claimed it, so restore must not signal them. Records written before
 * this field existed carry no boot id and count as unverifiable — leaving a
 * stray child alive costs a resumable session nothing, while killing an
 * unrelated process tree is not recoverable. */
export function isCurrentBoot(record: ThreadRecord, now = Date.now()): boolean {
	if (record.bootId === undefined) return false;
	return Math.abs(record.bootId - currentBootId(now)) <= BOOT_ID_TOLERANCE_MS;
}

interface ThreadsManifest {
	version: number;
	records: ThreadRecord[];
}

/** Each project's manifest lives inside its durable root, beside the sessions
 * and worktrees its records point at. */
export function getThreadsManifestPath(configPath: string, cwd: string): string {
	return join(getProjectRoot(configPath, cwd), THREADS_MANIFEST_FILE_NAME);
}

/** Location of the pre-per-project global manifest; only read by the
 * one-time migration that folds it into the project roots. */
function getLegacyManifestPath(configPath: string): string {
	return join(dirname(configPath), THREADS_MANIFEST_FILE_NAME);
}

function normalizeUsage(value: unknown): UsageStats {
	const raw = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
	const num = (key: string): number => (typeof raw[key] === "number" && Number.isFinite(raw[key]) ? raw[key] : 0);
	return {
		input: num("input"),
		output: num("output"),
		cacheRead: num("cacheRead"),
		cacheWrite: num("cacheWrite"),
		cost: num("cost"),
		contextTokens: num("contextTokens"),
		turns: num("turns"),
	};
}

function normalizeResultSummary(value: unknown): ThreadResultSummary | undefined {
	if (!value || typeof value !== "object") return undefined;
	const raw = value as Record<string, unknown>;
	if (typeof raw.agent !== "string" || !raw.agent) return undefined;
	if (typeof raw.output !== "string") return undefined;
	return {
		agent: raw.agent,
		task: typeof raw.task === "string" ? raw.task : raw.agent,
		exitCode: typeof raw.exitCode === "number" ? raw.exitCode : 0,
		failed: raw.failed === true,
		...(typeof raw.stopReason === "string" && raw.stopReason ? { stopReason: raw.stopReason } : {}),
		usage: normalizeUsage(raw.usage),
		...(typeof raw.model === "string" && raw.model ? { model: raw.model } : {}),
		...(typeof raw.thinking === "string" && raw.thinking ? { thinking: raw.thinking } : {}),
		output: raw.output,
	};
}

function normalizeRecord(value: unknown): ThreadRecord | undefined {
	if (!value || typeof value !== "object") return undefined;
	const raw = value as Record<string, unknown>;
	if (typeof raw.runId !== "number" || !Number.isInteger(raw.runId) || raw.runId < 1) return undefined;
	if (typeof raw.createdAt !== "number" || !Number.isFinite(raw.createdAt)) return undefined;
	if (typeof raw.updatedAt !== "number" || !Number.isFinite(raw.updatedAt)) return undefined;
	if (typeof raw.agentName !== "string" || !raw.agentName) return undefined;
	if (typeof raw.task !== "string" || !raw.task) return undefined;
	if (typeof raw.cwd !== "string" || !raw.cwd) return undefined;
	if (raw.isolation !== "shared" && raw.isolation !== "worktree") return undefined;
	if (raw.state !== "parked" && raw.state !== "completed" && raw.state !== "failed") return undefined;
	const worktree = raw.worktree === undefined ? undefined : normalizeWorktreeSnapshot(raw.worktree);
	if (worktree === null) return undefined;
	return {
		runId: raw.runId,
		createdAt: raw.createdAt,
		updatedAt: raw.updatedAt,
		generation: typeof raw.generation === "number" && Number.isInteger(raw.generation) && raw.generation >= 0 ? raw.generation : 0,
		agentName: raw.agentName,
		task: raw.task,
		cwd: raw.cwd,
		executionCwd: typeof raw.executionCwd === "string" && raw.executionCwd ? raw.executionCwd : raw.cwd,
		...(typeof raw.thinkingLevel === "string" && raw.thinkingLevel ? { thinkingLevel: raw.thinkingLevel } : {}),
		isolation: raw.isolation,
		state: raw.state,
		elapsedMs: typeof raw.elapsedMs === "number" && Number.isFinite(raw.elapsedMs) ? Math.max(0, raw.elapsedMs) : 0,
		...(typeof raw.sessionId === "string" && raw.sessionId ? { sessionId: raw.sessionId } : {}),
		...(typeof raw.sessionDir === "string" && raw.sessionDir ? { sessionDir: raw.sessionDir } : {}),
		...(worktree ? { worktree } : {}),
		childPids: Array.isArray(raw.childPids)
			? raw.childPids.filter((pid): pid is number => typeof pid === "number" && Number.isInteger(pid) && pid > 0)
			: [],
		...(typeof raw.bootId === "number" && Number.isFinite(raw.bootId) ? { bootId: raw.bootId } : {}),
		...(raw.resultSummary === undefined ? {} : { resultSummary: normalizeResultSummary(raw.resultSummary) }),
	};
}

async function readManifestRecords(path: string): Promise<ThreadRecord[]> {
	try {
		const parsed = JSON.parse(await readFile(path, "utf8")) as {
			records?: unknown;
		};
		if (!Array.isArray(parsed.records)) return [];
		return parsed.records.flatMap((record) => {
			const normalized = normalizeRecord(record);
			return normalized ? [normalized] : [];
		});
	} catch {
		return [];
	}
}

/** Manifest paths of every project that has a durable root. */
function projectManifestPaths(durableRoot: string): string[] {
	try {
		return readdirSync(durableRoot, { withFileTypes: true })
			.filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
			.map((entry) => join(durableRoot, entry.name, THREADS_MANIFEST_FILE_NAME));
	} catch {
		return [];
	}
}

/** Every parked record across all projects, for restore and the state-root
 * sweeps that must see references from anywhere. */
export async function readThreadRecords(configPath: string): Promise<ThreadRecord[]> {
	const manifests = await Promise.all(
		projectManifestPaths(join(dirname(configPath), PROJECT_ROOTS_DIR_NAME))
			.map((path) => readManifestRecords(path)),
	);
	return manifests.flat();
}

async function writeManifest(path: string, records: readonly ThreadRecord[]): Promise<void> {
	if (records.length === 0) {
		await rm(path, { force: true });
		return;
	}
	await mkdir(dirname(path), { recursive: true });
	const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`;
	try {
		const manifest: ThreadsManifest = {
			version: THREADS_MANIFEST_VERSION,
			records: [...records],
		};
		await writeFile(temporaryPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
		await rename(temporaryPath, path);
	} finally {
		await rm(temporaryPath, { force: true }).catch(() => undefined);
	}
}

export async function upsertThreadRecord(configPath: string, record: ThreadRecord): Promise<void> {
	const path = getThreadsManifestPath(configPath, record.cwd);
	await withFileMutationQueue(path, async () => {
		const records = await readManifestRecords(path);
		const index = records.findIndex((candidate) => candidate.runId === record.runId);
		const merged: ThreadRecord = index === -1
			? record
			: { ...record, createdAt: records[index]!.createdAt };
		if (index === -1) records.push(merged);
		else records[index] = merged;
		await writeManifest(path, records);
	});
}

export async function removeThreadRecord(configPath: string, runId: number, cwd: string): Promise<void> {
	const path = getThreadsManifestPath(configPath, cwd);
	await withFileMutationQueue(path, async () => {
		const records = await readManifestRecords(path);
		const next = records.filter((record) => record.runId !== runId);
		if (next.length === records.length) return;
		await writeManifest(path, next);
	});
}

function truncateSummary(text: string): string {
	if (text.length <= RESULT_SUMMARY_MAX_CHARS) return text;
	return `${text.slice(0, RESULT_SUMMARY_MAX_CHARS - 1)}…`;
}

function summarizeResult(result: SingleResult): ThreadResultSummary | undefined {
	if (!result) return undefined;
	return {
		agent: result.agent,
		task: result.task,
		exitCode: result.exitCode,
		failed: isFailedResult(result),
		...(result.stopReason ? { stopReason: result.stopReason } : {}),
		usage: result.usage,
		...(result.model ? { model: result.model } : {}),
		...(result.thinking ? { thinking: result.thinking } : {}),
		output: truncateSummary(getResultOutput(result)),
	};
}

/** Project a live thread into its durable record. Only handles whose
 * filesystem is still meaningful are persisted; finalized-and-removed
 * worktrees keep just their checkpoint commit for continuation resumes. */
export function threadRecordFromThread(
	thread: SubagentThread,
	state: "parked" | "completed" | "failed",
	previous?: ThreadRecord,
	now = Date.now(),
): ThreadRecord {
	const worktree = thread.worktree ? worktreeSnapshot(thread.worktree) : undefined;
	return {
		runId: thread.id,
		createdAt: previous?.createdAt ?? now,
		updatedAt: now,
		generation: thread.generation,
		agentName: thread.agentName,
		task: thread.task,
		cwd: thread.cwd,
		executionCwd: thread.executionCwd,
		...(thread.thinkingLevel ? { thinkingLevel: thread.thinkingLevel } : {}),
		isolation: thread.isolation,
		state,
		elapsedMs: thread.elapsedMs,
		...(thread.sessionId && thread.sessionDir ? { sessionId: thread.sessionId, sessionDir: thread.sessionDir } : {}),
		...(worktree ? { worktree } : {}),
		childPids: thread.control?.getChildPids?.() ?? [],
		bootId: currentBootId(now),
		...(thread.lastResult ? { resultSummary: summarizeResult(thread.lastResult) } : {}),
	};
}

/** Rebuild a displayable in-turn result from a persisted summary. The retained
 * session holds the real context; this only lets a restored thread report
 * what the previous session's generation concluded. */
export function restoredResultFromSummary(record: ThreadRecord): SingleResult | undefined {
	const summary = record.resultSummary;
	if (!summary) return undefined;
	return {
		agent: summary.agent,
		task: summary.task,
		exitCode: summary.exitCode,
		messages: summary.output
			? [{
				role: "assistant",
				content: [{ type: "text", text: summary.output }],
				stopReason: "stop",
			} as SingleResult["messages"][number]]
			: [],
		stderr: "",
		usage: summary.usage,
		isolation: record.isolation,
		...(summary.model ? { model: summary.model } : {}),
		...(summary.thinking ? { thinking: summary.thinking } : {}),
		...(summary.stopReason ? { stopReason: summary.stopReason } : {}),
		...(record.sessionId && record.sessionDir ? { sessionId: record.sessionId, sessionDir: record.sessionDir } : {}),
	};
}

async function discardRecordArtifacts(record: ThreadRecord): Promise<void> {
	if (record.sessionDir) {
		await rm(record.sessionDir, { recursive: true, force: true }).catch(() => undefined);
	}
	if (record.worktree && (record.worktree.state === "active" || record.worktree.state === "retained")) {
		const worktree = await restoreWorktreeIsolation(record.worktree).catch(() => undefined);
		await worktree?.discard().catch(() => undefined);
	}
}

/** Drop records past their retention age along with their artifacts. Runs at
 * extension load; the fixed age honors the no-config-knobs policy. */
export async function pruneThreadRecords(
	configPath: string,
	now = Date.now(),
): Promise<void> {
	const durableRoot = join(dirname(configPath), PROJECT_ROOTS_DIR_NAME);
	for (const path of projectManifestPaths(durableRoot)) {
		await withFileMutationQueue(path, async () => {
			const records = await readManifestRecords(path);
			if (records.length === 0) return;
			let changed = false;
			const kept: ThreadRecord[] = [];
			for (const record of records) {
				if (now - record.updatedAt <= PARKED_RECORD_MAX_AGE_MS) {
					kept.push(record);
					continue;
				}
				changed = true;
				await discardRecordArtifacts(record);
			}
			if (changed) await writeManifest(path, kept);
		});
	}
}

/** One-time move of the pre-per-project global manifest beside the config into
 * the project roots its records belong to, so an upgrade keeps parked work
 * resumable and pi home is left without a manifest. Existing project records
 * win over legacy ones; the legacy file is removed only after every group
 * landed, and an unreadable file stays put for the next boot. */
export async function migrateLegacyThreadsManifest(configPath: string): Promise<void> {
	const legacyPath = getLegacyManifestPath(configPath);
	let records: ThreadRecord[];
	try {
		const parsed = JSON.parse(await readFile(legacyPath, "utf8")) as { records?: unknown };
		if (!Array.isArray(parsed.records)) return;
		records = parsed.records.flatMap((record) => {
			const normalized = normalizeRecord(record);
			return normalized ? [normalized] : [];
		});
	} catch {
		return;
	}
	const groups = new Map<string, ThreadRecord[]>();
	for (const record of records) {
		const path = getThreadsManifestPath(configPath, record.cwd);
		const group = groups.get(path);
		if (group) group.push(record);
		else groups.set(path, [record]);
	}
	let migrated = true;
	for (const [path, group] of groups) {
		await withFileMutationQueue(path, async () => {
			const existing = await readManifestRecords(path);
			const merged = [...existing];
			for (const record of group) {
				if (!merged.some((candidate) => candidate.runId === record.runId)) merged.push(record);
			}
			await writeManifest(path, merged);
		}).catch(() => {
			migrated = false;
		});
	}
	if (migrated) await rm(legacyPath, { force: true }).catch(() => undefined);
}

/** Paths a manifest still references; used by the state-root sweep so
 * freshly created-but-unrecorded directories are never touched. */
export function referencedDurablePaths(records: readonly ThreadRecord[]): Set<string> {
	const paths = new Set<string>();
	for (const record of records) {
		if (record.sessionDir) paths.add(record.sessionDir);
		if (record.worktree) {
			paths.add(record.worktree.tempDir);
			if (existsSync(record.worktree.worktreePath)) paths.add(record.worktree.worktreePath);
		}
	}
	return paths;
}

/** Whether everything under root was last modified before `cutoffMs` — the only
 * question the age rule asks. Returns false the moment one fresh entry turns up,
 * so a project still in use costs a few stats instead of a full walk of its
 * retained sessions and worktree checkouts on every load. A root with no usable
 * timestamp at all also reports false: a directory nothing could be read from is
 * never the one to delete. */
function isIdleSince(root: string, cutoffMs: number, now: number): boolean {
	let sawTimestamp = false;
	const stack: string[] = [root];
	while (stack.length > 0) {
		const dir = stack.pop()!;
		let entries: Dirent[];
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			const path = join(dir, entry.name);
			let mtime: number;
			try {
				mtime = statSync(path).mtimeMs;
			} catch {
				continue;
			}
			// A timestamp in the future carries no usable age: it neither keeps a
			// root alive nor lets one age out.
			if (mtime > 0 && mtime <= now) {
				if (mtime >= cutoffMs) return false;
				sawTimestamp = true;
			}
			if (entry.isDirectory() && !entry.isSymbolicLink()) stack.push(path);
		}
	}
	return sawTimestamp;
}

/** Delete project directories under the ferris-pi-subagents root that have
 * been idle past PROJECT_ROOT_MAX_AGE_MS. A directory containing any path the
 * threads manifest still references is never touched, so parked work outlives
 * the age rule. Returns the removed directory names. */
export async function pruneStaleProjectRoots(configPath: string, options: { now?: number } = {}): Promise<string[]> {
	const now = options.now ?? Date.now();
	const records = await readThreadRecords(configPath).catch(() => [] as ThreadRecord[]);
	const referenced = referencedDurablePaths(records);
	const root = join(dirname(configPath), PROJECT_ROOTS_DIR_NAME);
	let projects: Dirent[];
	try {
		projects = readdirSync(root, { withFileTypes: true });
	} catch {
		return [];
	}
	const removed: string[] = [];
	for (const project of projects) {
		if (!project.isDirectory() || project.isSymbolicLink()) continue;
		const projectDir = join(root, project.name);
		if (containsReferencedPath(projectDir, referenced)) continue;
		if (!isIdleSince(projectDir, now - PROJECT_ROOT_MAX_AGE_MS, now)) continue;
		await rm(projectDir, { recursive: true, force: true }).catch(() => undefined);
		if (!existsSync(projectDir)) removed.push(project.name);
	}
	return removed;
}

function containsReferencedPath(projectDir: string, referenced: ReadonlySet<string>): boolean {
	for (const path of referenced) {
		if (isPathInside(projectDir, path)) return true;
	}
	return false;
}
