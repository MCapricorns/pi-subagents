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
	const reviewedWriterNames = [...codeWriterNames];
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
	const managedWriterWorkflowRule = reviewedWriterNames.length === 0
		? undefined
		: hasReviewer && hasDocumenter
			? `Successful top-level ${reviewedWriterNames.join("/")} runs continue through the enabled reviewer gate. Only REVIEW_PASS can authorize documenter, which runs for DOCUMENTATION: NEEDED or a missing marker; the workflow delivers once. Never duplicate stages.`
			: hasReviewer
				? `Successful top-level ${reviewedWriterNames.join("/")} runs continue through the enabled reviewer gate and then deliver once; never duplicate the gate.`
				: hasDocumenter
					? `With reviewer disabled, successful top-level ${reviewedWriterNames.join("/")} runs use documenter as the conservative final fallback and then deliver once; never duplicate the fallback.`
					: undefined;

	const dispatchRules = [
		"Keep small, known-target work in the main thread with direct tools: lookups and focused reads/edits do not justify a child context.",
		...(hasExplorer
			? [
				"Use `explorer` proactively only for broad or cross-file reconnaissance: mapping unfamiliar code, tracing symbols/dependencies, or finding multi-file references. It is a lightweight retrieval index, never an automatic gate. Re-read load-bearing files before edits or high-risk decisions. Use a stronger model/specialist for dynamic, concurrent, migration, or security analysis.",
			]
			: []),
		...(hasWorker
			? ["Use `worker` for a self-contained implementation, fix, refactor, or test whose separate context pays for itself—not a small known-target edit."]
			: []),
		...(hasCleaner
			? [
				`Use \`cleaner\` only as the separate evidence-first entry for user-authorized cleanup, removal, simplification, duplicate-code consolidation, or maintenance; never substitute it for \`worker\`. It applies every safe proven in-scope cut without item-by-item approval. Generic or read-only audit, review, code-health, plan, or cleanup-candidate assessment goes to ${hasReviewer ? "`reviewer`" : "direct main-context inspection because `reviewer` is disabled"}. Never dispatch cleaner by PR count or as the pre-commit gate.`,
			]
			: []),
		...(hasDocumenter
			? [
				`Use \`documenter\` directly only for explicit whole-codebase maintenance or standalone documentation/comment work; a top-level documenter delivers directly without an automatic reviewer.${codeWriterNames.length > 0 ? ` ${codeWriterNames.join("/")} must sync existing docs they directly affect; runtime runs documenter only after REVIEW_PASS with DOCUMENTATION: NEEDED or a missing marker, or as the reviewer-disabled fallback—never dispatch a duplicate.` : ""} It never changes runtime behavior, versions, or release state.`,
			]
			: []),
		...(hasReviewer
			? [
				`Use \`reviewer\` for read-only assessments or a gate.${reviewedWriterNames.length > 0 ? ` Successful ${reviewedWriterNames.join("/")} runs already get one fresh read-only reviewer gate, independent of the writer.` : ""} Advisory output has no VERDICT and cannot authorize follow-up edits${hasDocumenter ? "; gates classify docs separately for the enabled documenter." : "."}`,
			]
			: []),
		"Brief each child with the complete goal, exact paths, constraints, and expected output; it has no conversation memory.",
		"Children are leaf processes without delegation tools; use `subagent_control fork` on a parked/settled thread for an independent continuation.",
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
		"Dispatch ends this turn; results resume the main agent, even mid-turn. Never sleep, poll, or call `subagent_wait` to hold the turn.",
		"Use `subagent_wait` with explicit `timeoutMs` only when the user asks to wait in-turn; its default lookup is non-blocking.",
		"Results are already shown. Do not restate, paraphrase, or re-summarize them; add only your conclusion or next action.",
		"A delivered result does not mean siblings are finished. Before declaring the overall task done, use `subagent_status` to confirm that no runs remain active.",
	];

	const verificationRules = [
		"Never report an unrun check as passed; identify unavailable checks and pre-existing failures honestly.",
		...(managedWriterWorkflowRule ? [managedWriterWorkflowRule] : []),
		...(hasReviewer
			? [
				...(hasDocumenter
					? [
						`A direct REVIEW_PASS with DOCUMENTATION: CLEAN delivers immediately; NEEDED or a missing marker runs one documentation sync. A direct REVIEW_FAIL ${autoFixEnabled ? "keeps bounded worker/reviewer auto-fix, with docs considered only after its terminal REVIEW_PASS." : "cannot start fixes while worker/fix rounds are disabled."}`,
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

The \`subagent\` tool starts isolated Pi child processes and context windows. Completions automatically resume the main agent.

Available agents:
${catalog}

Dispatch:
${bullets(dispatchRules)}

Result handoff:
${bullets(handoffRules)}

Review and verification:
${bullets(verificationRules)}`;
}
