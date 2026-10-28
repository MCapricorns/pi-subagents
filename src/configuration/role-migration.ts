/** One-time data migration for the role rename. Runtime dispatch accepts only
 * current catalog names; these helpers are used only at storage boundaries. */

export function migrateStoredAgentName(name: string): string {
	if (name === "reviewer") return "sentinel";
	if (name === "critic") return "skeptic";
	return name;
}

/** Valid explicit new settings win; old keys disappear after persistence. */
export function migrateStoredRoleKeys<T>(settings: Record<string, T>): Record<string, T> {
	const migrated = { ...settings };
	for (const [name, value] of Object.entries(settings)) {
		const current = migrateStoredAgentName(name);
		if (current === name) continue;
		if (!Object.hasOwn(migrated, current)) migrated[current] = value;
		delete migrated[name];
	}
	return migrated;
}

function migrateField(value: unknown, key: string): boolean {
	if (!value || typeof value !== "object") return false;
	const record = value as Record<string, unknown>;
	if (typeof record[key] !== "string") return false;
	const name = record[key].trim();
	const current = migrateStoredAgentName(name);
	if (current === name) return false;
	record[key] = current;
	return true;
}

/** Accept saved plans or bare node arrays; never rewrite briefs or node ids. */
export function migrateStoredWorkflowRoles(value: unknown): boolean {
	const nodes = Array.isArray(value) ? value : value && typeof value === "object" ? (value as { nodes?: unknown }).nodes : undefined;
	if (!Array.isArray(nodes)) return false;
	let changed = false;
	for (const node of nodes) changed = migrateField(node, "agent") || changed;
	return changed;
}

/** Thread and workflow manifests retain their ids, leases, and recovery paths. */
export function migrateStoredRecordRoles(value: unknown): boolean {
	if (!value || typeof value !== "object") return false;
	const summary = (value as { resultSummary?: unknown }).resultSummary;
	const threadChanged = migrateField(value, "agentName");
	const summaryChanged = migrateField(summary, "agent");
	const nodesChanged = migrateStoredWorkflowRoles(value);
	return threadChanged || summaryChanged || nodesChanged;
}
