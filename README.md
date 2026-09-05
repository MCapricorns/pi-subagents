# pi-subagents

[![npm version](https://img.shields.io/npm/v/@ferris1225/pi-subagents?color=blue)](https://www.npmjs.com/package/@ferris1225/pi-subagents)
[![downloads](https://img.shields.io/npm/dm/@ferris1225/pi-subagents)](https://www.npmjs.com/package/@ferris1225/pi-subagents)
[![license](https://img.shields.io/npm/l/@ferris1225/pi-subagents)](./LICENSE)
![platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey)
![pi](https://img.shields.io/badge/pi-extension-orange)

A managed engineering team for [pi](https://github.com/earendil-works/pi): four
focused sub-agents, durable threads, and Git worktree isolation. You install it
once and your main agent delegates on its own.

## What's new

**4.3.10** — adds read-only `subagent_status` and removes `subagent_control`
(`steer`, `park`, and `resume`). Runs are one-shot; main handles unfinished work.
Failure reporting preserves real RPC exit/provider diagnostics and distinguishes
a failed run from an intentionally failing tool call. Requires Pi **0.85.0** and
reuses its official RPC types. Setup discovers actual role definitions instead
of inventing roles from saved names; there are no retired-role aliases or migrations.

See [CHANGELOG.md](./CHANGELOG.md).

## Contents

- [Why](#why)
- [Install](#install)
- [The team](#the-team)
- [Dispatching work](#dispatching-work)
- [Parallel edits](#parallel-edits)
- [Runs: status and stop](#runs-status-and-stop)
- [Live status and results](#live-status-and-results)
- [Models, thinking, and tools](#models-thinking-and-tools)
- [Configuration](#configuration)
- [Custom agents](#custom-agents)
- [Storage and cleanup](#storage-and-cleanup)
- [Development](#development)
- [Changelog](#changelog)
- [Release](#release)

## Why

Delegation is supposed to remove coordination work. Most sub-agent launchers stop
at "spawn a child with a prompt" and leave the hard parts — when to delegate, how
wide to fan out, what happens when a model dies, how results come
back — with you. This extension owns them:

- The main model gets a cost-aware routing contract and proactively delegates
  substantial self-contained phases when a fresh context saves more work than its
  handoff costs. Every brief carries the objective and done condition, exact paths,
  facts already established with citations, boundaries, and the expected output, so a
  child starts from evidence instead of re-deriving it.
- A stable `phaseId` owns a logical phase in one resolved working directory even if
  its task wording changes. IDs are 1–80 ASCII letters, numbers, or `._:-`, starting
  with a letter or number, so lease output stays single-line. Exact normalized task+cwd
  remains the backward-compatible fallback for old calls.
- Runs are one-shot. Use `subagent_status` to inspect them and `subagent_stop` to
  cancel them; main handles unfinished work instead of continuing a failed child.
- Background completions and stop results arrive at the next parent model boundary;
  `wait: true` returns the same result in-turn instead. A run uses exactly one route.
- Parallel writers use detached Git worktrees without touching your index.
  Worktree setup obeys the bounded queue; final integration releases its process slot.
- Interrupted work retains artifacts for manual recovery after reload or crash.
  Within a run, a configured child-model failure can still hand off to the main model.
- Failure notifications include available reasons, and status keeps terminal facts
  and retained recovery paths queryable for the current parent session.

## Install

Requires **pi >= 0.85.0** and **Node.js >= 22.19.0**.

```bash
pi install npm:@ferris1225/pi-subagents
```

Pi's extension list shows `@ferris1225/pi-subagents` without an internal source-path suffix.

Open pi and run `/subagents-setup`. The original menu flow lets you enable or
disable roles, configure one role's model and thinking level, or run the full setup
again. Each screen uses the usual arrow-key/Enter/Esc navigation, and model lists
remain searchable. Fresh installs select all four. A newly shipped built-in is
surfaced once without being re-enabled after you deliberately turn it off. Then ask
for work:

```text
Map how authentication works, fix the refresh race, run the tests, and review the diff.
```

The main agent decides when delegation pays off. You can also call the tools
directly when you want exact control.

## The team

| Agent     | Access    | Owns |
| --------- | --------- | ---- |
| `scout`   | Read-only | Broad or unfamiliar code reconnaissance and external research. Returns compact file citations or source URLs as leads, not proof. |
| `artisan` | Full      | One substantial primary change—implementation, fix, refactor, test, or docs—through root cause, affected verification, and local hygiene. |
| `steward` | Full      | One final cleanup and cross-cutting docs/comment sync pass after a broad or multi-writer change. |
| `sentinel` | Read-only + one proving check | One fresh-context review of a completed diff for risky changes. Returns only evidence-backed defects and test gaps, highest severity first, or `No findings.` |

Role prompts are self-contained and directly embed root-cause-first diagnosis,
meaningful test evidence, and bounded cleanup. Each role starts from the facts and
citations its brief already establishes instead of re-deriving them, answers the
brief's question and stops, and — because nobody can answer a child's questions —
resolves an ambiguity by naming the reading it took. Artisan stops and reports when
the brief's premise turns out wrong rather than substituting a different change;
steward runs only the checks that cover its own edits; sentinel treats the brief's
claims and the code as evidence to verify, runs only the smallest check that proves a
suspected defect, and names the smallest fix instead of making it. Every role hands
back a result-only report with each check as `command → result`.

Custom roles join them with a Markdown file (see [Custom agents](#custom-agents)).

Every child is an isolated leaf pi process with its own context window and no
memory of your conversation, so the brief is its only input. A good brief carries
the objective and its done condition, exact paths and symbols, facts already
established (with citations), boundaries, and the expected output shape — which is
what the injected delegation guidance produces when the main agent dispatches for you.

Children run the official `pi --mode rpc` server, using Pi's exported command/response
types and its own session persistence. There is no separate subagent protocol. The
host transport remains local because Pi 0.85.0's `RpcClient` cannot attach to our
child process or provide process-tree shutdown, bounded abort coordination, and
cancellation of child extension dialogs.

## Dispatching work

```ts
// One task
subagent({
  phaseId: "cache-invalidation-fix",
  agent: "artisan",
  task: "Fix the cache invalidation bug in src/cache, add regression tests, run the checks.",
  scope: {
    paths: ["src/cache"],
    symbols: [{ path: "test/cache.test.ts", name: "invalidates stale entries" }],
  },
});

// Parallel only when each scope independently justifies a child
subagent({
  tasks: [
    {
      agent: "artisan",
      phaseId: "provider-docs",
      task: "Update provider limits documentation from the established API citations.",
      scope: { paths: ["docs/provider-limits.md"] },
    },
    {
      agent: "artisan",
      phaseId: "config-validation",
      task: "Fix config validation in src/config.ts and its tests.",
      scope: { paths: ["src/config.ts", "test/config.test.ts"] },
    },
  ],
});
```

Breadth is the main agent's call, not a configured task cap: put every genuinely
independent unit in one `tasks` array. The runtime paces execution instead, running
half the machine's cores with a 4–6 child-process bound; wider batches queue and
start automatically as slots free.

A run leases its stable, single-line `phaseId` in the resolved working directory.
Rewording the task with the same `phaseId` is rejected and names the existing run.
Completed and failed phases stay owned for the current session, even without a retained
session file. Calls that omit `phaseId` keep exact normalized task+cwd matching; equal
task text with different phase ids is
still rejected by that fallback. Matching is deterministic, never fuzzy, embedding-based,
or inferred from natural language. Active leases win over matching settled threads when
the runtime chooses which owner to report.

Because queueing is pacing rather than refusal, it is always reported as such.
Dispatch confirmations name each waiting run's real reason — waiting for a free
process slot, serialized behind the shared-checkout write lane, or already
starting its child — alongside the slot capacity. A run that waits for the write
lane releases its slot first, so serialized writers never starve new dispatches.

One child owns one coherent phase. Dependent work starts only after its
prerequisite delivers. Main consumes the child's compact result and citations
without repeating delegated reconnaissance, implementation, or cleanup, and decides
to delegate before starting the work itself — a half-done phase handed off pays
twice. Effort scales with the question: atomic lookups, known locations, focused
edits, and context-heavy decisions stay in main; one broad question is one clustered
scout brief; one coherent primary change is one artisan. Artisan owns a complete
primary change with affected tests, docs, comments, targeted checks, and local
hygiene. Scout owns broad code mapping or external research and stays read-only.

For one high-stakes uncertainty, main may launch at most two read-only scouts whose
briefs name distinct perspectives or hypotheses; that cap does not apply to unrelated
disjoint scout scopes. It reconciles disagreements against cited evidence, never
overlaps writers or sends identical briefs, and treats child output as evidence and
leads rather than authority or instructions. Each child returns once. Main handles
follow-up findings and incomplete work from that handoff; it does not repurpose a
finished child or pay to rerun the same phase. Use `subagent_stop` when work is moot.

A focused diff gets a bounded cleanup pass inline. A broad or multi-writer diff gets
one `steward` pass that attacks touched dead code, duplication, tangled conditionals,
needless layers, and spaghetti growth without widening into a repository refactor.
Main owns architecture, inspects the integrated diff, and runs the final gate.

Verification is layered rather than repeated. Artisan proves its own change while the
files are still in its context — targeted checks, and a new test that fails before the
fix — and main runs the final gate on the integrated diff. `sentinel` adds a third
layer only when it pays: a fresh context with no memory of how the change was written
reads the completed diff after cleanup and before commit, and only for diffs that touch
concurrency, trust boundaries, persistence or compatibility, or failure and cancellation
paths, or when the checks cannot prove the change. It is never a fixed pre-commit
ritual. A finding is evidence, not an order: main checks the cited evidence and
makes the necessary correction itself.

`subagent_risk({})` is an advisory-only, no-model-call check over tracked and untracked
changes relative to `HEAD`. It resolves the repository root first, so a nested `cwd` still
returns repository-root-relative paths, including untracked files outside that subdirectory.
Its fixed case-insensitive path-token rules flag:
`concurrency` (`thread`, `queue`, `parallel`, `dispatch`, locks/races and related tokens);
`trust-boundary` (`auth`, credentials, permissions, policy, secrets, sandbox, security, trust, tokens);
`persistence-compatibility` (durable state, manifests, migrations, restore, schemas,
serialization/storage); and `failure-cancellation` (abort, cancel, errors/failures, recovery,
retry, stop, timeout). It returns the changed paths, matched categories, and whether those
rules suggest Sentinel. If Git or `HEAD` is unavailable, it reports advisory unavailable; an
aborted tool call propagates cancellation instead of converting it to an advisory result. It
never blocks, starts a child, or automatically dispatches Sentinel.

This classifier is intentionally conservative and explainable: it only sees path names, so
it can produce false positives and miss risky behavior hidden behind neutral names. Main
still decides whether review pays from the actual diff, test evidence, handoff cost, and the
complete conversation. The runtime can enforce explicit phase/scope admission, but cannot
safely force the natural-language judgment of whether work is worth delegating.

## Parallel edits

`scope` is declarative admission metadata for expected writes, not access control. `paths`
contains exact file or directory paths; `symbols` contains exact `{ path, name }` claims.
Paths resolve from each task's caller-facing cwd and use case-insensitive comparison on
Windows. Wildcard `*` and `?` inputs are rejected; other punctuation is treated literally,
so paths such as `app/[id]/page.tsx` are valid exact claims. A path claim overlaps the same
path, an ancestor/descendant path, or a symbol under that path; identical path+symbol
claims overlap, while two different symbols in the same file may run together.

Fresh dispatches check declared writer scope against active, interrupted, or settling
writer leases before allocating a run. Scope
comparison uses normalized absolute claims rather than requiring equal caller cwd, so a
repo-root claim still conflicts with the same path claimed from a nested cwd. Settled
threads do not block a later phase solely because it edits the same scope.

Before allocating any run in a parallel call, the runtime also rejects deterministic phase
duplicates within the batch or against existing active/retained threads, then compares
declared writer scopes across the whole batch. A definite conflict rejects the whole batch
with zero starts. Parallel calls without `scope` remain valid, but their tool result and
launch receipt say `independence not verified`; that means the contract lacked enough
metadata, not that overlap was proved safe. Single calls never make a batch-independence
claim. The existing shared-checkout writer lane remains the final serialization boundary.

- Single tasks use your checkout. Every parallel write-capable agent (`artisan`,
  `steward`, and custom writers) defaults to a detached Git worktree, so
  parallel writers run at the same time. Worktree mode needs a committed `HEAD`;
  read-only roles such as scout stay on the shared checkout. `sentinel` always
  reviews the shared checkout, because the uncommitted diff it inspects does not
  exist in a detached worktree; an explicit `isolation: worktree` for it is
  rejected. Its proving check makes it a shared-checkout lane holder, so it never
  reviews a diff a shared writer is still changing.

> **Security boundary:** worktree isolation isolates Git changes only; it is not a sandbox.
Child tools, network access, and environment access retain the Pi process's privileges.
Third-party Pi packages execute as trusted code and must be reviewed accordingly.

- A role file can pin its own default with `isolation: worktree` or
  `isolation: shared` in the frontmatter. Precedence is an explicit per-dispatch
  `isolation`, then the role's declaration, then the parallel write default.
- An isolated run's tracked, deleted, untracked, and binary changes integrate
  back exactly once, after the child settles. Nothing is staged and your index is
  untouched.
- Integration is a three-way merge, so parallel workers that touched disjoint
  files or regions land cleanly even when earlier patches moved the checkout
  underneath them. A genuine overlap leaves conflict markers in the checkout and
  keeps the worktree and patch for you to resolve.
- Shared-checkout writers serialize through
  one repository lane, so two of them never race. A run waiting there is reported
  as a lane wait, not as slot queueing, and its process slot is already released.
- Setup and integration failures keep the useful patch and worktree, and record
  where they are in `~/.pi/agent/ferris-pi-subagents/pi-subagents-recovery.json`.
  start repeats that notice until you remove the artifacts. When the changes had
  already been applied and only the cleanup failed, the next session start
  removes the retained copy itself and clears the notice.

## Runs: status and stop

Every dispatch returns a stable `#id`. Runs are one-shot: there is no
`subagent_control`, `steer`, `park`, or `resume` interface. Main takes over failed
or incomplete work using the child's partial edits and artifacts. A different
deliverable needs a new phase and brief, not a recycled thread.

| Tool | What it does |
| ---- | ------------ |
| `subagent_status` | Read-only inspection. Omit `id` to list this parent session's runs, or pass an exact numeric `id` to inspect one. |
| `subagent_stop` | Destructively cancel/retire a run by id/prefix, or all active runs with `all: true`. Delivers partial output and finalizes isolated changes. |

```ts
subagent_status({});
subagent_status({ id: 7 });
subagent_stop({ id: "7" });
```

Status reads runtime state without starting, stopping, continuing, or waiting for a
child to finish. It includes the phase/task summary, activity, elapsed time, model,
usage, terminal diagnostics, and available result/session/recovery paths. States
distinguish `queued`, `running`, `interrupting`, `settling` (Git finalization),
`completed`, `failed`, `stopped`, and `interrupted` (recovered unfinished work).
Queued runs report their actual wait reason. Settled runs remain queryable in the
current parent session even after their transient widget rows disappear.

The tool returns these facts in Pi's existing structured `details.runs` field.
An individual run's failure does not make a successful status lookup a tool error;
an unknown `id` does. This is runtime-authored data, not a requirement for children
to generate strict JSON. Agent-written reports remain evidence to verify.

A background dispatch returns a launch receipt, then its completion arrives at
the next safe parent boundary—after current tool calls and before the next model
call. `wait: true` instead holds the dispatch until its new runs settle, which is
useful for one-shot `pi -p` sessions or an immediate dependency. Each run has one
delivery route; aborting the waiting parent turn transfers delivery to the
background path. Use status for on-demand inspection, not a polling or sleep loop.

Stop drops messages still queued inside Pi, performs a bounded RPC abort, and
terminates the child process tree. It retires the session; it never starts another
attempt. Worktree integration failures keep their recovery artifacts.

Interrupted work retains a durable record and any session/worktree artifacts for
manual recovery after reload or crash. Missing session files no longer discard
isolated edits. Restore runs at session start; lookup tools, prompt injection, and
fresh dispatch wait for that pass so an existing id cannot be reported missing or
reused. Missing recorded worktrees surface as failures without discarding the
remaining recovery evidence.

Canonical managed-path and repository validation remains in place. Invalid records
are dropped without following or deleting their targets. Recovery-owned worktrees
and patches stay protected from startup sweeps and project-root retention.
Completed/failed runs drop their durable thread record; after reload, inspect their
delivered result instead of expecting them in the current-session status list.

## Live status and results

The TUI widget renders one line per active run in fixed identity columns —
status icon, right-aligned `#id`, padded agent name, then the task label — so
every label starts at the same column, with the live activity dimmed after
`↳` on its own line and the rest of the telemetry flowing inline after ` · `: the
worktree badge, wait state, token flow in the footer vocabulary (`↑` input, `↓`
output, `R`/`W` cache read/write), cost, full `provider/model`, current effective
`think:<level>`, and seconds-precision elapsed. A live run renders
two lines: what it is — agent, task, usage, model, thinking, elapsed —
and, dim under the label column, what it is doing right now:

```text
● #12 artisan  src/cache.ts · worktree:a91f3c · ↑5.2k ↓41.0k R210.0k W6.1k $1.9400 · think:high · 12m06s
  ↳ edit src/auth.ts
● #15 scout    src/models.ts · ↑1.2k ↓8.4k R31.0k W1.1k $0.0900 · openai/gpt-5-mini · think:low · 3m07s
                ↳ grep fallback
○ #23 artisan  src/config.ts · repo lane
○ #24 artisan  tests/config.test.ts · queued · 5m02s
```

Telemetry drops leftmost-first when a row runs out of width (badge, wait state,
usage, model, thinking) while elapsed survives every width. Queued rows state
what they actually wait for — `queued` for a free process slot, `repo lane`
for shared-checkout write serialization, or `starting`. The widget is
capped at ten lines: when many runs are live, extra runs collapse into a
`… +N more` marker so the editor keeps its space.

The widget is the detailed surface, but it only pays off while you are looking
at it. A one-line roll-up in the always-visible footer answers "is anything
still working?" without opening the widget or asking:

```text
subagents 2 running · 1 repo lane · 3 done
```

It is count-only, keeps the same wait vocabulary as the widget, and works in
RPC hosts as well as the TUI. Settled counts stay on the line only while a
sibling is still live (`2 running · 3 done`); the line disappears once nothing
is active.

Completions resume the main agent on their own, with a compact block of at most 40
lines by default; longer output lands unchanged in a Markdown artifact whose path
comes with the message, stated as how much was actually cut (`40 of 137 lines
shown`, or a 200-character clip when a short result has a long line) and
conditioned on the shown lines being insufficient, so the same
content does not enter the main context twice. Roles write result-only handoffs — outcome, paths,
verification, unresolved blockers — and the main agent is told to add its
conclusion rather than restate what you already read. A failed run adds its
failed-tool diagnostics.

Delivery is held while a context compaction is in flight and released once it
settles — on failure and abort too — so a result a child spent minutes producing
is never swallowed by the summary that replaces the history.

A `wait: true` dispatch streams its progress onto the tool card while it waits,
and reports the awaited children's token spend as the tool call's own usage, so
sub-agent cost lands in the footer, `/session`, and RPC session totals. A
background dispatch returns before its children finish, so it reports no usage
rather than a fabricated number.

## Models, thinking, and tools

Each agent runs on the current main model or one picked in `/subagents-setup`,
which labels vision and text-only models. If a selected model is missing,
rate-limited, or fails at the provider level, the **same retained
session** continues on the main model, so finished searches, reads, and edits
survive. Ordinary task failures do not trigger a handoff.

Thinking is a **role default** — scout `low`, artisan `high`, steward `medium`,
sentinel `high` — clamped to what the effective model supports. `/subagents-setup` →
_Configure an agent_ lists only the levels that model supports and marks the role
default; selecting it clears the stored override. There is no
Auto choice, no per-dispatch `thinking` flag, and
no `thinking` field in agent Markdown. Precedence: your setup override > the
role default, then the model clamp. There is no separate vision mode — assign
a multimodal model and name the image paths in the task.

Every dispatch, startup retry, and model fallback snapshots the parent's active tools,
and all `subagent*` tools are removed so children remain leaves. A role without
an explicit list inherits that snapshot; an explicit list is a strict
intersection, so active extension tools are available only when named. A declared
shell slot follows the parent's active shell on non-scout roles.

`scout` is a hard read-only boundary even when a project override omits or
overstates its tool list. Its known-safe set includes `read`, `grep`, `find`,
`ls`, `anchor_grep`, `web_search`, `fetch_content`, `resolve-library-id`, and
`query-docs`; tools not installed or active in Main are simply omitted. Scout
receives no shell, local mutation tool, or unknown custom tool. `sentinel` declares
the same retrieval set plus one shell slot, which follows the parent's active shell
and exists only for the smallest check that proves a suspected defect; it is an
ordinary declared list, not a hard boundary like scout's. Unknown tools
declared by other roles are conservatively treated as write-capable when
isolation is chosen. An empty resolved snapshot starts the child with
`--no-tools`.

For external research scout prefers official documentation, specifications, release
notes, and first-party repositories; it fetches decisive pages rather than citing
search snippets, records material dates/versions, and marks uncertainty.

## Configuration

`/subagents-setup` opens the original settings menu: enable or disable roles,
configure one enabled role's model and thinking level, or walk through a full
re-setup. `Esc` moves back through the menu stack, and model lists support fuzzy
search. The enable menu discovers built-ins and actual custom role files in the configured
scope, including roles never configured before. Project files require Pi's project trust.
Config-only names are not role definitions and never appear in the enable or configure
picker. Saving an enable selection or full setup discards unavailable role names and their
model/thinking settings; no retired-name aliases or configuration migration are applied.
To start over, remove `pi-subagents.json` and run `/subagents-setup` again. Other settings live in
`~/.pi/agent/pi-subagents.json` (following `PI_CODING_AGENT_DIR`):

```json
{
  "enabledAgents": ["scout", "artisan", "steward", "sentinel"],
  "knownAgents": ["scout", "artisan", "steward", "sentinel"],
  "agentModels": { "scout": "anthropic/claude-haiku-4-5" },
  "agentThinkingLevels": { "artisan": "high" },
  "maxResultLines": 40,
  "agentScope": "user",
  "idleTimeoutSec": 90
}
```

| Field                 | Meaning |
| --------------------- | ------- |
| `enabledAgents`       | Agents available for discovery and delegation. `[]` disables all. |
| `knownAgents`         | Catalog shown by setup; tracks built-in adoption, but cannot define a custom role without a file. |
| `agentModels`         | Optional model per agent; missing means the current main model. |
| `agentThinkingLevels` | Optional setup override per agent; missing means the role default. |
| `maxResultLines`      | Lines kept in a completion message before the artifact takes over. Default `40`. |
| `agentScope`          | Discover `user`, `project`, or `both` agent directories. Default `user`. |
| `idleTimeoutSec`      | Seconds without child RPC output before termination; `0` disables. Default `90`. |

When at least one role is enabled, the cost-aware delegation directive is injected
automatically. `enabledAgents` is authoritative after catalog adoption: a newly
shipped built-in is appended once, then `knownAgents` records that it was surfaced
so a deliberate later disable remains disabled. `sentinel` returns through that
rule: a config written by 4.3.5–4.3.7, which removed it, enables it once on the next
load; turn it off in `/subagents-setup` and it stays off. Available custom roles remain
selectable even when disabled. Invalid known fields fall back safely, and unknown fields
are dropped when canonical config is persisted.

At session start, model overrides that pi no longer reports are removed with a
one-time notice. If pi's own session compaction fails mid-thread, a notice surfaces
the error and automatic retry instead of failing quietly.

## Custom agents

Built-ins ship with the package. Add or replace them with Markdown files:

- User agents: `~/.pi/agent/agents/`
- Project agents: the nearest `.pi/agents/` in a trusted project
- Precedence: project > user > built-in, where the same `name` wins

```yaml
---
name: scout
description: Fast read-only codebase reconnaissance
isolation: shared
tools: read, grep, find, ls
---
…additional system prompt…
```

`description` is the routing line the main model reads. `isolation` pins the
role's default boundary as described under [Parallel edits](#parallel-edits).
Models come only from `/subagents-setup`; an agent file cannot pin one. An
explicit `tools` list is intersected with the parent's active set; omitting it
inherits the active set. A role named `scout` is always reduced to the fixed
read-only tool set described above.

## Storage and cleanup

Everything lives under your pi agent directory, grouped per project. Nothing
long-lived is written to the OS temp directory, and every class of file has a rule
that removes it, so this directory does not grow without bound:

| Path                                       | Holds                                                | Removed                                                          |
| ------------------------------------------ | ---------------------------------------------------- | ---------------------------------------------------------------- |
| `pi-subagents.json`                        | Your configuration                                   | Never — it is yours                                              |
| `ferris-pi-subagents/pi-subagents-recovery.json` | Worktree integration and cleanup failures | When the retained patch or worktree it points at is gone |
| `ferris-pi-subagents/<project>/pi-subagents-threads.json` | One record per interrupted thread     | When the thread settles, or after 30 days                        |
| `ferris-pi-subagents/<project>/sessions/`  | Child sessions for in-run fallback and manual recovery | When the owning session ends and no recovery record claims them |
| `ferris-pi-subagents/<project>/worktrees/` | Isolated checkouts for parallel writers              | On integration, or when no thread/recovery record claims them  |
| `ferris-pi-subagents/<project>/results/`   | Full text of truncated results                       | After 7 days, or beyond 50 per project                           |
| `ferris-pi-subagents/<project>/tmp/`       | Child prompt copies and the no-retry policy shim     | When its owning process exits                                    |
| `ferris-pi-subagents/<project>/`           | All of the above for one checkout                     | After 3 idle days unless a thread/recovery record claims it      |

Cleanup runs at session start and is deliberately conservative. A directory goes
away only when the process that created it is gone and no valid manifest record still
claims it, so a live sibling pi instance never loses state and interrupted or recovery-owned
work outlives its own process by design. Thread and recovery references always beat an
age rule.

## Development

```bash
npm install
npm run check
```

`npm run check` is `tsc --noEmit` plus the unit tests (`npm test`). There are
no bundled runtime dependencies; pi and TypeBox are peers. The source is
grouped by responsibility under `src/`: configuration, delegation, execution, isolation,
lifecycle, and presentation. Thread restoration, shared lifecycle coordination, RPC control,
and Git command execution live in focused modules rather than oversized catch-all files.

The test runner uses Node 22 or 24; Node 26 removed `--experimental-transform-types`.
Pi 0.85.0's unbundled SDK and CLI import `@earendil-works/pi-server` without declaring
it. This project declares the official server package as a peer (and a development
dependency), so npm can resolve it alongside the SDK in consumer installations.
It is not bundled into the extension, and no replacement RPC server is introduced.

## Changelog

See [CHANGELOG.md](./CHANGELOG.md) for published release notes.

## Release

Pushing to `main` publishes `@ferris1225/pi-subagents` when `package.json`
carries a version npm does not have yet, then opens a matching GitHub Release.
Do not `npm publish` from a laptop. The workflow is
`.github/workflows/publish.yml` (npm trusted publisher or `NPM_TOKEN`).

## License

MIT
