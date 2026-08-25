/**
 * Builds the authoritative delegation directive injected into the parent model's
 * system prompt via `before_agent_start`. Tool metadata stays intentionally
 * minimal so role/process guidance is not paid for twice.
 */

import type { AgentConfig } from "./agents.ts";
import { formatCatalogEntry } from "./agents.ts";

function bullets(lines: readonly string[]): string {
	return lines.map((line) => `- ${line}`).join("\n");
}

export function buildDelegationDirective(
	agents: AgentConfig[],
	options: { maxFixRounds?: number } = {},
): string {
	if (agents.length === 0) return "";

	const catalog = agents.map(formatCatalogEntry).join("\n");
	const hasExplorer = agents.some((agent) => agent.name === "explorer");
	const hasWorker = agents.some((agent) => agent.name === "worker");
	const hasCleaner = agents.some((agent) => agent.name === "cleaner");
	const hasDocumenter = agents.some((agent) => agent.name === "documenter");
	const hasReviewer = agents.some((agent) => agent.name === "reviewer");
	const hasMultiple = agents.length > 1;
	const autoFixEnabled = hasWorker && (options.maxFixRounds ?? 1) > 0;
	const codeWriterNames = [
		...(hasWorker ? ["worker"] : []),
		...(hasCleaner ? ["cleaner"] : []),
	];
	const reviewedWriterNames = [
		...codeWriterNames,
		...(hasDocumenter ? ["documenter"] : []),
	];
	const automaticWriterRoute = [
		...(hasReviewer ? ["reviewer"] : []),
		...(hasDocumenter ? ["documenter"] : []),
	].join(" → ");
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
		"Handle simple work inline with direct tools: one-line lookups, known-target reads/edits, and quick questions do not justify a child process.",
		...(hasExplorer
			? [
				"Use `explorer` proactively when reconnaissance becomes broad or crosses files: mapping unfamiliar code, tracing symbols/dependencies, or answering multi-file location/reference questions. Treat its output only as a retrieval index; re-read load-bearing files before edits or decisions about deletion, security, compatibility, persistence, or dynamic reachability. Use a stronger model/specialist for complex dynamic, concurrent, migration, or security-sensitive analysis.",
			]
			: []),
		...(hasWorker
			? ["Use `worker` for a self-contained implementation, fix, refactor, or test task whose separate context pays for itself."]
			: []),
		...(hasCleaner
			? [
				`Use \`cleaner\` only for user-authorized cleanup, removal, simplification, duplicate-code consolidation, or maintenance. Once dispatched, it applies every safe proven in-scope cut without item-by-item approval; zero edits is valid only if none is proved. Generic or read-only audit, review, code-health, plan, or cleanup-candidate assessment goes to ${hasReviewer ? "`reviewer`" : "direct main-context inspection because `reviewer` is disabled"}. Never dispatch cleaner by PR count or as the pre-commit gate.`,
			]
			: []),
		...(hasDocumenter
			? [
				`Use \`documenter\` directly for explicit whole-codebase maintenance or standalone documentation work.${codeWriterNames.length > 0 ? ` Successful ${codeWriterNames.join("/")} runs already auto-sync the actual diff once after the review gate; never dispatch a duplicate.` : ""} Zero edits is valid and broad mode is never inferred. It changes docs/comments only and never runtime behavior, versions, or release state.`,
			]
			: []),
		...(hasReviewer
			? [
				`Use \`reviewer\` for read-only assessments or an explicit gate.${reviewedWriterNames.length > 0 ? ` Successful ${reviewedWriterNames.join("/")} runs already get a fresh read-only reviewer gate.` : ""} Advisory output has no VERDICT: it stays read-only and does not authorize follow-up edits.`,
			]
			: []),
		"Brief every child with the complete goal, exact paths, constraints, and expected output. It has no memory of this conversation.",
		"Children are leaf processes without delegation tools. Do not ask them to spawn sub-agents; use `subagent_control fork` on a parked/settled retained thread for an independent continuation.",
		...(hasMultiple
			? [
				"Dispatch independent work in one `tasks` array and let the resumed main agent start dependent work only after prerequisites finish.",
			]
			: []),
		`Filesystem isolation: single tasks default to shared${hasWorker ? "; parallel worker tasks default to detached Git worktrees" : ""}${hasCleaner ? "; cleaner defaults to shared" : ""}${hasDocumenter ? "; documenter defaults to shared" : ""}. Request \`isolation: "worktree"\` only for ${worktreeTargets} write-capable agent in a Git repository with committed HEAD. Read-only agents reject it, and setup/integration failure never falls back silently to shared.`,
		"A configured child model/provider failure automatically continues the same retained session on the current main model; do not redispatch. Ordinary tool/task failures stay on the selected model.",
		"Trust but verify: inspect actual changes/results before reporting completion.",
	];

	const handoffRules = [
		"Dispatch returns immediately and ends this turn. Never sleep, poll, or call `subagent_wait` to hold the turn; results arrive as messages that automatically resume the main agent, even mid-turn.",
		"Use `subagent_wait` with explicit `timeoutMs` only when the user specifically asks you to remain in-turn and wait. Its default lookup is non-blocking.",
		"A result is already shown to the user. Do not restate, paraphrase, or re-summarize it; add only your conclusion or next action, often one line.",
		"A delivered result does not mean siblings are finished. Before declaring the overall task done, use `subagent_status` to confirm that no runs remain active.",
	];

	const verificationRules = [
		"Never report an unrun check as passed; identify unavailable checks and pre-existing failures honestly.",
		...(automaticWriterRoute && reviewedWriterNames.length > 0
			? [
				`Successful top-level write roles automatically continue through enabled downstream roles (${automaticWriterRoute}) to one final delivery; never duplicate stages.`,
			]
			: []),
		...(hasReviewer
			? [
				...(hasDocumenter
					? [
						`A direct REVIEW_PASS is final for code: runtime runs the final documentation sync once and delivers. A direct REVIEW_FAIL ${autoFixEnabled ? "keeps auto-fix; maxFixRounds limits worker fixes only, not the final documentation sync." : "cannot start fixes while worker/fix rounds are disabled."}`,
					]
					: []),
				"Resolve every gate finding; do not bypass the configured auto-fix/re-review cap. A reviewer report without a standalone VERDICT is advisory and cannot trigger writes.",
				"Use multi-model cross-review only when explicitly requested or for genuinely high-risk security, unsafe/FFI, persistence-migration, or concurrency changes.",
			]
			: []),
		"Commit or push only when explicitly requested, applicable checks pass, and no review finding remains unresolved.",
	];

	return `
## Sub-agent delegation (pi-subagents)

The \`subagent\` tool starts specialized leaf agents in isolated Pi child processes and context windows. It returns immediately; completion messages automatically resume the main agent.

Available agents:
${catalog}

Dispatch:
${bullets(dispatchRules)}

Result handoff:
${bullets(handoffRules)}

Review and verification:
${bullets(verificationRules)}`;
}
