# pi-subagents

[![npm version](https://img.shields.io/npm/v/@ferris1225/pi-subagents?color=blue)](https://www.npmjs.com/package/@ferris1225/pi-subagents)
[![downloads](https://img.shields.io/npm/dm/@ferris1225/pi-subagents)](https://www.npmjs.com/package/@ferris1225/pi-subagents)
[![license](https://img.shields.io/npm/l/@ferris1225/pi-subagents)](./LICENSE)
![platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey)
![pi](https://img.shields.io/badge/pi-extension-orange)

A managed engineering team for [pi](https://github.com/earendil-works/pi): two
focused sub-agents, durable threads, and Git worktree
isolation. You install it once and your main agent delegates on its own.

## Why

Delegation is supposed to remove coordination work. Most sub-agent launchers stop
at "spawn a child with a prompt" and leave the hard parts — when to delegate, how
wide to fan out, what happens when a model dies, how results come
back — with you. This extension owns them:

- The main model delegates without being asked, because a delegation directive is
  always in its system prompt.
- Dispatching never blocks or ends the main turn, so it can start several runs and
  keep working while they execute.
- Results deliver themselves. There is no status tool to poll and no lookup step.
- Parallel writers get their own Git worktrees, so concurrent edits do not collide
  and your index is never touched.
- Threads keep their context across resume, stop, reload, and crash; a dead model
  hands its session to the current main model instead of losing progress.
- Crashes, partial starts, and integration failures come back as results with
  recovery records — never as silent hangs.

## Install

Requires **pi >= 0.84.4** and **Node.js >= 22.19.0**.

```bash
pi install npm:@ferris1225/pi-subagents
```

Open pi and run `/subagents-setup` to choose agents, models, and thinking
strengths. A fresh install enables every agent on the current main model, and each
session start points you at the wizard until a config file exists. Then just ask
for work:

```text
Map how authentication works, fix the refresh race, run the tests, and review the diff.
```

The main agent decides when delegation pays off. You can also call the tools
directly when you want exact control.

## The team

| Agent         | Access    | Best for                                                                                                                                                                                                   |
| ------------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `explorer`    | Read-only | Broad search, unfamiliar-area mapping, symbol and dependency tracing. Returns a retrieval index — never proof.                                                                                              |
| `executor`    | Full      | The default route for any non-trivial, self-contained task: implementation, fixes, refactors, tests, evidence-first cleanup, docs/comment sync, or merging a fan-out's results into one brief — carried through verification and a result-only handoff. |

Custom roles join them with a Markdown file (see [Custom agents](#custom-agents)).

Every child is an isolated leaf pi process with its own context window and no
memory of your conversation, so the brief is its only input. A good brief carries
the goal, exact paths, constraints, and expected output — which is what the
injected delegation guidance produces when the main agent dispatches for you.

```text
You
 └─ pi main agent
     ├─ explorer ─── parallel recon, retrieval leads only
     └─ executor ─── one deliverable per child: implement, fix, clean up,
                     sync docs, or merge fan-out results → verify → deliver
```

## Dispatching work

```ts
// One task
subagent({
  agent: "executor",
  task: "Fix the cache invalidation bug in src/cache, add regression tests, run the checks.",
});

// Parallel: as many genuinely independent units as the work has
subagent({
  tasks: [
    { agent: "explorer", task: "Trace model fallback from dispatch to completion." },
    { agent: "executor", task: "Add edge-case tests for config migration." },
  ],
});
```

Breadth is the main agent's call, not a configured limit. There is no per-call
task cap: put every genuinely independent unit in one `tasks` array. The runtime
paces execution instead, running a pool of child processes that scales with the
machine (half its cores, bounded to 4–16) and starting queued runs automatically
as slots free.

Because queueing is pacing rather than refusal, it is always reported as such.
Dispatch confirmations name each waiting run's real reason — waiting for a free
process slot, serialized behind the shared-checkout write lane, or already
starting its child — alongside the slot capacity. A run that waits for the write
lane releases its slot first, so serialized writers never starve new dispatches.

One child owns one coherent deliverable and its files. Dependent work starts only
after its prerequisite delivers. Verification belongs to whoever did the work:
every child runs the checks it can and reports exactly which ones ran, and the
main agent inspects the actual changes before calling anything done.

## Parallel edits

- Single tasks use your checkout. Every parallel write-capable agent (`executor`
  and custom writers) defaults to a detached Git worktree, so
  parallel writers run at the same time. Worktree mode needs a committed `HEAD`,
  and read-only agents reject it.
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
  where they are in `~/.pi/agent/pi-subagents-recovery.json`. Every later session
  start repeats that notice until you remove the artifacts.

## Threads: resume, stop

Every dispatch returns a stable `#id`, which is the handle for the thread tools:

| Tool               | What it does                                                                                                                                                                  |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `subagent_control` | `resume` a parked or settled thread with its full retained context, optionally appending a new `objective`.                                                                     |
| `subagent_stop`    | Destructively cancel, deliver the partial output, and retire the thread. Steering and follow-up messages still queued in the child are dropped so nothing can revive it later.  |

```ts
subagent_control({ action: "resume", id: 7, objective: "Finish the tests." });
```

There is deliberately no status, polling, or wait tool. Every result delivers
itself as a completion that wakes the main model, so a turn never blocks on a
running subagent — keep working or end the turn, and the completion continues
it. The one in-turn block is `wait: true` on a dispatch, which holds that call
until the runs it started settle: the escape hatch for one-shot `pi -p`
parents, which exit at end of turn and would otherwise never see them. That
wait runs on no timer and no timeout the model picks: it resolves the instant
its run settles, a parked run answers immediately with its resume handle, and
aborting the turn is the escape hatch. Control operations are all bounded, so
they never hang on a generation that is still settling.

A thread stays durable while its work is unfinished. Parked sessions, worktree
checkpoints, and result excerpts are recorded in a manifest beside your config, so
a pi reload, restart, or crash interrupts a run into a resumable checkpoint
instead of losing it, and an isolated thread resumes in the worktree it was
already working in. Restore happens at load, and everything that answers for a run
waits for it — `subagent_control`, `subagent_stop`, and a new dispatch before it
takes an id — so the first call after a reload can never report parked work as
missing or hand its id to something else.

Only interrupted work needs a record, so a thread that completes or fails cleanly
drops its own. That also means a reload keeps interrupted threads resumable, while
threads that had already finished keep only their delivered result.

## Live status and results

The TUI widget renders one line per active run in fixed identity columns —
status icon, right-aligned `#id`, padded agent name, then the task label — so
every label starts at the same column, with the live activity dimmed after
`↳` on its own line and the rest of the telemetry flowing inline after ` · `: the
worktree badge, the token flow in the footer vocabulary (`↑` input, `↓` output,
`R`/`W` cache read/write), cost, the full `provider/model` ref, the
wait state, and an elapsed time that always carries seconds. A live run renders
two lines: what it is — agent, task, token flow, cost, provider/model, elapsed —
and, dim under the label column, what it is doing right now:

```text
● #12 executor  src/cache.ts · wt:a91f3c · ↑5.2k ↓41.0k R210.0k W6.1k $1.9400 · 12m06s
  ↳ edit src/auth.ts
● #15 explorer  src/models.ts · ↑1.2k ↓8.4k R31.0k W1.1k $0.0900 · openai/gpt-5-mini · 3m07s
                ↳ grep fallback
○ #23 executor  src/config.ts · repo lane
○ #24 executor ↻  tests/config.test.ts · queued · 5m02s
```

Telemetry drops leftmost-first when a row runs out of width (badge, wait
state, usage, model) while the elapsed survives every width. Queued rows state
what they actually wait for — `queued` for a free process slot, `repo lane`
for shared-checkout write serialization, or `starting` — and a resumed thread
carries a dim `↻` in its agent column with its cumulative time. The widget is
capped at ten lines: when many runs are live, extra runs collapse into a
`… +N more` marker so the editor keeps its space.

Completions resume the main agent on their own, with a compact block of at most 40
lines by default; longer output lands unchanged in a Markdown artifact whose path
comes with the message. Roles write result-only handoffs — outcome, paths,
verification, unresolved blockers — and the main agent is told to add its
conclusion rather than restate what you already read. A failed run adds its
failed-tool diagnostics.

## Models, thinking, and tools

Each agent runs on the current main model or on one you pick in
`/subagents-setup`, which labels vision and text-only models. If a selected model
is missing, rate-limited, or fails at the provider level, the **same retained
session** continues on the main model, so finished searches, reads, and edits
survive. Ordinary task failures do not trigger a handoff.

Thinking defaults to **Auto**: the role's own preference, clamped to what the
effective model supports. `/subagents-setup` → _Configure an agent_ also offers a
manual strength, listing only the levels that model supports. There is no separate
vision mode — assign a multimodal model and name the image paths in the task.

Every dispatch, resume, retry, and fallback snapshots the parent's
currently active tools. A role with no explicit list inherits the full set. An
explicit list keeps its pi built-in boundary and gains active extension tools,
while its shell slot follows the parent: a role file naming `bash` runs
`powershell` when that is the shell you enabled. When you run both, the child gets
the one that fits the host — PowerShell on Windows, Bash elsewhere — rather than
two terminals to choose between. A child never receives a shell you disabled,
since pi's `--tools` allowlist overrides its own `defaultTools`. Read-only roles
never gain `edit` or `write`, and all `subagent*` tools are stripped so children
stay leaves. An empty snapshot starts the child with `--no-tools`.

Shell guidance in the shipped roles is portable for the same reason: they reach
for pi's own `read`/`grep`/`find`/`ls` tools, which behave identically everywhere,
and keep shell examples to `git` queries instead of POSIX binaries a PowerShell
child cannot run.

## Configuration

`/subagents-setup` stays one level deep: enabled agents, plus a model and thinking
strength per agent. Everything else is config-file only, stored at
`~/.pi/agent/pi-subagents.json` (following `PI_CODING_AGENT_DIR`):

```json
{
  "enabledAgents": ["explorer", "executor"],
  "knownAgents": ["explorer", "executor"],
  "agentModels": { "explorer": "anthropic/claude-haiku-4-5" },
  "agentThinkingLevels": { "executor": "high" },
  "maxResultLines": 40,
  "agentScope": "user",
  "idleTimeoutSec": 90
}
```

| Field                 | Meaning                                                                           |
| --------------------- | --------------------------------------------------------------------------------- |
| `enabledAgents`       | Agents available for discovery and delegation. `[]` disables all.                 |
| `knownAgents`         | Built-ins this config has seen; automatic bookkeeping — never edit it.            |
| `agentModels`         | Optional `provider/model-id` per agent; missing = current main model.             |
| `agentThinkingLevels` | Optional manual level per agent; missing = Auto.                                  |
| `maxResultLines`      | Lines kept in a completion message before the artifact takes over. Default `40`.  |
| `agentScope`          | Discover `user`, `project`, or `both` agent directories. Default `user`.          |
| `idleTimeoutSec`      | Seconds without child RPC output before termination; `0` disables. Default `90`.  |

The delegation directive is always injected; there is no toggle. Invalid values
fall back safely, and stale keys — including the former `proactiveInjection`,
`maxConcurrency`, `maxFixRounds`, and `notifyOnReviewPass` knobs — are dropped
automatically. At session
start, model overrides pi no longer reports are removed with a one-time notice. If
pi's own session compaction fails mid-thread, a notice surfaces the error and the
automatic retry instead of failing quietly.

Agents shipped by a newer package version turn themselves on at the next
session: a built-in the config has never seen is adopted into `enabledAgents`
and follows explorer's configured model and thinking level — the fast lane
these light roles need — while an agent you disabled stays disabled
(`knownAgents` is what tells the two cases apart). Enabling a role in
`/subagents-setup` adopts the same explorer route.

## Custom agents

Built-ins ship with the package. Add or replace them with Markdown files:

- User agents: `~/.pi/agent/agents/`
- Project agents: the nearest `.pi/agents/` in a trusted project
- Precedence: project > user > built-in, where the same `name` wins

```yaml
---
name: explorer
description: Fast read-only codebase reconnaissance
thinking: low
isolation: shared
tools: read, bash
---
…additional system prompt…
```

`description` is the routing line the main model reads, and `thinking` is the
role's Auto preference, which a wizard choice overrides. `isolation` pins the
role's default boundary as described under [Parallel edits](#parallel-edits).
Models come only from `/subagents-setup`; an agent file cannot pin one. An
explicit `tools` list is the capability boundary, and omitting it inherits the
parent's complete active set.

## Storage and cleanup

Everything lives under your pi agent directory, grouped per project. Nothing
long-lived is written to the OS temp directory, and every class of file has a rule
that removes it, so this directory does not grow without bound:

| Path                                       | Holds                                                | Removed                                                          |
| ------------------------------------------ | ---------------------------------------------------- | ---------------------------------------------------------------- |
| `pi-subagents.json`                        | Your configuration                                   | Never — it is yours                                              |
| `pi-subagents-threads.json`                | One record per interrupted thread                     | When the thread settles, or after 30 days                        |
| `pi-subagents-recovery.json`               | Worktree integration and cleanup failures            | When the retained patch or worktree it points at is gone         |
| `ferris-pi-subagents/<project>/sessions/`  | Retained child sessions that a resume continues from | When the pi session that produced it ends, or its owner is gone  |
| `ferris-pi-subagents/<project>/worktrees/` | Isolated checkouts for parallel writers              | On integration, or when its owning process is gone               |
| `ferris-pi-subagents/<project>/results/`   | Full text of truncated results                       | After 7 days, or beyond 50 per project                           |
| `ferris-pi-subagents/<project>/tmp/`       | Child prompt copies and the no-retry policy shim     | When its owning process exits                                    |
| `ferris-pi-subagents/<project>/`           | All of the above for one checkout                     | When the whole directory has been idle for 3 days                |

Cleanup runs at extension load and is deliberately conservative. A directory goes
away only when the process that created it is gone and no manifest record still
claims it, so a live sibling pi instance never loses state and parked work
outlives its own process by design — a reference from the threads manifest always
beats an age rule.

## Development

```bash
npm install
npm run check
npm test
```

There are no bundled runtime dependencies; pi and TypeBox are peers. The source is
split by responsibility: dispatch policy, thread lifecycle, RPC
transport, worktree integration, completion delivery, tools, and TUI status.

## License

MIT
