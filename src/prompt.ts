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
	explore: "explore — codebase reconnaissance: broad/open-ended search, multi-file lookups, mapping unfamiliar code, tracing symbols/dependencies (read-only, cheap fast model); NOT for one-line lookups.",
	worker: "worker — implement/fix/refactor/test a self-contained task worth a separate context (full tools; plans internally).",
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
- Use \`explore\` PROACTIVELY for codebase reconnaissance: mapping an unfamiliar area, multi-file lookups, tracing symbols across modules, or any "where is X / which files reference Y" question that would take several greps or reading multiple files. It runs on a fast cheap model and returns compressed findings, so delegating recon costs little.
- Delegate only when isolation genuinely pays: a self-contained implementation/fix with its own validation (worker), or a fresh-context review gate (reviewer).
- When in doubt, start with a direct tool call in the main context; escalate to \`explore\` as soon as the search turns broad or crosses multiple files.
- For an already-known or trivial target, use a direct search/read tool (e.g. grep/find/read) — do not over-delegate a one-line lookup.
${hasMultiple ? "- Run INDEPENDENT tasks in parallel: one subagent call with a `tasks` array, and track them with your todo list. Let the automatically resumed main agent launch dependent work only after its prerequisite result arrives (e.g. explore, then worker, then reviewer).\n" : ""}- Brief each sub-agent as self-contained: goal, exact paths, constraints, expected output. It has NO memory of this conversation.
- Treat delegated agents as leaf workers: do not ask a sub-agent to dispatch another sub-agent; child processes do not have this tool.
- Trust but verify: a sub-agent's summary describes intent, not outcome. Check the actual changes/results before reporting work done.

Review & verification:
- Never report an unrun check as passed; report it as unavailable or as a pre-existing failure.
${hasReviewer ? "- For non-trivial diffs, run one fresh read-only `reviewer` sub-agent before reporting done. Fix only concrete blockers and re-review at most once.\n- Use multi-model cross-review only when explicitly requested or for genuinely high-risk changes (security, unsafe/FFI, persistence-migration, concurrency). Reviewers are read-only; only the main agent edits.\n" : ""}- Commit or push only when explicitly requested, applicable checks pass, and no accepted blockers remain.`;
}
