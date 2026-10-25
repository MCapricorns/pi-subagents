/**
 * Durable workflow records: what a graph had completed, what it was still
 * running, and the plan itself, so a crashed or reloaded session can still
 * explain what was in flight.
 *
 * The graph is not resumed automatically — each node is an ordinary sub-agent
 * thread with its own durable record and retained session, and main finishes
 * that work with its own tools. This manifest keeps the *shape* of the run
 * (which nodes settled, which were pending, which were blocked) queryable
 * instead of leaving a pile of unrelated parked threads.
 *
 * One manifest per project, written atomically, like the thread manifest; a
 * settled workflow removes its record, so the file exists exactly while
 * unfinished work needs explaining.
 */

import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { readdirSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { getProjectRoot, getSubagentsRoot } from "../execution/spawn.ts";
import { PARKED_RECORD_MAX_AGE_MS } from "../lifecycle/durable.ts";

export const WORKFLOWS_MANIFEST_FILE_NAME = "pi-subagents-workflows.json";
const WORKFLOWS_MANIFEST_VERSION = 1;

export type RecordedNodeState = "pending" | "running" | "completed" | "failed" | "blocked" | "stopped";

export interface WorkflowRecordNode {
	id: string;
	agent: string;
	task: string;
	dependsOn: string[];
	state: RecordedNodeState;
	runId?: number;
	error?: string;
}

export interface WorkflowRecord {
	workflowId: number;
	name: string;
	description?: string;
	cwd: string;
	/** How the graph stopped being live. */
	state: "running" | "stopped" | "interrupted";
	startedAt: number;
	updatedAt: number;
	stopReason?: string;
	nodes: WorkflowRecordNode[];
}

interface WorkflowsManifest {
	version: number;
	records: WorkflowRecord[];
}

const NODE_STATES = new Set<RecordedNodeState>([
	"pending",
	"running",
	"completed",
	"failed",
	"blocked",
	"stopped",
]);

export function getWorkflowsManifestPath(configPath: string, cwd: string): string {
	return join(getProjectRoot(configPath, cwd), WORKFLOWS_MANIFEST_FILE_NAME);
}

function normalizeNode(value: unknown): WorkflowRecordNode | undefined {
	if (!value || typeof value !== "object") return undefined;
	const raw = value as Record<string, unknown>;
	if (typeof raw.id !== "string" || !raw.id) return undefined;
	if (typeof raw.agent !== "string" || !raw.agent) return undefined;
	if (typeof raw.state !== "string" || !NODE_STATES.has(raw.state as RecordedNodeState)) return undefined;
	return {
		id: raw.id,
		agent: raw.agent,
		task: typeof raw.task === "string" ? raw.task : "",
		dependsOn: Array.isArray(raw.dependsOn)
			? raw.dependsOn.filter((dep): dep is string => typeof dep === "string")
			: [],
		state: raw.state as RecordedNodeState,
		...(typeof raw.runId === "number" && Number.isInteger(raw.runId) && raw.runId > 0 ? { runId: raw.runId } : {}),
		...(typeof raw.error === "string" && raw.error ? { error: raw.error } : {}),
	};
}

function normalizeRecord(value: unknown): WorkflowRecord | undefined {
	if (!value || typeof value !== "object") return undefined;
	const raw = value as Record<string, unknown>;
	if (typeof raw.workflowId !== "number" || !Number.isInteger(raw.workflowId) || raw.workflowId < 1) return undefined;
	if (typeof raw.name !== "string" || !raw.name) return undefined;
	if (typeof raw.cwd !== "string" || !raw.cwd || !isAbsolute(raw.cwd)) return undefined;
	if (raw.cwd !== resolve(raw.cwd)) return undefined;
	if (raw.state !== "running" && raw.state !== "stopped" && raw.state !== "interrupted") return undefined;
	if (typeof raw.startedAt !== "number" || typeof raw.updatedAt !== "number") return undefined;
	if (!Array.isArray(raw.nodes)) return undefined;
	const nodes = raw.nodes.map(normalizeNode);
	if (nodes.some((node) => node === undefined)) return undefined;
	return {
		workflowId: raw.workflowId,
		name: raw.name,
		...(typeof raw.description === "string" && raw.description ? { description: raw.description } : {}),
		cwd: raw.cwd,
		state: raw.state,
		startedAt: raw.startedAt,
		updatedAt: raw.updatedAt,
		...(typeof raw.stopReason === "string" && raw.stopReason ? { stopReason: raw.stopReason } : {}),
		nodes: nodes as WorkflowRecordNode[],
	};
}

async function readManifestRecords(path: string): Promise<WorkflowRecord[]> {
	try {
		const parsed = JSON.parse(await readFile(path, "utf8")) as { records?: unknown };
		if (!Array.isArray(parsed.records)) return [];
		return parsed.records.flatMap((record) => {
			const normalized = normalizeRecord(record);
			return normalized ? [normalized] : [];
		});
	} catch {
		return [];
	}
}

async function writeManifest(path: string, records: readonly WorkflowRecord[]): Promise<void> {
	if (records.length === 0) {
		await rm(path, { force: true });
		return;
	}
	await mkdir(dirname(path), { recursive: true });
	const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`;
	try {
		const manifest: WorkflowsManifest = { version: WORKFLOWS_MANIFEST_VERSION, records: [...records] };
		await writeFile(temporaryPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
		await rename(temporaryPath, path);
	} finally {
		await rm(temporaryPath, { force: true }).catch(() => undefined);
	}
}

export async function upsertWorkflowRecord(configPath: string, record: WorkflowRecord): Promise<void> {
	const path = getWorkflowsManifestPath(configPath, record.cwd);
	await withFileMutationQueue(path, async () => {
		const records = await readManifestRecords(path);
		const index = records.findIndex((candidate) => candidate.workflowId === record.workflowId);
		const merged: WorkflowRecord = index === -1
			? record
			: { ...record, startedAt: records[index]!.startedAt };
		if (index === -1) records.push(merged);
		else records[index] = merged;
		await writeManifest(path, records);
	});
}

export async function removeWorkflowRecord(configPath: string, workflowId: number, cwd: string): Promise<void> {
	const path = getWorkflowsManifestPath(configPath, cwd);
	await withFileMutationQueue(path, async () => {
		const records = await readManifestRecords(path);
		const next = records.filter((record) => record.workflowId !== workflowId);
		if (next.length === records.length) return;
		await writeManifest(path, next);
	});
}

/** Records for one checkout, newest first. */
export async function readWorkflowRecords(configPath: string, cwd: string): Promise<WorkflowRecord[]> {
	const path = getWorkflowsManifestPath(configPath, cwd);
	const records = (await readManifestRecords(path)).filter(
		(record) => process.platform === "win32"
			? record.cwd.toLowerCase() === resolve(cwd).toLowerCase()
			: record.cwd === resolve(cwd),
	);
	return records.sort((left, right) => right.updatedAt - left.updatedAt);
}

/** Drop records no longer worth explaining. Runs at session start. */
export async function pruneWorkflowRecords(configPath: string, now = Date.now()): Promise<void> {
	let projects: string[];
	try {
		projects = readdirSync(getSubagentsRoot(configPath), { withFileTypes: true })
			.filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
			.map((entry) => join(getSubagentsRoot(configPath), entry.name, WORKFLOWS_MANIFEST_FILE_NAME));
	} catch {
		return;
	}
	for (const path of projects) {
		await withFileMutationQueue(path, async () => {
			const records = await readManifestRecords(path);
			const kept = records.filter((record) => now - record.updatedAt <= PARKED_RECORD_MAX_AGE_MS);
			if (kept.length !== records.length) await writeManifest(path, kept);
		});
	}
}
