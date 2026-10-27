# Changelog

Release notes for `@ferris1225/pi-subagents`. Only the most recent releases
are kept here; every published version is preserved as a GitHub Release.

## 5.0.0

Behavior changes: child execution now uses Pi's native one-shot JSON CLI, and
cancelling the parent stops its child work instead of transferring undelivered
awaited results back to background completion. Conversation-tree navigation
also stops unfinished work. New/resume/fork/reload retains interruption evidence
without carrying old children or completion wake-ups into the new conversation.

- Restore ordinary subagent completion delivery; workflow quiet mode had left
  the normal completion constructed but unpublished. Add a dispatcher regression
  and enable unused-local and unused-parameter checks.
- Replace the custom RPC transport with Pi's native one-shot JSON CLI. Keep
  process-tree cancellation, Pi session persistence, and one selected-to-main
  model handoff. Use Pi's native retries and provider adapters; remove RPC
  commands, handshake retries, delivery fallback state, and the provider shim.
- Stop owned work on parent cancellation and conversation-tree navigation
  without completion wake-ups. New/resume/fork teardown ends old children and
  retains recovery evidence. Share the stop lifecycle between tools and graphs,
  wait for worktree cleanup, and interrupt graph and standalone writers together.
- Fix transitive result interpolation, bound upstream answers with full-result
  artifacts, honor explicit isolation, propagate blocked nodes in any author
  order, and checkpoint live graphs for crash recovery. Reserve pending phases
  before run allocation and reject malformed or unfinished saved definitions.
- Show workflow progress, pending dependencies, queue reasons, failures, and
  blocked branches in the TUI widget, within the existing ten-line limit.
- Keep adversarial review, independent confirmation, and synthesis available;
  choose depth for risk instead of prescribing one pipeline. Keep fixes with
  their regression tests, use command-capable roles for reproduction, and keep
  discovery-dependent planning in main. Update templates and authoring guidance.
- Verify the actual installed Pi CLI and same-session model handoff with an
  offline fixture provider, alongside lifecycle and rendering regressions.

## 4.3.34

- Reject a workflow that would reuse a phase this session already owns, before
  any node starts, and name each owning run with the way out. A settled phase
  stays owned once it settles, and an interrupted one keeps its claim across
  reloads, so "re-run it in a new session" was wrong: the graph previously failed
  its first node and blocked the rest.
- Say the same thing for a per-run duplicate: a parked owner is told to retire
  the phase with `subagent_stop({ id })` instead of being told to let it finish.

## 4.3.33

- Add `subagent_workflow`: declare a graph of phases with `dependsOn` and the
  runtime dispatches each node the moment its prerequisites settle and a process
  slot frees, without a parent model turn between waves. The graph is validated
  before the first child starts (unique ids, existing dependencies, no cycles,
  resolvable `{{id}}` placeholders, no declared writer-scope overlap between
  nodes no dependency orders), so an invalid plan costs zero child processes.
- Nodes are ordinary one-shot runs: same dispatcher, admission, isolation,
  durable checkpointing, and usage accounting. A node's result registers only
  after its worktree is integrated, so a dependent reads what its prerequisite
  actually left behind.
- A node completion is quiet; the graph reports once. The summary names
  completed, failed, and never-ran nodes with the reason, inlines each node's
  answer (clipped, with a full-report artifact when anything was cut), and adds a
  per-model tally. A failed node blocks only its dependents.
- Saved definitions: `.pi/workflows/<name>.json` or `.md` in a trusted project,
  `~/.pi/agent/workflows/` for the user, and `code-review`, `research`, and
  `migration` templates shipped with the package. Markdown definitions carry
  prose plus one `json` fenced block.
- `subagent_status` accepts `workflow` and reports graph nodes, wait reasons, and
  retained graphs; `subagent_stop` accepts `workflow` and stops a graph without
  starting its idle dependents. An unfinished graph's shape is retained on disk
  for the next session's notice instead of resuming automatically.
- Ship a `workflow` skill with the authoring guidance, and describe the graph
  tool in the delegation contract.
## 4.3.32

- Derive a role's tools from the live catalog instead of a hardcoded name list.
  No role file names extension, MCP, or vendor tools any more: `scout` keeps
  every active tool the host proves read-only (`annotations.readOnlyHint`, plus
  pi's own `read`, `grep`, `find`, `ls`), so any retrieval extension or MCP
  search server works for it without being named. The former `anysearch`,
  `anchor_grep`, `web_search`, and `fetch_content` entries are gone.
- Keep a tool that reaches other tools out of a read-only role. `codemode` and
  `tool_search` can reach a writer, so scout never receives them even when they
  are annotated read-only; broad roles still inherit the session's live surface,
  codemode included, and a code-mode parent therefore produces code-mode
  children under the same `codemode.mode`.
- Reach read-only MCP tools without reconfiguring the server. A server left at
  pi's default `codemode` exposure keeps its tools out of the model's
  declarations, so scout previously got nothing from it. It now receives the
  read-only ones directly — exactly those, since a named MCP tool also filters the
  rest — so a script-only search server works for scout with no `mcp.json` edit,
  and the child still cannot reach an MCP writer.
- Keep MCP tools out of a child that names none. pi keeps MCP tools unless a
  `--tools` entry names one, so a resolved child list that names none now adds
  `mcp__*` to the excluded tools; scout's read-only boundary can no longer leak
  an MCP writer.
- Treat tools without a read-only annotation as write-capable for worktree and
  repository-lane decisions, instead of trusting a built-in name list.
- Ship the two built-in role prompts as code and drop `agents/` from the
  package. Custom role files are gone entirely: nothing is discovered from
  `~/.pi/agent/agents/` or `.pi/agents/` any more, `scout` and `artisan` are
  always enabled, and a role can no longer declare its own tool list or
  isolation default.
- Reduce the config file to `agentModels` and `agentThinkingLevels`.
  `enabledAgents`, `knownAgents`, `agentScope`, `maxConcurrentAgents`,
  `idleTimeoutSec`, and `maxResultLines` are removed — capacity, idle timeout,
  and result length are fixed constants — and obsolete keys in an older file
  are dropped on load. `/subagents-setup` now lists the two fixed roles with
  their current route and walks model then thinking for one or both.
- Show a code-mode script's first meaningful line in the activity trail instead
  of a bare tool name, and drop the remaining vendor tool names from the
  formatter.
- Default to delegating instead of requiring a proven benefit first. The
  delegation directive and the `subagent` tool description now tell main to
  dispatch independent or self-contained work — parallel phases usually beat a
  serialized main — and keep only what needs conversation context or is too
  small to brief.
- Development dependencies track Pi 1.4.0. The unused
  `@earendil-works/pi-server` and `@earendil-works/pi-agent-core` peer and
  development dependencies are removed, and the source no longer uses parameter
  properties, so `npm test` runs without an experimental flag on Node 26 as well
  as Node 22 and 24.
- Drop dead code and tighten the module surface: stale re-exports
  (`matchRunIds`, `runInManagedRepositoryLane`, the `rpc-run` passthroughs) and
  the never-read `WorktreeSetupError.retainedPaths` are gone, and internal
  helpers and tuning constants are no longer exported. No behavior change.

## 4.3.31

- Write the config on first start instead of prompting. A missing
  `pi-subagents.json` is created with both roles enabled and no model overrides,
  so scout and artisan follow the main model immediately. Session start announces
  `/subagents-setup` once; the file's presence keeps later sessions silent. The
  first-run confirm dialog is gone.

## 4.3.30

- Restore pi's own footer. The extension no longer replaces the built-in
  consumption line with a per-model cost footer, so session spend is shown
  exactly as pi reports it.
- Ask for configuration on a fresh install. When `pi-subagents.json` does not
  exist, session start announces `/subagents-setup` and offers to open the
  wizard immediately instead of only printing a hint.
- The full setup asks each enabled role's thinking level right after its model,
  the same model-then-thinking order as _Configure an agent_, instead of leaving
  the role default unexamined.

## 4.3.29

- Remove the leftover `steward` and `sentinel` routing. Those roles are no
  longer shipped, yet a custom file with either name still received a special
  routing rule and lease label; it is now an ordinary custom role, listed by
  its catalog line only. Configs without adoption tracking now assume the
  shipped two-role catalog.

## 4.3.28

- Deliver a child's whole final answer. When the last assistant message split
  its answer into several text blocks (for example around interleaved
  thinking), only the first block reached main; every block is now joined.
- Keep only the newest 32k characters of a child's stderr. A chatty or
  crash-looping child no longer grows parent memory without bound, and error
  toasts are capped to one line; completion blocks and result files still carry
  the diagnostic tail.
- Model handoff prompts put the objective in its own block, so a multi-line
  brief stays intact instead of being spliced mid-sentence.
- The routing contract's preference line no longer restates the scout and
  artisan catalog descriptions word for word.
- Performance: RPC stdout framing is linear in the chunk size, identical
  streamed thinking/text deltas no longer re-render the widget, the durable
  manifest is rewritten only when a run's session or child pids change instead
  of on every child turn, and session-start hygiene validates manifests once.
- Session-start sweeps fail closed: an unreadable manifest skips the deleting
  sweeps instead of treating every directory as unclaimed.
- Internal cleanup: one shared process-tree terminator, a single result-row
  renderer, and shared usage formatting.

## 4.3.27

- Let `scout` use the `anysearch`/`anysearch_extract` web-retrieval tools. The
  role's known-safe read-only set already carried one search extension's tool
  ids (`web_search`/`fetch_content`); adding the AnySearch pair lets scout
  search and read decisive pages on installs that run that extension instead.
  Both tools stay behind the strict intersection with Main's active tools.
- Raise the idle-watchdog default from 90 to 1800 seconds (clamp ceiling 600 →
  3600). A child that goes silent on a long fetch or slow provider is no longer
  terminated mid-work; a saved config with the old `idleTimeoutSec` value keeps
  overriding the default until edited.

## 4.3.26

- Track Pi 1.3.0 development dependencies. Pi 1.2.0 fires `before_agent_start`
  for runs triggered by `sendMessage` too, which this extension already handles
  idempotently, and fixes Pi 1.0.x dropping extension-installed system prompt
  sections after the first tool call of such a run.
- Narrow `scout` to search only. Its role file and the parent routing line now
  say read-only code, documentation, and web lookup with no shell; work that
  needs execution stays in main instead of being briefed to a child that cannot
  run commands.
- Deliver long results exactly once. A completion that exceeds
  `maxResultLines` (or has lines wider than 200 characters) no longer inlines a
  truncated copy: the notice states the true size and routes main to the full
  Markdown artifact, so the same content never enters the main context twice.
- `subagent_status` answers progress with an activity trail of what each run
  has been doing, and no longer dangles child session paths in the
  model-facing text. Actionable paths — a truncated run's full-result file and
  retained worktree/patch artifacts — remain.
- Remove the advisory `subagent_risk` tool. A path-name classifier cannot
  out-judge main reading the integrated diff, and the tool added a call without
  adding evidence.

## 4.3.24

- Remove the live `tok/s` throughput figure from the per-model cost footer.
  Dividing the message's output tokens by wall-clock stream time could not be
  made trustworthy across providers (reasoning tokens, time-to-first-token,
  and per-chunk usage semantics differ), and no mainstream agent CLI ships a
  comparable live rate. The footer keeps exactly-reported facts only: per-model
  token flow, cost, context share, and thinking level.

## 4.3.23

- Track Pi 1.0.3. The extension API, RPC command types, and the child
  `registerProvider` path are unchanged. Pi renamed the Azure provider from
  `azure-openai-responses` to `azure`; a stored agent model override follows
  whichever of those ids the live catalog still lists, and is rewritten to
  `azure/<id>` once that is the one Pi reports.

## 4.3.22

- Use a subagent when the work can run independently in parallel, its boundary
  is clear, and delegation will actually reduce cost or improve completion
  quality. Role choice still prefers scout or artisan when that gate is met.

## 4.3.21

- Ship `scout` and `artisan` only. Scout is the lightweight read-only researcher;
  artisan implements one substantial change. Remove the built-in steward and
  sentinel roles, their setup profiles, and the sentinel review gate.
- Rewrite the role prompts and the parent delegation section for GPT-6 Astra:
  the brief outranks role text, authorized work finishes without a first-draft
  pause, and checks stay proportional to the change.
- Ask main to prefer scout and artisan when a fresh context or an independent
  parallel phase would help, and to keep small understood edits. Free slots are
  not a reason to open another phase.
- Report `subagent_risk` as elevated path risk for main to inspect.

## 4.3.20

- Install the delegation contract as a `<subagents>` prompt section and live
  phase leases as `<subagent_leases>`. Pi 1.0 appends a section delta only when
  that text changes, so an unchanged turn keeps the cached system prefix.
  Hosts without a section map still append the combined directive.
- Declare `subagent`, `subagent_status`, `subagent_stop`, and `subagent_risk`
  as `model-only`, with read-only or destructive annotations. Codemode scripts
  cannot call them, and they stay declared even when codemode hides `direct`
  tools. Dispatch and stop run sequentially so one assistant message cannot
  race phase admission.
- Register the child no-retry provider override with the model's `api`. Pi 1.0
  rejects a `streamSimple` registration that omits it, which left provider
  retries at the user's setting.
- Require Pi 1.0.0. Development dependencies track 1.0.2.

## 4.3.19

- Scope session-start thread restore and recovery notices to the current
  checkout. A second pi window in another project no longer announces the first
  project's retained worktree, retries its leftover cleanup, or restores and
  stops its interrupted children.
- Cover sibling-window isolation with recovery announcement, leftover-cleanup,
  and parked-thread restore checks across two checkouts that share one agent dir.

## 4.3.18

- Keep known-context local changes in main and delegate only substantial,
  bounded work with a concrete context, exploration, or parallelism benefit.
  Available roles and process slots are capacity rather than a team-size target.
- Reserve Steward for remaining cross-cutting cleanup and Sentinel for fresh
  verification of concrete concerns. Reuse completed local hygiene and checks.
- Add `maxConcurrentAgents`: `0` preserves automatic host capacity (4–6), and
  `1`–`6` selects an explicit process limit. Apply changes at the next dispatch;
  lowering capacity drains active work without aborting it. Existing queue,
  write-scope, leaf, and recovery protections remain in force.
- Document controlled workload comparisons that include final acceptance,
  parent and child costs, integration, failed attempts, and rework.

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
