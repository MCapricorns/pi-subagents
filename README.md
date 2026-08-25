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
intentional cleanup and duplicate-code consolidation to `cleaner`, documentation
synchronization to `documenter`, and independent checks to `reviewer`. Each role
runs in its own child process with a clean context, works in the background, and
returns its result automatically. Active top-level work can be steered or
retargeted; managed stages can be parked, resumed, stopped, or forked without
losing retained context.

```text
You
 └─ pi main agent
     ├─ explorer ─── maps the codebase
     ├─ worker ───── implements ─┬─▶ reviewer ─▶ documenter
     ├─ cleaner ──── cleans up ──┘       (enabled roles only)
     ├─ documenter ─ synchronizes docs ─▶ reviewer
     └─ reviewer ─── advisory report (no VERDICT), or managed gate
          ├─ REVIEW_PASS + documenter → final documentation sync
          └─ REVIEW_FAIL → worker → reviewer (fix rounds) → final docs

The stable parent run returns one final result when the complete workflow settles.
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
- **Parallel edits stay safe.** Parallel workers use temporary, isolated Git
  checkouts (worktrees) by default, then apply their changes back without
  touching your index.
- **Documentation stops drifting.** Enabled `documenter` runs automatically
  once after the review gate settles — after successful workers/cleaners or
  fix rounds, never per fix round. It can also run an explicitly requested
  whole-codebase maintenance pass.
- **Review can close the loop.** A failed gate can automatically dispatch a
  worker, request another independent review, and repeat up to a hard limit;
  one final documentation sync follows the settled chain.
- **Agents remain controllable.** Every run has a stable id and retained session,
  so you can change direction or continue later without starting from zero.
- **Failures are handled, not hidden.** Model failures can hand the same session to
  the current main model; pre-prompt startup races retry safely; process and
  integration failures are reported with recovery details.

### More than a basic sub-agent launcher

| A basic launcher often gives you… | pi-subagents gives you… |
| --- | --- |
| One generic child role | Five focused engineering roles |
| A one-shot prompt | Retained, steerable, resumable, forkable threads |
| Concurrent writers in one checkout | Git worktree isolation for parallel workers |
| A review report you must act on manually | Automatic writer → reviewer → documenter delivery and bounded fix rounds |
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

Fresh installs enable `explorer`, `worker`, `cleaner`, and `reviewer`.
`documenter` is available in the wizard but stays off until you select it. You
can keep the current main model for every role or choose a different model and
thinking level per agent.

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

## What changed in 4.1.4

### Documentation sync moved after the review gate

`documenter` now runs once at the end of a managed chain instead of before the
reviewer and once per fix round:

```text
before: worker → documenter → reviewer → (worker → documenter → reviewer) × N
after:  worker → reviewer → (worker → reviewer) × N → documenter
```

Code fixes no longer invalidate a docs pass written moments earlier, fix rounds
stop paying for documenter runs and re-reviewing their churn, and a direct
passing gate gets one final documentation sync instead of a second full review.
Gate reviewers record documentation drift as non-gating `## Documentation notes`
that the final documenter applies; when `documenter` is disabled, drift stays a
normal gate finding. The sync is skipped when a chain ends on a failing gate.

## What changed in 4.1.2

### Documentation sync as a real workflow stage

The new `documenter` is a write-capable, explorer-class role with two modes:

1. **Pre-commit diff sync** — after the last code edit and before the final
   reviewer, it compares the actual diff with comments, README/docs, examples,
   commands, config, defaults, and lifecycle descriptions.
2. **Whole-codebase maintenance** — when explicitly requested, it scans an
   existing project for stale comments and documentation and applies every safe,
   verified correction in scope.

It never changes runtime behavior, commits, pushes, publishes, or bumps versions.
When enabled, runtime now treats it as a managed stage: successful top-level
`worker`/`cleaner` runs continue through `documenter → reviewer`, a successful
whole-codebase `documenter` continues through reviewer, and auto-fix rounds use
`worker → documenter → reviewer`. Existing non-empty configs receive `documenter`
once and inherit the configured `explorer` model and thinking level; fresh
installs leave it as an explicit setup choice.

### Safer startup contention recovery

Startup contention is much harder to exhaust. A child that exits or fails its RPC
readiness handshake before the initial prompt is dispatched is retried through a
longer backoff window. Each default delay also gets additive jitter, reducing the
chance that several children retry in the same lockstep waves. The base window
covers stale startup locks and leaves headroom beyond the default four-way fan-out.

Only a failure known to precede prompt dispatch qualifies. Once the parent sends a
prompt command, pi-subagents will not replay it—even if the ACK is lost or an idle
watchdog wins the race—because Pi may already have started the model or tools.
This recovery therefore cannot repeat model calls or edits.

## Meet the team

| Agent | Access | Best for |
| --- | --- | --- |
| `explorer` | Read-only | Broad codebase search, unfamiliar-area mapping, symbol and dependency tracing, and multi-file reconnaissance. |
| `worker` | Full | A self-contained implementation, bug fix, refactor, or test task carried through verification. |
| `cleaner` | Full | Explicitly authorized cleanup, removal, simplification, and duplicate-code consolidation. Dispatch authorizes every safe in-scope cut; it must prove each one. |
| `documenter` | Docs/comments | Pre-commit diff sync or explicitly requested whole-codebase documentation maintenance. Uses an explorer-class model, may make zero edits, and never changes runtime behavior. |
| `reviewer` | Read-only | Audits, code-health checks, plans, PR or issue validation, documentation-drift checks, and fresh pre-commit gates. |

Children have no memory of the parent conversation. A good manual brief includes
the goal, exact paths, constraints, and expected output. The injected delegation
guidance does this automatically when the main agent dispatches on your behalf.

### Tool, plugin, skill, and context inheritance

Every initial dispatch, managed stage, retained resume, fork, startup retry,
and selected-to-main fallback snapshots the parent session's currently active
tools. Roles without an explicit tool list (such as shipped `worker` and
`cleaner`) inherit that complete set. An explicit role list remains its Pi
built-in permission boundary, but its existing shell slot follows the parent
(`bash`, `powershell`, both, or neither) and parent-active extension/SDK tools
are appended; inactive plugin names declared in frontmatter are not enabled.
Therefore `explorer` and `reviewer` never gain Pi's built-in `edit`/`write`;
`documenter` keeps them for docs/comments; and a custom agent keeps the built-in
capabilities declared in its own frontmatter. All `subagent*` control tools are
removed from children so they remain leaves. An empty inherited snapshot starts
the child with `--no-tools` instead of falling back to Pi's defaults.

`powershell` is the Pi tool name. On Windows, it selects native `pwsh.exe` when
available and falls back to `powershell.exe`. Parent-active plugin tools such as
web search or API/documentation lookup are available to every child when that
plugin also loads there. Global skills and trusted project skills load normally
inside each child Pi process.

Each child is an independent Pi session and uses Pi's normal global/project
`compaction` settings. Auto-compaction therefore remains enabled by default when
a child's model context approaches its limit. Retained resume/fork sessions keep
their existing conversation and compaction summaries instead of starting over.

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

A gate reviewer ends with `REVIEW_PASS` or `REVIEW_FAIL`. A direct pass is
final for the code: runtime runs the final documentation sync once (when
`documenter` is enabled) and delivers. A failure uses the bounded loop:

```text
reviewer → worker fixes every open finding → reviewer checks again → … → final documentation sync
```

Each step gets a fresh model context. The chain shares the same code state and
passes every full reviewer and worker report forward; it does not reuse one
context window. Internal children bypass top-level lifecycle policy, so they
cannot recursively start another chain. Gate reviewers keep documentation drift
out of the verdict while `documenter` is enabled by recording it as
`## Documentation notes` for the final documenter.

`maxFixRounds` limits worker fix attempts only. The post-writer review gate and
the final documentation sync still run when it is `0`. Generic audits and
read-only reviews are advisory: they omit `VERDICT`, remain read-only, and
never trigger edits.

### Clean up without guessing

`cleaner` is only for requests that authorize cleanup edits. Once dispatched,
that authorization covers every safe, proven in-scope cut without another
item-by-item confirmation. It checks reachability, ownership, history, and
boundaries before removing, simplifying, or consolidating anything, then verifies
the result.

Repeated code is a first-class cleanup target. Cleaner compares contracts,
invariants, side effects, ownership, and reasons to change—not just matching
text—then extracts the smallest stable shared implementation and migrates all
in-scope callers. It keeps similar code separate when domains or future change
axes genuinely differ, avoiding a generic abstraction that is worse than the
duplication.

```text
explicit cleanup request → cleaner applies proven cuts → reviewer gates the diff → documenter syncs docs
read-only cleanup audit   → reviewer reports candidates only
```

This separation matters: asking for an audit does not silently authorize code
changes, and asking for cleanup does not reward speculative deletion.

### Keep comments and README/docs synchronized

`documenter` has two deliberate launch paths.

**For a pending worker or cleaner change**, enable the role. Runtime schedules
one final sync automatically against the actual diff after the review gate
settles; do not dispatch a duplicate manual sync. If reviewer is disabled,
documenter becomes the final managed stage directly after the writer. If
documenter is disabled, reviewer follows the writer directly.

**For an existing project**, explicitly authorize a broad maintenance pass:

```ts
subagent({
  agent: "documenter",
  task: "Run a whole-codebase documentation maintenance pass. Verify comments, docstrings, README files, docs, and examples against the implementation; update every safe stale statement in scope.",
});
```

A successful explicit whole-codebase documenter also continues automatically to
reviewer when enabled. A generic or read-only documentation audit still belongs
to `reviewer`. `documenter` is the last writer, never the approver:

```text
worker / cleaner / documenter / auto-fix worker → enabled downstream roles → one final delivery
```

## Safe parallel editing

A Git worktree is a temporary second checkout of the same repository. It shares
Git history with your main checkout but has its own files, so two workers do not
overwrite each other while they run.

Every child has process and context isolation. Write-capable tasks can also have
filesystem isolation:

- A single task defaults to `isolation: "shared"`.
- Parallel `worker` tasks default to `isolation: "worktree"`.
- `cleaner` and `documenter` support worktree mode when explicitly requested;
  their default remains shared.
- Read-only `explorer` and `reviewer` tasks reject worktree mode because they do
  not need a writable checkout.

Worktree mode requires a Git repository with a committed `HEAD`. For an isolated
writer, automatic reviewer/documenter children run inside that same worktree.
Those isolated stages can still run in parallel; writer, fix, and documentation
changes are integrated only after the final managed stage settles. Tracked,
deleted, untracked, and binary changes are then carried back to the original
checkout without staging or modifying the parent index.

Repository-lane discovery uses the Git top-level even in an empty repository, so
root and nested paths share one lane before the first commit. Every shared
`worker`, `cleaner`, and `documenter` writer—and each shared `reviewer` snapshot
when managed writers are enabled—uses that lane. Standalone documentation,
writer-only configurations, and workflows without reviewer cannot race another
writer or documentation sync. Isolated agents keep doing model work in parallel,
but their final apply waits for the same lane.

Normal completion, stop, and shutdown share one finalization result, so isolated
state is applied at most once. If park, stop, or shutdown wins after the top-level
child settles, no downstream role starts and the stable top-level session remains
the checkpoint. If setup or integration fails, pi-subagents keeps the useful
patch or worktree when possible and records recovery information in:

```text
~/.pi/agent/pi-subagents-recovery.json
```

A parked isolated thread keeps its worktree. Resume continues there. Forking an
isolated checkpoint is available after that checkpoint has settled and integrated.

## Follow, redirect, or stop a run

Dispatch confirmations and completion messages include a stable `#id`. That
parent id represents the whole managed workflow; each internal documenter,
reviewer, and fix step gets a separate queryable id in the final summary. No
internal completion wakes the main agent.

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

Use `steer` or `retarget` only while the top-level RPC child is active. `steer`
queues guidance without changing the displayed objective; `retarget` aborts that
generation's objective and replaces it in the same session. During an automatic
documenter, reviewer, or fix stage, use `park` or `stop`. `resume` without an
`objective` continues the currently displayed goal; supplying one appends that
explicit goal to the retained conversation and makes it the new displayed goal.
It never clears prior context. `fork` follows the same objective rule on a copied
branch while leaving its source unchanged. Widget labels distinguish retained,
appended, retargeted, and forked objectives.

Use `park` to preserve the newest active stage and release its process slot;
parking during documentation retains the documenter's partial/session, not an
older writer or review. A resumed logical run keeps cumulative active elapsed
time across all generations while excluding the parked interval. Use `stop` only
when you want to discard that thread's future continuation. Stop and session
shutdown abort the active internal stage, suppress stale delivery, and leave
worktree finalization to the same one-time lifecycle owner. `stop-all` interrupts
every lane holder before waiting for finalization, avoiding self-deadlock when an
isolated apply is queued behind shared work.

## Results and live status

The active TUI widget shows queued and running work as a compact tree:

```text
● reviewer workflow · review diff of src/cache.ts · 42s
  ├ ● worker · fix round 1 · src/cache.ts · claude-sonnet-4-5/high · 10s
  │    grep cacheKey
  └ ○ documenter · final documentation sync · claude-haiku-4-5/low · 3s
```

A managed root keeps its original top-level role and workflow-wide elapsed
time, but deliberately omits model/thinking because several model stages own
that row over its lifetime. The active nested row shows the current stage's
actual role, selected/fallback model, thinking level, stage elapsed time, and
activity. Per-stage usage stays attached to that stage; only the final summary
is labeled and calculated as an aggregate.

Completed internal rows disappear from the widget; a parked parent remains
queryable. Final messages contain one managed-workflow summary with aggregate
token/cost totals and every internal id. Built-in roles author their own
result-only handoff—outcome, relevant paths, verification, and unresolved
blockers—without a second summarization layer that could distort the result.
They omit task/process narration and recovered transient tool failures. The
80-line delivery cap remains a safety limit; long output is written unchanged to
a temporary Markdown artifact, and explicit `subagent_status` lookup keeps the
complete report and failed-tool diagnostics available by id.

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
the level for the main model. `documenter` deliberately ships with the same fast,
low-thinking profile as `explorer`; migration and manual enablement copy any
configured explorer route, and you can still override it independently.

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

In nested setup screens, `Esc` returns one level: thinking → model → agent
selection → settings. Runtime value pickers return to the Runtime settings menu,
and other nested pickers return to the main settings menu. Only `Esc` from the
top-level settings menu exits the wizard; completed agent choices are saved when
leaving that configuration pass.

Configuration is stored at `~/.pi/agent/pi-subagents.json` and follows
`PI_CODING_AGENT_DIR` when that environment variable is set.

```json
{
  "enabledAgents": ["explorer", "worker", "cleaner", "documenter", "reviewer"],
  "agentModels": {
    "explorer": "anthropic/claude-haiku-4-5",
    "documenter": "anthropic/claude-haiku-4-5"
  },
  "agentThinkingLevels": {
    "documenter": "low",
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
| `notifyOnReviewPass` | When `true`, a standalone passing gate is delivered without waking the main agent. Managed workflows still wake once at final delivery. Default `false`. |
| `maxResultLines` | Lines kept in a completion message before the full result moves to a temporary artifact. Default `80`. |
| `proactiveInjection` | Teach the main model when and how to delegate. Default `true`. |
| `agentScope` | Discover `user`, `project`, or `both` agent directories. Default `user`. |
| `maxConcurrency` | Running process limit and maximum tasks in one parallel call, from `1` to `16`. Default `4`. |
| `maxFixRounds` | Maximum worker fixes after `REVIEW_FAIL`; each fix is re-reviewed by a reviewer, and one final documentation sync runs after the chain settles. `0` disables fixes but not the post-writer review gate or final docs. Default `2`. |
| `idleTimeoutSec` | Seconds without RPC output before termination. `0` disables the watchdog. Default `90`. |

Invalid values fall back safely. Older configs are normalized automatically. The
former built-in name `explore` migrates to `explorer`, and pre-cleaner non-empty
agent lists receive `cleaner` once. Existing non-empty configs also receive
`documenter` once, inserted before `reviewer`, with any configured `explorer`
model and thinking copied across. Fresh installs do not enable `documenter`
until the user selects it. Later deliberate disables are respected.

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
chosen in `/subagents-setup` takes precedence over frontmatter defaults. A
custom agent's explicit `tools` list remains its Pi built-in capability boundary;
an existing shell slot follows the parent, and active extension/SDK tools are
appended as described above. Omitting `tools` inherits the parent's complete
active set.

## Development

```bash
npm install
npm run check
npm test
```

The package has no bundled runtime dependencies; it uses pi and TypeBox as peer
packages. Source is split by responsibility: managed dispatch/workflow policy,
retained thread lifecycle, RPC transport, worktree integration, completion
delivery, tools, and TUI status.

## License

[MIT](./LICENSE)
