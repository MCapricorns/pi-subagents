# Changelog

Published versions of `@ferris1225/pi-subagents`. Unpublished numbers
(`4.2.3`, `4.2.6`, `4.2.9`–`4.2.11`) never shipped on npm; their changes
landed in the next published release.

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
