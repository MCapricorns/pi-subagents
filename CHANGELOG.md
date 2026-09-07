# Changelog

Release notes for `@ferris1225/pi-subagents`. Only the most recent releases
are kept here; every published version is preserved as a GitHub Release.

## 4.3.15

- Fix the cost footer's stale-context crash after reload, new session, resume,
  or fork. Remove the module-global event context cache and render against
  the installed footer's own live session context. Existing shutdown cleanup
  removes the footer and its subscriptions before that context is invalidated.
- Cover replacement-session rendering with Pi's real context invalidation,
  subscription cleanup, and live model/thinking/context/session-name updates.

## 4.3.13

- Remove the `subagents N running · …` activity-count line from the footer.
  Live progress stays visible in the above-editor widget, per-run completion
  notifications, and `subagent_status`; the footer is reserved for the
  per-model cost tally.

## 4.3.12

- Replace pi's built-in consumption line with a per-model cost footer for the
  main window: each `provider/model` keeps its own token flow, cost, context
  share, thinking level, and live `tok/s` throughput, directly under the
  current-project line. Settled models rank by spend, cap at three rows, and
  drop token flow before truncating under width pressure. The tally reseeds
  from the session file on reload.
- Stop attaching awaited children's usage to the `subagent` tool result: pi
  folds tool-result usage into one session total, which merged every model's
  spend into the main window's consumption. Children keep reporting usage per
  run with their model ref when they settle.
- Group parallel completion totals per model instead of summing different
  models' costs into one number.

## 4.3.11

- Simplify parent delegation and built-in role prompts using OpenAI's GPT-6 Astra
  guidance and Eric Provencher's prompting experience. Keep role descriptions in
  the catalog and brief details in tool parameters instead of repeating both.
- Replace fixed search routines, research fan-out, exhaustive cleanup itineraries,
  and mandatory per-test red/green demonstrations with outcome-driven work and
  change-appropriate verification. Required project gates and meaningful tests remain.
- Clarify that children receive normal Pi project instructions in addition to their
  brief. Let writers resolve routine implementation details and complete authorized
  work, while preserving explicit scope/approval boundaries and read-only roles.
- Retain one-shot phase ownership, tool restrictions, admission checks, isolation,
  cancellation, and recovery. Make stop's destructive, non-resumable behavior explicit
  in its own tool description. Model selection and thinking defaults are unchanged.

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
