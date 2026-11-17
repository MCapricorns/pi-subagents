# pi-subagents

Lead/worker orchestration for [Pi](https://github.com/earendil-works/pi).
Your capable main model judges difficulty, plans, handles complex work, reviews
the actual changes, and owns the final answer. Cheaper workers execute simple,
bounded tasks with their own context, model, tools, and retained sessions.

Requires **Pi >= 1.5.2** and **Node.js >= 22.19.0**. Development and native CLI
integration tests use the **Pi 1.5.2 SDK**.

## Get started

1. Install the extension:

   ```bash
   pi install npm:@ferris1225/pi-subagents
   ```

2. Choose a capable main model with Pi's model selector; it always owns review.
3. Run `/subagents-setup` and choose models for **Researcher** and **Worker**.
4. Give main your task. Orchestration is the default and only workflow.

The setup panel has two sections: **Researcher** for read-only research and
**Worker** for implementation and checks. Each has its own **Model**, **Thinking**,
and **Reset** controls. Both assignments stay visible together.
Use ↑/↓ and Enter; Esc returns without changing a picker selection. Changes save
immediately. The model picker supports search, paste, paging, and Tab for details.
The menu keeps the current main model visible, highlights unavailable assignments,
and returns focus to the setting you just edited. Long values can be paged with
PgUp/PgDn, and narrow terminals use a compact list with the role on each row.

Workers initially **follow main** with **medium** thinking. Choose a separate
worker model to use a cheaper model for execution. The extension does not guess
model quality or promise savings from token prices. A saved thinking preference
survives model changes and is clamped to the chosen model's supported levels.
Reset restores Follow main and medium thinking for that role only.

The goal is to reduce expensive main-model usage, budget, and quota consumption.
Total tokens can increase because briefs, separate contexts, and review also cost
tokens. Judge savings by total task cost and main-model usage, including retries
and rework. Compact handoffs, retained worker sessions, reuse of valid checks, and
delegating execution are the mechanisms; no savings benchmark is claimed here.

## Configuration and upgrading to 7.0.1

**This update resets settings and renames roles.** On the first session start after upgrading, the
old `pi-subagents.json` is atomically overwritten with fresh, independent role settings.
Previous model/thinking values are discarded, with no migration or config backup.
Pi displays a notice directing you to `/subagents-setup`.

The role names are now `researcher` and `worker`; previous names are rejected.
Main continues to own planning and review. There are no role or provider aliases,
old SDK shims, or recovery-path migrations. Model references must exactly match
the available registry entry.

Only the settings file is reset. Existing sessions, results, worktrees, and
recovery evidence remain protected. Unsupported recovery manifests are left
untouched and block automated cleanup; they are not converted or resumed.

The new configuration is stored at `~/.pi/agent/pi-subagents.json`:

```json
{
  "version": 2,
  "researcher": { "thinking": "medium" },
  "worker": { "thinking": "medium" }
}
```

Selecting a model adds `model: "provider/model-id"` inside that role's object.
Each role's model and thinking are saved independently.
`PI_CODING_AGENT_DIR` overrides the agent directory.
An unavailable or out-of-scope model stays configured and blocks only its role until
availability is restored or you select another model. Provider failures return
to main with evidence; the extension never starts a main-model worker as a retry.
Unreadable settings or an invalid model reference also stop new dispatches instead
of silently selecting main. Startup leaves such a file untouched and warns; repair
it by hand or run `/subagents-setup`, which replaces an unreadable file with
defaults or clears only the invalid model reference. A UTF-8 BOM is accepted.

## How orchestration works

1. **Main judges difficulty and plans.** It investigates the decisions that
   determine the approach, resolves ambiguity, and defines acceptance criteria
   and write boundaries. It splits complex tasks into simple worker briefs and
   keeps the difficult core when delegation would create more rework.
2. **Workers execute.** Main sends a self-contained brief written so a cheaper
   model can act without guessing: files, symbols, acceptance criteria, write
   boundary, and exact check commands. Each worker owns a bounded task and its
   checks, returning a fixed handoff (`Status`, `Changes`, `Checks`, `Notes`;
   researcher: `Answer`, `Evidence`, `Gaps`) that main can review quickly.
3. **Main reviews.** After worktree integration, main checks the actual diff,
   relevant callers, acceptance criteria, and test evidence. Worker completion
   is explicitly marked as a review handoff, not approval.
4. **Main corrects or accepts.** Focused corrections go back to the owning worker
   through its retained session. Main repairs an invalid plan or takes over when
   assumptions fail. It owns final validation, release, and the user-facing answer.

Simple edits, fixes, tests, docs, and bounded research go to cheaper workers by
default. Main decides what is simple enough for the configured worker; there is
no keyword classifier or automatic model ranking. Complex or uncertain work can
stay in main. Review and final acceptance always stay in main, never in a cheap
reviewer. Main avoids repeating completed worker effort. Questions and review-only requests do not authorize
implementation. Explicit requests to work in main take precedence. Parallel workers require independent
scope and disjoint write ownership; a fix and its regression tests share an owner.

There are two roles, each using its own model/thinking settings:

| Scope | Tool parameter | Access |
| --- | --- | --- |
| Implementation | `worker` | Parent's live tools, including codemode; implements and checks the plan |
| Read-only research | `researcher` | Proven read-only lookups; no commands, builds, tests, or edits |

The read-only scope preserves a tool boundary for research. It is not a separate
reviewer. Children cannot delegate or release. Main and workers exchange briefs,
results, and feedback, rather than copying the parent's full conversation.

Planning, review, and the instruction to return after two unsuccessful fixes
are model instructions, not a runtime verdict engine or a hard retry counter.
Cancellation, role admission, tool boundaries, and worktree lifecycle are enforced
by the extension. No automatic review score certifies a worker's result.

## Briefs and calls

A useful brief names the **outcome**, **acceptance criteria**, **relevant paths and
evidence**, **write boundary**, **checks**, **return conditions**, and **expected
result**. Pass established facts forward and assign only missing work.

```ts
subagent({
  agent: "worker",
  task: [
    "Fix cache invalidation in src/cache.ts and its regression test.",
    "Acceptance: a write invalidates the matching key without clearing unrelated keys.",
    "Evidence: the stale read starts in Cache.get; keep the current public API.",
    "Write only src/cache.ts and test/cache.test.ts.",
    "Run the cache tests. Return to main if the storage interface contradicts this plan.",
    "Report the outcome, changed paths, command/results, and blockers for main's review.",
  ].join("\n"),
  wait: true,
});
```

Independent tasks use `tasks: [{ agent, task }, ...]`. Each task can also specify
`cwd` and `isolation`; a top-level `isolation` is the default for tasks that omit
it. Duplicate normalized tasks in the same cwd are rejected while active or
settled; reuse the result or continue the existing run with `subagent_message`.

Use `wait: true` for an immediate dependency. Print/JSON sessions wait by
default; TUI/RPC sessions return background receipts. A launch receipt is not
completion. Main continues independent work, then pauses until results arrive.
Results are delivered once, after integration. Awaited failures are tool errors.
Answers exceeding 40 lines or 8,000 characters link their full-result artifact.

| Tool | Purpose |
| --- | --- |
| `subagent_status({ id: 12 })` | Inspect progress, result, session availability, and recovery paths |
| `subagent_message({ id: 12, message: "Fix the remaining edge case", wait: true })` | Steer an active worker or continue completed work |
| `subagent_message({ id: 12, message: "Next bounded task", context: "summary" })` | Start from a compact summary instead of the earlier transcript |
| `subagent_stop({ id: "12" })` | Stop a run (exact id; `#12` also accepted) and retire its retained session |
| `subagent_stop({ all: true })` | Stop all active work in this session |

Follow-ups use `context: "auto"` by default: a private copy of the retained session,
or an explicit summary fallback when it expired. `context: "session"` requires full
history. Continuations retain the session ID/cache key and re-read files in their
current workspace. Summary continuations cannot rely on omitted history.

Steering waits for a matching RPC acknowledgement. Received/queued means Pi queued
the instruction, not that the model acted on it. A rejected or missing
acknowledgement is an error. Failed or interrupted runs require main to inspect
partial work; they do not restart automatically.

## Isolation and control

Implementation uses a detached Git worktree by default, even for one worker.
Read-only research uses the caller's directory. Without a Git repository or
committed HEAD, automatic isolation reports a shared-directory fallback.
Explicit `isolation: "worktree"` requires isolation; `"shared"` writes directly
in the caller's checkout.

Each worktree snapshots current tracked and non-ignored untracked files,
including uncommitted work. The child is told how original paths map into its
worktree. Integration applies only its delta, is serialized per repository,
and preserves the caller's index, branch, and HEAD. Failures retain recovery
artifacts. Worktrees isolate Git changes, not permissions.

Escape cancels unfinished workers without waking main. Main receives a cancellation
receipt on the next user turn. Tree navigation, new/resume/fork/reload, and shutdown
stop old work; interrupted evidence remains available for recovery.

The task widget shows status, elapsed time, model, thinking, tokens, and worktree
state in at most ten lines. Independent workers can start together; only
integration into the original checkout is serialized.

## Pi integration

Workers run the native Pi CLI in RPC mode with piped I/O and retained sessions.
Delegation/control tools are model-only: call them directly, outside codemode.
Workers inherit reachable tools without activating unrelated direct tools; researcher
gets only tools whose metadata proves them read-only.

Unattended confirmation/input dialogs are cancelled, never auto-approved. Windows
child processes and their Node descendants use the existing hidden-console
policy; process-tree cancellation remains active on every supported platform.
A provider failure returns control and evidence to main without an automatic
upgrade to main's model. Pi's own same-model retry behavior remains unchanged.

[Pi 1.5.2](https://github.com/earendil-works/pi/blob/v1.5.2/packages/coding-agent/CHANGELOG.md)
fixes sessions whose original directory disappeared. Private continuation
copies still rebind their cwd while retaining their session ID. Pi 1.5.1 added
message threads, idle cache warming, and classifier access through
`ctx.modelRegistry.classify()`. This extension keeps Pi's provider behavior and
cache settings; exited workers do not keep warming caches between runs.
Classifier routing is not used: main makes the plan after investigation.
The settings modal uses Pi's `blocked` status while awaiting input.

## Storage

Durable data lives under `~/.pi/agent/ferris-pi-subagents/`, grouped by project:
sessions, worktrees, temporary state, and result artifacts.

Startup and paced settlement cleanup reclaim dead-owner artifacts, expired results,
and old settled sessions. Settled session retention is normally 30 minutes with
a 1.5 GB project budget; budget pressure can remove sessions older than five
minutes. Interrupted records expire after 30 days when their recorded processes
are no longer alive. Live work, parked recovery, and referenced artifacts are
protected. Unreadable manifests prevent reclamation.

`/subagents-cleanup dry-run` reports usage; `/subagents-cleanup` reclaims eligible
artifacts. Unknown arguments are rejected. Shutdown drains cleanup already running.

## Design references

The prompt policy draws on these official descriptions:

- [Devin Fusion](https://cognition.com/blog/local-fusion): separate lead/worker
  contexts, compact briefs and feedback, and lead-owned review.
- [Antigravity Orchestrator](https://antigravity.google/docs/models#orchestrator):
  planning, execution, and returning control when the plan needs repair.
- [Anthropic's multi-agent engineering](https://www.anthropic.com/research/multi-agent-research-system):
  explicit objectives, output formats, sources, boundaries, and effort proportional to the task.
- [Context engineering](https://www.anthropic.com/research/effective-context-engineering-for-ai-agents):
  focused instructions and small, relevant context.

These inform this extension's design; benchmark savings from other products do
not establish savings here. Local tests verify routing, delivery, isolation, and
UI behavior, not comparative model quality or cost.

## Development

```bash
npm ci
npm run check
```

Runtime modules live in `src/`: configuration/UI, orchestration prompts,
execution, lifecycle, isolation/recovery, and presentation. Native integration tests
use a local fixture provider and do not consume paid model requests.

Pushes of an unpublished version to `main` run checks on Windows, macOS, and
Linux, then [publish to npm and create a GitHub Release](./.github/workflows/publish.yml).
Do not publish locally.

[Changelog](./CHANGELOG.md) · [MIT license](./LICENSE)
