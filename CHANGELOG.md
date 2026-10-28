# Changelog

## 6.0.0

### Breaking changes

- Support only the built-in `code-review`, `research`, and `migration` workflows
  through `workflow` plus `inputs`. Remove inline graphs, custom names, workflow
  files, and user/project workflow discovery. Keep old interrupted records
  readable for recovery.
- Embed routing guidance and workflow templates in the extension. Remove the
  separately loaded workflow skill and root workflow resource directory.

### Changes

- Append one mandatory independent sentinel acceptance officer to every
  workflow. Review all settled work and integration evidence, including failed
  branches; require an explicit terminal PASS, and reject missing, ambiguous,
  malformed, or FAIL verdicts. Cancellation skips acceptance.
- Replace ambiguous graph-source selection with direct built-in input errors.
  Give different template inputs distinct phase identities while retaining
  duplicate ownership for the same deliverable. Preserve brace syntax in task
  inputs as literal text instead of interpreting it as graph dependencies.
- Redesign the terminal board around work progress, blocking reasons, and a
  separate required-acceptance row. Keep failures visible within the 10-line
  budget, preserve narrow-screen identity, and correct hidden-task counts.
- Redesign setup as a role selector with focused model/thinking details, using
  side-by-side or stacked layouts. Preserve search, paging, focus, and default
  versus override information. Budget setup height with the host's widget and
  footer so required acceptance remains visible in a 24-row terminal.
- Preserve managed recovery references when the original checkout is temporarily
  unavailable. Use stable durable identities and cross-process manifest locks
  so separate windows cannot overwrite or delete each other's recovery records.
  Match recovered workflow children by durable identity after local renumbering,
  keep project keys stable through unavailable checkouts with aliased parent paths,
  and exclude lock directories from project scans.
- Preserve concurrent recovery additions during announcements and keep newly
  settled long-running sessions inside their follow-up retention window.
- Remove duplicate manifest scans and model-catalog lookups. Stop idle widget
  refreshes and fix zero-width summaries and ANSI-contaminated task labels.

## 5.0.6

### Changes

- Hide Windows console windows for process launches inside child tools and
  extensions, including `pi.exec` and inherited Node descendants. Preserve RPC
  pipes, existing Node options, and macOS/Linux process-group cancellation.
- Prefer useful bounded delegation, including one artisan for a substantial
  implementation without parallel work. Keep single runs, independent batches,
  dependency workflows, and the two review roles distinct.
- Skip unused orchestration runtime creation in leaf processes and remove
  duplicated delegation guidance. Correct transport and lifecycle comments.
- Gate publishing on checks across Windows, macOS, and Linux, with regression
  coverage for shell visibility, process APIs, inherited preloads, and native Pi.

## 5.0.5

### Changes

- Share writer ownership across main edit/write calls, subagent runs, and pending
  workflow nodes. Reject conflicting batches and graphs before any child starts;
  keep ordered nodes compatible and hold stopped claims until finalization ends.
- Expose phase/scope ownership and retained results in status. Keep bounded
  ownership reminders and reuse completed research, implementation, and checks.
- Rename reviewer to sentinel for implementation review and critic to skeptic
  for named claims. Migrate settings, retained records, and selected trusted
  workflow files on disk; runtime calls and inline graphs accept only current
  role names. Reduce the review template to one implementation review followed
  by verification of its specific findings.
- Automatically isolate implementation tasks in worktrees for single calls as
  well as batches and workflows. Keep reading and review local. Report a fallback
  to the caller's directory only when Git or a committed HEAD is unavailable;
  explicit worktree requests never fall back. Simplify isolation guidance and
  leave final integration serialized without delaying independent launches.
- Remove the unused dispatch-mode argument from isolation selection and its
  callers, keeping explicit overrides and fallback behavior intact.
- Hide Pi child console windows on Windows while preserving RPC pipes and
  process-tree cancellation.
- Hide successfully completed workflows from the widget immediately while
  preserving failures, blocked nodes, completion messages, and status results.
- Inline the setup picker's forwarding wrapper and simplify the two-model route
  without changing selection, provider aliases, or fallback behavior.

## 5.0.4

### Changes

- Initialize isolated worktrees from the caller's current files so dependent
  workflow nodes and follow-ups see integrated uncommitted changes. Use the same
  snapshot as the integration base and preserve the caller's index and HEAD.
- Keep stopped writer and phase leases until children and finalization quiesce,
  including after control timeouts and repeated stop calls.
- Keep review requests within their authorized outcome, focus change reviews on
  introduced defects, and request confirmation only for material uncertainty.
  Main checks done conditions and blockers before claiming a delegated task is done.
- Reduce the broad code-review workflow from five nodes to four: its critic
  verifies findings and writes the final review. Use both review roles only when
  their distinct questions justify the extra session.
- Pass the shared interface contract to every migration node and declare the
  closing gate's write scope. Reuse completed integrated checks when still valid.
- Clarify retained-session follow-ups and phase ownership in the workflow skill.

## 5.0.3

### Changes

- Align setup headers, selected cells, and keyboard actions; show the focused
  role and field explicitly, with Thinking described as reasoning effort.
- Remove the six-process cap, shared-repository startup lane, and sequential
  dispatch-tool lock. Independent runs start together; duplicate phases and
  declared scope conflicts remain rejected, and worktree integration stays
  serialized. Remove obsolete scheduling and settings-panel code.
- Record Escape cancellation for the next user turn without waking the parent,
  including cancellation during an awaited dispatch. Main is told that the
  runs are already stopped and must not restart automatically.
- Tighten delegation and review prompts around user preferences, independent
  work, and confirmed defects. Handle synchronous background-task exceptions
  without stranding lifecycle ownership.

## 5.0.2

### Changes

- Reclaim disk automatically on settlement: one paced sweep per five minutes
drops dead-owner artifacts, expired results and settled session copies older
than 30 minutes, then keeps each project inside a 1.5 GB budget. Live runs,
parked recovery work, recent sessions and every manifest-referenced path stay.

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
