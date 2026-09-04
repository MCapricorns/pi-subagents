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

**4.3.8** — `sentinel` is back as an optional fresh-context reviewer. It reads a
completed diff with no memory of how it was written and returns only evidence-backed
defects and test gaps; the main agent dispatches it for diffs that touch concurrency,
trust boundaries, persistence, or failure paths, never as a fixed pre-commit ritual, and
routes a finding back to the thread that owns the change. Configs written by
4.3.5–4.3.7 adopt it once; a deliberate disable sticks.

See [CHANGELOG.md](./CHANGELOG.md).

## Contents

- [Why](#why)
- [Install](#install)
- [The team](#the-team)
- [Dispatching work](#dispatching-work)
- [Parallel edits](#parallel-edits)
- [Threads: steer, resume, park, stop](#threads-steer-resume-park-stop)
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
- One normalized task and working directory owns its phase: an exact duplicate of an
  active run is rejected, and an exact re-run of a finished brief with retained
  context is rejected in favor of resuming it, so the same work is never bought twice.
- Follow-up work stays on the same thread: `steer` a running phase, `resume` or
  `park` a thread with its retained context, `stop` a phase the evidence made moot.
- Background completions and stop results arrive at the next parent model boundary;
  `wait: true` returns the same result in-turn instead. A run uses exactly one route.
- Parallel writers use detached Git worktrees without touching your index.
  Worktree setup obeys the bounded queue; final integration releases its process
  slot.
- Interrupted threads retain their session for resume after reload or crash; a
  configured child-model failure continues the same session on the main model.
- Start, restore, and integration failures surface with retained recovery paths
  instead of becoming silent hangs.

## Install

Requires **pi >= 0.84.4** and **Node.js >= 22.19.0**.

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

## Dispatching work

```ts
// One task
subagent({
  agent: "artisan",
  task: "Fix the cache invalidation bug in src/cache, add regression tests, run the checks.",
});

// Parallel only when each scope independently justifies a child
subagent({
  tasks: [
    { agent: "scout", task: "Research current provider API limits in primary sources and cite URLs." },
    { agent: "artisan", task: "Fix config validation in src/config.ts and its tests." },
  ],
});
```

Breadth is the main agent's call, not a configured task cap: put every genuinely
independent unit in one `tasks` array. The runtime paces execution instead, running
half the machine's cores with a 4–6 child-process bound; wider batches queue and
start automatically as slots free.

A run leases its normalized task and resolved working directory across agent
names. Dispatching the same pair again while the run is active is rejected and
names the existing run id. Once the run has finished in this session and still
holds its retained session, the same pair is rejected too, pointing at
`subagent_control resume` — the thread that already did the work continues for a
fraction of a fresh run — or at restating the brief with what changed. Matching is
exact, never fuzzy.

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
leads rather than authority or instructions. Follow-up work goes to the same thread,
never a second one: new in-scope evidence travels through `subagent_control steer`
(a thread that has settled or is parked continues with it), a follow-up on a
finished phase is a `resume` with an appended objective, a phase that must wait is
`park`ed at a stable checkpoint, and a phase the evidence made moot is ended with
`subagent_stop` instead of left running.

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
ritual. A finding is evidence, not an order: main routes it to the thread that owns
the change with `subagent_control resume`, or fixes it inline when that is cheaper.

## Parallel edits

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

## Threads: steer, resume, park, stop

Every dispatch returns a stable `#id`, which is the handle for the thread tools:

| Tool               | What it does |
| ------------------ | ------------ |
| `subagent_control` | `steer` a running RPC attempt with additional evidence/guidance, continuing the same thread with it when the thread has settled or is parked; `resume` a parked/settled thread with an optional appended `objective`; `park` a running thread at a stable checkpoint, keeping its session and worktree for a later resume. |
| `subagent_stop`    | Destructively cancel, deliver partial output, and retire the thread. Steering and follow-up messages still queued in the child are dropped so nothing can revive it later. |

```ts
subagent_control({ action: "steer", id: 7, objective: "The failing request used an expired token; account for that evidence." });
subagent_control({ action: "park", id: 7 });
subagent_control({ action: "resume", id: 7, objective: "Finish the tests." });
```

`steer` requires a nonblank `objective`. While the child RPC is running, it adds
guidance to the current phase without replacing the original task. If the thread has
already reached `completed`, `failed`, or `parked` — including a generation that settles
between the state check and RPC acceptance — the control call resumes the same stable
id, reuses retained context when available, and supplies the guidance as its appended
objective, so evidence is never re-bought by a second dispatch. Queued, starting,
retrying, resuming, interrupting, stopped, retired, and missing threads are rejected
without changing them. Steering ACKs are bounded, and steering/stop are serialized so
stop can clear queued child messages and abort without a stale steer landing afterward.

`park` pauses a running thread at its next safe point: the child is interrupted the
same way a session shutdown interrupts it, but the thread returns as `parked` rather
than failed, its retained session and any active worktree are kept, and its durable
record is written immediately so the checkpoint survives a reload. Nothing is
integrated or delivered on park; the tool result carries the usage so far and the
resume handle. Only an active running attempt with a retained session can be parked;
a run that has not started has nothing worth keeping, so `subagent_stop` discards it.

A resumed child is told that its earlier work is preserved and must not be redone, and
that the workspace may have changed while the thread was inactive — main may have
integrated sibling worktrees or edited the tree — so it re-reads a file before editing
it unless it read it during the continuation. A resume with an appended objective is
framed as the same thread continuing on top of finished work, never as a restart.

There is no status, polling, or separate wait tool. A background dispatch returns
a launch receipt, then its completion is steered at the next safe parent boundary—after
the current tool calls and before the next model call. This wakes the main model without
waiting for its whole run to end.

`wait: true` instead holds that tool call until its new runs settle,
which is useful for one-shot `pi -p` sessions. It claims the delivery route before
launch, so the same result cannot also arrive as a background completion; if the
parent turn is aborted, delivery falls back to the completion path.
Use `wait: true` only when the result is the immediate dependency. Otherwise
leave it in the background and continue real disjoint work — never burn main
context on `sleep` or polling while a child keeps running.

The wait has no timer chosen by the model: it resolves when its run settles, and
a parked run returns its resume handle. Control operations are bounded so they do
not hang on a generation that is still settling.

A thread stays durable while its work is unfinished. Parked sessions, worktree
checkpoints, and result excerpts are recorded under the per-project storage root,
so reload, restart, or crash produces a resumable checkpoint. An isolated thread
continues in its original worktree.

Restore runs at session start. `subagent_control`, `subagent_stop`, prompt
injection, and new dispatches wait for it, so a parked id cannot be reported
missing or reused. If a recorded worktree is gone, the run is surfaced as failed
and non-resumable while its retained session and recovery record remain available
for inspection or destructive stop.

Persisted sessions and worktrees are resumed or removed only when their canonical paths
match the current project's managed storage layout and repository. Invalid records are
dropped without following or deleting their targets. Recovery-owned worktrees and patches
remain protected from startup sweeps and project-root retention until recovery is announced.

Only interrupted work needs a record, so a thread that completes or fails cleanly
drops its own. That also means a reload keeps interrupted threads resumable, while
threads that had already finished keep only their delivered result.

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
○ #24 artisan ↻  tests/config.test.ts · queued · 5m02s
```

Telemetry drops leftmost-first when a row runs out of width (badge, wait state,
usage, model, thinking) while elapsed survives every width. Queued rows state
what they actually wait for — `queued` for a free process slot, `repo lane`
for shared-checkout write serialization, or `starting` — and a resumed thread
carries a dim `↻` in its agent column with its cumulative time. The widget is
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

Every dispatch, resume, retry, and fallback snapshots the parent's active tools,
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
search. Built-in and previously configured custom roles remain available in the
enable menu. Other settings live in
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
| `knownAgents`         | Roles already surfaced by setup; retains disabled custom roles and tracks built-in adoption. |
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
load; turn it off in `/subagents-setup` and it stays off. Custom roles and other
known-agent entries remain intact. Invalid known fields fall back safely, and unknown
fields are dropped when canonical config is persisted.

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
| `ferris-pi-subagents/<project>/sessions/`  | Retained child sessions that a resume continues from | When the thread settles or its retained record is removed        |
| `ferris-pi-subagents/<project>/worktrees/` | Isolated checkouts for parallel writers              | On integration, or when no thread/recovery record claims them  |
| `ferris-pi-subagents/<project>/results/`   | Full text of truncated results                       | After 7 days, or beyond 50 per project                           |
| `ferris-pi-subagents/<project>/tmp/`       | Child prompt copies and the no-retry policy shim     | When its owning process exits                                    |
| `ferris-pi-subagents/<project>/`           | All of the above for one checkout                     | After 3 idle days unless a thread/recovery record claims it      |

Cleanup runs at session start and is deliberately conservative. A directory goes
away only when the process that created it is gone and no valid manifest record still
claims it, so a live sibling pi instance never loses state and parked or recovery-owned
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

## Changelog

See [CHANGELOG.md](./CHANGELOG.md) for published release notes.

## Release

Pushing to `main` publishes `@ferris1225/pi-subagents` when `package.json`
carries a version npm does not have yet, then opens a matching GitHub Release.
Do not `npm publish` from a laptop. The workflow is
`.github/workflows/publish.yml` (npm trusted publisher or `NPM_TOKEN`).

## License

MIT
