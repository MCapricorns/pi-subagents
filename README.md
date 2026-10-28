# pi-subagents

Sub-agents for [Pi](https://github.com/earendil-works/pi): research, implementation,
dependency workflows, and Git worktree isolation.

## Install

Requires **Pi >= 1.0.0** and **Node.js >= 22.19.0**.

```bash
pi install npm:@ferris1225/pi-subagents
```

Run `/subagents-setup` for a role grid: one row per role with **Model**,
**Thinking**, and **Reset** as columns. ↑/↓ moves between roles, ←/→ between
columns, and Enter edits the highlighted value. Headers align with their values,
and the footer names the focused role and field; **Thinking** selects reasoning
effort. Each selection saves immediately;
Esc returns without applying a picker selection, and the grid keeps the focused
cell. Model pickers support search, paste, and paging.

All roles follow the main model by default; thinking defaults to `low` for scout
and `high` for artisan, sentinel, and skeptic. The panel distinguishes defaults from overrides and
shows the effective level when model capabilities clamp a preference. Changing
a model preserves the thinking preference. Settings live in
`~/.pi/agent/pi-subagents.json` as `agentModels` and `agentThinkingLevels`.

## Agents

| Agent | Use for | Access |
| --- | --- | --- |
| `scout` | Code, documentation, and web research with citations | Read-only tools; no commands or edits |
| `artisan` | Implementation and fixes with tests and checks | Parent's tool surface, including codemode |
| `sentinel` | Inspect an implementation or diff against requirements and callers | Parent's tool surface; instructed not to edit |
| `skeptic` | Test a named claim, assumption, or review finding with counterexamples | Parent's tool surface; instructed not to edit |

The main model chooses from these role descriptions; names alone do not route a
task. Use `sentinel` for "inspect this diff" and `skeptic` for "does this claim
hold?" Default to one review role. Both are justified only by distinct questions, such as
reviewing an implementation and then testing its specific findings. A skeptic
without a named claim reports the gap and stops instead of starting another review.

Sentinel and skeptic may run focused checks, so their no-edit boundary is an
instruction, not a tool-enforced restriction. Change reviews focus on introduced
defects; a wider audit needs an explicit brief. All roles reuse existing facts
and valid checks, filling gaps rather than repeating main or upstream work.

Only `scout`, `artisan`, `sentinel`, and `skeptic` are valid runtime role names.
Existing model/thinking settings and interrupted run records migrate on load
and are saved with the new names. Explicit valid settings under the new names
win. A selected trusted saved workflow is migrated on disk before compilation;
its briefs, node ids, and dependency edges are preserved. Discovery remains
read-only. New tool calls and inline graphs using retired names are rejected.

Children receive a self-contained brief and project instructions, but no parent
conversation. They cannot delegate or release. Main owns planning, integration,
and the final result. Keep a fix and its regression tests with one owner.

## Delegate

Pi proactively looks for useful bounded phases to delegate; no special request
is required. Focused ownership, isolated context, parallel progress, and an
independent check can each justify a child. A substantial self-contained fix can
go to one artisan together with its regression tests, even when there is nothing
to parallelize. Quick source checks and small understood edits stay in main.
Choose team size from independent work. Explicit requests to work in main or
avoid subagents take precedence.

Use one owner per deliverable, including its regression tests. Brief the child
with the outcome, done condition, relevant paths, established evidence, write
boundaries, required checks, and a compact expected result. Scout retrieves
sources; artisan implements, while sentinel and skeptic can execute focused checks. This policy applies the context-isolation,
focused-role, and coordination-cost guidance in the official
[Codex subagents](https://developers.openai.com/codex/subagents) and
[Claude Code subagents](https://code.claude.com/docs/en/sub-agents) docs to Pi's
one-shot leaf runs.

A review request produces findings. Main applies fixes when changes are
authorized and requests focused confirmation only when material uncertainty
remains. Before reporting success, main checks each done condition and any
blockers in the child's answer as well as the integrated diff.

Ask Pi to delegate explicitly, or call the tools directly:

```ts
subagent({
  agent: "artisan",
  phaseId: "cache-fix",
  task: "Fix cache invalidation in src/cache, add regression tests, and run the checks.",
  scope: { paths: ["src/cache", "test/cache.test.ts"] },
});
```

Independent tasks can run together:

```ts
subagent({
  tasks: [
    {
      agent: "artisan",
      phaseId: "config-fix",
      task: "Fix config validation and its regression tests.",
      scope: { paths: ["src/config.ts", "test/config.test.ts"] },
    },
    {
      agent: "artisan",
      phaseId: "provider-docs",
      task: "Update docs/providers.md from the established API citations.",
      scope: { paths: ["docs/providers.md"] },
    },
  ],
});
```

Results arrive automatically. Set `wait: true` to return them in the tool call,
including in one-shot `pi -p` sessions. Use stable `phaseId` values: completed
phases stay owned for the parent session, and interrupted phases retain ownership
across reloads. Repeating the same task in the same cwd is also rejected.

Ownership includes main, individual runs, and workflow nodes still waiting on
dependencies. Main continues only disjoint work and passes its completed research
and checks into the child brief. Pending graph nodes reserve their declared write
scopes; external conflicts reject a batch or graph before any child starts.
Main `edit`/`write` calls, including nested calls through `codemode`, are blocked
on those scopes. In-flight main writes also prevent conflicting dispatches.
Stopped writers keep their claims until execution and integration finish.

These checks use declared phase identity and exact paths/symbols. Main file writes
conservatively conflict with any claimed symbol in that file. Omitted scopes,
arbitrary shell/custom-tool effects, symlink aliases, and differently worded work
without a shared phase id cannot be inferred reliably; this is coordination,
not a sandbox or semantic duplicate detector. Use `subagent_status` to inspect
phase/scope ownership; an exact run id also retrieves its retained result for reuse.

## Workflows

Main proactively chooses `subagent_workflow` for two or more substantial phases
with known dependencies and write scopes when scheduling them saves coordination.
Independent phases without dependency edges use `subagent` with `tasks`; a single
justified phase uses one `subagent` run. Small work stays in main.

If a research result must determine the next task or its scope, run that phase
first, decide in main, then reassess whether the remaining work fits a graph.
A workflow runs a fixed plan; it does not discover the plan or adapt its nodes
while running. Research, implementation, review, and confirmation are added only
when the task needs their distinct work.

```ts
subagent_workflow({
  name: "auth-fix",
  nodes: [
    {
      id: "fix",
      agent: "artisan",
      task: "Fix the refresh race in src/auth and add regression tests. Run the relevant checks.",
      scope: { paths: ["src/auth", "test/auth.test.ts"] },
    },
    {
      id: "review",
      agent: "sentinel",
      dependsOn: ["fix"],
      task: "Inspect the implementation against the refresh contract and callers. Reuse valid checks and investigate concrete gaps. Do not edit files.\n{{fix}}",
    },
  ],
});
```

`dependsOn` starts a node after its prerequisites complete and integrate.
`{{id}}` inserts an upstream answer; `.status`, `.runId`, and `.error` expose its
facts. Long answers include a full-result file. A failed node blocks its
dependents; independent branches continue. The graph delivers one summary.

Reviews inspect implementations; claim verification tests named findings or
assumptions. Add independent verification only when its distinct work earns the cost.

Saved definitions use JSON or Markdown with a `json` fenced block:

```ts
subagent_workflow({ workflow: "code-review" });
subagent_workflow({ file: ".pi/workflows/code-review.md" });
```

Definitions load from `.pi/workflows/`, `~/.pi/agent/workflows/`, and the shipped
[templates](./workflows), in that order of precedence. Project definitions and
explicit file paths require project trust. Customize template questions, targets,
and scopes before running them. The `code-review` template has two nodes:
sentinel reviews the target, then skeptic verifies only the reported claims and
returns the final review. An ordinary review uses one sentinel. The `migration`
template passes the shared interface contract to every slice and declares the
closing gate's write scope. Run the full integrated gate once in main or a closing
node, and repeat it when later edits or unresolved failures warrant it.

See the [workflow skill](./skills/workflow/SKILL.md) for graph authoring details.

## Status, cancellation, and recovery

| Tool | Use |
| --- | --- |
| `subagent_status({ id: 12 })` | Inspect a run's progress, result, and recovery paths |
| `subagent_status({ workflow: 3 })` | Inspect graph nodes and dependencies |
| `subagent_message({ id: 12, message: "Check the caller too" })` | Steer a running child, or start a follow-up from its completed session |
| `subagent_message({ id: 12, message: "Add the test", context: "summary" })` | Start a new next step with only a bounded summary of the earlier run |
| `subagent_stop({ id: "12" })` | Stop a run and retire its retained session |
| `subagent_stop({ workflow: 3 })` | Stop a graph and finalize its active nodes |
| `subagent_stop({ all: true })` | Stop all active runs and graphs |

The widget is a compact task board capped at 10 lines: a status overview,
workflow progress groups, and task rows with status and elapsed time at the right.
Activity, model, thinking, token usage, and worktree state use secondary lines as
space permits. Task identities take priority over detail; failed and blocked
work takes priority over ordinary activity. Completed nodes collapse into graph
progress while their workflow is running. Successfully completed workflows hide
automatically, while failed or blocked work stays visible until the next dispatch.
Completion messages and status lookups retain the results. Overflow reports
hidden tasks. Runs preparing their child process show `starting`. There is no
process-count limit or shared-checkout startup
lock: independent runs start together, including separate dispatch calls while
another call awaits results.

Usually omit `isolation`: implementation tasks use detached Git worktrees in
single calls, parallel batches, and workflows. Reading and review use the current
directory. Without a Git repository or committed `HEAD`, automatic isolation uses
the caller's directory and reports why. Unexpected setup or integration failures
remain failures; an explicit `isolation: "worktree"` requires isolation and never
falls back. `isolation: "shared"` is an advanced override for tasks that need to
write directly in the caller's checkout.

Each worktree starts from the caller's current tracked files and non-ignored
untracked files, including uncommitted changes. Its initial snapshot is also the
integration base, so dependent tasks see earlier results without reapplying them.
The caller's index, branch, and `HEAD` stay unchanged. Declare exact write paths
or symbols in `scope` to detect conflicts. Worktrees isolate Git changes, not
tool permissions. Independent tasks start together; only the final application
of worktree changes to the original checkout is serialized. Integration leaves
your index untouched, and failures retain recovery artifacts.

Cancelling the parent run with Escape stops unfinished work without waking the
parent. A cancellation receipt is supplied on the next user turn with the stopped
run and workflow ids, so main knows no additional `subagent_stop` is needed.
Cancelled work must not restart automatically. A stopped run keeps its phase
and declared writer leases until its child and Git finalization quiesce, even if
the stop call reaches its wait deadline. Conversation-tree navigation also
stops unfinished work. New/resume/fork/reload ends old children and retains interrupted work
for manual recovery. Runs do not resume automatically; main finishes incomplete
work from partial changes and artifacts.

A steering message is queued at the next Pi steering boundary; acknowledgement
does not mean the child has acted on it. To continue a successfully completed
run, choose the context that fits the follow-up:

- `context: "session"` (default) for rework — revising, fixing or extending the
  same deliverable. It continues a private copy of the retained session, so the
  earlier reasoning stays available and the provider prompt-cache key
  (`sessionId`) is unchanged.
- `context: "summary"` for a new next step — the new run never sees the old
  transcript and is briefed with the objective, the final result and the files
  the run touched. Cheaper, no cache reuse, and it cannot rely on detail the
  summary omits.

Both start a new run with the role, workspace and scope preserved. Queueing,
admission and isolation still apply. Pending runs cannot be steered, and fixed
workflow graphs cannot be edited.

Children use Pi's native `--mode rpc` CLI with piped input/output, retries, and
session persistence. On Windows, console hiding covers the Pi child and Node
process launches made by its tools and extensions, including `pi.exec`, `pwsh`,
and `powershell`. The child preloads this policy before Pi starts and passes it
to Node descendants through `NODE_OPTIONS`, preserving existing options. An
explicit child extension installs the same policy for runtimes without Node
preloading. Windows launches stay attached so detachment cannot open a console.
On macOS and Linux, the policy leaves shell options unchanged; the Pi child uses
a separate process group for cancellation and does not launch a terminal app.
RPC communication and process-tree cancellation remain active. Commands that
explicitly open a terminal or GUI control their own windows.
A settled provider failure can hand off once to the main model in the same
session. State and full-result files live under
`~/.pi/agent/ferris-pi-subagents/`, grouped by project. `PI_CODING_AGENT_DIR`
overrides the agent directory.

## Storage and cleanup

Each project root holds `sessions/`, `worktrees/`, `tmp/` and `results/`. Startup
hygiene already drops temp leftovers, artifacts whose Pi process is gone, result
files past their retention window, and project roots idle for three days. Parked
recovery work and anything a manifest still references always survive.

Reclamation is automatic: a settlement may trigger one paced sweep (at most every
five minutes) that drops dead-owner artifacts, expired result files, and settled
session copies older than 30 minutes, then trims the oldest settled sessions
until a project fits its 1.5 GB budget. Live runs, parked recovery work, recent
sessions, and anything a manifest references are never touched, so rework within
the last half hour can still continue its session.

`/subagents-cleanup` runs the same pass immediately and reports per-project usage
and freed bytes; `/subagents-cleanup dry-run` measures without deleting anything.

## Development

```bash
npm ci
npm run check
```

Pushing an unpublished package version to `main` runs the checks on Windows,
macOS, and Linux before triggering
[publishing and a GitHub Release](./.github/workflows/publish.yml).

[Changelog](./CHANGELOG.md) · [MIT license](./LICENSE)
