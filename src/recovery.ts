/** Durable handoff for worktree integration/cleanup failures across sessions. */

import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { removeWorktreeGroup, worktreeGroupDir, type WorktreeFinalization } from "./worktree.ts";

export const RECOVERY_MANIFEST_FILE_NAME = "pi-subagents-recovery.json";
const RECOVERY_MANIFEST_VERSION = 1;

export interface RecoveryRecord {
	runId: number;
	createdAt: number;
	integrated: boolean;
	/** Repository a cleanup retry can prune stale worktree metadata against. */
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
	return join(dirname(configPath), RECOVERY_MANIFEST_FILE_NAME);
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

export async function readRecoveryRecords(configPath: string): Promise<RecoveryRecord[]> {
	try {
		const parsed = JSON.parse(await readFile(getRecoveryManifestPath(configPath), "utf8")) as {
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
		for (const record of await readRecoveryRecords(configPath)) merged.set(recoveryKey(record), record);
		for (const record of records) merged.set(recoveryKey(record), record);
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
		const groupDir = worktreeGroupDir(record.worktreePath);
		if (!groupDir) continue;
		if (!existsSync(record.worktreePath) && !(record.patchPath ? existsSync(record.patchPath) : false)) continue;
		await removeWorktreeGroup({
			originalRoot: record.originalRoot,
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
