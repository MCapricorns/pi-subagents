# Changelog

## 5.0.1

### Changes

- Add independent `reviewer` and `critic` roles with their own model and
  thinking settings. `artisan` now owns implementation only; reviews report the
  smallest fix per confirmed defect so the same turn can apply it and confirm
  only that fix.
- Replace the nested `/subagents-setup` screens with a role grid: one row per
  role, Model / Thinking / Reset as columns.
- Run children through Pi RPC so a running child can be steered. Add
  `subagent_message`: `context: "session"` continues a private copy of the
  retained session for rework (same prompt-cache key); `context: "summary"`
  starts a new next step from a bounded summary of objective, result and
  touched files.
- Fix `subagent_stop` ignoring `all` when an unknown `workflow` was also sent,
  and remove stopped runs and graphs from the widget instead of showing them as
  failures.
- Stop restore from signalling recorded child or owner PIDs, so another Pi
  window or project is never disturbed.
- Add `/subagents-cleanup` (and `dry-run`) to report per-project usage and
  reclaim unclaimed sessions, worktrees and result artifacts while keeping
  parked recovery work.
## 5.0.0

### Breaking changes

- Run children through Pi's native `--mode json` CLI instead of the custom RPC
  transport. Pi owns provider adapters, retries, and session persistence.
- Cancelling the parent stops its child work. Aborted awaited results no longer
  return through background completion.
- Conversation-tree navigation stops unfinished work. New/resume/fork/reload
  ends old children and retains interrupted artifacts for manual recovery.

### Changes

- Restore ordinary subagent completion delivery.
- Fix workflow isolation, transitive result interpolation, output limits, and
  failure propagation. Checkpoint live graphs and reserve pending phases.
- Share cancellation and worktree finalization across runs and graphs. Stop all
  writers before waiting for cleanup.
- Redesign the widget as a 10-line task board with an overview, workflow
  groups, stable status/time columns, and secondary activity/model details.
  Keep task identities and failures visible before optional telemetry; collapse
  completed nodes into progress and share space between groups.
- Choose delegation from task structure and coordination cost. Keep small work
  in main, use parallel tasks for independent work, and proactively choose a
  workflow for substantial phases with known dependencies. Reassess after
  discovery instead of imposing a research/implementation/review pipeline.
  Keep fixes with their tests and use command-capable roles for reproduction.
- Replace the setup wizard with a grouped role panel. Edit model and thinking
  separately, restore defaults per role, preserve focus, and show effective
  reasoning levels. Add native input handling for search, paste, and IME.
- Validate saved definitions before dispatch, reject unfilled templates, and
  honor call-level name and description overrides.
