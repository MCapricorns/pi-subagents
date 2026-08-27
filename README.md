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
  into its system prompt: substantive work goes to children so the main context
  stays lean for orchestration, trivial work stays inline, and nothing is
  re-explained twice. No custom prompts needed.
- **Fan-out is the model's call, not a cap.** One parallel dispatch carries as
  many tasks as the work genuinely decomposes into. The runtime paces execution
  at four concurrent child processes; extra tasks simply queue, so wide batches
  never fail and never flood your context (results deliver compact, with the
  full text on disk).
- **Quality gates are built in.** Successful worker/cleaner runs continue
  through one independent reviewer gate, and `REVIEW_FAIL` findings return to
  the main agent with concrete fix instructions — it resolves them itself,
  without stopping to ask you. No black-box auto-fix chain edits code behind
  your back.
- **Documentation stops drifting.** Writers sync the docs they directly affect;
  after a passing gate, the documenter runs only when the reviewer actually
  reports drift.
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
     ├─ worker ───── implements ─┬─▶ reviewer ─┬─ docs CLEAN → deliver
     ├─ cleaner ──── cleans up ──┘             └─ NEEDED/missing → documenter
     ├─ documenter ─ explicit docs/comments task → deliver
     └─ reviewer ─── advisory report (no VERDICT), or managed gate
          └─ REVIEW_FAIL → findings + fix instructions → main agent fixes

Worker and cleaner update existing docs/comments they directly affect. The stable
parent returns one final result when its complete managed workflow settles.
```

Every child is an isolated leaf Pi process with its own context window and no
memory of your conversation — the brief is its only input. Completions resume
the main agent automatically; there is no polling loop.

## Quick start

Requires **pi >= 0.83.0** and **Node.js >= 22.19.0**.

```bash
pi install npm:@ferris1225/pi-subagents
```

Open pi and run `/subagents-setup` to pick agents and models. Fresh installs
enable `explorer`, `worker`, `cleaner`, and `reviewer`; `documenter` is opt-in.
Then just ask:

```text
Map how authentication works, fix the refresh race, run the tests, and review the diff.
```

The main agent decides when delegation pays off; you can also call the tools
directly for exact control.

## The team

| Agent | Access | Best for |
| --- | --- | --- |
| `explorer` | Read-only | Broad search, unfamiliar-area mapping, symbol/dependency tracing. Fast model, returns a retrieval index — never proof. |
| `worker` | Full | A self-contained implementation, fix, refactor, or test task carried through verification. |
| `cleaner` | Full | Explicitly authorized cleanup, removal, simplification, deduplication. Every safe proven cut applies without item-by-item approval. |
| `documenter` | Docs/comments | Conditional final diff sync, or an explicit standalone docs/comments task. May make zero edits; never changes runtime behavior. |
| `reviewer` | Read-only | Audits, code-health checks, plans, PR/issue validation, and independent gates. |

A good brief carries the goal, exact paths, constraints, and expected output —
the injected delegation guidance does this automatically when the main agent
dispatches for you.

## Dispatch and fan-out

```ts
// One task
subagent({ agent: "worker", task: "Fix the cache invalidation bug in src/cache, add regression tests, run the checks." });

// Parallel: as many genuinely independent units as the work has
subagent({
  tasks: [
    { agent: "explorer", task: "Trace model fallback from dispatch to completion." },
    { agent: "worker", task: "Add edge-case tests for config migration." },
  ],
});
```

The main agent owns the breadth — there is no per-call task cap. The runtime
runs four child processes at once and queues the rest; a generation that moves
on to its managed stages (gate review, docs sync) releases its slot, so managed
work never starves new dispatches. One child owns one coherent deliverable and
its files; dependent work starts only after its prerequisite delivers.

## Review gates and fixes

```ts
subagent({ agent: "reviewer", task: "Gate the current diff for correctness, regressions, and missing tests." });
```

A gate ends with `VERDICT: REVIEW_PASS` or `REVIEW_FAIL`, plus
`DOCUMENTATION: CLEAN`/`NEEDED` when documenter is enabled. Only `REVIEW_PASS`
continues to documentation: CLEAN delivers immediately; NEEDED or a missing
marker runs one final docs sync. A `REVIEW_FAIL` delivers the full findings —
each with a concrete fix instruction — straight back to the main agent, which
resolves them itself (inline or via a worker it briefs) without waiting for you;
only a genuinely destructive or scope-changing fix is worth asking about.

Re-verifying your own fixes? Dispatch with `advisory: true`: the report comes
back to the main window and never starts anything, even if a verdict slips
through. Generic audits and read-only reviews are advisory by default: no
`VERDICT`, no edits.

`cleaner` is dispatch-authorized cleanup: asking for an audit never silently
authorizes code changes, and asking for cleanup never rewards speculative
deletion. A top-level `documenter` is an explicit docs-writing task that
delivers without another gate.

## Safe parallel editing

- Single tasks default to the shared checkout; parallel `worker` tasks default
  to detached Git worktrees (requires a committed `HEAD`; read-only agents
  reject worktree mode).
- An isolated workflow's reviewer and documenter run inside the same worktree;
  tracked, deleted, untracked, and binary changes integrate back exactly once
  after the workflow settles — nothing is staged and your index is untouched.
- Shared-checkout writers (and reviewers snapshotting their diff) serialize
  through one repository lane, so two shared writers never race.
- Setup or integration failures keep the useful patch/worktree and record
  recovery info in `~/.pi/agent/pi-subagents-recovery.json`; a parked isolated
  thread keeps its worktree and resumes there.

## Follow, redirect, or stop

Every dispatch returns a stable `#id` — the handle for all control tools:

| Tool | What it does |
| --- | --- |
| `subagent_control` | `resume` a parked/settled thread with its full retained context, optionally with a new `objective` appended. |
| `subagent_status` | List active and recent runs, or return one run's full result and failed-tool diagnostics. |
| `subagent_wait` | Non-blocking in-turn lookup; `timeoutMs` only when you must wait. |
| `subagent_stop` | Destructively cancel, deliver the partial output, retire the thread. |

```ts
subagent_control({ action: "resume", id: 7, objective: "Finish the tests." });
```

Threads are durable: parked/settled sessions, worktree checkpoints, and state
live under `~/.pi/agent/` (not the OS temp directory) and are restored when pi
reloads or restarts — a reload interrupts a live run into a restorable
checkpoint instead of losing it. Settled results stay resumable for 7 days,
parked work for 30. All control operations are bounded; they never hang on a
generation that is still settling.

## Results and live status

The TUI widget projects each managed workflow as a timeline plus its current
child:

```text
◆ #12 worker workflow · src/cache.ts · wt:a91f3c · 42s
  ✓ implement ─ ● review ─ ○ docs
  └ ● #15 reviewer · final review · claude-sonnet-4-5/high · 10s
○ #23 worker · queued · redirect to ripgrep crates · 5m02s
```

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
*Configure an agent* also offers a manual strength per agent, listing only the
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

| Field | Meaning |
| --- | --- |
| `enabledAgents` | Agents available for discovery and delegation. `[]` disables all. |
| `agentModels` | Optional `provider/model-id` per agent; missing = current main model. |
| `agentThinkingLevels` | Optional manual level per agent; missing = Auto. |
| `notifyOnReviewPass` | Deliver a standalone passing gate without waking the main agent. Default `false`. |
| `maxResultLines` | Lines kept in a completion message before the artifact takes over. Default `40`. |
| `proactiveInjection` | Inject the delegation directive into the main system prompt. Default `true`. |
| `agentScope` | Discover `user`, `project`, or `both` agent directories. Default `user`. |
| `idleTimeoutSec` | Seconds without child RPC output before termination; `0` disables. Default `90`. |

Invalid values fall back safely; stale keys (including the former
`maxConcurrency`/`maxFixRounds` knobs) are dropped automatically. At session
start, model overrides Pi no longer reports are removed with a one-time notice.

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
