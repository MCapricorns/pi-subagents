# pi-subagents

[![npm version](https://img.shields.io/npm/v/@ferris1225/pi-subagents?color=blue)](https://www.npmjs.com/package/@ferris1225/pi-subagents)
[![downloads](https://img.shields.io/npm/dm/@ferris1225/pi-subagents)](https://www.npmjs.com/package/@ferris1225/pi-subagents)
[![license](https://img.shields.io/npm/l/@ferris1225/pi-subagents)](./LICENSE)
![platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey)
![pi](https://img.shields.io/badge/pi-extension-orange)

A managed engineering team for [pi](https://github.com/earendil-works/pi): five
specialized sub-agents, durable threads, automatic quality gates, and Git
worktree isolation — installed once, then your main agent delegates on its own.

## Why pi-subagents

Delegation should **remove** coordination work, not create more of it. Most
sub-agent launchers stop at "spawn a child with a prompt"; the coordination
burden — when to delegate, how wide to fan out, who reviews, what happens when a
model dies, how results come back — stays with you. pi-subagents owns that
burden:

- **The main model actually delegates.** A lean delegation directive is injected
  into its system prompt: child contexts are cheap and yours is scarce —
  non-trivial implementation defaults to `worker`, trivial work stays inline,
  and dispatching never blocks or ends the main turn, so it can fire several
  dispatches and keep working while they run.
- **Fan-out is the model's call, not a cap.** One parallel dispatch carries as
  many tasks as the work genuinely decomposes into. The runtime paces execution
  at a process-slot pool that scales with the machine (cores/2, bounded 4–16);
  extra tasks simply queue and start automatically as slots free, so wide
  batches never fail, never flood your context (results deliver compact, with
  the full text on disk), and queueing is always visible pacing — never a
  hidden dispatch limit.
- **Quality gates are built in and converge by themselves.** Successful
  worker/cleaner runs continue through one independent reviewer gate. A failing
  gate is fixed by the reviewer itself — the same retained session gets write
  access and applies its own fix instructions, then a converging re-review
  verifies the fixes — bounded rounds; a still-failing gate returns to the main
  agent with every finding and fix instruction. No guessing what satisfies the
  reviewer.
- **Documentation stops drifting.** Writers sync the docs they directly affect;
  documentation drift is an ordinary gate finding, and dispatching the
  documenter for real remaining drift stays the main agent's decision.
- **Parallel edits are safe.** Parallel workers default to isolated Git
  worktrees and integrate back without touching your index; shared-checkout
  writers serialize through one repository lane.
- **Work survives everything.** Threads keep retained sessions across resume,
  stop, and pi reloads or crashes; a model failure hands the same session to
  the current main model instead of losing progress.
- **Failures are visible.** Crashes, partial starts, and integration failures
  come back as results with recovery records — never as silent hangs.

## How it works

```text
You
 └─ pi main agent
     ├─ explorer ─── retrieval index only (never an automatic gate)
     ├─ worker ───── implements ─┬─▶ reviewer ─ PASS → deliver
     ├─ cleaner ──── cleans up ──┘            └─ FAIL → reviewer fixes itself
     ├─ documenter ─ explicit docs/comments task → deliver                │
     └─ reviewer ─── advisory report (no VERDICT), or managed gate ◀──────┘
          └─ direct REVIEW_FAIL → findings + fix instructions → main agent fixes

Worker and cleaner update existing docs/comments they directly affect. The stable
parent returns one final result when its complete managed workflow settles.
```

Every child is an isolated leaf Pi process with its own context window and no
memory of your conversation — the brief is its only input. Completions resume
the main agent automatically; there is no polling loop.

## Quick start

Requires **pi >= 0.84.4** and **Node.js >= 22.19.0**.

```bash
pi install npm:@ferris1225/pi-subagents
```

Open pi and run `/subagents-setup` to pick agents, models, and thinking
strengths. Fresh installs enable all five built-in agents on the current main
model, and until a config file exists each session start points you at
`/subagents-setup`. Then just ask:

```text
Map how authentication works, fix the refresh race, run the tests, and review the diff.
```

The main agent decides when delegation pays off; you can also call the tools
directly for exact control.

## The team

| Agent        | Access                                | Best for                                                                                                                                                         |
| ------------ | ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `explorer`   | Read-only                             | Broad search, unfamiliar-area mapping, symbol/dependency tracing. Fast model, returns a retrieval index — never proof.                                           |
| `worker`     | Full                                  | The default route for any non-trivial, self-contained implementation, fix, refactor, or test task carried through verification.                                  |
| `cleaner`    | Full                                  | Explicitly authorized cleanup, removal, simplification, deduplication. Every safe proven cut applies without item-by-item approval.                              |
| `documenter` | Docs/comments                         | Standalone docs/comments work, including syncing real drift a change left behind. May make zero edits; never changes runtime behavior.                           |
| `reviewer`   | Read-only (review) / full (fix stage) | Audits, code-health checks, plans, PR/issue validation, and independent gates; a failing managed gate continues into the reviewer's own write-enabled fix stage. |

A good brief carries the goal, exact paths, constraints, and expected output —
the injected delegation guidance does this automatically when the main agent
dispatches for you.

## Dispatch and fan-out

```ts
// One task
subagent({
  agent: "worker",
  task: "Fix the cache invalidation bug in src/cache, add regression tests, run the checks.",
});

// Parallel: as many genuinely independent units as the work has
subagent({
  tasks: [
    {
      agent: "explorer",
      task: "Trace model fallback from dispatch to completion.",
    },
    { agent: "worker", task: "Add edge-case tests for config migration." },
  ],
});
```

The main agent owns the breadth — there is no per-call task cap. The runtime
runs a machine-scaled pool of child processes at once and queues the rest;
dispatch confirmations and `subagent_status` state the live running/queued
counts and the slot capacity, so pacing is never mistaken for a limit. A
generation that moves on to its managed stages (gate review, fix rounds) or
waits on the shared-checkout writer lane releases its slot, so neither managed
work nor serialized writers starve new dispatches. Parallel write-capable
agents default to isolated worktrees and integrate via a three-way merge, so
disjoint edits from parallel workers land without conflicts. One child owns one
coherent deliverable and its files; dependent work starts only after its
prerequisite delivers.

## Review gates and fixes

```ts
subagent({
  agent: "reviewer",
  task: "Gate the current diff for correctness, regressions, and missing tests.",
});
```

A gate ends with exactly one verdict line: `VERDICT: REVIEW_PASS` or
`REVIEW_FAIL`. Every gate finding carries a concrete fix instruction, and the
reviewer must surface the complete finding set in one pass — never rationing
findings across later rounds.

A failing **managed** gate (after a top-level worker/cleaner) converges inside
the workflow: the same retained reviewer session continues with write access
and applies its own fix instructions, then a fresh gate verifies the fixes and
hunts regressions they introduced (re-reviews converge on the fixes instead of
re-scanning the whole surface). The loop is bounded to two fix rounds, after
which the still-failing gate returns to the main agent with every finding.

A failing gate **you dispatched directly** returns the full findings to the
main agent, which resolves them itself (inline or via a worker it briefs)
without waiting for you; only a genuinely destructive or scope-changing fix is
worth asking about. It re-verifies once, then reports remaining findings and
moves on — gate dispatches never loop. Generic audits and read-only reviews
are advisory by default: no `VERDICT`, no edits.

`cleaner` is dispatch-authorized cleanup: asking for an audit never silently
authorizes code changes, and asking for cleanup never rewards speculative
deletion. A top-level `documenter` is an explicit docs-writing task that
delivers without another gate.

## Safe parallel editing

- Single tasks default to the shared checkout; every parallel write-capable
  agent (`worker`, `cleaner`, `documenter`, custom writers) defaults to a
  detached Git worktree (requires a committed `HEAD`; read-only agents reject
  worktree mode), so parallel writers run concurrently.
- An isolated workflow's reviewer and documenter run inside the same worktree;
  tracked, deleted, untracked, and binary changes integrate back exactly once
  after the workflow settles — nothing is staged and your index is untouched.
- Integration is a three-way merge: parallel workers that touched disjoint
  files or regions land cleanly even when earlier patches drifted the checkout.
  A genuine overlap keeps conflict markers in the checkout plus the retained
  worktree and patch for you to resolve.
- Shared-checkout writers (and reviewers snapshotting their diff) serialize
  through one repository lane, so two shared writers never race.
- Setup or integration failures keep the useful patch/worktree and record
  recovery info in `~/.pi/agent/pi-subagents-recovery.json`; a parked isolated
  thread keeps its worktree and resumes there.

## Follow, redirect, or stop

Every dispatch returns a stable `#id` — the handle for all control tools:

| Tool               | What it does                                                                                                                                                     |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `subagent_control` | `resume` a parked/settled thread with its full retained context, optionally with a new `objective` appended. Only interrupted (parked) threads survive a reload. |
| `subagent_status`  | List active and recent runs, or return one run's full result and failed-tool diagnostics.                                                                        |
| `subagent_wait`    | Non-blocking in-turn lookup; `timeoutMs` only when you must wait.                                                                                                |
| `subagent_stop`    | Destructively cancel, deliver the partial output, retire the thread. Stopping also drops any steering/follow-up messages still queued in the child so a stopped or later resumed thread cannot be revived by stale queue entries.      |

```ts
subagent_control({ action: "resume", id: 7, objective: "Finish the tests." });
```

Threads are durable while work is unfinished: parked sessions, worktree
checkpoints, and result excerpts live under
`~/.pi/agent/ferris-pi-subagents/<project>/` (grouped per project; nothing is
written to the OS temp directory — transient per-run scratch lives in the
project's `tmp/` and is swept for dead owners on the next load) and are
restored when pi reloads or restarts — a reload
interrupts a live run into a restorable checkpoint instead of losing it. A
thread that completes or fails cleanly drops its durable record, so the
threads manifest exists only
while interrupted work needs it; parked work stays resumable for 30 days, and
a project directory idle for three days is deleted wholesale on the next load
(parked threads' references always win), so per-project storage never grows
forever. All control operations are bounded; they never hang on a generation
that is still settling.

## Results and live status

The TUI widget projects each managed workflow as a timeline plus its current
child:

```text
◆ #12 worker workflow · src/cache.ts · wt:a91f3c · 42s
  ✓ implement ─ ● review ─ ○ docs
  └ ● #15 reviewer · final review · claude-sonnet-4-5/high · 10s
○ #23 worker · queued · redirect to ripgrep crates · 5m02s
```

The widget is capped at ten lines: when many runs are live at once, extra rows
collapse into a `… +N more (subagent_status)` marker so the editor area keeps
its space; `subagent_status` always shows the full picture.

Completions resume the main agent automatically with a compact block (40 lines
by default; longer output lands unchanged in a temporary Markdown artifact
reachable via `subagent_status`). Roles author result-only handoffs — outcome,
paths, verification, unresolved blockers — and the main agent is told to add
its conclusion, not restate what you already saw.

## Models, thinking, and vision

Each agent runs on the current main model or one picked in `/subagents-setup`
(vision/text-only labels included). If a selected model is missing, rate-limited,
or fails at the provider level, the **same retained session** continues on the
main model — finished searches, reads, and edits are preserved; ordinary task
failures do not trigger a handoff. Thinking defaults to **Auto**: the role's
preference, clamped to what the effective model supports. `/subagents-setup` →
_Configure an agent_ also offers a manual strength per agent, listing only the
levels that model supports. There is no separate
vision mode: assign a multimodal model and name the image paths in the task.

Every dispatch, managed stage, resume, retry, and fallback snapshots the
parent's currently active tools: roles without an explicit list inherit the
full set; explicit lists keep their Pi built-in boundary while their shell slot
(`bash`/`powershell`) follows the parent and active extension tools are
appended. Read-only roles never gain `edit`/`write`; all `subagent*` tools are
stripped so children stay leaves. An empty snapshot starts the child with
`--no-tools`.

## Configuration

`/subagents-setup` stays one level deep: enabled agents, per-agent models and
thinking strengths, and the delegation-injection toggle. Everything else is
config-file only, stored at
`~/.pi/agent/pi-subagents.json` (follows `PI_CODING_AGENT_DIR`):

```json
{
  "enabledAgents": ["explorer", "worker", "cleaner", "documenter", "reviewer"],
  "agentModels": { "explorer": "anthropic/claude-haiku-4-5" },
  "agentThinkingLevels": { "reviewer": "high" },
  "notifyOnReviewPass": false,
  "maxResultLines": 40,
  "proactiveInjection": true,
  "agentScope": "user",
  "idleTimeoutSec": 90
}
```

| Field                 | Meaning                                                                           |
| --------------------- | --------------------------------------------------------------------------------- |
| `enabledAgents`       | Agents available for discovery and delegation. `[]` disables all.                 |
| `agentModels`         | Optional `provider/model-id` per agent; missing = current main model.             |
| `agentThinkingLevels` | Optional manual level per agent; missing = Auto.                                  |
| `notifyOnReviewPass`  | Deliver a standalone passing gate without waking the main agent. Default `false`. |
| `maxResultLines`      | Lines kept in a completion message before the artifact takes over. Default `40`.  |
| `proactiveInjection`  | Inject the delegation directive into the main system prompt. Default `true`.      |
| `agentScope`          | Discover `user`, `project`, or `both` agent directories. Default `user`.          |
| `idleTimeoutSec`      | Seconds without child RPC output before termination; `0` disables. Default `90`.  |

Invalid values fall back safely; stale keys (including the former
`maxConcurrency`/`maxFixRounds` knobs) are dropped automatically. At session
start, model overrides Pi no longer reports are removed with a one-time notice.
When pi's own session compaction fails mid-thread, a notice surfaces the error
(and the automatic retry) instead of failing silently.

## Custom agents

Built-ins ship in the package; add or replace them with Markdown files:

- User agents: `~/.pi/agent/agents/`
- Project agents: nearest `.pi/agents/` in a trusted project
- Precedence: project > user > built-in (same `name` wins)

```yaml
---
name: explorer
description: Fast read-only codebase reconnaissance
model: anthropic/claude-haiku-4-5
thinking: low
tools: read, bash
---
…additional system prompt…
```

Wizard choices override frontmatter defaults; an explicit `tools` list stays the
capability boundary (shell slot follows the parent, active extension tools are
appended), and omitting it inherits the parent's complete active set.

## Development

```bash
npm install
npm run check
npm test
```

No bundled runtime dependencies — pi and TypeBox are peers. Source is split by
responsibility: dispatch/workflow policy, thread lifecycle, RPC transport,
worktree integration, completion delivery, tools, and TUI status.

## License

MIT
