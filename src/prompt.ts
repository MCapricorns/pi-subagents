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
	const codeWriterNames = [
		...(hasWorker ? ["worker"] : []),
		...(hasCleaner ? ["cleaner"] : []),
	];
	const namedWorktreeTargets = [
		...(hasWorker ? ["worker"] : []),
		...(hasCleaner ? ["cleaner"] : []),
		...(hasDocumenter ? ["documenter"] : []),
	];
	const worktreeTargets = namedWorktreeTargets.length === 0
		? "a"
		: namedWorktreeTargets.length === 1
			? `${namedWorktreeTargets[0]} or another`
			: `${namedWorktreeTargets.slice(0, -1).join(", ")}, ${namedWorktreeTargets.at(-1)}, or another`;

	const dispatchRules = [
		`Delegate aggressively: child contexts are cheap, yours is scarce. Inline only trivial work — a one-shot lookup, a single focused edit, an answer already in context${hasWorker ? "; default every non-trivial implementation, fix, refactor, or test task to `worker`" : ""}.`,
		...(hasExplorer
			? [
				"`explorer`: broad or multi-file search. Its findings are leads, never proof — re-read load-bearing files before acting yourself (a child you brief re-verifies). Split a broad question into several parallel explorers with disjoint scopes.",
			]
			: []),
		...(hasCleaner
			? ["`cleaner`: only user-authorized cleanup or dedup; it applies every safe proven cut without per-item approval and is never a gate."]
			: []),
		...(hasDocumenter
			? ["`documenter`: standalone docs/comment work, or syncing real drift a change left — writers already sync what they directly affect."]
			: []),
		...(hasReviewer
			? [
				`\`reviewer\`: read-only assessments and gates${codeWriterNames.length > 0 ? `; successful ${codeWriterNames.join("/")} runs get one fresh gate, and failing gates are fixed by the reviewer itself in bounded fix/re-review rounds that converge on the fixes (a still-failing gate returns to you)` : ""}. Advisory output has no VERDICT and cannot authorize edits.`,
			]
			: []),
		`Parallelize by default: map the todo list onto ONE \`tasks\` dispatch. One child owns one deliverable and its files; only genuinely dependent work waits for its prerequisite.`,
		"Brief each child completely — goal, exact paths, constraints, expected output; it has no conversation memory and cannot delegate. Resume parked threads with `subagent_control resume`.",
		`Request \`isolation: "worktree"\` only for ${worktreeTargets} write-capable agent in a repo with committed HEAD.`,
	];

	const handoffRules = [
		"Dispatch never blocks or ends your turn — keep working; each completion resumes you automatically. Never sleep, poll, or `subagent_wait` to hold the turn.",
		"Results are already shown; add only your conclusion or next action, never a restatement.",
		"Before declaring the overall task done, `subagent_status` must show no active runs.",
	];

	const verificationRules = [
		"Never report an unrun check as passed; surface unavailable checks and pre-existing failures, and inspect actual changes before reporting completion.",
		...(hasReviewer
			? [
				"A REVIEW_FAIL from a gate you dispatched directly returns its findings to you: fix them inline or via a briefed worker without waiting for the user (ask only for genuinely destructive or scope-changing fixes), then re-verify ONCE. If the gate still fails, report the remaining findings and move on — never loop gate dispatches.",
				"Multi-model cross-review only when explicitly requested or for high-risk security, unsafe/FFI, persistence-migration, or concurrency changes.",
			]
			: []),
		"Commit or push only when explicitly requested, applicable checks pass, and no review finding remains unresolved.",
	];

	return `
## Sub-agent delegation (pi-subagents)

\`subagent\` runs isolated leaf Pi child processes in the background; each completion resumes you.

Agents:
${catalog}

Dispatch:
${bullets(dispatchRules)}

Result handoff:
${bullets(handoffRules)}

Review and verification:
${bullets(verificationRules)}`;
}
