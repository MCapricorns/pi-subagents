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

**4.3.4** — makes Ferris skills optional enhancements instead of runtime
requirements. Artisan, steward, and sentinel remain fully operational from their
standalone role prompts when users have no Ferris skills installed.
See [CHANGELOG.md](./CHANGELOG.md).

## Contents

- [Why](#why)
- [Install](#install)
- [The team](#the-team)
- [Dispatching work](#dispatching-work)
- [Parallel edits](#parallel-edits)
- [Threads: resume, stop](#threads-resume-stop)
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

- The main model gets a cost-aware routing contract and delegates only when a leaf
  context saves more work than its handoff costs.
- One active normalized task and working directory owns its phase, so an exact
  duplicate dispatch is rejected instead of paying twice.
- Background completions wake the main model; `wait: true` returns the same result
  in-turn instead. A run uses exactly one route.
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

Open pi and run `/subagents-setup`. One overlay shows every role's enabled state,
model, and effective thinking level. Move through the grid, search models in place,
then choose **Save & Exit** to write everything once; **Cancel** or `Esc` discards
the draft. Fresh installs select all four, and an upgrade surfaces a new built-in
once without re-enabling it after you deliberately turn it off. Then ask for work:

```text
Map how authentication works, fix the refresh race, run the tests, and review the diff.
```

The main agent decides when delegation pays off. You can also call the tools
directly when you want exact control.

## The team

| Agent      | Access      | Owns |
| ---------- | ----------- | ---- |
| `scout`    | Read-only   | Broad or unfamiliar code reconnaissance and external research. Returns compact file citations or source URLs as leads, not proof. |
| `artisan`  | Full        | One substantial primary change—implementation, fix, refactor, test, or docs—through root cause, affected verification, and local hygiene. |
| `steward`  | Full        | One final cleanup and cross-cutting docs/comment sync pass after a broad or multi-writer change. |
| `sentinel` | Review-only | A post-cleanup adversarial review using standalone evidence gates plus any matching Ferris skills; reports only evidence-backed defects and concrete test gaps. |

Role prompts are standalone: they embed root-cause-first diagnosis, meaningful test
evidence, bounded cleanup, and evidence-only review. Optional Ferris skills remain
the canonical source of deeper language, platform, debugging, testing, and audit
guidance. Artisan and sentinel load matching skills when available; steward uses
`ferris-audit`; a missing skill never blocks a role or changes its ownership contract.

Custom roles join them with a Markdown file (see [Custom agents](#custom-agents)).

Every child is an isolated leaf pi process with its own context window and no
memory of your conversation, so the brief is its only input. A good brief carries
the goal, exact paths, constraints, and expected output — which is what the
injected delegation guidance produces when the main agent dispatches for you.

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

Breadth is the main agent's call, not a configured limit. There is no per-call
task cap: put every genuinely independent unit in one `tasks` array. The runtime
paces execution instead, running a pool of child processes that scales with the
machine (half its cores, bounded to 4–16) and starting queued runs automatically
as slots free.

An active run leases its normalized task and resolved working directory across
agent names. Dispatching the same pair again is rejected and names the existing
run id; it does not use fuzzy matching, and resuming that thread remains allowed.

Because queueing is pacing rather than refusal, it is always reported as such.
Dispatch confirmations name each waiting run's real reason — waiting for a free
process slot, serialized behind the shared-checkout write lane, or already
starting its child — alongside the slot capacity. A run that waits for the write
lane releases its slot first, so serialized writers never starve new dispatches.

One child owns one coherent phase. Dependent work starts only after its
prerequisite delivers. Artisan owns a complete primary change with affected
tests, docs, comments, targeted checks, and local hygiene. Scout owns broad code
mapping or external research and stays read-only.

With the default team, every commit ends in one order: cleanup -> `sentinel`. A
focused diff gets a bounded cleanup pass inline; a broad or multi-writer diff gets
one `steward` pass that attacks touched dead code, duplication, tangled conditionals,
needless layers, and spaghetti growth without widening into a repo refactor.
Sentinel then reviews the cleaned diff with its standalone evidence gates plus any
available matching skills.
A review-driven edit repeats that sequence once; unresolved findings block the
commit. Main inspects the final diff and runs the final gate.

## Parallel edits

- Single tasks use your checkout. Every parallel write-capable agent (`artisan`,
  `steward`, and custom writers) defaults to a detached Git worktree, so
  parallel writers run at the same time. Worktree mode needs a committed `HEAD`,
  and scout/sentinel reject it. Sentinel stays shared so it sees the caller's
  uncommitted diff.
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

## Threads: resume, stop

Every dispatch returns a stable `#id`, which is the handle for the thread tools:

| Tool               | What it does                                                                                                                                                                  |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `subagent_control` | `resume` a parked or settled thread with its full retained context, optionally appending a new `objective`.                                                                     |
| `subagent_stop`    | Destructively cancel, deliver the partial output, and retire the thread. Steering and follow-up messages still queued in the child are dropped so nothing can revive it later.  |

```ts
subagent_control({ action: "resume", id: 7, objective: "Finish the tests." });
```

There is no status, polling, or separate wait tool. A background dispatch returns
a launch receipt, then its completion is delivered as a follow-up that wakes the
main model. `wait: true` instead holds that tool call until its new runs settle,
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
which labels vision and text-only models. Without its own override, `sentinel`
uses `artisan`'s configured model; if artisan also follows main, sentinel does
too. If a selected model is missing, rate-limited, or fails at the provider level,
the **same retained
session** continues on the main model, so finished searches, reads, and edits
survive. Ordinary task failures do not trigger a handoff.

Thinking is a **role default** — scout `low`, artisan `high`, steward `medium`,
sentinel `max` — clamped to what the effective model supports. The unified setup
grid shows the effective level; changing the thinking cell cycles only supported
levels, and returning to the role default clears the stored override. There is no
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
receives no shell, local mutation tool, or unknown custom tool. Unknown tools
declared by other roles are conservatively treated as write-capable when
isolation is chosen. An empty resolved snapshot starts the child with
`--no-tools`.

For external research scout prefers official documentation, specifications, release
notes, and first-party repositories; it fetches decisive pages rather than citing
search snippets, records material dates/versions, and marks uncertainty.

`sentinel` has an explicit retrieval/documentation list plus a portable shell
slot for Git inspection and the smallest proving check. It is pinned to `shared`
so it sees the current uncommitted diff. Its concise prompt uses matching available
Ferris skills, preserves their owners, and forbids mutation; missing skills do not
block review. This is a review contract,
not a hard shell sandbox.

## Configuration

`/subagents-setup` opens one transactional overlay for every built-in and already
configured custom role. Its grid edits enabled state, model, and thinking before
**Save & Exit** persists the complete draft; **Cancel**/`Esc` writes nothing. Model
selection remains inside the overlay and supports fuzzy search. Other settings live in
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
| `agentModels`         | Optional model per agent; missing means main, except sentinel inherits artisan's override. |
| `agentThinkingLevels` | Optional setup override per agent; missing means the role default. |
| `maxResultLines`      | Lines kept in a completion message before the artifact takes over. Default `40`. |
| `agentScope`          | Discover `user`, `project`, or `both` agent directories. Default `user`. |
| `idleTimeoutSec`      | Seconds without child RPC output before termination; `0` disables. Default `90`. |

When at least one role is enabled, the cost-aware delegation directive is injected
automatically. `enabledAgents` is authoritative after catalog adoption: a newly
shipped built-in is appended once, then `knownAgents` records that it was surfaced
so a deliberate later disable remains disabled. Invalid known fields fall back
safely, and unknown fields are dropped when canonical config is persisted.

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
| `ferris-pi-subagents/<project>/worktrees/` | Isolated checkouts for parallel writers              | On integration, or when no retained record claims them           |
| `ferris-pi-subagents/<project>/results/`   | Full text of truncated results                       | After 7 days, or beyond 50 per project                           |
| `ferris-pi-subagents/<project>/tmp/`       | Child prompt copies and the no-retry policy shim     | When its owning process exits                                    |
| `ferris-pi-subagents/<project>/`           | All of the above for one checkout                     | When the whole directory has been idle for 3 days                |

Cleanup runs at session start and is deliberately conservative. A directory goes
away only when the process that created it is gone and no manifest record still
claims it, so a live sibling pi instance never loses state and parked work
outlives its own process by design — a reference from the threads manifest always
beats an age rule.

## Development

```bash
npm install
npm run check
```

`npm run check` is `tsc --noEmit` plus the unit tests (`npm test`). There are
no bundled runtime dependencies; pi and TypeBox are peers. The source is
split by responsibility: dispatch policy, thread lifecycle, RPC
transport, worktree integration, completion delivery, tools, and TUI status.

## Changelog

See [CHANGELOG.md](./CHANGELOG.md) for published release notes.

## Release

Pushing to `main` publishes `@ferris1225/pi-subagents` when `package.json`
carries a version npm does not have yet, then opens a matching GitHub Release.
Do not `npm publish` from a laptop. The workflow is
`.github/workflows/publish.yml` (npm trusted publisher or `NPM_TOKEN`).

## License

MIT
