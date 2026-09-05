# Changelog

Published versions of `@ferris1225/pi-subagents`. Unpublished numbers
(`4.2.3`, `4.2.6`, `4.2.9`–`4.2.11`) never shipped on npm; their changes
landed in the next published release.

## 4.3.10

- Add read-only `subagent_status`: list current-session runs or inspect an exact id,
  including progress, elapsed time, terminal diagnostics, and retained artifact paths.
  Runtime facts use Pi's existing `details.runs`; children do not need strict JSON reports.
- Remove `subagent_control` and all steer/park/resume entry points, continuation
  admission, session forking, and resume widget markers. Main handles failed or
  incomplete phases; new deliverables get new briefs. Dispatch, automatic completion
  delivery, destructive stop, RPC cancellation, and manual worktree recovery remain.
- Keep interrupted worktree edits even when the retained Pi session file is missing.
  Manual recovery no longer depends on model context; managed-path validation and
  index-preserving Git integration stay intact.
- Record child exits before RPC settlement with their exit code or signal instead
  of returning only partial output. Clear stale provider errors after successful Pi
  retries, expose missing diagnostic evidence explicitly, and keep individual failed
  tool calls separate from a terminal run failure. Preserve safe pre-prompt startup
  retries and keep the last recorded cause when that retry budget is exhausted.
- Require Pi 0.85.0 and reuse its exported RPC command/response types. Include its
  official server package as a peer and development dependency: the unbundled SDK
  and CLI require it at runtime, not only in tests.
- Discover actual built-in/custom role definitions in setup, respecting project
  trust. Saving selection removes unavailable names and overrides without retired-role
  aliases or config migration; real disabled and never-configured custom roles remain selectable.

## 4.3.9

- Add optional bounded stable `phaseId` and exact declarative write `scope` claims to single
  and parallel dispatches. Phase identity is immutable across task rewrites and resume; scope
  is monotonic across retained generations and survives durable v1 restore. Exact task+cwd
  remains the compatibility fallback.
- Reject deterministic duplicates and declared writer-scope conflicts before parallel batch
  allocation. Fresh single and resumed writers also reject normalized absolute scope overlap
  with active leases, without requiring equal caller cwd. Parallel calls that omit scope remain
  compatible and explicitly report `independence not verified`; declared claims do not prove
  natural-language task independence. Scope is conflict metadata, not permissions or a sandbox.
- Add the advisory-only `subagent_risk` tool. Without a model call it resolves the repository
  root, reads root-relative tracked and untracked changes from `HEAD`, and applies fixed
  explainable rules for concurrency, trust-boundary, persistence-compatibility, and
  failure-cancellation risk. It propagates cancellation, and suggests but never dispatches or
  requires a Sentinel review.

## 4.3.8

- Restore `sentinel` as an optional fresh-context reviewer instead of the mandatory
  pre-commit loop retired in 4.3.5. It reads a completed diff with no memory of how the
  change was written, attacks behavior, trust boundaries, failure and cancellation paths,
  concurrency, persistence, portability, and whether each test would fail without the
  change, runs only the smallest check that proves a suspected defect, and returns
  evidence-backed findings as `SEVERITY path:line — failure scenario; evidence; smallest
  fix` or `No findings.`
- Route sentinel by risk, not ritual: the delegation directive dispatches it after cleanup
  and before commit only for diffs touching concurrency, trust boundaries,
  persistence/compatibility, or failure/cancellation paths, or when checks cannot prove
  the change, and treats a finding as evidence to route back to the owning thread via
  `resume` or fix inline. Artisan keeps proving its own change; main keeps the final gate.
- Sentinel runs on the current main model unless `/subagents-setup` picks one, defaults to
  `high` thinking, stays on the shared checkout whose uncommitted diff it reviews (an
  explicit `isolation: worktree` is rejected), and holds the repository lane while it
  reviews.
- Drop the 4.3.5 retirement filter: configs written by 4.3.5–4.3.7 adopt `sentinel` once
  through the built-in adoption rule, and a deliberate disable in setup remains disabled.

## 4.3.7

- Make `subagent_control steer` continue rather than reject a thread that is no longer
  live: a child that reached `completed` or `failed` before guidance lands (including
  settlement between the state check and RPC acceptance) and a `parked` thread both
  resume the same stable id with the guidance as their appended objective and retained
  context when available.
- Add `subagent_control park`: pause a running thread at a stable checkpoint, keep its
  session and active worktree, write its durable record immediately, and return the
  usage so far with the resume handle. Only an active running attempt with a retained
  session can be parked; the generation body leaves publication to the park owner.
- Reject an exact re-run of a finished brief while the thread that did the work still
  holds its retained session, pointing at `resume` with an appended objective or at a
  brief that states what changed. Active duplicates are still named first.
- Rewrite the injected delegation directive around the brief contract a memoryless child
  needs (objective and done condition, exact paths, established facts with citations,
  boundaries, expected output), effort scaling, the steer/resume/park/stop routing for
  follow-up work, and reading a truncated result's artifact only when the excerpt is
  insufficient. The `subagent` task parameter states the same contract.
- Deepen the built-in roles: scout, artisan, and steward start from the brief's cited
  facts and stop at its done condition, resolve ambiguity by naming the reading taken
  instead of asking, scout never drafts fixes or patches and marks unverified
  conclusions `(inferred)`, artisan stops and reports a wrong premise instead of
  substituting a change, steward runs only the checks that cover its own edits, and
  every role reports each check as `command → result`.
- Tell a resumed child that the workspace may have changed while the thread was inactive
  so it re-reads a file before editing it, and frame an appended-objective resume as a
  continuation of the same thread rather than sending the bare objective.
- Clear a stopped generation's recorded child pids once its process tree has closed, so a
  long-lived parked record can never direct a later restore at a reassigned pid. Remove
  an unreachable objective-replacement prompt branch and the never-populated
  `SessionSeed.prompt`.

## 4.3.6

- Add `subagent_control steer` for nonblank, parent-mediated guidance to the current active
  RPC attempt without replacing its logical objective. Stable control serialization orders
  steering against stop and AbortSignal shutdown; bounded ACKs keep stop responsive.
- Refine the lean delegation directive: main owns architecture; for one high-stakes
  uncertainty at most two read-only scouts may examine distinct hypotheses, without
  capping unrelated disjoint scout scopes; main reconciles cited evidence, writers
  and briefs never overlap, and new evidence steers the existing phase instead of
  duplicating or restarting it.
- Steer background completions and stop results into the next parent model boundary
  instead of queuing them until the whole parent run settles, preventing stale notifications
  from arriving after the main agent has already finished.
- Validate durable session, worktree, repository, and recovery paths against their canonical
  project-scoped layout before restore or cleanup. Forged and junction-escaping records are
  dropped without deleting external targets.
- Keep worktree and patch artifacts referenced by recovery records through durable sweeps and
  stale project-root retention until their recovery notice can be delivered.
- Clarify that worktree isolation protects Git changes rather than sandboxing child privileges
  or third-party Pi packages.

## 4.3.5

- Restore `/subagents-setup`'s nested menu flow, fuzzy model picker, and disabled
  custom-role discovery.
- Retire the built-in `sentinel` role and mandatory pre-commit review workflow.
  Config normalization, loading, and saving now remove its enabled/known entries
  and model/thinking overrides while preserving every other custom role.
- Keep role prompts self-contained: direct diagnosis, test, and cleanup rules remain,
  while external loading directives are removed.
- Delegate substantial independent phases more proactively while capping the child-process
  pool at six and retaining phase leases, duplicate-dispatch rejection, and single-route delivery.
- Move the extension assembly to package-root `index.ts`, group `src/` by responsibility,
  and split thread restoration, shared lifecycle coordination, RPC control, and Git command
  execution out of the largest modules. Pi now shows the package name without a `:src` suffix.

## 4.3.4

- Keep artisan, steward, and sentinel fully usable when Ferris skills are absent.
  Installed matching skills add deeper guidance but are optional and never block a role.

## 4.3.3

- Add `sentinel`, a concise read-only adversarial reviewer that runs after cleanup,
  follows artisan's configured model by default, requests maximum supported thinking,
  and stays on the shared checkout.
- Replace `/subagents-setup`'s sequential menus with one transactional overlay for
  enabled roles, models, and thinking. Cancellation writes nothing; disabled custom
  roles remain visible, and newly shipped built-ins are adopted exactly once.
- Show each active run's effective `think:<level>` in the widget.
- Expand scout into primary-source external research, make artisan the complete
  primary-change owner, and keep detailed Ferris rules in skills while embedding the
  minimum diagnosis, testing, cleanup, and evidence gates in role prompts.

## 4.3.2

- Let scout use active, known-safe retrieval plugins: `anchor_grep`, web content
  tools, and Context7 documentation tools. Shells, mutation tools, and unknown
  custom tools remain blocked.

## 4.3.1

- Make phase ownership explicit and reject an exact active duplicate by normalized
  task plus resolved working directory, regardless of agent name.
- Route each result exactly once: `wait: true` owns in-turn delivery, background
  completions use follow-up wakeups, and immediate failures flush earlier successes.
- Move worktree preparation under the bounded queue, release child-process slots
  before Git finalization, and report repository-lane versus process-slot waits
  accurately.
- Keep missing restored worktrees failed, retained, and non-resumable; compute RPC
  usage from generation-safe session-stat deltas.
- Store the worktree recovery manifest under `ferris-pi-subagents/`, relocating
  an existing agent-root manifest without losing retained artifact pointers.
- Enforce a strict read-only scout tool set and strict declared-tool intersection.
  Unknown custom tools remain conservatively write-capable for isolation.
- Honor `enabledAgents`, including `[]`, without auto-enabling roles. Remove the
  completed role/config migration bridge and shorten role prompts, tool metadata,
  launch receipts, and handoffs.

## 4.3.0

- Built-in team is `scout`, `artisan`, and `steward`. All three stay enabled.
- `explorer` / `executor` configs rename in place (models and thinking
  overrides follow). `steward` is adopted. That migration is deleted in the
  next major.
- Artisan owns implement / fix / refactor / test. Steward owns cleanup, docs
  sync, and merge — dispatched only when that work exists.
- Thinking is a role default (scout low, artisan high, steward medium) that
  `/subagents-setup` can override. Per-call `thinking` and agent-file
  `thinking` are gone. There is no Auto row.
- First session and first-run setup explain each role and ask for a model.
- Unit tests cover catalog migration, role prompts, dispatch routing, and
  honest footer / truncation notes.

## 4.2.13

- README: table of contents, a What's new lead-in, and a pointer at this
  changelog. Release notes describe the live `main` → npm path.

## 4.2.12

- Executor confirms each named defect on current code before editing.
- Footer settled counts stay on the line only while a sibling is live, and
  widget truncation no longer lies about what was cut.
- Merging to `main` publishes an unpublished `package.json` version to npm
  and opens a matching GitHub Release.

## 4.2.8

- Always-visible footer roll-up: `subagents 2 running · 1 repo lane · 3 done`.
- `wait: true` streams progress onto the tool card and reports child token
  spend as the call's own usage.
- Completions are held while context compaction rewrites history, then
  released on success, failure, or abort.
- A delivered result no longer enters the parent context a second time.
- Isolated worktrees link `node_modules`.
- Widget worktree badge is spelled out (`worktree:a91f3c`).

## 4.2.7

- Executor routing is a single self-contained deliverable; `thinking` can
  be set per dispatch.
- Child prompt temp directories are removed recursively.

## 4.2.5

- The threads manifest lives per project, beside that project's artifacts.

## 4.2.4

- Explorer findings are one-line retrieval leads.
- Worktree recovery retries cleanup when the patch was already applied.

## 4.2.2

- A single artifact the main agent must fully absorb stays an inline read;
  re-reads are bounded.

## 4.2.1

- Upgraded configs prune retired built-in roles so the setup wizard never
  mixes old and new names.

## 4.2.0

- Built-in team is `explorer` and `executor`. The old
  `worker` / `cleaner` / `documenter` / `synthesizer` / `reviewer` set is
  gone.
- Live widget splits each run into an identity line and a dim activity line.
