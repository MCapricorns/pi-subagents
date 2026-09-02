/**
 * Builds the delegation directive injected into the parent model's
 * system prompt via `before_agent_start`. It is paid on every turn, so it
 * stays a lean routing contract — when a child context pays for itself,
 * how wide to fan out, and how results come back. Tool metadata stays
 * intentionally minimal so role/process guidance is not paid for twice.
 */

import type { AgentConfig } from "./agents.ts";
import { formatCatalogEntry } from "./agents.ts";

function bullets(lines: readonly string[]): string {
	return lines.map((line) => `- ${line}`).join("\n");
}

export function buildDelegationDirective(
	agents: AgentConfig[],
): string {
	if (agents.length === 0) return "";

	const catalog = agents.map(formatCatalogEntry).join("\n");
	const hasExplorer = agents.some((agent) => agent.name === "explorer");
	const hasExecutor = agents.some((agent) => agent.name === "executor");

	const dispatchRules = [
		`Delegate aggressively: child contexts are cheap, yours is scarce. A unit is delegable when it can proceed independently and return a compact result${hasExecutor ? "; when both hold, default it to `executor`" : ""}.`,
		"Keep inline what fails either test — a lookup, a single focused edit, an answer already in context, or a single artifact you must absorb yourself (one issue, one spec), where delegation saves search, not that read. Cluster related questions into one brief instead of firing many small dispatches; a child loses context between runs.",
		...(hasExplorer
			? [
				"`explorer`: split a broad question into parallel explorers with disjoint scopes. Its findings are leads, never proof — re-read the cited line ranges before acting on them (a child you brief re-verifies).",
			]
			: []),
		...(hasExecutor
			? [
				"`executor`: brief it as the edit authorization. For cleanup, name the scope (uncommitted diff, Git range, directory) — every safe proven cut applies without per-item approval; finding no safe cut is a valid result. After a wide fan-out, pass the result-artifact paths to one executor and read its merged brief instead of every result yourself.",
			]
			: []),
		"Parallelize by default: map the todo list onto ONE `tasks` dispatch. One child owns one deliverable and its files; only genuinely dependent work waits for its prerequisite.",
		"Brief each child completely — goal, exact paths, constraints, expected output; it has no conversation memory and cannot delegate. Resume parked threads with `subagent_control resume`.",
	];

	const handoffRules = [
		"Dispatch never blocks or ends your turn — keep working; each completion resumes you automatically. Never sleep or poll for it.",
		"Results are already shown; add only your conclusion or next action, never a restatement.",
		"Never declare the overall task done while a dispatched run is still active.",
	];

	const verificationRules = [
		"Never report an unrun check as passed; surface unavailable checks and pre-existing failures, and inspect the actual diff before reporting completion.",
		"Commit or push only when explicitly requested and applicable checks pass.",
	];

	return `
## Sub-agent delegation (pi-subagents)

\`subagent\` runs isolated leaf Pi child processes in the background.

Agents:
${catalog}

Dispatch:
${bullets(dispatchRules)}

Result handoff:
${bullets(handoffRules)}

Verification:
${bullets(verificationRules)}`;
}
