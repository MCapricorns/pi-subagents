/** Durable handoff for worktree integration/cleanup failures across sessions. */

import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { getSubagentsRoot } from "../execution/spawn.ts";
import { managedRecoveryGroup } from "./managed-paths.ts";
import { removeWorktreeGroup, type WorktreeFinalization } from "./worktree.ts";

export const RECOVERY_MANIFEST_FILE_NAME = "pi-subagents-recovery.json";
const RECOVERY_MANIFEST_VERSION = 1;

export interface RecoveryRecord {
	runId: number;
	createdAt: number;
	integrated: boolean;
	/** Legacy diagnostic metadata; cleanup authorization comes only from managed paths. */
	originalRoot?: string;
	worktreePath?: string;
	patchPath?: string;
	error?: string;
}

interface RecoveryManifest {
	version: number;
	records: RecoveryRecord[];
}

export function getRecoveryManifestPath(configPath: string): string {
	return join(getSubagentsRoot(configPath), RECOVERY_MANIFEST_FILE_NAME);
}

function normalizeRecord(value: unknown): RecoveryRecord | undefined {
	if (!value || typeof value !== "object") return undefined;
	const raw = value as Record<string, unknown>;
	if (typeof raw.runId !== "number" || !Number.isInteger(raw.runId) || raw.runId < 1) return undefined;
	if (typeof raw.createdAt !== "number" || !Number.isFinite(raw.createdAt)) return undefined;
	return {
		runId: raw.runId,
		createdAt: raw.createdAt,
		integrated: raw.integrated === true,
		...(typeof raw.originalRoot === "string" && raw.originalRoot ? { originalRoot: raw.originalRoot } : {}),
		...(typeof raw.worktreePath === "string" && raw.worktreePath ? { worktreePath: raw.worktreePath } : {}),
		...(typeof raw.patchPath === "string" && raw.patchPath ? { patchPath: raw.patchPath } : {}),
		...(typeof raw.error === "string" && raw.error ? { error: raw.error } : {}),
	};
}

interface RecoveryManifestRead {
	valid: boolean;
	sourceCount: number;
	records: RecoveryRecord[];
}

async function readManifest(path: string): Promise<RecoveryManifestRead> {
	try {
		const parsed = JSON.parse(await readFile(path, "utf8")) as { records?: unknown };
		if (!Array.isArray(parsed.records)) return { valid: false, sourceCount: 0, records: [] };
		return {
			valid: true,
			sourceCount: parsed.records.length,
			records: parsed.records.flatMap((record) => {
				const normalized = normalizeRecord(record);
				return normalized ? [normalized] : [];
			}),
		};
	} catch {
		return { valid: false, sourceCount: 0, records: [] };
	}
}

async function validatedRecords(configPath: string, records: readonly RecoveryRecord[]): Promise<RecoveryRecord[]> {
	const groups = await Promise.all(records.map((record) => managedRecoveryGroup(configPath, record)));
	return records.filter((_record, index) => groups[index] !== undefined);
}

export async function referencedRecoveryPaths(
	configPath: string,
	records: readonly RecoveryRecord[],
): Promise<Set<string>> {
	const groups = await Promise.all(records.map((record) => managedRecoveryGroup(configPath, record)));
	return new Set(groups.filter((group): group is string => group !== undefined));
}

export async function readRecoveryRecords(configPath: string): Promise<RecoveryRecord[]> {
	const path = getRecoveryManifestPath(configPath);
	return withFileMutationQueue(path, async () => {
		const manifest = await readManifest(path);
		const records = await validatedRecords(configPath, manifest.records);
		if (!manifest.valid || records.length !== manifest.sourceCount) await writeManifest(path, records);
		return records;
	});
}

/** Move valid records from the previous agent-root manifest into the internal-state
 * root. Invalid legacy records are removed without touching their referenced paths. */
export async function relocateRecoveryManifest(configPath: string): Promise<void> {
	const legacyPath = join(dirname(configPath), RECOVERY_MANIFEST_FILE_NAME);
	const currentPath = getRecoveryManifestPath(configPath);
	if (legacyPath === currentPath || !existsSync(legacyPath)) return;
	await withFileMutationQueue(legacyPath, async () => {
		const legacy = await readManifest(legacyPath);
		if (!legacy.valid) {
			await rm(legacyPath, { force: true });
			return;
		}
		await persistRecoveryRecords(configPath, legacy.records);
		await rm(legacyPath, { force: true });
	});
}

function recoveryKey(record: RecoveryRecord): string {
	return `${record.runId}\0${record.worktreePath ?? ""}\0${record.patchPath ?? ""}\0${record.error ?? ""}`;
}

async function writeManifest(path: string, records: readonly RecoveryRecord[]): Promise<void> {
	if (records.length === 0) {
		await rm(path, { force: true });
		return;
	}
	await mkdir(dirname(path), { recursive: true });
	const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`;
	try {
		const manifest: RecoveryManifest = {
			version: RECOVERY_MANIFEST_VERSION,
			records: [...records],
		};
		await writeFile(temporaryPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
		await rename(temporaryPath, path);
	} finally {
		await rm(temporaryPath, { force: true }).catch(() => undefined);
	}
}

/** Merge retained artifacts into the durable manifest. */
export async function persistRecoveryRecords(
	configPath: string,
	records: readonly RecoveryRecord[],
): Promise<void> {
	if (records.length === 0) return;
	const path = getRecoveryManifestPath(configPath);
	await withFileMutationQueue(path, async () => {
		const merged = new Map<string, RecoveryRecord>();
		const existing = await readManifest(path);
		for (const record of await validatedRecords(configPath, existing.records)) {
			merged.set(recoveryKey(record), record);
		}
		for (const record of await validatedRecords(configPath, records)) {
			merged.set(recoveryKey(record), record);
		}
		await writeManifest(path, [...merged.values()]);
	});
}

export function recoveryRecordFromFinalization(
	runId: number,
	finalization: WorktreeFinalization,
	now = Date.now(),
): RecoveryRecord {
	return {
		runId,
		createdAt: now,
		integrated: finalization.integrated,
		...(finalization.originalRoot ? { originalRoot: finalization.originalRoot } : {}),
		...(finalization.worktreePath ? { worktreePath: finalization.worktreePath } : {}),
		...(finalization.patchPath ? { patchPath: finalization.patchPath } : {}),
		...(finalization.error ? { error: finalization.error } : {}),
	};
}

/** Show retained recovery paths on every later session start until the user
 * removes the artifacts. Records whose changes already landed only need the
 * worktree group deleted — the step whose failure retained them — so each
 * session start retries that removal first and forgets records it completes.
 * Stale records are pruned automatically. */
export async function announceRecoveryRecords(
	configPath: string,
	ctx: {
		hasUI?: boolean;
		ui: { notify(message: string, kind: "info" | "warning" | "error"): void };
	},
): Promise<void> {
	if (ctx.hasUI === false) return;
	const records = await readRecoveryRecords(configPath);
	if (records.length === 0) return;
	for (const record of records) {
		if (!record.integrated || !record.worktreePath) continue;
		const groupDir = await managedRecoveryGroup(configPath, record);
		if (!groupDir) continue;
		if (!existsSync(record.worktreePath) && !(record.patchPath ? existsSync(record.patchPath) : false)) continue;
		await removeWorktreeGroup({
			worktreePath: record.worktreePath,
			tempDir: groupDir,
		});
	}
	const live = records.filter((record) =>
		(record.worktreePath ? existsSync(record.worktreePath) : false) ||
		(record.patchPath ? existsSync(record.patchPath) : false),
	);
	if (live.length !== records.length) {
		const path = getRecoveryManifestPath(configPath);
		await withFileMutationQueue(path, () => writeManifest(path, live)).catch(() => undefined);
	}
	for (const record of live) {
		const paths = [
			record.worktreePath ? `worktree ${stripVTControlCharacters(record.worktreePath)}` : undefined,
			record.patchPath ? `patch ${stripVTControlCharacters(record.patchPath)}` : undefined,
		].filter(Boolean).join(" · ");
		const reason = record.error ? ` · ${stripVTControlCharacters(record.error)}` : "";
		ctx.ui.notify(
			`pi-subagents recovery for run #${record.runId}: ${record.integrated ? "changes were applied but cleanup failed" : "integration failed"}${paths ? ` · retained ${paths}` : ""}${reason}`,
			"error",
		);
	}
}
