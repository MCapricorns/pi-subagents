# pi-subagents

Sub-agents for [Pi](https://github.com/earendil-works/pi): research, implementation,
dependency workflows, and Git worktree isolation.

## Install

Requires **Pi >= 1.0.0** and **Node.js >= 22.19.0**.

```bash
pi install npm:@ferris1225/pi-subagents
```

Run `/subagents-setup` for a grouped role settings panel. Edit **Model** and
**Thinking** independently; **Reset role** restores that role's defaults. Each
selection saves immediately, Esc returns without applying a picker selection,
and the panel keeps your focus. Model pickers support search, paste, and paging.

Both roles follow the main model by default; thinking defaults to `low` for scout
and `high` for artisan. The panel distinguishes defaults from overrides and
shows the effective level when model capabilities clamp a preference. Changing
a model preserves the thinking preference. Settings live in
`~/.pi/agent/pi-subagents.json` as `agentModels` and `agentThinkingLevels`.

## Agents

| Agent | Use for | Access |
| --- | --- | --- |
| `scout` | Code, documentation, and web research with citations | Read-only tools; no commands or edits |
| `artisan` | Implementation with tests, or reviews and validation that need commands | Parent's tool surface, including codemode |

Children receive a self-contained brief and project instructions, but no parent
conversation. They cannot delegate or release. Main owns planning, integration,
and the final result. Keep a fix and its regression tests with one owner.

## Delegate

Pi chooses delegation from the task structure; no special request is required.
Small, familiar, or tightly coupled work stays in main. A child earns its cost
when substantial bounded work benefits from parallel progress, isolating noisy
research, or an independent check. Free process slots are not a team-size target.

Use one owner per deliverable, including its regression tests. Brief the child
with the outcome, done condition, relevant paths, established evidence, write
boundaries, required checks, and a compact expected result. Scout retrieves
sources; artisan can execute commands. This policy applies the context-isolation,
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
      agent: "artisan",
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
| `subagent_stop({ id: "12" })` | Stop a run and retire its retained session |
| `subagent_stop({ workflow: 3 })` | Stop a graph and finalize its active nodes |
| `subagent_stop({ all: true })` | Stop all active runs and graphs |

The widget is a compact task board capped at 10 lines: a status overview,
workflow progress groups, and task rows with status and elapsed time at the right.
Activity, model, thinking, token usage, and worktree state use secondary lines as
space permits. Task identities take priority over detail; failed and blocked
work takes priority over ordinary activity. Completed nodes collapse into graph
progress, and overflow reports hidden tasks. Queue reasons distinguish process
capacity, the repository write lane, and startup. Execution uses 4–6 process
slots; wider batches queue automatically.

Single writers use the shared checkout. Parallel writers and workflow writers
default to detached worktrees, which require a committed `HEAD`. Set
`isolation: "shared"` to use the checkout's serialized write lane. Declare exact
write paths or symbols in `scope` to detect conflicts. Worktrees isolate Git
changes, not tool permissions. Integration leaves your index untouched; failures
retain recovery artifacts.

Cancelling the parent run or navigating the conversation tree stops unfinished
work without completion wake-ups. New/resume/fork/reload ends old children and retains interrupted work
for manual recovery. Runs do not resume automatically; main finishes incomplete
work from partial changes and artifacts.

Children use Pi's native `--mode json` CLI, retries, and session persistence.
A settled provider failure can hand off once to the main model in the same
session. State and full-result files live under
`~/.pi/agent/ferris-pi-subagents/`, grouped by project. `PI_CODING_AGENT_DIR`
overrides the agent directory.

## Development

```bash
npm ci
npm run check
```

Pushing an unpublished package version to `main` triggers
[publishing and a GitHub Release](./.github/workflows/publish.yml).

[Changelog](./CHANGELOG.md) · [MIT license](./LICENSE)
