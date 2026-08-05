# pi-subagents

[![npm version](https://img.shields.io/npm/v/@ferris1225/pi-subagents?color=blue)](https://www.npmjs.com/package/@ferris1225/pi-subagents)
[![downloads](https://img.shields.io/npm/dm/@ferris1225/pi-subagents)](https://www.npmjs.com/package/@ferris1225/pi-subagents)
[![license](https://img.shields.io/npm/l/@ferris1225/pi-subagents)](./LICENSE)
![platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey)
![pi](https://img.shields.io/badge/pi-extension-orange)

Focused background delegation for [pi](https://pi.dev). `pi-subagents` adds a small set of
specialized agents that run in isolated child processes, report results back to the main
agent, and keep the workflow moving without manual polling.

## Highlights

- **Automatic delegation guidance** — injects the enabled agent catalog and routing rules into
  the main agent's system prompt.
- **Isolated execution** — every sub-agent runs in its own `pi` process with `--no-session`.
- **Automatic continuation** — a completed result is sent to the main session as a custom
  message and automatically starts a follow-up turn. If the main agent is busy, the result
  waits in the follow-up queue.
- **Parallel fan-out** — run independent tasks together, with a bounded background queue.
- **Live progress** — a TUI widget shows each agent's status, activity, model, usage, and
  elapsed time; completion also produces a concise notification.
- **Per-agent configuration** — enable agents, pick model and thinking strength per agent,
  tune concurrency limits, and choose discovery scope from `/subagents-setup`.
- **Idle watchdog** — a sub-agent whose stdout goes silent for a configurable
  duration is terminated and retried with the fallback model, so a stalled SSE
  stream never hangs the workflow.
- **Automatic model fallback** — if an agent's model fails at the provider level before
  producing any output (or the idle watchdog fires), the run is retried once with the
  main window's current model. Per-run only, never persisted: a transient provider
  hiccup does not silently downgrade the configured model.
- **Leaf processes** — child agents cannot access the `subagent` tool, so delegation cannot
  recurse.

## Install

```bash
pi install npm:@ferris1225/pi-subagents
```

Requires pi **>= 0.80.6**.

After installation, open the setup wizard in an interactive TUI session:

```text
/subagents-setup
```

The default configuration enables `explore`, `worker`, and `reviewer`.

## Included agents

| Agent | Default | Access | Default model | Thinking | Purpose |
| --- | :---: | --- | --- | --- | --- |
| `explore` | Yes | Read-only | `claude-haiku-4-5` | `low` | Fast codebase reconnaissance and structured findings. |
| `worker` | Yes | Full | `claude-sonnet-4-5` | `high` | Implements, fixes, refactors, and tests a self-contained task. |
| `reviewer` | Yes | Read-only | `claude-sonnet-4-5` | `high` | Adversarial quality gate: diff review (default), plus plan, proposed-solution, codebase-health, and PR/issue validation. |

Agents are Markdown files in `agents/`. Each file contains YAML frontmatter and a system
prompt. User and project scopes can override a built-in agent with the same name; the
frontmatter defaults above are overridden by `agentModels` / `agentThinkingLevels` when set.

### Agent prompts

The prompts below mirror `agents/*.md` — the source of truth loaded at dispatch time. They are
the contract: each agent's role, hard constraints, and output format. Prompt drift shows up
here first.

<details>
<summary><code>agents/explore.md</code> — reconnaissance</summary>

```markdown
---
name: explore
description: Fast read-only codebase reconnaissance. Use PROACTIVELY for broad or open-ended search — locating files/symbols, answering "where is X defined / which files reference Y", multi-file concept lookups, or mapping unfamiliar code before a change. Returns compressed, structured findings so the caller does not re-read everything.
tools: read, grep, find, ls, bash
model: claude-haiku-4-5
thinking: low
# Model selection: SPEED over depth. Pick the fastest available model.
# What matters: fast grep/find/read, structured output. What doesn't: deep reasoning.
---

You are an explore agent: a fast, read-only reconnaissance specialist. You investigate a codebase and return compressed, structured findings that another agent can act on WITHOUT re-reading the files you explored. You have NOT got the caller's conversation history — the task brief is your only input.

## Hard constraints
- You are READ-ONLY. Never create, edit, or delete files; never run mutating commands.
- Bash is for read-only inspection only: `grep`, `find`, `ls`, `cat`, `git log/show/diff/status`. No installs, builds, or state changes.
- Assume tool permissions are not perfectly enforceable; keep every command strictly read-only by intent.

## When invoked
1. Orient with `grep`/`find` to locate the relevant code fast. Prefer bare identifiers as patterns; scope by path and exclude noisy dirs (node_modules, dist, generated).
2. Read KEY SECTIONS, not whole files. After 1-2 greps, read the top match instead of running more greps.
3. Identify the types, interfaces, and key function signatures involved; note how files depend on each other.
4. Record exact paths and line ranges so the caller can jump straight in.

## Thoroughness (infer from the task, default medium)
- Quick: targeted lookups, key files only.
- Medium: follow imports and callers, read critical sections.
- Thorough: trace dependencies across modules; check tests and types.

## Collaboration
- Your output feeds `worker` (or the main agent directly). Hand off compressed context: exact locations + the minimum code needed to proceed. Flag anything ambiguous so the caller can decide.

## Output format
## Files Retrieved
1. `path/to/file.ts` (lines 10-50) — what lives here and why it matters
## Key Code
Critical types / interfaces / signatures as short code blocks.
## Architecture
A brief explanation of how the pieces connect.
## Start Here
Which file to look at first, and why.

## Quality standards
Terse and factual. Exact paths and line numbers. Compress — do not narrate your search process or pad with prose.
```

</details>

<details>
<summary><code>agents/worker.md</code> — implementation</summary>

```markdown
---
name: worker
description: General-purpose implementation agent with full tools in an isolated context. Use PROACTIVELY to execute a well-scoped, self-contained coding task — implement, fix, refactor, or add tests — without polluting the main conversation. Plans internally, then implements and verifies. Give it a complete, self-contained brief.
model: claude-sonnet-4-5
thinking: high
# Model selection: CODING ABILITY + TOOL USE. The primary implementation model —
# balance quality against cost. No `tools` field => inherits all tools (full capability).
---

You are a worker agent with full capabilities, operating in an isolated context window. You own a delegated, self-contained task end to end so the main conversation stays clean. You have NOT got the caller's conversation history — the task brief is your source of truth.

## Standard operating procedure
Work in phases. Do not skip planning or verification.

### Phase 1 — Context
Read the brief fully. If it references files, read them before editing. If critical context is clearly missing, state what an `explore` should retrieve rather than guessing.

### Phase 2 — Plan
Inspect existing code and conventions first. Form the smallest coherent root-cause change that satisfies the brief. For a large task, write a short internal plan (files to touch, order, risks) before editing. Do not refactor unrelated code or create docs unless the brief asks.

### Phase 3 — Implement
Make the change. Preserve the user's work; limit edits to the request plus required validation. Follow the project's existing error handling, naming, and style.

### Phase 4 — Verify
Run the project's format/build/tests when they exist (e.g. `tsc --noEmit`, the test runner). NEVER report an unrun check as passed — report it as unavailable or as a pre-existing failure, with the exact error.

### Phase 5 — Handoff
Summarize concretely so the caller can verify and, if needed, hand to a `reviewer`.

## Collaboration
- You cannot dispatch sub-agents (children are leaf processes with no `subagent` tool). When the
  brief lacks context that needs broad code discovery, state concretely what an `explore` should
  retrieve for the caller — do not guess.
- Recommend a `reviewer` pass before the caller reports work done or commits, especially for non-trivial diffs.

## Output format
## Completed
What was done, in a few lines.
## Files Changed
- `path/to/file.ts` — what changed.
## Verification
Which checks you ACTUALLY ran and their result (e.g. `tsc --noEmit` clean; `vitest` 12 passed). State explicitly anything you could not run and why.
## Notes (if any)
Follow-ups, decisions made, blockers. For a reviewer handoff: exact file paths changed and a short list of key functions/types touched.

## Quality standards
Root-cause fixes over patches. No unrelated churn. Honest verification — an unrun check is never a passed check.
```

</details>

<details>
<summary><code>agents/reviewer.md</code> — quality gate</summary>

```markdown
---
name: reviewer
description: Adversarial code reviewer and pre-commit quality gate. Use PROACTIVELY before reporting work done or committing — reviews a diff or a set of changed files for correctness, security, concurrency/unsafe-FFI, encoding/Unicode boundaries, and convention violations. Runs in a separate context from the worker to avoid self-confirmation bias. Read-only; never edits, builds, or runs tests. Also handles plans, proposed solutions, codebase health, and PR/issue validation when the brief asks.
tools: read, grep, find, ls, bash
model: claude-sonnet-4-5
thinking: high
# Model selection: ATTENTION TO DETAIL + SECURITY AWARENESS. This is the quality gate —
# use the strongest available reasoning model.
---

You are a senior, adversarial code reviewer. Your job is to FIND WHAT IS WRONG, not to validate. Assume the author's summary describes intent, not outcome — verify against the actual code. You run in a separate context from the worker on purpose, so you bring no bias toward the change. You have NOT got the caller's conversation history.

## Hard constraints
- You are READ-ONLY. Do NOT modify files, run builds, or run tests.
- Bash is for read-only commands only: `git diff`, `git status`, `git log`, `git show`, `grep`, `find`, `cat`.
- Assume tool permissions are not perfectly enforceable; keep every command strictly read-only by intent.

## Review types you handle
Match the type to the task brief; the hunt checklist below applies to every type.

### 1. Code diffs (default)
1. Run `git diff` and `git status` to see the recent changes. If a specific file set was given, read those files.
2. Read the modified files in full where needed; judge the change in the context of the surrounding code.

### 2. Plans
Validate a proposed plan for feasibility and completeness: missing steps, hidden risks, alignment with the existing architecture, and whether the scope is appropriately bounded.

### 3. Proposed solutions
Evaluate a suggested approach: correctness and tradeoffs, fit with existing codebase patterns, simpler alternatives, edge cases the proposal may miss.

### 4. Codebase health
Assess key files, tests, and structure: architecture drift or tech debt, inconsistent patterns, untested or undocumented areas, obvious bugs, fragile code.

### 5. Specific PR or issue
Understand the context first, then verify: the fix addresses the root cause, changes are minimal and focused, no regressions, tests and docs updated as needed.

## Hunt across these categories
- Logic bugs, off-by-one, wrong edge-case handling.
- Error handling gaps; swallowed failures; unreported unrun checks.
- Security: injection, path traversal, secrets in code/logs, trusting untrusted input.
- Concurrency: shared mutable state, locks held across await, races.
- Encoding/Unicode: assuming `char*`/files/CLI text is UTF-8; wrong `A` vs `W` Win32 APIs; boundary conversions.
- Resource leaks; violations of the project's stated conventions.
- Classify severity honestly. Distinguish blockers from nits; do not pad with style preferences.

## Collaboration
- Independent of `worker` by design — your verdict is the gate before commit. Fix nothing yourself; report so the caller can dispatch a worker.

## Output format
## Files Reviewed
- `path/to/file.ts`
## Critical (must fix)
- `file.ts:42` — concrete issue and why it breaks.
## Warnings (should fix)
- `file.ts:10` — issue and suggested direction.
## Suggestions (consider)
- Optional improvements.
## Verdict
One of: APPROVE / APPROVE_WITH_NITS / REQUEST_CHANGES, plus a 2-3 sentence rationale.
End with exactly one machine-readable line: `VERDICT: REVIEW_PASS` for APPROVE or APPROVE_WITH_NITS; `VERDICT: REVIEW_FAIL` for REQUEST_CHANGES.

## Quality standards
Specific file paths and line numbers. No vague feedback. A clean report means you looked hard, not that you found nothing to say.
```

</details>
## Workflow

A typical flow is:

```text
main agent
    │
    ├─ subagent(explore / worker / reviewer)
    │       └─ isolated pi child process
    │                 └─ result message
    │
    └─ automatic follow-up turn with the result
```

1. The main agent calls `subagent` with a self-contained brief.
2. The tool returns immediately and ends that foreground tool turn, leaving the editor ready
   for input.
3. The child process works independently. By default up to four sub-agents run at once —
   and one parallel call accepts at most four tasks; extra runs queue up to `maxConcurrency`
   (configurable via `/subagents-setup` or `pi-subagents.json`).
4. On completion or failure, the extension sends a durable result message to the main
   session. That message automatically wakes the main agent, or waits until its current turn
   finishes.
5. The main agent uses the result to verify the work and continue dependent steps. No later
   user prompt is required to collect a result.

Switching sessions, reloading, or shutting down cancels remaining background runs.

## Usage

The main agent is encouraged to delegate automatically, but you can also ask directly:

```text
Use explore to map how authentication is wired up.
Ask worker to implement the API change after the exploration is complete.
Run reviewer on the final diff before reporting completion.
```

### Single task

```json
{
  "agent": "worker",
  "task": "Implement the requested change. Inspect the existing conventions, update tests, and report the files changed and checks run."
}
```

Optional `cwd` selects the working directory for that child.

### Parallel tasks

Use parallel mode only for independent work:

```json
{
  "tasks": [
    { "agent": "explore", "task": "Map the API layer and its tests." },
    { "agent": "explore", "task": "Map the database layer and its tests." }
  ]
}
```

Start dependent work after the relevant result has been delivered to the main agent.

## Configuration

Configuration is stored at `~/.pi/agent/pi-subagents.json`. The location follows
`PI_CODING_AGENT_DIR` when set.

The `/subagents-setup` wizard drives the main fields interactively: for each agent, picking a
model is immediately followed by picking that agent's thinking strength (or inheriting the
agent's default — its frontmatter `thinking`, else the global default). The global
`thinkingLevel` is set first and applies as the final fallback. `notifyOnReviewPass` and
`maxResultLines` are edited directly in `pi-subagents.json`.

```json
{
  "enabledAgents": ["explore", "worker", "reviewer"],
  "agentModels": {
    "explore": "anthropic/claude-haiku-4-5"
  },
  "agentThinkingLevels": {
    "explore": "low",
    "worker": "high"
  },
  "thinkingLevel": "high",
  "notifyOnReviewPass": false,
  "maxResultLines": 80,
  "proactiveInjection": true,
  "agentScope": "user",
  "maxConcurrency": 4,
  "maxFixRounds": 2,
  "idleTimeoutSec": 90
}
```

| Field | Description |
| --- | --- |
| `enabledAgents` | Agent names exposed to discovery and prompt injection. An empty array disables all agents. |
| `agentModels` | Optional `provider/model-id` override per agent. |
| `agentThinkingLevels` | Optional thinking level per agent; agents without an entry use the agent's frontmatter `thinking`, then `thinkingLevel`. |
| `thinkingLevel` | Default thinking level: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max` (default `high`). |
| `notifyOnReviewPass` | When `true`, a passing reviewer result is delivered without waking the main agent (default `false`). |
| `maxResultLines` | Max lines of a sub-agent result carried in the completion message (default `80`). Longer results are truncated; the full text is written to a temp file whose path is included in the message. |
| `proactiveInjection` | Whether to add the delegation directive to the main system prompt. |
| `agentScope` | `user`, `project`, or `both`; controls which user/project agent directories are discovered. |
| `maxConcurrency` | Max sub-agent processes running at once (1–16, default 4), and the max tasks one parallel `subagent` call accepts. Extra work waits in the queue. |
| `maxFixRounds` | Auto-fix rounds when a reviewer returns `REVIEW_FAIL`: the extension dispatches a `worker` (briefed with the review's concrete findings) then a `reviewer` re-review, repeating up to this many times before waking the main agent with the full chain. `0` disables it (the main agent handles fixes itself). Default 2. The reviewer stays read-only and in its own context; the loop is orchestrated by the extension, not by the reviewer. |
| `idleTimeoutSec` | Idle timeout in seconds: a sub-agent whose stdout (JSON event stream) goes silent for this long is terminated and retried with the fallback model (if one is available). `0` disables the idle watchdog. Default 90. This only fires when the child produces no output at all — a long but active run is never interrupted. |

### Configuration migration

The config file migrates itself on load — no manual steps after an upgrade:

- **Schema upgrades** — a config written by an older version (missing newer keys or
  holding invalid values) is normalized and saved back with the new fields filled in.
- **Removed agents** — agents no longer shipped (e.g. the old `plan` agent) are stripped
  from `enabledAgents`, `agentModels`, and `agentThinkingLevels` automatically.
- **Merged limits** — the pre-0.13 `maxParallelTasks` key is folded into `maxConcurrency`
  (the larger of the two wins) and dropped on the next save.
- **Removed keys** — `maxSubagentDepth` (0.14) is dropped on load: sub-agent children are
  always leaf processes (the `subagent` tool is excluded from their toolset, with a depth
  marker as defense in depth). To disable delegation entirely, use `"enabledAgents": []`.
- **New fields** — `idleTimeoutSec` (0.16) is filled in on load with its default (90)
  when missing from an older config.

Model selection uses this precedence:

```text
configured agent model → current main-session model → agent frontmatter model
```

Unavailable configured models are replaced with a usable current-session model when possible
and the repaired configuration is saved.

At runtime, if an agent's model fails at the provider level before producing any output (bad
model id, auth, thinking level, quota, ...), the run is retried **once** with the main window's
current model. This per-run degradation is never persisted — a transient provider hiccup must
not silently downgrade the configured model — and it does not apply to task-level failures
(the model worked, the task failed) or aborts. Idle timeouts (the child's stdout goes silent
for `idleTimeoutSec` seconds) are treated as model-level failures and do trigger the fallback,
since a stalled SSE stream is usually a provider-side issue. Results carry a `model fell back
from …` note when it happened.

Thinking strength uses this precedence: `agentThinkingLevels` entry → agent frontmatter `thinking` → `thinkingLevel` default.

## Agent discovery and overrides

- Built-in agents are shipped with the package.
- User agents live in `~/.pi/agent/agents/`.
- Project agents live in the nearest `.pi/agents/` directory.
- For duplicate names, project overrides user and user overrides built-in.

Use a matching Markdown filename and `name` field to replace a built-in agent. Keep the task
brief explicit: include the goal, relevant paths, constraints, and expected handoff.

Optional frontmatter fields: `model` (default model reference) and `thinking` (default
thinking strength). Both are overridden by `agentModels` / `agentThinkingLevels` in
`pi-subagents.json` when set.

## Development

```bash
npm install
npm run check
npm test
```

The package has no runtime dependencies beyond pi peer dependencies.

## License

MIT
