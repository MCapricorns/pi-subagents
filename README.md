# pi-subagents

[![npm version](https://img.shields.io/npm/v/@ferris1225/pi-subagents?color=blue)](https://www.npmjs.com/package/@ferris1225/pi-subagents)
[![downloads](https://img.shields.io/npm/dm/@ferris1225/pi-subagents)](https://www.npmjs.com/package/@ferris1225/pi-subagents)
[![license](https://img.shields.io/npm/l/@ferris1225/pi-subagents)](./LICENSE)
![platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey)
![pi](https://img.shields.io/badge/pi-extension-orange)

## Give pi a dependable engineering team

**pi-subagents** turns delegation in [pi](https://pi.dev) into a complete workflow,
not just a way to launch another prompt.

Your main agent can send research to `explorer`, implementation to `worker`,
intentional maintenance to `cleaner`, and independent checks to `reviewer`. Each
role runs in its own child process with a clean context, works in the background,
and returns its result automatically. Long-running work can be steered, parked,
resumed, retargeted, or forked without losing what the agent already learned.

```text
You
 └─ pi main agent
     ├─ explorer ── maps the codebase
     ├─ worker ──── implements and verifies the change
     └─ reviewer ── checks the diff
          └─ REVIEW_FAIL → worker fixes → reviewer checks again

The main agent receives one useful result when the work is ready.
```

Install it once and keep using pi normally. The extension teaches the main model
when to delegate, so most users do not need custom prompts or manual orchestration.

## Why use pi-subagents?

Use pi-subagents when delegation should **remove coordination work**, not create
more of it.

- **The right specialist gets the right job.** Research, implementation, cleanup,
  and review have separate roles, tools, and operating rules.
- **You do not babysit background work.** Results wake the main agent automatically;
  there is no polling loop and no “go check whether it finished” step.
- **Parallel edits stay safe.** Parallel workers use detached Git worktrees by
  default, then apply their changes back without touching your index.
- **Review can close the loop.** A failed gate can automatically dispatch a worker,
  run another independent review, and repeat up to a hard limit.
- **Agents remain controllable.** Every run has a stable id and retained session,
  so you can change direction or continue later without starting from zero.
- **Failures are handled, not hidden.** Model failures can hand the same session to
  the current main model; pre-prompt startup races retry safely; process and
  integration failures are reported with recovery details.

### More than a basic sub-agent launcher

| A basic launcher often gives you… | pi-subagents gives you… |
| --- | --- |
| One generic child role | Four focused engineering roles |
| A one-shot prompt | Retained, steerable, resumable, forkable threads |
| Concurrent writers in one checkout | Git worktree isolation for parallel workers |
| A review report you must act on manually | An optional reviewer → fix → re-review loop |
| Manual polling or follow-up | Automatic result delivery that resumes the main agent |
| A hard failure when the selected model is unavailable | Direct handoff to the current main model |
| Synchronized retries during startup contention | Extended jittered backoff that reduces retry collisions |

## Quick start

Requires **pi >= 0.83.0** and **Node.js >= 22.19.0**.

```bash
pi install npm:@ferris1225/pi-subagents
```

Open pi and run the setup wizard:

```text
/subagents-setup
```

Fresh installs enable all four built-in agents. You can keep the current main
model for every role or choose a different model and thinking level per agent.

Then ask for work in plain language:

```text
Map how authentication works, fix the refresh race, run the tests, and review the diff.
```

```text
Clean up src/cache. Remove only code you can prove is dead, then verify the result.
```

```text
Compare screenshots/settings.png with design.png and report every visual mismatch.
```

The main agent decides when delegation is useful. You can also call the tools
explicitly when you want exact control.

## What changed in 4.1.2

Startup contention is now much harder to exhaust. A child that exits or fails its
RPC readiness handshake before the initial prompt is dispatched is retried through
a longer backoff window. Each default delay also gets additive jitter, reducing the
chance that several children retry in the same lockstep waves. The base window
covers stale startup locks and leaves headroom beyond the default four-way fan-out.

Only a failure known to precede prompt dispatch qualifies. Once the parent sends a
prompt command, pi-subagents will not replay it—even if the ACK is lost—because Pi
may already have started the model or tools. This recovery therefore cannot
repeat model calls or edits.

## Meet the team

| Agent | Access | Best for |
| --- | --- | --- |
| `explorer` | Read-only | Broad codebase search, unfamiliar-area mapping, symbol and dependency tracing, and multi-file reconnaissance. |
| `worker` | Full | A self-contained implementation, bug fix, refactor, or test task carried through verification. |
| `cleaner` | Full | Explicitly authorized cleanup, removal, simplification, and maintenance. It must prove each cut; zero edits is a valid result. |
| `reviewer` | Read-only | Audits, code-health checks, plans, PR or issue validation, and fresh pre-commit gates. |

Children have no memory of the parent conversation. A good manual brief includes
the goal, exact paths, constraints, and expected output. The injected delegation
guidance does this automatically when the main agent dispatches on your behalf.

## Everyday workflows

### Delegate one task

```ts
subagent({
  agent: "explorer",
  task: "Map the test setup. Report exact files, commands, and CI entry points.",
});
```

```ts
subagent({
  agent: "worker",
  task: "Fix the cache invalidation bug in src/cache, add regression tests, and run the relevant checks.",
});
```

### Fan out independent work

```ts
subagent({
  tasks: [
    { agent: "explorer", task: "Trace model fallback from dispatch to completion." },
    { agent: "worker", task: "Add edge-case tests for config migration." },
  ],
});
```

Independent tasks run up to `maxConcurrency` (default `4`). One parallel call may
contain at most that many tasks and is rejected if it exceeds the limit. Accepted
background work from separate calls waits in the shared queue when all slots are
busy.

### Run an independent quality gate

```ts
subagent({
  agent: "reviewer",
  task: "Gate the current diff for correctness, regressions, and missing tests.",
});
```

A gate reviewer ends with `REVIEW_PASS` or `REVIEW_FAIL`. On failure, pi-subagents
can run this loop without waking the main agent between steps:

```text
reviewer → worker fixes every open finding → reviewer checks again → PASS/FAIL
```

`maxFixRounds` is a hard cap, so the chain always settles. Generic audits and
read-only reviews are advisory: they do not emit a gate verdict and never trigger
edits.

### Clean up without guessing

`cleaner` is only for requests that explicitly authorize cleanup edits. It checks
reachability, ownership, history, and boundaries before removing or simplifying
anything, then applies every safe in-scope cut and verifies the result.

```text
explicit cleanup request → cleaner applies proven cuts → reviewer gates the diff
read-only cleanup audit   → reviewer reports candidates only
```

This separation matters: asking for an audit does not silently authorize code
changes, and asking for cleanup does not reward speculative deletion.

## Safe parallel editing

Every child has process and context isolation. Write-capable tasks can also have
filesystem isolation:

- A single task defaults to `isolation: "shared"`.
- Parallel `worker` tasks default to `isolation: "worktree"`.
- `cleaner` supports worktree mode when explicitly requested.
- Read-only `explorer` and `reviewer` tasks reject worktree mode because they do
  not need a writable checkout.

Worktree mode requires a Git repository with a committed `HEAD`. Tracked,
deleted, untracked, and binary changes are carried back to the original checkout
without staging or modifying the parent index. If setup or integration fails,
pi-subagents keeps the useful patch or worktree when possible and records recovery
information in:

```text
~/.pi/agent/pi-subagents-recovery.json
```

A parked isolated thread keeps its worktree. Resume continues there. Forking an
isolated checkpoint is available after that checkpoint has settled and integrated.

## Follow, redirect, or stop a run

Dispatch confirmations and completion messages include a stable `#id`.

| Tool | What it does |
| --- | --- |
| `subagent_control` | `steer`, `retarget`, `park`, `resume`, or `fork` a logical thread. |
| `subagent_status` | Show active and recent runs, or return the full result for one id. |
| `subagent_wait` | Look up a result in the current turn. It is non-blocking by default; use `timeoutMs` only when you must wait in-turn. |
| `subagent_stop` | Destructively cancel work, deliver partial output, and retire that thread's retained session. Independent forks survive. |

```ts
subagent_control({ action: "steer", id: 7, instruction: "Check the Windows path too." });
subagent_control({ action: "park", id: 7 });
subagent_control({ action: "resume", id: 7, objective: "Finish the tests." });
subagent_control({ action: "fork", id: 7, objective: "Try the smaller design instead." });
```

Use `steer` to add guidance to active work. Use `retarget` when the current
objective is obsolete. Use `park` to preserve a checkpoint while releasing its
process slot. Use `stop` only when you want to discard that thread's future
continuation.

## Results and live status

The active TUI widget shows queued and running work as a compact tree:

```text
● reviewer · review diff of src/cache.ts · claude-sonnet-4-5/high · 42s
  ├ ● worker · fix round 1 · src/cache.ts · claude-sonnet-4-5/high · 10s
  │    grep cacheKey
  └ ○ reviewer · re-review round 1 · claude-sonnet-4-5/high · 3s
```

Completed and parked rows disappear from the widget. Final messages include the
result plus aggregate token and cost totals. Long output is truncated in the
conversation and written to a temporary Markdown artifact; `subagent_status`
keeps the complete run report available by id.

The main agent is told not to paraphrase a result you have already seen. It should
add only its own conclusion or next action instead of charging you twice for the
same explanation.

## Models, thinking, and image work

Each agent can use the current main model or one selected in `/subagents-setup`.
The setup picker shows authenticated models and labels them `vision` or
`text-only`.

```text
selected agent model → current main model
```

If the selected model is missing, unavailable, rate-limited, out of quota, or
fails at the provider level, the current main model continues the same retained
session. Searches, reads, reasoning, and edits already completed are preserved.
Ordinary tool and test failures remain task failures and do not trigger a model
handoff.

Thinking defaults to **Auto**. pi-subagents starts from the role's preference and
chooses only a level the effective model actually supports. A fallback re-checks
the level for the main model.

There is no separate vision mode. Assign a multimodal model to the agent and name
the image paths in the task:

```ts
subagent({
  agent: "reviewer",
  task: "Compare screenshots/settings.png with design.png and list every visual mismatch.",
});
```

## Reliability without duplicate work

- **Startup recovery:** silent, zero-activity failures before prompt dispatch
  retry with extended jittered backoff. A dispatched prompt is never replayed,
  even when its ACK is lost.
- **Idle watchdog:** a run with no RPC output for `idleTimeoutSec` is terminated;
  selected-model failures can continue on the current main model.
- **Retained context:** model handoff, park/resume, retarget, and fork build on the
  same session history instead of repeating discovery.
- **Visible failures:** process crashes, partial parallel starts, model failures,
  and Git integration failures are returned as failures rather than silent hangs.
- **Safe status text:** live tool activity is credential-redacted and stripped of
  terminal control characters.
- **No runaway trees:** child processes are leaves; they cannot dispatch more
  sub-agents.

## Configuration

The wizard covers enabled agents, per-agent models and thinking, concurrency,
auto-fix rounds, and the idle timeout:

```text
/subagents-setup
```

Configuration is stored at `~/.pi/agent/pi-subagents.json` and follows
`PI_CODING_AGENT_DIR` when that environment variable is set.

```json
{
  "enabledAgents": ["explorer", "worker", "cleaner", "reviewer"],
  "agentModels": {
    "explorer": "anthropic/claude-haiku-4-5"
  },
  "agentThinkingLevels": {
    "reviewer": "high"
  },
  "notifyOnReviewPass": false,
  "maxResultLines": 80,
  "proactiveInjection": true,
  "agentScope": "user",
  "maxConcurrency": 4,
  "maxFixRounds": 2,
  "idleTimeoutSec": 90
}
```

| Field | Meaning |
| --- | --- |
| `enabledAgents` | Agent names available for discovery and delegation. `[]` disables all agents. |
| `agentModels` | Optional `provider/model-id` per agent. Missing means use the current main model. |
| `agentThinkingLevels` | Optional manual level per agent. Missing means Auto. |
| `notifyOnReviewPass` | When `true`, a passing gate is delivered without waking the main agent. Default `false`. |
| `maxResultLines` | Lines kept in a completion message before the full result moves to a temporary artifact. Default `80`. |
| `proactiveInjection` | Teach the main model when and how to delegate. Default `true`. |
| `agentScope` | Discover `user`, `project`, or `both` agent directories. Default `user`. |
| `maxConcurrency` | Running process limit and maximum tasks in one parallel call, from `1` to `16`. Default `4`. |
| `maxFixRounds` | Worker → reviewer rounds after `REVIEW_FAIL`. `0` disables auto-fix. Default `2`. |
| `idleTimeoutSec` | Seconds without RPC output before termination. `0` disables the watchdog. Default `90`. |

Invalid values fall back safely. Older configs are normalized automatically. The
former built-in name `explore` migrates to `explorer`, and pre-cleaner non-empty
agent lists receive `cleaner` once; a later deliberate disable is respected.

## Custom and overridden agents

Built-ins ship in the package. You can add or replace agents with Markdown files:

- User agents: `~/.pi/agent/agents/`
- Project agents: nearest `.pi/agents/` directory in a trusted project
- Precedence: project overrides user, user overrides built-in

To replace a built-in, use the same filename and `name`. Optional frontmatter:

```yaml
---
name: explorer
description: Fast read-only codebase reconnaissance
model: anthropic/claude-haiku-4-5
thinking: low
tools: read, bash
---
```

The Markdown body becomes the child's additional system prompt. Configuration
chosen in `/subagents-setup` takes precedence over frontmatter defaults.

## Development

```bash
npm install
npm run check
npm test
```

The package has no bundled runtime dependencies; it uses pi and TypeBox as peer
packages. Source is split by responsibility: dispatch and auto-fix, retained
thread lifecycle, RPC transport, worktree integration, completion delivery,
tools, and TUI status.

## License

[MIT](./LICENSE)
