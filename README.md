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
and `high` for artisan, reviewer, and critic. The panel distinguishes defaults from overrides and
shows the effective level when model capabilities clamp a preference. Changing
a model preserves the thinking preference. Settings live in
`~/.pi/agent/pi-subagents.json` as `agentModels` and `agentThinkingLevels`.

## Agents

| Agent | Use for | Access |
| --- | --- | --- |
| `scout` | Code, documentation, and web research with citations | Read-only tools; no commands or edits |
| `artisan` | Implementation and fixes with tests and checks | Parent's tool surface, including codemode |
| `reviewer` | Code review for correctness and regressions | Parent's tool surface; instructed not to edit |
| `critic` | Adversarial review of changes or findings | Parent's tool surface; instructed not to edit |

Reviewer and critic may run checks, so their no-edit boundary is an instruction,
not a tool-enforced restriction. Configure each role independently.

Children receive a self-contained brief and project instructions, but no parent
conversation. They cannot delegate or release. Main owns planning, integration,
and the final result. Keep a fix and its regression tests with one owner.

## Delegate

Pi chooses delegation from the task structure; no special request is required.
Small, familiar, or tightly coupled work stays in main. A child earns its cost
when substantial bounded work benefits from parallel progress, isolating noisy
research, or an independent check. Choose team size from independent work.
Explicit requests to work in main or avoid subagents take precedence.

Use one owner per deliverable, including its regression tests. Brief the child
with the outcome, done condition, relevant paths, established evidence, write
boundaries, required checks, and a compact expected result. Scout retrieves
sources; artisan implements, while reviewer and critic can execute checks. This policy applies the context-isolation,
focused-role, and coordination-cost guidance in the official
[Codex subagents](https://developers.openai.com/codex/subagents) and
[Claude Code subagents](https://code.claude.com/docs/en/sub-agents) docs to Pi's
one-shot leaf runs.

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
      agent: "critic",
      isolation: "shared",
      dependsOn: ["fix"],
      task: "Try to disprove this fix: inspect callers and edge cases, then run focused checks. Do not edit files.\n{{fix}}",
    },
  ],
});
```

`dependsOn` starts a node after its prerequisites complete and integrate.
`{{id}}` inserts an upstream answer; `.status`, `.runId`, and `.error` expose its
facts. Long answers include a full-result file. A failed node blocks its
dependents; independent branches continue. The graph delivers one summary.

Reviews seek counterexamples and try to disprove findings. Add independent
confirmation and synthesis when risk warrants them; combine stages for small tasks.

Saved definitions use JSON or Markdown with a `json` fenced block:

```ts
subagent_workflow({ workflow: "code-review" });
subagent_workflow({ file: ".pi/workflows/code-review.md" });
```

Definitions load from `.pi/workflows/`, `~/.pi/agent/workflows/`, and the shipped
[templates](./workflows), in that order of precedence. Project definitions and
explicit file paths require project trust. Customize template questions, targets,
and scopes before running them.

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
progress, and overflow reports hidden tasks. Runs preparing their child process
show `starting`. There is no process-count limit or shared-checkout startup
lock: independent runs start together, including separate dispatch calls while
another call awaits results.

Single writers use the shared checkout. Parallel writers and workflow writers
default to detached worktrees, which require a committed `HEAD`. Set
`isolation: "shared"` to run directly in the checkout without a repository-wide
launch lock. Declare exact write paths or symbols in `scope` to detect conflicts.
Duplicate phases and declared writer overlaps are still rejected. Worktrees
isolate Git changes, not tool permissions. Only final worktree integration into
the original checkout is serialized; it leaves your index untouched, and failures
retain recovery artifacts.

Cancelling the parent run with Escape stops unfinished work without waking the
parent. A cancellation receipt is supplied on the next user turn with the stopped
run and workflow ids, so main knows no additional `subagent_stop` is needed.
Cancelled work must not restart automatically. Conversation-tree navigation also
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

Children use Pi's native `--mode rpc` CLI, retries, and session persistence.
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

Pushing an unpublished package version to `main` triggers
[publishing and a GitHub Release](./.github/workflows/publish.yml).

[Changelog](./CHANGELOG.md) · [MIT license](./LICENSE)
