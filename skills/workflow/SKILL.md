---
name: workflow
description: Plan and run a multi-phase sub-agent job as a dependency graph with subagent_workflow — deciding when a graph is worth it, slicing phases, wiring dependsOn, writing briefs that survive their own placeholders, and reading the one summary it returns. Use for requests with several ordered phases (survey, parallel changes, then a gate), or when a saved graph under .pi/workflows/ should run by name.
---

# Planning multi-agent work as a workflow

`subagent_workflow` runs a graph of ordinary sub-agent phases. You declare the
nodes and their prerequisites once; the runtime starts each node the moment its
prerequisites settle, and wakes you once with a summary
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

Choose proactively from task structure; the user does not need to name the
tool. Use a graph for two or more substantial phases with known dependency
edges and write scopes when scheduling saves coordination. Independent phases
without edges use a parallel `subagent` batch. Honor an explicit user choice.

After a discovery phase, reassess the remaining work: use a graph if its plan
is now clear, or keep the next bounded step in main or a single child. A graph
schedules a fixed plan; it does not decide what a discovery result means or
change its nodes at runtime. Never add survey, implementation, review,
confirmation, and gate nodes merely to follow a template.

## 2. Shape

```ts
subagent_workflow({
  name: "auth-fix",
  description: "Fix the refresh race and inspect the implementation.",
  nodes: [
    { id: "map", agent: "scout", task: "Trace the refresh race in src/auth. Cite path:line and test coverage gaps." },
    { id: "fix", agent: "artisan", task: "Fix the race and add its regression tests. Evidence:\n{{map}}", dependsOn: ["map"],
      scope: { paths: ["src/auth", "test/auth.test.ts"] } },
    { id: "review", agent: "sentinel",
      task: "Inspect the implementation against the refresh contract and callers. Reuse completed checks; investigate concrete gaps and report confirmed defects. Do not edit files.\n{{fix}}",
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
- **Implementation review → claim verification.** A sentinel inspects the diff
  against requirements and callers. A skeptic tests only its named findings or a
  stated design assumption. Do not ask both for a general review. Reuse valid
  checks; add the second phase only when independent verification earns its cost.
  Both may run focused reproductions; scout cannot execute commands.
- **A closing gate.** Run the project's required checks on the integrated result
  in main or one closing node. Keep focused regression checks with the writer;
  reuse a completed full gate unless later edits, failures, or unresolved
  concerns invalidate it. A separate gate node must justify its own session.

Choose depth for the risk. Use sentinel for an implementation review, skeptic
for a named assumption or finding, and both only for distinct questions. Every
extra node should deliver new evidence. Keep a fix and its regression tests with
one owner.
A review request authorizes findings; apply fixes only when changes are also
authorized. Request focused confirmation when material uncertainty remains.

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
  stop unfinished graphs and runs without completion wake-ups. Escape records
  stopped ids for the next user turn; do not send another stop or automatically
  restart cancelled work. New/resume/fork tears down the old Pi runtime and
  retains interruption evidence.
- **Independent nodes start together.** There is no process-count limit or shared
  repository startup lock. Only dependencies delay ready work; final worktree
  integration into the original checkout remains serialized.

## 5. Briefs

A node has no access to your conversation. Its brief carries:

1. the outcome and the done condition,
2. the facts it needs, including upstream answers via placeholders,
3. the boundary (what not to touch, what not to decide),
4. the output you want back.

Include shared interface contracts or their file paths in every brief that needs
them; saying main already established a contract does not transmit it. A settled
run can still report a blocker: dependents must check prerequisite outputs, and
main checks done conditions before claiming success.

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
- External writer conflicts are rejected before any node starts. All pending
  nodes reserve their declared write scope, including while dependencies run.
  Main `edit`/`write` calls and other dispatches respect these reservations.
  Ordered nodes in the same graph may reuse a scope after their prerequisites
  settle. Arbitrary commands and undeclared writes are not sandboxed.
- Usually omit `isolation`. Implementation nodes use a detached Git worktree,
  initialized from the caller's current tracked and non-ignored untracked files.
  Reading and review stay in the caller's directory. Without a Git repository or
  committed HEAD, automatic isolation uses the current directory and reports why.
  An explicit `worktree` override requires isolation and never falls back.
  Each isolated snapshot is also the integration base, so nodes see integrated
  prerequisites before commit and only their own delta is applied on settlement.
- A stopped run retains phase and writer leases while its child or finalization
  can still change files, including after the stop call's bounded wait expires.

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

**Settled phases stay owned for the parent session; interrupted phases keep
ownership across reloads.** Derived phase ids are `<workflow-slug>.<node-id>`.
Re-running the same shape is rejected **before any node starts**, naming the
owning runs. For a successfully completed phase, use `subagent_message` to
continue the same deliverable with its retained context. Finish incomplete or
interrupted work in main from the retained evidence. Retire the owner with
`subagent_stop({ id })` only when intentionally discarding its retained session;
give a different deliverable its own brief and phase id. Renaming the graph does
not bypass exact task matching. A new session alone does not clear an interrupted
run's claim.

## 9. Cost

Every node is a full model session with its own context, and the summary carries
each node's answer. Budget accordingly:

- Give each phase one owner across main, subagent, and workflow, including
  pending nodes. Main continues only disjoint work. Pass completed main findings
  and checks into briefs; later nodes fill gaps instead of restarting research.
- Use sentinel for implementation defects or skeptic for a named claim. Add both
  only for distinct questions; reuse valid checks across every owner.
- Keep node answers short: conclusions, paths, `command → result`.
- Choose nodes from independent work; do not split one tightly coupled change
  across nodes just to increase concurrency.

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
- review (sentinel) completed · run #15 · 2m40s

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
