# Changelog

## 7.0.7

- Show free dispatch slots in background launch receipts and the main prompt.
  When the ownership list fills up, show runs occupying slots first.
- Tailor briefs to the role. A summary follow-up gives the child its current
  objective and earlier evidence while keeping the same phase identity as a
  retained-session follow-up. Switching context cannot start the same phase twice.
- Expand a terminal dispatch card to inspect each full brief, directory, and
  isolation setting. The task widget counts worktree application separately
  from running children.

## 7.0.6

- Show Escape cancellation progress and per-run statistics in the terminal before
  the next user message. Finished workers report pending integration and retain
  normal result delivery.
- Gate staged commits, pull requests, and publishing on unused-code checks.
  The main-agent prompt delegates a dead-code review before an authorized push.
  Clean up confirmed unused code before committing.

## 7.0.5

- Shorten the main and child prompts with clear routing, brief, and review steps.
  Keep live work visible ahead of older interrupted runs in the prompt.
- Apply a batch working directory to every task unless it overrides the path.
  Reject empty or mixed single and batch requests before reserving runs, and
  report accepted runs alongside any launch failures.
- Show awaited run progress, worktree integration, and failed launches in the
  terminal. Expanding the tool result shows the available output and recovery details.
- Keep model and settings details readable and pageable in short or narrow terminals.

## 7.0.4

### Changes and fixes

- Cap concurrent subagents at **5** (`MAX_CONCURRENT_SUBAGENTS = 5`) across the
  `tasks` tool schema, dispatch/follow-up admission, and the background task
  scheduler. Settling, stopped, and restored parked runs do not consume live
  concurrency slots, and steering an active run still works at full capacity.
- Serialize per-repository Git baseline snapshots, `git worktree add/remove/prune`,
  and three-way patch integration so five parallel isolated workers start and
  settle reliably without colliding on `.git/worktrees` metadata while their
  child processes execute concurrently.
- Keep all five active phase leases and five recent settled phases visible in
  `<subagent_leases>` so main does not lose track of concurrent owners and
  repeat or overwrite their work.
- Strengthen orchestration prompts and tool schemas to batch independent tasks
  together in `tasks` (up to 5 concurrently instead of serializing one by one),
  forbid duplicating leased scopes in main or sibling subagents, and leave
  `wait` omitted by default so main continues disjoint work in parallel.
- Remove duplicate repository-lane locking, unused internal exports, and
  redundant/brittle test cases and child-process spawns.

## 7.0.3

### Fixes

- Escape no longer cancels a run whose child already finished and is only
  integrating its worktree. It settles normally, and its real result is
  delivered on the next turn without waking main, instead of being reported as
  aborted partial work while its changes were applied anyway.
- Escape hands successes already queued for delivery to the next turn instead
  of discarding them. Branch navigation still stops everything and discards
  results for the abandoned branch.
- `subagent_stop({ all: true })` skips settling runs and runs that are already
  stopping. An explicit stop of a settling run retires it but keeps its real
  result and integration status.

## 7.0.2

### Orchestration prompts

- Frame main as the orchestrator: spend its effort on decisions, send broad
  searches and multi-file reading to the read-only role, and write briefs a
  weaker worker model can execute without guessing (files, symbols, exact
  check commands, design choices settled first).
- Give Worker and Researcher an ordered method and a fixed handoff
  (`Status/Changes/Checks/Notes`, `Answer/Evidence/Gaps`) so cheaper models stay
  predictable and main reviews faster.
- After a failed run, re-brief with the correction instead of defaulting to
  doing the work in main. Parallel duplicate rejections now give the same
  follow-up remedy as single dispatch (continue the owner with `subagent_message`).
- The live orchestration section no longer asks main to run `/subagents-setup`,
  which only the user can do.

### Fixes

- Worktree integration patches ignore user diff settings (`diff.external`,
  textconv, `diff.noprefix`, `color.ui=always`) that could break or misplace
  `git apply`.
- On POSIX, an unignored `node_modules` symlink no longer enters every patch;
  the link is removed with `unlink`, never touching the shared dependency tree.
- Windows long paths apply to every worktree Git command, not only removal.
- A failing `git worktree prune` after artifacts are already gone no longer
  marks a successful integration as failed.
- A run stopped just before its child spawned no longer stays `interrupting`
  forever and blocks its phase, and no longer launches a child that is killed
  at once.
- A worker that settled with a complete answer but whose Pi process shut down
  slower than the grace period is no longer reported as a failed dispatch.
- Settled runs no longer persist dead child pids that a reused pid could match.
- Interrupted records keep their original timestamp across restarts, so the
  30-day expiry actually applies.
- `subagent_stop` requires an exact run id (`#12` accepted); a prefix such as
  `1` no longer stops `#12` and `#15`.
- A result file that cannot be written no longer loses a successful result;
  a bounded head is inlined with the save error instead.
- Startup keeps an unreadable or invalid current settings file (and accepts a
  UTF-8 BOM) instead of silently resetting roles to follow main;
  `/subagents-setup` repairs it, keeping every valid field.
- The startup availability warning uses the session's scoped models, matching
  dispatch.
- Parallel dispatch applies a top-level `isolation` as the default for tasks.
- Model-failure notes name the actual role instead of always saying "worker".
- Remove an unreachable queue cancellation callback and a dead diff branch.

## 7.0.1

### Breaking changes

- Rename `scout` to `researcher` and `artisan` to `worker`, without aliases.
- Overwrite old settings with configuration version 2. Researcher and Worker
  each have an independent model and thinking preference; neither is migrated.
- Remove provider aliases, older Pi API shims, opaque-prompt fallback, recovery
  path migration, synthesized record identities, and legacy steering receipts.
  Unsupported recovery files remain untouched and prevent automated cleanup.

### Fixes and changes

- Restore model selection for each role throughout setup, dispatch, and live
  orchestration. An unavailable model blocks only its assigned role.
- Redesign setup into Researcher and Worker sections with visible Model,
  Thinking, and role-specific Reset controls. Preserve search, paging, focus,
  Unicode input, and a compact layout for narrow terminals.
- Keep config replacement atomic and recovery ownership checks intact.
- Keep automatic releases on patch increments, including three-digit patch
  numbers such as `7.0.100`.

## 7.0.0

### Breaking changes

- Make lead/worker orchestration the only workflow. Main judges difficulty,
  delegates simple bounded work by default, splits complex tasks or handles
  their difficult core, and always reviews the actual diff and evidence.
  Remove sentinel and the role matrix.
- Replace legacy configuration on startup with versioned worker settings:
  one model and thinking preference shared by artisan and scout. Delete the
  old config without a backup and direct users to `/subagents-setup`; preserve
  sessions, worktrees, results, and recovery records.
- Remove automatic main-model worker retries. Provider failures return evidence
  to main. An unavailable configured worker blocks dispatch and keeps its setting
  instead of silently consuming main-model quota.
- Reject unreadable settings and invalid worker model references at dispatch,
  while keeping main available to explain the problem.
- Require Pi >= 1.5.2 and align development SDKs to 1.5.2.

### Changes

- Simplify setup to Model, Thinking, and Reset with searchable pickers, compact
  narrow-terminal hints, and Pi's blocked status while awaiting input.
- Keep live main/worker assignments separate from the stable prompt for caching.
  Use compact briefs, preserved worker sessions, focused corrections, and reuse
  of valid evidence to limit repeated work. Return invalid plans and repeated
  failed fixes to main; worker completion explicitly requests main's review.
- Rewrite the README around the new workflow, breaking reset, budget tradeoffs,
  prompt research, Pi APIs, controls, and recovery behavior.
- Prefer an exact configured provider reference over its alias regardless of
  catalog order. Remove obsolete role migration and duplicate delivery logic.
- Bound test-file concurrency to four so native Windows shell probes do not
  time out under process-heavy parallel suites; retain runtime concurrency tests.

## 6.0.5

### Fixes

- List every run a parallel launch started in its receipt instead of the first
  two run ids.
- Inline completion answers up to 40 lines and 8,000 characters regardless of
  line width; a single prose line over 200 characters no longer moves the whole
  answer to its result file. Repeated deliveries of one result name one artifact.
- Give isolated children the original checkout and worktree paths so they map
  paths from the brief into the worktree instead of editing the original.
- Include the model-failure takeover guidance in awaited results, and keep
  per-model usage totals for stopped, crashed, and restored runs.
- Keep model overrides outside the session's model scope; session start removes
  only overrides that no authenticated provider offers.
- Reject unknown `/subagents-cleanup` arguments without deleting anything.
- Show `starting` for every starting run, including a restart on the main model,
  and advise waiting for a stopping run instead of stopping it again.
- Give session follow-ups a deterministic objective, so repeated identical
  follow-ups follow the same duplicate rules as summary follow-ups.

### Changes

- Restrict the `subagent` role parameter to `scout`, `artisan`, and `sentinel`.
- Tighten the delegation directive and role prompts: drop the routing line that
  restated role descriptions, name codemode only when present, clarify how main
  applies review findings, label leases by role, remove script-tool guidance
  from scout, and separate sentinel findings from unverified concerns.
- Shorten the `subagent_message` description and remove code left from the
  workflow runner and earlier setup screens.

## 6.0.4

### Changes

- Open `/subagents-setup` role configuration and model/thinking pickers in
  standalone centered modal overlay panels instead of squeezing them into the
  input editor dock.
- Streamline delegation to the three core roles (`scout`, `artisan`, `sentinel`),
  consolidating implementation review and claim-challenge verification into
  `sentinel` and removing separate workflow/phase-scope machinery.

## 6.0.3

### Changes

- Update the Pi SDK dependencies and minimum supported Pi version to 1.5.0.
- Preserve typed isolation and workflow enums with Pi's new JSON Schema
  validation while retaining the existing tool parameter format.
- Keep setup search focus stable and show configured navigation shortcuts.
  Preserve acceptance verdicts and worktree application state on narrow panels.
- Make follow-ups prioritize the current objective and reuse relevant history.
  Clarify research evidence standards and reduce overlapping workflow prompts.

## 6.0.2

### Fixes

- Simplify `/subagents-setup` into role, setting, and value lists with consistent
  up/down navigation and one-level-back cancellation. Preserve focus and save
  each confirmed change immediately.
- Prioritize visible model choices over repeated details, show readable model
  names with providers, and distinguish saved settings from keyboard focus.
  Explain following the main model versus choosing a fixed model explicitly.
- Preserve Unicode search, paste, paging, capability-aware thinking preferences,
  and space for the workflow required-acceptance row on short terminals.

## 6.0.1

### Fixes

- Resolve the child working directory before launching or updating its private
  session header, preserving fallback and follow-ups through macOS path aliases
  and Windows junctions without a cross-project fork prompt.
- Require Pi SDK 1.4.0 and preserve callable codemode/deferred tools in child
  sessions, including approved read-only tools that register after startup.
  Keep delegation controls model-only and invoke them outside codemode.
- Add workflow and completed-run follow-up waiting; default all dispatches to
  waiting in one-shot print/JSON sessions. Return final evidence exactly once
  after integration and acceptance, mark awaited failures as tool errors, and
  cancel unfinished work without background wake-ups.
- Display child RPC steering acknowledgements in the tool card and status,
  including request ID and queued/handled/unknown queue disposition. Distinguish
  receipt from model execution instead of showing only a generic success mark.
- Cancel unattended RPC input dialogs with an explicit response, preventing
  invisible confirmation or input requests from hanging child execution.
- Clarify that launch receipts are not task completion and that main resumes
  from child evidence to finish fixes and final checks. Correct interrupted-run
  retirement examples, equal-task ownership guidance, and completed-run
  follow-up recommendations. Reuse the completion waiter across dispatch paths.
- Deliver unexpected workflow failures through the same final-summary route.
- Retry brief Windows permission/sharing errors during atomic manifest
  replacement under the existing writer lock, preserving the last checkpoint
  and propagating persistent errors without an unlink/copy fallback.

- Contain synchronous Windows process-termination errors and child spawn
  failures with missing stdio, preventing resource errors such as `ENOMEM`,
  `EMFILE`, and `ENFILE` from escaping into the parent Pi process.
- Default completed-run follow-ups to `context: "auto"`: reuse retained history
  when available, otherwise dispatch with a bounded summary and report the
  fallback. Keep explicit `session` strict, expose available follow-up context
  in status, and give interrupted runs actionable recovery guidance.
- Bind private session copies to the next run's cwd so follow-ups survive
  removal of an earlier worktree. Preserve the session ID and prior entries,
  and remind continued agents to re-read changed files.
- Preserve recovery artifacts when manifests or path validation cannot be read.
  Protect live owners during empty-session, age, budget and project cleanup.
  Prune expired checkpoints before restore, keep checkpoints with live owners
  or children, and retain validated paths when a session file is unavailable.
  Recovery inspection errors warn without skipping progress-widget setup.
- Recheck cancellation and source state before follow-up dispatch, and handle
  a retained transcript disappearing during copying without duplicate launches.
- Drain settlement-triggered cleanup during shutdown and stop launching new
  sweeps once shutdown begins, avoiding filesystem activity after teardown.
- Correct the documented five-minute minimum retention under budget pressure
  and distinguish automatic reclamation from explicit storage cleanup.

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
