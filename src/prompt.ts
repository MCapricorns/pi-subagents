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
		"Route substantive work to sub-agents so your context stays lean for orchestration; inline only trivial work — a one-shot lookup, a single focused read/edit, or an answer already in context.",
		...(hasExplorer
			? [
				"Use `explorer` for any broad or multi-file search; it is a retrieval index, never a gate — its findings are leads, not proof. Before acting on them yourself — editing inline, deleting, or deciding something load-bearing — re-read the files involved; a child you brief re-verifies them in its own context.",
			]
			: []),
		...(hasWorker
			? ["Use `worker` for a self-contained implementation, fix, refactor, or test whose separate context pays for itself."]
			: []),
		...(hasCleaner
			? [
				`Use \`cleaner\` only for user-authorized cleanup or deduplication; it applies every safe proven cut without item-by-item approval, and never runs as a pre-commit gate or by PR count.`,
			]
			: []),
		...(hasDocumenter
			? [
				`Use \`documenter\` directly only for explicit standalone documentation work; a top-level documenter delivers without a gate.${codeWriterNames.length > 0 ? ` The runtime runs the final docs sync after REVIEW_PASS with DOCUMENTATION: NEEDED or a missing marker, or as the reviewer-disabled fallback; writers sync docs they directly affect — never dispatch a duplicate.` : ""}`,
			]
			: []),
		...(hasReviewer
			? [
				`Use \`reviewer\` for read-only assessments or gates.${codeWriterNames.length > 0 ? ` Successful ${codeWriterNames.join("/")} runs already get one fresh gate and then deliver once.` : ""} Advisory output has no VERDICT and cannot authorize edits; dispatch your own re-verification with \`advisory: true\`.`,
			]
			: []),
		"You own the fan-out breadth: every genuinely independent unit goes in one `tasks` array — there is no per-call cap, and extra tasks queue for the next free process slot. One child owns one coherent deliverable and its files; no two children share a file or re-answer the same question; dependent work starts only after its prerequisite delivers.",
		"Brief each child with the complete goal, exact paths, constraints, and expected output; it has no conversation memory and cannot delegate. Continue a parked/settled thread with `subagent_control resume`.",
		`Single tasks share the checkout${hasWorker ? "; parallel workers default to detached Git worktrees" : ""}. Request \`isolation: "worktree"\` only for ${worktreeTargets} write-capable agent in a Git repo with committed HEAD; setup failure never silently falls back to shared.`,
		"A configured child model/provider failure automatically continues the same retained session on the current main model; do not redispatch. Ordinary tool/task failures stay on the selected model.",
	];

	const handoffRules = [
		"Dispatch ends this turn; each completion resumes the main agent automatically — never sleep, poll, or call `subagent_wait` to hold the turn.",
		"Results are already shown; add only your conclusion or next action, never a restatement.",
		"Before declaring the overall task done, use `subagent_status` to confirm that no runs remain active.",
	];

	const verificationRules = [
		"Never report an unrun check as passed; surface unavailable checks and pre-existing failures honestly, and inspect actual changes before reporting completion.",
		...(hasReviewer
			? [
				...(hasDocumenter
					? [
						"A direct REVIEW_PASS with DOCUMENTATION: CLEAN delivers immediately; NEEDED or a missing marker runs one documentation sync.",
					]
					: []),
				"A REVIEW_FAIL — direct or from a managed gate — returns the findings to you: resolve them yourself, inline or via a worker you brief, without waiting for the user; the runtime never auto-fixes. Ask only for genuinely destructive or scope-changing fixes. Advisory reports cannot trigger writes.",
				"Use multi-model cross-review only when explicitly requested or for genuinely high-risk security, unsafe/FFI, persistence-migration, or concurrency changes.",
			]
			: []),
		"Commit or push only when explicitly requested, applicable checks pass, and no review finding remains unresolved.",
	];

	return `
## Sub-agent delegation (pi-subagents)

The \`subagent\` tool runs isolated leaf Pi child processes and context windows; each completion automatically resumes the main agent.

Agents:
${catalog}

Dispatch:
${bullets(dispatchRules)}

Result handoff:
${bullets(handoffRules)}

Review and verification:
${bullets(verificationRules)}`;
}
