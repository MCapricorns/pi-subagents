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
retargeted; managed stages can be parked, resumed, or stopped without losing
retained context, and parked/settled threads survive a pi reload or restart.

```text
You
 └─ pi main agent
     ├─ explorer ─── retrieval index only (never an automatic gate)
     ├─ worker ───── implements ─┬─▶ reviewer ─┬─ docs CLEAN → deliver
     ├─ cleaner ──── cleans up ──┘             └─ NEEDED/missing → documenter
     ├─ documenter ─ explicit docs/comments task → deliver
     └─ reviewer ─── advisory report (no VERDICT), or managed gate
          └─ REVIEW_FAIL → worker → reviewer (bounded fix rounds)

Worker and cleaner update existing docs/comments they directly affect. The stable
parent returns one final result when its complete managed workflow settles.
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
- **Documentation stops drifting without a mandatory extra pass.** Workers and
  cleaners synchronize directly affected existing docs. After `REVIEW_PASS`,
  enabled `documenter` runs only for `DOCUMENTATION: NEEDED` (or conservatively
  for a missing marker); with reviewer disabled, it remains the fallback.
- **Review can close the loop.** A failed gate can automatically dispatch a
  worker, request another independent review, and repeat up to a hard limit;
  documentation is considered only after the terminal `REVIEW_PASS`.
- **Agents remain controllable.** Every run has a stable id and retained session,
  so you can change direction or continue later without starting from zero.
- **Failures are handled, not hidden.** Model failures can hand the same session to
  the current main model; pre-prompt startup races retry safely; process and
  integration failures are reported with recovery details.

### More than a basic sub-agent launcher

| A basic launcher often gives you… | pi-subagents gives you… |
| --- | --- |
| One generic child role | Five focused engineering roles |
| A one-shot prompt | Retained, steerable, resumable threads that survive reloads |
| Concurrent writers in one checkout | Git worktree isolation for parallel workers |
| A review report you must act on manually | Independent worker/cleaner gate, bounded fix rounds, and conditional docs sync |
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

## Managed workflow behavior

The runtime deliberately keeps delegation conservative:

- Small work with a known target stays in the main thread on direct tools.
  `explorer` is worthwhile for broad reconnaissance only; it returns a retrieval
  index, never an automatic gate, and downstream roles re-read load-bearing code.
- `worker` and `cleaner` remain distinct write-capable entry roles. Each updates
  existing README/docs/examples/comments directly affected by its change. After
  success, one enabled independent `reviewer` gate runs, with the existing bounded
  worker ↔ reviewer fix loop for `REVIEW_FAIL`. Every gate finding carries a
  concrete fix instruction; the worker implements those instructions or ships a
  sounder fix with an explicit pushback, and re-review judges the resulting code —
  only open findings and defects the fix itself introduced can continue the loop.
- When `documenter` is enabled, every managed reviewer gate is asked for a
  standalone `DOCUMENTATION: CLEAN` or `DOCUMENTATION: NEEDED` line. Only
  `REVIEW_PASS` can authorize the final sync: NEEDED includes
  `## Documentation notes` and runs it, CLEAN removes the pending docs stage,
  and a missing marker on that passing gate conservatively runs it.
- A process failure, missing verdict, or terminal `REVIEW_FAIL` never starts
  documentation writing. With reviewer disabled, the writer → documenter
  fallback remains. Documentation drift is non-gating only while documenter is
  available; otherwise it is an ordinary review finding.
- A top-level `documenter` is already an explicit docs/comments writing task. It
  still uses the shared writer lane and may use worktree isolation, but delivers
  directly after success instead of starting another reviewer.

No workflow decision depends on diff line count, file count, or a size heuristic.

## Meet the team

| Agent | Access | Best for |
| --- | --- | --- |
| `explorer` | Read-only | Broad codebase search, unfamiliar-area mapping, symbol and dependency tracing, and multi-file reconnaissance. |
| `worker` | Full | A self-contained implementation, bug fix, refactor, or test task carried through verification. |
| `cleaner` | Full | Explicitly authorized cleanup, removal, simplification, and duplicate-code consolidation. Dispatch authorizes every safe in-scope cut; it must prove each one. |
| `documenter` | Docs/comments | Conditional final diff sync or an explicit standalone documentation/comment task (including explicitly broad maintenance). Uses an explorer-class model, may make zero edits, and never changes runtime behavior. |
| `reviewer` | Read-only | Audits, code-health checks, plans, PR or issue validation, documentation-drift checks, and fresh pre-commit gates. |

Children have no memory of the parent conversation. A good manual brief includes
the goal, exact paths, constraints, and expected output. The injected delegation
guidance does this automatically when the main agent dispatches on your behalf.

### Tool, plugin, skill, and context inheritance

Every initial dispatch, managed stage, retained resume, startup retry,
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
a child's model context approaches its limit. Retained resume sessions keep
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

Independent tasks run up to a fixed limit of `4` concurrent sub-agent processes.
One parallel call may contain at most that many tasks and is rejected if it
exceeds the limit. Accepted background work from separate calls waits in the
shared queue when all slots are busy. The limit protects manual dispatches only:
once a generation's top-level child settles and the runtime continues into its
own managed stages (gate review, auto-fix rounds, documentation sync), that
generation releases its slot, so long fix chains never starve new dispatches.

### Run an independent quality gate

```ts
subagent({
  agent: "reviewer",
  task: "Gate the current diff for correctness, regressions, and missing tests.",
});
```

A gate reviewer ends with `REVIEW_PASS` or `REVIEW_FAIL` and independently
emits `DOCUMENTATION: CLEAN` or `DOCUMENTATION: NEEDED` when documenter is
enabled. Only `REVIEW_PASS` can continue to documentation: CLEAN delivers
immediately, while NEEDED (or a missing marker on that passing gate) runs one
final docs sync. A failure uses the bounded loop:

```text
reviewer → worker applies each fix instruction (or rebuts with a sounder fix)
         → reviewer re-reviews the result → …
                                          REVIEW_PASS ─┬─ CLEAN → deliver
                                                       └─ NEEDED/missing → documenter
```

Each step gets a fresh model context. The chain shares the same code state and
passes every full reviewer and worker report forward; it does not reuse one
context window. Re-review converges instead of re-auditing: it rules on every
previous finding once, judges the code as it now stands (a sound worker fix
counts even when it deviates from the instruction), and adds new findings only
for defects the fix round's own edits introduced or exposed — issues unrelated
to those edits belong to a fresh gate, not to the loop. Internal children bypass top-level lifecycle policy, so they
cannot recursively start another chain. Gate reviewers keep documentation drift
out of the code verdict while `documenter` is enabled by recording it under
`## Documentation notes`; with documenter disabled, drift is a normal finding.

The loop is fixed at two worker fix rounds (each fix is re-reviewed); disabling
the `worker` agent is the way to turn fixes off. The post-writer review gate still
runs regardless, and only a terminal `REVIEW_PASS` can decide whether docs
sync is needed. Generic audits and read-only reviews are advisory: they omit
`VERDICT` and documentation machine markers, remain read-only, and never trigger
edits.

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
explicit cleanup request → cleaner applies cuts + syncs affected docs → reviewer gate → conditional documenter
read-only cleanup audit   → reviewer reports candidates only
```

This separation matters: asking for an audit does not silently authorize code
changes, and asking for cleanup does not reward speculative deletion.

### Keep comments and README/docs synchronized

`documenter` has two deliberate launch paths.

**For a pending worker or cleaner change**, those writers first synchronize
existing docs/comments directly affected by their edits. When the role is
enabled, runtime schedules a final sync only after terminal `REVIEW_PASS` when
the reviewer emits `DOCUMENTATION: NEEDED` or omits the marker; do not dispatch
a duplicate. If reviewer is disabled, documenter remains the conservative final
fallback. If documenter is disabled, documentation drift is an ordinary reviewer
finding.

**For standalone documentation work**, explicitly authorize the desired scope
(a whole-codebase maintenance pass must be explicit):

```ts
subagent({
  agent: "documenter",
  task: "Run a whole-codebase documentation maintenance pass. Verify comments, docstrings, README files, docs, and examples against the implementation; update every safe stale statement in scope.",
});
```

A successful top-level documenter delivers directly without another reviewer.
It still occupies the shared writer lane and can use worktree isolation. A
generic or read-only documentation audit belongs to `reviewer`; `documenter` is
a docs/comments writer, never the code approver.

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
worker/cleaner, its automatic reviewer and any needed documenter run inside that
same worktree. A top-level isolated documenter writes there and then delivers
directly. Isolated workflows can still run in parallel; writer, fix, and any
documentation changes are integrated only after the final managed stage
settles. Tracked, deleted, untracked, and binary changes are then carried back
to the original checkout without staging or modifying the parent index.

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

A parked isolated thread keeps its worktree. Resume continues there.

## Follow, redirect, or stop a run

Dispatch confirmations and completion messages include a stable `#id`. For a
managed worker/cleaner or fix chain, that parent id represents the whole workflow;
each internal reviewer, fix, and conditionally launched documenter gets a
separate queryable id in the final summary. No internal completion wakes the
main agent.

| Tool | What it does |
| --- | --- |
| `subagent_control` | `steer`, `retarget`, `park`, or `resume` a logical thread. |
| `subagent_status` | Show active and recent runs, or return the full result for one id. |
| `subagent_wait` | Look up a result in the current turn. It is non-blocking by default; use `timeoutMs` only when you must wait in-turn. |
| `subagent_stop` | Destructively cancel work, deliver partial output, and retire that thread's retained session. |

```ts
subagent_control({ action: "steer", id: 7, instruction: "Check the Windows path too." });
subagent_control({ action: "park", id: 7 });
subagent_control({ action: "resume", id: 7, objective: "Finish the tests." });
```

Use `steer` or `retarget` only while the top-level RPC child is active. `steer`
queues guidance without changing the displayed objective; `retarget` aborts that
generation's objective and replaces it in the same session. During an automatic
documenter, reviewer, or fix stage, use `park` or `stop`. `resume` without an
`objective` continues the currently displayed goal; supplying one appends that
explicit goal to the retained conversation and makes it the new displayed goal.
It never clears prior context. Widget labels distinguish retained, appended,
and retargeted objectives.

Use `park` to preserve the newest active stage and release its process slot;
parking during documentation retains the documenter's partial/session, not an
older writer or review. A resumed logical run keeps cumulative active elapsed
time across all generations while excluding the parked interval. Use `stop` only
when you want to discard that thread's future continuation. Stop and session
shutdown abort the active internal stage, suppress stale delivery, and leave
worktree finalization to the same one-time lifecycle owner. `stop-all` interrupts
every lane holder before waiting for finalization, avoiding self-deadlock when an
isolated apply is queued behind shared work.

Every control operation is bounded: park, stop, and resume never wait
indefinitely on a generation that is still settling (for example an isolated
apply queued behind the managed repository lane). Stop proceeds after a bounded
deadline once it owns the lifecycle, a still-running integration continues in the
background, and a durable recovery record is persisted pointing at the retained
worktree/patch so stopped work is never lost.

## Survive reloads and restarts

Retained sessions, worktree checkpoints, and thread state live next to your pi
agent config, never in the OS temp directory:

```text
~/.pi/agent/pi-subagents-threads.json   # durable thread manifest
~/.pi/agent/pi-subagents-state/         # retained sessions and worktree temp state
```

When pi reloads (or the process crashes and restarts), the extension restores
parked and settled threads from that manifest: `subagent_status` lists them
again, `subagent_control resume` continues one with its full retained context,
and a one-time notice reports how many threads were restored. New run ids never
collide with restored ones. A reload that interrupts a live run converts it to a
restorable checkpoint instead of losing it, and child processes orphaned by the
reload are killed so the on-disk session is the single source of truth.

Retention is fixed, not configurable: settled results stay resumable for 7 days,
parked work (which may hold unintegrated changes) for 30 days. Expired records
are removed at load together with their artifacts. `subagent_stop` removes a
thread's record immediately. Startup also sweeps leaked temp directories whose
owning process is gone and state-root directories no record references, so
crashes between creation and the first checkpoint do not accumulate garbage.

## Results and live status

The active TUI widget shows standalone runs normally and projects each managed
workflow as a compact timeline plus its current internal child. Every row leads
with its stable run id — the handle for `subagent_control`, `subagent_status`,
and `subagent_stop`:

```text
◆ #12 worker workflow · src/cache.ts · wt:a91f3c              · 42s
  ✓ implement ─ ● review ─ ○ docs
  └ ● #15 reviewer · final review · claude-sonnet-4-5/high · 10s
      git diff
○ #23 worker · queued · redirect to ripgrep crates · 5m02s
```

Success is green, the active stage uses the accent color and bold text, pending
stages are dim, `REQUEST_CHANGES` is warning-colored, and process failure is an
error. Fix paths show their budget (`fix 1/2`, `re-review 1/2`). The timeline
contains only stages that ran or are currently planned; `DOCUMENTATION: CLEAN`
removes pending docs instead of pretending that stage ran.

Worktree-isolated runs carry a group badge on the row that owns the worktree:
`wt:<id>` while active, `wt:<id> applying` while the settled patch is being
applied to the original checkout, then `applied`/`clean`, or `retained` when
integration failed. The short id changes when a resumed generation creates a
continuation worktree, so a group boundary change is visible at a glance.
Nested stage rows inherit the group through the tree instead of repeating the
badge. Queued rows say `queued` and omit model/thinking — the route is
re-resolved when the run actually starts.

A managed root keeps its original top-level role and workflow-wide elapsed time,
but omits model/thinking because several model stages own it. The active nested
row shows the current role, relation, selected/fallback model, thinking, stage
elapsed, and activity. Completed internal rows can disappear while their stage
remains visible on the parent until the workflow settles. Standalone and
resume/retarget labels retain their existing semantics; narrow layouts
prioritize the current stage and elapsed tail. Adjacent workflows add no blank
separator rows.

A parked parent remains queryable. Final messages contain one managed-workflow
summary with aggregate token/cost totals and every internal id. Built-in roles
author their own result-only handoff—outcome, relevant paths, verification, and unresolved
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

Model changes apply immediately to work that has not started: a run still
waiting for a concurrency slot re-resolves its route when it actually starts,
and managed workflow stages (fix rounds, re-reviews, the conditional documenter)
re-read the config before each stage launches. Only an already-running child
keeps the model it started with.

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
- **Retained context:** model handoff, park/resume, retarget, and cross-reload
  restore build on the same session history instead of repeating discovery.
- **Visible failures:** process crashes, partial parallel starts, model failures,
  and Git integration failures are returned as failures rather than silent hangs.
- **Safe status text:** live tool activity is credential-redacted and stripped of
  terminal control characters.
- **No runaway trees:** child processes are leaves; they cannot dispatch more
  sub-agents.

## Configuration

The wizard covers enabled agents, per-agent models and thinking, and the idle
timeout:

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
| `idleTimeoutSec` | Seconds without RPC output before termination. `0` disables the watchdog. Default `90`. |

Invalid values fall back safely. Keys from older versions (including the former
`maxConcurrency` and `maxFixRounds` tuning options, now fixed at `4` concurrent
processes and `2` fix rounds) are dropped automatically and the normalized
shape is saved back. At session start, per-agent model overrides that Pi no
longer reports as available are removed with a one-time notice; those agents
fall back to the current main model until you re-pick them in
`/subagents-setup`.

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
