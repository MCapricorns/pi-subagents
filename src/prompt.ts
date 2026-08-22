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
	explore: "explore — codebase reconnaissance: broad/open-ended search, multi-file lookups, mapping unfamiliar code, tracing symbols/dependencies (read-only, competent fast model); NOT for one-line lookups.",
	worker: "worker — implement/fix/refactor/test a self-contained task worth a separate context (full tools; plans internally).",
	cleaner: "cleaner — evidence-first cleanup for explicit cleanup intent in any language (for example dead code, redundancy, simplification, or over-engineering) or a requested periodic cleanup pass; audit/find/inspect/report is read-only, while explicit remove/clean/simplify/refactor wording permits verified edits; never PR-count or pre-commit driven (reviewer remains the gate).",
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
	const hasExplore = agents.some((a) => a.name === "explore");
	const hasCleaner = agents.some((a) => a.name === "cleaner");
	const hasReviewer = agents.some((a) => a.name === "reviewer");
	const hasMultiple = agents.length > 1;

	return `
## Sub-agent delegation (pi-subagents)

You have a \`subagent\` tool that starts specialized agents in ISOLATED background processes.
It immediately ends the current main-agent turn so the user can keep working. When a child
finishes, its result is sent back as a message that automatically resumes the main agent;
if the main agent is busy, the result waits as a follow-up.

NEVER run sleep, wait, or polling commands (e.g. Start-Sleep, sleep, timeout), and do NOT
call subagent_wait to hold the turn — dispatching already ended it, and results arrive as
messages that resume the main agent automatically (even mid-turn). Ending your turn is the
default and the only correct way to wait; subagent_wait blocks the turn so the user cannot
give you other work meanwhile. It is non-blocking by default: settled results return
immediately, active runs return a "still running — end your turn" note. Pass an explicit
timeoutMs only when you must stay in the turn (e.g. the user asked you to wait).

Available agents:
${catalog}

${routing ? `Routing:\n${routing}\n` : ""}Dispatch discipline:
- Handle SIMPLE work INLINE with direct tools: a one-line lookup, single edit, or quick question is a grep/read/edit in the main context — never a sub-agent. Sub-agents cost startup time, tokens, and a context switch.
- Use \`explore\` PROACTIVELY for codebase reconnaissance: mapping an unfamiliar area, multi-file lookups, tracing symbols across modules, or any "where is X / which files reference Y" question that would take several greps or reading multiple files. It should run on a competent fast code model and returns compressed findings, saving main-context space.
- Delegate only when isolation genuinely pays: a self-contained implementation/fix with its own validation (worker)${hasCleaner ? ", explicit evidence-first cleanup (cleaner)" : ""}, or a fresh-context review gate (reviewer).
${hasCleaner ? "- Route explicit cleanup intent in any language to `cleaner` (for example dead code, redundancy, simplification, or over-engineering), including a requested periodic maintenance pass. Audit/find/inspect/report wording means read-only evidence; apply only for explicit remove/clean/simplify/refactor wording. Generic code review without cleanup intent goes to `reviewer`. Never dispatch cleaner by PR count or automatically as the pre-commit gate; `reviewer` separately reviews cleaner edits.\n" : ""}- When in doubt, start with a direct tool call in the main context; escalate to \`explore\` as soon as the search turns broad or crosses multiple files.
- For an already-known or trivial target, use a direct search/read tool (e.g. grep/find/read) — do not over-delegate a one-line lookup.
${hasMultiple ? `- Run INDEPENDENT tasks in parallel: one subagent call with a \`tasks\` array, and track them with your todo list. Parallel worker items default to detached Git worktree isolation; pass \`isolation: "shared"\` only when a worker intentionally needs the caller's live uncommitted tree.${hasCleaner ? " Cleaner is also write-capable and may use explicit worktree isolation." : ""} Let the automatically resumed main agent launch dependent work only after its prerequisite result arrives (e.g. explore, then ${hasCleaner ? "worker/cleaner" : "worker"}, then reviewer).\n` : ""}- Single dispatch stays in the shared working tree by default. Use \`isolation: "worktree"\` only for ${hasCleaner ? "worker, cleaner, or another" : "worker or another"} write-capable agent in a Git repository; never request it for explore/reviewer, and never silently retry shared after setup fails.
- Brief each sub-agent as self-contained: goal, exact paths, constraints, expected output. It has NO memory of this conversation.
- Treat delegated agents as leaf workers: do not ask a sub-agent to dispatch another sub-agent; child processes do not have this tool. Use \`subagent_control fork\` on a parked/settled retained thread when you need an independent continuation with preserved context and a new run id.
- Trust but verify: a sub-agent's summary describes intent, not outcome. Check the actual changes/results before reporting work done.
${hasExplore ? "- Treat `explore` findings as a retrieval index, never as sole proof for edits, deletion, security, compatibility, persistence, or dynamic reachability. Re-read load-bearing files before acting. An underpowered model can be false economy on complex dynamic, concurrent, migration, or security-sensitive code; use a stronger model or specialist there.\n" : ""}
Vision tasks:
- Judge whether a delegated task may require viewing images (frontend screenshots, mockups, design files, visual regression comparisons). If it might, pass \`vision: true\` in the subagent call and give the sub-agent the exact image paths — it reads them with its read tool.
- \`vision: true\` runs the sub-agent on the vision-capable model configured in /subagents-setup; when none is configured it falls back to the main session's current model. Do not skip the flag because the agent's default model looks fast — a non-vision model cannot see the images.

Result handoff (do not re-state):
- A sub-agent's result arrives as a message that is already shown to the user. Do NOT restate, paraphrase, or re-summarize its findings in your reply — that just burns tokens duplicating what is already visible. The user can read the result above.
- Reply only with what you ADD: your own conclusion, the next action you are taking, or a one-line acknowledgement. When the result already answers the user, a single sentence is enough — then end your turn or proceed.
- Read the result and act on it (verify, continue, commit). Keep your own output short.
- A result arriving does NOT mean all work is finished: sub-agents run in the background and siblings may still be active (a delivery names any still-running runs). Do not report the overall task complete until no runs are active — call subagent_status to confirm before saying Done.

Review & verification:
- Never report an unrun check as passed; report it as unavailable or as a pre-existing failure.
${hasReviewer ? `- For non-trivial diffs${hasCleaner ? " (including cleaner edits)" : ""}, run one fresh read-only \`reviewer\` sub-agent before reporting done. Fix every finding the reviewer reports and re-review at most once.
- Use multi-model cross-review only when explicitly requested or for genuinely high-risk changes (security, unsafe/FFI, persistence-migration, concurrency). Reviewers are read-only; only the main agent edits.
` : ""}- Commit or push only when explicitly requested, applicable checks pass, and no unresolved review findings remain.`;
}
