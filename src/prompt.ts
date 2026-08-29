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
	const hasWorker = agents.some((agent) => agent.name === "worker");
	const hasCleaner = agents.some((agent) => agent.name === "cleaner");
	const hasDocumenter = agents.some((agent) => agent.name === "documenter");
	const hasReviewer = agents.some((agent) => agent.name === "reviewer");
	const hasSynthesizer = agents.some((agent) => agent.name === "synthesizer");
	const codeWriterNames = [
		...(hasWorker ? ["worker"] : []),
		...(hasCleaner ? ["cleaner"] : []),
	];

	const dispatchRules = [
		`Delegate aggressively: child contexts are cheap, yours is scarce. Inline only trivial work — a lookup, a single focused edit, an answer already in context${hasWorker ? "; default every non-trivial implementation, fix, refactor, or test task to `worker`" : ""}.`,
		...(hasExplorer
			? [
				"`explorer`: split a broad question into parallel explorers with disjoint scopes. Its findings are leads, never proof — re-read load-bearing files before acting yourself (a child you brief re-verifies).",
			]
			: []),
		...(hasCleaner
			? ["`cleaner`: dispatch for requested cleanup AND proactively when finished work leaves dead code or duplication in scope. Your brief is its edit authorization — every safe proven cut applies without per-item approval; never a gate."]
			: []),
		...(hasDocumenter
			? ["`documenter`: standalone docs/comment work; dispatch it proactively when a change — yours or a child's — leaves README/docs/comment drift no writer already synced; cheap and may make zero edits."]
			: []),
		...(hasReviewer
			? [
				`\`reviewer\`: read-only assessments and gates${codeWriterNames.length > 0 ? `; successful ${codeWriterNames.join("/")} runs get one fresh gate, and failing gates are fixed by the reviewer itself in bounded fix/re-review rounds (a still-failing gate returns to you). Pass \`review: "none"\` for mechanical, low-risk edits you verify yourself; keep the default gate whenever behavior can change` : ""}. Advisory output has no VERDICT and cannot authorize edits.`,
			]
			: []),
		...(hasSynthesizer
			? ["`synthesizer`: after a wide fan-out, pass the result-artifact paths to one synthesizer and read its brief instead of every result yourself."]
			: []),
		`Parallelize by default: map the todo list onto ONE \`tasks\` dispatch. One child owns one deliverable and its files; only genuinely dependent work waits for its prerequisite.`,
		"Brief each child completely — goal, exact paths, constraints, expected output; it has no conversation memory and cannot delegate. Resume parked threads with `subagent_control resume`.",
	];

	const handoffRules = [
		"Dispatch never blocks or ends your turn — keep working; each completion resumes you automatically. Never sleep or poll for it.",
		"Results are already shown; add only your conclusion or next action, never a restatement.",
		"Never declare the overall task done while a dispatched run is still active — completions name the runs still working.",
	];

	const verificationRules = [
		"Never report an unrun check as passed; surface unavailable checks and pre-existing failures, and inspect actual changes before reporting completion.",
		...(hasReviewer
			? [
				"A REVIEW_FAIL from a gate you dispatched directly returns its findings to you: fix them inline or via a briefed worker without waiting for the user, then re-verify ONCE. If the gate still fails, report the remaining findings and move on — never loop gate dispatches.",
				"Multi-model cross-review only when explicitly requested or for high-risk security, FFI, migration, or concurrency changes.",
			]
			: []),
		"Commit or push only when explicitly requested, applicable checks pass, and no review finding remains unresolved.",
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

Review and verification:
${bullets(verificationRules)}`;
}
