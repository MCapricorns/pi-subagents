/**
 * Builds the delegation directive injected into the parent model's system prompt
 * via the `before_agent_start` hook. This is the lever that makes the main model
 * actually USE the subagent tool proactively (pi never shows it the per-agent
 * descriptions otherwise).
 *
 * The directive is a self-contained replacement for the "Sub-agent Dispatch" and
 * "Review, Verification & Commit" sections users otherwise keep in a global
 * AGENTS.md — so installing this extension lets them delete those sections without
 * losing the behavior. (Other AGENTS.md sections — Behavior, Git & Security,
 * platform/language rules — are unrelated and stay put.)
 */

import type { AgentConfig } from "./agents.ts";
import { formatCatalogEntry } from "./agents.ts";

/** Compact role routing hints, emitted only for roles that are enabled. */
const ROLE_ROUTING: Record<string, string> = {
	explore: "explore — broad/open-ended code search, \"where is X\", multi-file lookups (read-only, cheap).",
	plan: "plan — a separate, human-reviewable implementation plan before any code (read-only).",
	worker: "worker — implement/fix/refactor/test a well-scoped task (full tools; plans internally).",
	reviewer: "reviewer — adversarial pre-commit review of a diff (read-only; independent context).",
};

export function buildDelegationDirective(agents: AgentConfig[]): string {
	if (agents.length === 0) return "";

	const catalog = agents.map(formatCatalogEntry).join("\n");
	const routing = agents
		.map((a) => ROLE_ROUTING[a.name])
		.filter((line): line is string => Boolean(line))
		.map((line) => `- ${line}`)
		.join("\n");
	const hasReviewer = agents.some((a) => a.name === "reviewer");
	const hasMultiple = agents.length > 1;

	return `
## Sub-agent delegation (pi-subagents)

You have a \`subagent\` tool that runs specialized agents in ISOLATED context windows.
Delegate discrete, self-contained tasks to it instead of doing everything inline, so the
main window stays focused on orchestration, synthesis, and verification.

Available agents:
${catalog}

${routing ? `Routing:\n${routing}\n` : ""}Dispatch discipline:
- Default to delegating every discrete task to a sub-agent; do the orchestration and verification yourself in the main window.
- Only handle inline: pure Q&A, a single trivial edit/lookup, or when the user explicitly says to do it directly. When in doubt, delegate.
- For an already-known or trivial target, use a direct search/read tool (e.g. grep/find/read) — do not over-delegate a one-line lookup.
${hasMultiple ? "- Run INDEPENDENT tasks in parallel: one subagent call with a `tasks` array, and track them with your todo list. Keep dependent work sequential (e.g. explore, then worker, then reviewer).\n" : ""}- Brief each sub-agent as self-contained: goal, exact paths, constraints, expected output. It has NO memory of this conversation.
- Treat delegated agents as leaf workers: do not ask a sub-agent to dispatch another sub-agent; child processes do not have this tool.
- Trust but verify: a sub-agent's summary describes intent, not outcome. Check the actual changes/results before reporting work done.

Review & verification:
- Never report an unrun check as passed; report it as unavailable or as a pre-existing failure.
${hasReviewer ? "- For non-trivial diffs, run one fresh read-only `reviewer` sub-agent before reporting done. Fix only concrete blockers and re-review at most once.\n- Use multi-model cross-review only when explicitly requested or for genuinely high-risk changes (security, unsafe/FFI, persistence-migration, concurrency). Reviewers are read-only; only the main agent edits.\n" : ""}- Commit or push only when explicitly requested, applicable checks pass, and no accepted blockers remain.`;
}
