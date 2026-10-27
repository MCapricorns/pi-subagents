---
name: workflow
description: Plan and run a multi-phase sub-agent job as a dependency graph with subagent_workflow — deciding when a graph is worth it, slicing phases, wiring dependsOn, writing briefs that survive their own placeholders, and reading the one summary it returns. Use for requests with several ordered phases (survey, parallel changes, then a gate), or when a saved graph under .pi/workflows/ should run by name.
---

# Planning multi-agent work as a workflow

`subagent_workflow` runs a graph of ordinary sub-agent phases. You declare the
nodes and their prerequisites once; the runtime starts each node the moment its
prerequisites settle and a process slot frees, and wakes you once with a summary
of the whole graph. Nothing dispatches the next wave on your behalf except the
runtime.

Two things this changes about delegating: you stop paying a model turn between
waves, and the graph — not your attention — is what remembers which phase is
next. Two things it does not change: every node is still a one-shot leaf run
with its own context, and main still owns architecture, integration, the final
gate, and release.

## 1. Is a graph the right tool?

| The request | The tool |
| --- | --- |
| One thing, one owner | `subagent` (single) |
| A few independent lookups nobody reads before the end | `subagent` (`tasks`), in parallel |
| One phase whose result you will read before deciding the next step | `subagent`; decide in main |
| A small edit already understood in the current context | main, no child |
| Several phases with real ordering, and the ordering is known now | `subagent_workflow` |
| The same multi-phase job you will run again on another change | `subagent_workflow` with a saved definition |

A graph earns its cost when **the dependency structure is already known** and
**the phases are each substantial**. If you would have to look at phase one's
answer to know what phase two is, you cannot write the graph yet: run phase one
with `subagent` and write the graph afterwards. If every phase is a one-line
read, the graph is overhead — do it in main.

Use a graph when it fits the task, and honor an explicit user choice. A graph
schedules a fixed plan; it does not decide what a discovery result means. Main
keeps decisions that depend on that result.

## 2. Shape

```ts
subagent_workflow({
  name: "auth-fix",
  description: "Fix the refresh race and challenge the result.",
  nodes: [
    { id: "map", agent: "scout", task: "Trace the refresh race in src/auth. Cite path:line and test coverage gaps." },
    { id: "fix", agent: "artisan", task: "Fix the race and add its regression tests. Evidence:\n{{map}}", dependsOn: ["map"],
      scope: { paths: ["src/auth", "test/auth.test.ts"] } },
    { id: "review", agent: "artisan", isolation: "shared",
      task: "Try to disprove the fix: inspect callers and edge cases, then run the documented checks. Report evidence and unresolved risks; do not edit files.\n{{fix}}",
      dependsOn: ["fix"] },
  ],
});
```

- `id` — identifies the node in `dependsOn` and in placeholders. Unique per graph.
- `dependsOn` — start only after these complete. Omit for work that can begin now.
- `task` — the brief (section 5). Placeholders allowed only for nodes it waits for.
- `agent`, `scope`, `cwd`, `isolation`, `phaseId` — as for `subagent`.
- Or run a saved definition: `subagent_workflow({ workflow: "code-review" })` /
  `subagent_workflow({ file: ".pi/workflows/code-review.md" })`.

The call returns a launch receipt and the graph runs in the background. One
completion message arrives when it settles. Do not poll it.

## 3. Topology: fresh eyes, then deterministic proof

The shapes that are worth writing, in the order they usually appear:

- **Survey → act.** One read-only node establishes the facts; writers depend on it
  and quote it. Reuse established evidence and verify decisive or conflicting claims.
- **Fan-out with a join.** Independent slices of one plan run at the same time; a
  join node depends on all of them. Declare disjoint `scope.paths` per slice —
  the compiler rejects overlapping scopes between nodes with no dependency edge.
- **Adversarial review and confirmation.** Reviewers seek counterexamples;
  confirmation tries to disprove their findings against callers, invariants,
  and focused reproductions. Use different lenses for independent reviewers.
  Distinguish reproduced, source-supported, disproved, and unverified findings.
  Use artisan when commands are required; scout cannot execute a reproduction.
- **A closing gate.** The last node runs the project's own checks. Prefer
  commands over opinions: the repository's test suite, typecheck, build, or the
  verification line its README names. Ask for the strongest tier it has, not the
  fastest one.

Choose depth for the risk. A reviewer, independent confirmer, and synthesis
node are reasonable for a large or sensitive change; a focused review can
combine stages or leave synthesis to main. Every extra node should answer a
different question. Keep a fix and its regression tests with one owner.

## 4. What the runtime guarantees, and what it does not

- **Dependents start on settlement, not on wall-clock.** A node's result is
  registered only after its isolated worktree is integrated, so a dependent sees
  the files its prerequisite actually left behind.
- **Failure is contained.** A failed node blocks only its dependents. Independent
  branches keep running. The summary states completed, failed, and
  never-ran-with-why.
- **No retries, no resumption.** Nodes are one-shot. Main finishes incomplete
  work from the child's partial edits and retained artifacts; a different
  deliverable needs a new graph. This mirrors the one-shot rule for `subagent`.
- **A stopped graph stops cleanly.** `subagent_stop({ workflow: id })` prevents
  dependents from starting and cancels running nodes; the summary still reports
  what had completed.
- **An interrupted graph is explained, not resumed.** If the session ends
  mid-graph, the next session's start notice and `subagent_status({ workflow })`
  report which nodes completed and which were still running, with their run ids.
  Checkpoints are written during execution, so a process crash also leaves the
  graph shape.
- **Parent cancellation ends owned work.** Escape and conversation-tree navigation
  stop unfinished graphs and runs without completion wake-ups. New/resume/fork
  tears down the old Pi runtime and retains interruption evidence.
- **Capacity is pacing, not refusal.** The automatic process limit bounds simultaneous
  child processes; a wider graph queues and starts as slots free. Queue position
  never changes dependency order.

## 5. Briefs

A node has no access to your conversation. Its brief carries:

1. the outcome and the done condition,
2. the facts it needs, including upstream answers via placeholders,
3. the boundary (what not to touch, what not to decide),
4. the output you want back.

Write the brief the way you would brief a competent colleague who was not in the
meeting. Name paths and symbols; do not paste file contents — every node has its
own file tools, and a pasted file costs tokens it could have read.

Ask for failures, not approval. "Is this good?" gets a yes; "what would break
this, and what is missing?" gets findings. Say "do not edit any file" when a node
is only judging.

## 6. Placeholders

| Placeholder | Expands to |
| --- | --- |
| `{{id}}` | that node's final answer (bounded; long answers are clipped with a pointer) |
| `{{id.status}}` | `completed` / `failed` / `blocked` / `stopped` |
| `{{id.runId}}` | that node's run id, for follow-up inspection |
| `{{id.error}}` | the failure reason, or `(no error reported)` |

A placeholder may only name a node the current node waits for — directly or
through the chain. That rule is enforced at compile time, because reading a
sibling's answer would mean reading something that may not have run yet. If you
want two branches to read each other, they are not independent: join them first.

Keep results narrow. A node that returns a whole file makes every dependent pay
for it; a node that returns paths and conclusions does not.

## 7. Scope and isolation

`scope` is admission metadata, not access control. Declare the exact paths a
node expects to write:

- Two nodes with no dependency edge may not claim overlapping paths — the graph
  is rejected before anything starts. A dependency edge makes the overlap
  intentional (a fix, then its own test file).
- Externally, declared scopes are still checked against live runs at dispatch
  time, so a node that conflicts with unrelated work fails alone.
- Write-capable nodes default to a detached Git worktree in a graph, and their
  changes are integrated once, when the node settles. The checkout therefore
  always looks like the graph's completed work — which is exactly what the next
  node needs to read.

## 8. Saved definitions

- Project: `.pi/workflows/<name>.json` or `.pi/workflows/<name>.md`
- User: `~/.pi/agent/workflows/`
- Shipped templates: this package's `workflows/` directory (`code-review`,
  `research`, `migration`)

A Markdown definition carries prose plus one ```json fenced block with the plan
(or a bare node array); JSON carries the plan object. Project definitions load
only in a trusted project. Same-name precedence: project > user > builtin.
Explicit file paths also require project trust. A call-level `name` overrides a
saved graph's name. Customize unfilled question, target, and slice placeholders
in a copy of a shipped template before execution.

Save a graph when it will run again, when a reviewer should read the plan before
it runs, or when the phases are long enough that you want them in version
control. Run it by name; do not restate it inline.

**A phase stays owned after it settles, and across reloads.** Derived phase ids
are `<workflow-slug>.<node-id>`; an interrupted run keeps its claim until it is
retired. Re-running the same shape is therefore rejected **before any node
starts**, naming the owning runs. Three ways forward: retire the owner with
`subagent_stop({ id })` (destructive — it drops that run's retained session),
give a genuinely different deliverable its own brief and phase id. Renaming the
graph does not bypass exact task matching. Prefer reusing the owner's evidence
and finishing incomplete work in main. A new session alone does not help: a retained interrupted run is
restored with its claim intact.

## 9. Cost

Every node is a full model session with its own context, and the summary carries
each node's answer. Budget accordingly:

- Give each phase one owner. Add separate review, confirmation, and synthesis
  when their distinct work justifies the cost; combine them for bounded tasks.
- Keep node answers short: conclusions, paths, `command → result`.
- Do not add a node to fill a free process slot, and do not split one tightly
  coupled change across nodes.

## 10. Anti-patterns

| What you wrote | What it costs |
| --- | --- |
| A graph for a task with no real ordering | A model turn saved, two sessions wasted |
| A node whose brief re-derives what a scout already established | Paying twice for the same reading |
| `{{sibling}}` from a node that does not wait for it | Compile error; add the dependency or join first |
| Two writers with overlapping `scope` and no edge between them | The whole graph is rejected before any node starts |
| A reviewer asked "is this good?" | It approves; ask what would break it |
| A gate node asked to judge quality instead of running the tests | An opinion where an exit code would have decided |
| Retrying a failed node inside another node | Duplicate phase; main finishes the work instead |
| Twenty nodes over one small change | Twenty contexts, one deliverable |
| Reporting unverified findings as facts | The summary cannot tell "seen" from "suspected" |

## 11. Reading the summary

One completion message per graph:

```text
### workflow auth-fix completed (3/3 completed)
- map (scout) completed · run #12 · 1m02s
- fix (artisan) completed · run #13 · 4m11s
- review (artisan) completed · run #15 · 2m40s

Node answers:
#### map
…
Totals: 3 nodes · anthropic/claude-sonnet-4: ↓48.0k $0.8200
```

- Node answers are clipped here; the full report file is named when that happens.
- `failed` / `never ran (blocked)` lines say why, and each run keeps its own
  retained artifacts.
- Main then does what children cannot: inspect the integrated diff, run the gate
  if the graph's gate node could not, and report only checks that actually ran.
