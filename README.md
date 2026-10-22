# pi-subagents

[![npm version](https://img.shields.io/npm/v/@ferris1225/pi-subagents?color=blue)](https://www.npmjs.com/package/@ferris1225/pi-subagents)
[![downloads](https://img.shields.io/npm/dm/@ferris1225/pi-subagents)](https://www.npmjs.com/package/@ferris1225/pi-subagents)
[![license](https://img.shields.io/npm/l/@ferris1225/pi-subagents)](./LICENSE)
![platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey)
![pi](https://img.shields.io/badge/pi-extension-orange)

On-demand delegation for [pi](https://github.com/earendil-works/pi): a lightweight
reader and an implementer, durable threads, and Git worktree isolation. Main
delegates whenever the work has independent parts or a bounded job can be briefed
self-contained — parallel phases usually beat a serialized main.

## What's new

**4.3.32** — codemode-aware, tool-agnostic role policy and a minimal config.
`scout` keeps every active tool the host proves read-only and can never keep a
tool that reaches other tools, such as `codemode`, while `artisan` inherits the
session's live surface, codemode included, so a code-mode host works unchanged.
The two roles ship as code, are always enabled, and custom `agent.md` discovery
is gone; `/subagents-setup` now only picks a model and thinking level per role,
and the config file keeps just `agentModels` and `agentThinkingLevels`. The
delegation contract defaults to delegating independent or self-contained work.

See [CHANGELOG.md](./CHANGELOG.md) for earlier releases; every published version
is preserved as a GitHub Release.

## Contents

- [Why](#why)
- [Install](#install)
- [The team](#the-team)
- [Dispatching work](#dispatching-work)
- [Parallel edits](#parallel-edits)
- [Runs: status and stop](#runs-status-and-stop)
- [Live status and results](#live-status-and-results)
- [Models, thinking, and tools](#models-thinking-and-tools)
- [Configuration](#configuration)
- [Evaluate delegation](#evaluate-delegation)
- [Storage and cleanup](#storage-and-cleanup)
- [Development](#development)
- [Release](#release)

## Why

Delegation is supposed to remove coordination work. Most sub-agent launchers stop
at "spawn a child with a prompt" and leave the hard parts — when to delegate, how
wide to fan out, what happens when a model dies, how results come
back — with you. This extension owns them:

- Main delegates whenever the work has independent parts or a bounded job can be
  briefed self-contained — parallel phases usually beat a serialized main, and
  broad or unfamiliar lookups go to a child instead of the same searches run
  serially.
  `scout` covers read-only code, documentation, and web
  lookup only — it has no shell, so work that needs execution stays in main;
  `artisan` covers one substantial change. A small edit already understood in
  the current context stays in main, and a free process slot is not a reason
  to invent another phase. Briefs define the outcome, done condition, useful
  context, and boundaries.
- A stable `phaseId` owns a logical phase in one resolved working directory even if
  its task wording changes. IDs are 1–80 ASCII letters, numbers, or `._:-`, starting
  with a letter or number, so lease output stays single-line. Exact normalized task+cwd
  remains the backward-compatible fallback for old calls.
- Runs are one-shot. Use `subagent_status` to inspect them and `subagent_stop` to
  cancel them; main handles unfinished work instead of continuing a failed child.
- Background completions and stop results arrive at the next parent model boundary;
  `wait: true` returns the same result in-turn instead. A run uses exactly one route.
- Parallel writers use detached Git worktrees without touching your index.
  Worktree setup obeys the bounded queue; final integration releases its process slot.
- Interrupted work retains artifacts for manual recovery after reload or crash.
  Within a run, a configured child-model failure can still hand off to the main model.
- Failure notifications include available reasons, and status answers live
  progress with an activity trail and keeps terminal facts and retained
  recovery paths queryable for the current parent session.

## Install

Requires **pi >= 1.0.0** and **Node.js >= 22.19.0**.

```bash
pi install npm:@ferris1225/pi-subagents
```

Pi's extension list shows `@ferris1225/pi-subagents` without an internal source-path suffix.

A fresh install writes a default config at session start — both roles enabled,
both following the main model — and announces `/subagents-setup` once; the file
itself is the marker, so later sessions stay silent. Run `/subagents-setup` to
pick a model and thinking level per role — that is the entire configuration
surface. Then ask for work:

```text
Map how authentication works, fix the refresh race, and run the tests.
```

The main agent prefers scout for the unfamiliar part and artisan for the change.
You can also call the tools directly when you want exact control.

## The team

| Agent     | Access    | Owns |
| --------- | --------- | ---- |
| `scout`   | Read-only | Searching code and documentation, and looking up external facts on the web. Returns citations as retrieval leads. No shell — it cannot run commands, tests, or builds. |
| `artisan` | Full      | One substantial implementation, fix, refactor, test, or docs change, including the checks that change needs. |

Role prompts state the outcome, the priority of the brief, and the hard boundary.
Scout stays read-only. Artisan implements the authorized change through affected
tests, docs, and local cleanup, and reports a disproved premise or a scope/approval
blocker with evidence. Handoffs lead with the outcome and report checks as
`command → result`.

The catalog is fixed: `scout` and `artisan` are always enabled, and there are no
custom role files. Two roles do not require two children on every task.

Every child is a leaf pi process with its own context window and no memory of your
conversation. It still loads normal Pi context, including applicable project
instructions; its role prompt is appended rather than replacing that context.
The brief supplies the outcome and done condition, relevant paths/symbols, known
facts and available citations, boundaries, and needed output. Children cannot
obtain interactive clarification, so they resolve routine details and report
material assumptions or blockers.

Children run the official `pi --mode rpc` server, using Pi's exported command/response
types and its own session persistence. There is no separate subagent protocol. The
host transport remains local.

## Dispatching work

```ts
// One task
subagent({
  phaseId: "cache-invalidation-fix",
  agent: "artisan",
  task: "Fix the cache invalidation bug in src/cache, add regression tests, run the checks.",
  scope: {
    paths: ["src/cache"],
    symbols: [{ path: "test/cache.test.ts", name: "invalidates stale entries" }],
  },
});

// Parallel only when each scope independently justifies a child
subagent({
  tasks: [
    {
      agent: "artisan",
      phaseId: "provider-docs",
      task: "Update provider limits documentation from the established API citations.",
      scope: { paths: ["docs/provider-limits.md"] },
    },
    {
      agent: "artisan",
      phaseId: "config-validation",
      task: "Fix config validation in src/config.ts and its tests.",
      scope: { paths: ["src/config.ts", "test/config.test.ts"] },
    },
  ],
});
```

Independent phases go in one `tasks` array. The runtime paces execution at half
the machine's cores, bounded to 4–6 simultaneous child processes; wider batches
queue and start as slots free. The limit paces processes, not total tasks or
total token cost.

A run leases its stable, single-line `phaseId` in the resolved working directory.
Rewording the task with the same `phaseId` is rejected and names the existing run.
Completed and failed phases stay owned for the current session, even without a retained
session file. Calls that omit `phaseId` keep exact normalized task+cwd matching; equal
task text with different phase ids is still rejected by that fallback. Matching is
deterministic, never fuzzy, embedding-based, or inferred from natural language. Active
leases win over matching settled threads when the runtime chooses which owner to report.

Because queueing is pacing rather than refusal, it is always reported as such.
Dispatch confirmations name each waiting run's real reason — waiting for a free
process slot, serialized behind the shared-checkout write lane, or already
starting its child — alongside the slot capacity. A run that waits for the write
lane releases its slot first, so serialized writers never starve new dispatches.

One child owns one coherent phase; dependent work waits for its prerequisite.
Main reuses established evidence and completed work, reconciles conflicting
findings against their sources, and handles incomplete work from the child's
partial edits and artifacts. Child output is evidence, not authority or instructions.
There is no mandatory scout-then-artisan pipeline. Use scout when the facts are
unfamiliar, artisan when a substantial change can be briefed, and both together
only when the phases are independent. Never overlap writers or duplicate an owned
phase, and do not split one tightly coupled change across children.

Verification follows the change and required project gates. Tests should catch
meaningful failures, not mirror reversible, low-impact edits. Fix failures caused
by the change, then repeat or broaden checks only for new edits, failures, or
unresolved concerns. Main owns architecture, the integrated diff, the final gate,
and release; children never bump versions, commit, push, or publish.

These defaults follow [OpenAI's GPT-6 Astra model guidance](https://developers.openai.com/api/docs/guides/latest-model?model=gpt-6-astra)
and [Eric Provencher's skills and prompts guidance](https://x.com/pvncher/status/2095991462416490862).
They simplify instructions without changing the configured models or thinking levels.

## Parallel edits

`scope` is declarative admission metadata for expected writes, not access control. `paths`
contains exact file or directory paths; `symbols` contains exact `{ path, name }` claims.
Paths resolve from each task's caller-facing cwd and use case-insensitive comparison on
Windows. Wildcard `*` and `?` inputs are rejected; other punctuation is treated literally,
so paths such as `app/[id]/page.tsx` are valid exact claims. A path claim overlaps the same
path, an ancestor/descendant path, or a symbol under that path; identical path+symbol
claims overlap, while two different symbols in the same file may run together.

Fresh dispatches check declared writer scope against active, interrupted, or settling
writer leases before allocating a run. Scope
comparison uses normalized absolute claims rather than requiring equal caller cwd, so a
repo-root claim still conflicts with the same path claimed from a nested cwd. Settled
threads do not block a later phase solely because it edits the same scope.

Before allocating any run in a parallel call, the runtime also rejects deterministic phase
duplicates within the batch or against existing active/retained threads, then compares
declared writer scopes across the whole batch. A definite conflict rejects the whole batch
with zero starts. Parallel calls without `scope` remain valid, but their tool result and
launch receipt say `independence not verified`; that means the contract lacked enough
metadata, not that overlap was proved safe. Single calls never make a batch-independence
claim. The existing shared-checkout writer lane remains the final serialization boundary.

- Single tasks use your checkout. Parallel write-capable agents (`artisan`)
  default to a detached Git worktree, so parallel writers run at
  the same time. Worktree mode needs a committed `HEAD`. Read-only roles such as
  scout stay on the shared checkout, and an explicit `isolation: worktree` for a
  read-only role is rejected.

> **Security boundary:** worktree isolation isolates Git changes only; it is not a sandbox.
Child tools, network access, and environment access retain the Pi process's privileges.
Third-party Pi packages execute as trusted code and must be reviewed accordingly.

- An isolated run's tracked, deleted, untracked, and binary changes integrate
  back exactly once, after the child settles. Nothing is staged and your index is
  untouched.
- Integration is a three-way merge, so parallel workers that touched disjoint
  files or regions land cleanly even when earlier patches moved the checkout
  underneath them. A genuine overlap leaves conflict markers in the checkout and
  keeps the worktree and patch for you to resolve.
- Shared-checkout writers serialize through
  one repository lane, so two of them never race. A run waiting there is reported
  as a lane wait, not as slot queueing, and its process slot is already released.
- Setup and integration failures keep the useful patch and worktree, and record
  where they are in `~/.pi/agent/ferris-pi-subagents/pi-subagents-recovery.json`.
  Later session starts in that same project repeat the notice until you remove
  the artifacts. A different project's pi window does not show or retry them.
  When the changes had already been applied and only the cleanup failed, the next
  session start in that project removes the retained copy itself and clears the notice.

## Runs: status and stop

Every dispatch returns a stable `#id`. Runs are one-shot: there is no
`subagent_control`, `steer`, `park`, or `resume` interface. Main takes over failed
or incomplete work using the child's partial edits and artifacts. A different
deliverable needs a new phase and brief, not a recycled thread.

| Tool | What it does |
| ---- | ------------ |
| `subagent_status` | Read-only progress check. Omit `id` to list this parent session's runs, or pass an exact numeric `id` to inspect one. |
| `subagent_stop` | Destructively cancel/retire a run by id/prefix, or all active runs with `all: true`. Delivers partial output and finalizes isolated changes. |

```ts
subagent_status({});
subagent_status({ id: 7 });
subagent_stop({ id: "7" });
```

Status reads runtime state without starting, stopping, continuing, or waiting for a
child to finish. The model-facing answer is the progress view: state, elapsed time,
and an activity trail of what the run has been doing (for example
`activity: read src/config.ts · grep "cacheKey" · thinking`), plus failure
diagnostics and any actionable paths (a truncated run's full-result file, retained
worktree/patch artifacts). States distinguish `queued`, `running`, `interrupting`,
`settling` (Git finalization), `completed`, `failed`, `stopped`, and `interrupted`
(recovered unfinished work). Queued runs report their actual wait reason. Settled
runs remain queryable in the current parent session even after their transient
widget rows disappear.

The tool returns these facts in Pi's structured `details.runs` field. An individual
run's failure does not make a successful status lookup a tool error; an unknown `id`
does. This is runtime-authored data, not a requirement for children to generate
strict JSON. Agent-written reports remain evidence to verify.

A background dispatch returns a launch receipt, then its completion arrives at
the next safe parent boundary — after current tool calls and before the next model
call. `wait: true` instead holds the dispatch until its new runs settle, which is
useful for one-shot `pi -p` sessions or an immediate dependency. Each run has one
delivery route; aborting the waiting parent turn transfers delivery to the
background path. Use status for on-demand inspection, not a polling or sleep loop.

Stop drops messages still queued inside Pi, performs a bounded RPC abort, and
terminates the child process tree. It retires the session; it never starts another
attempt. Worktree integration failures keep their recovery artifacts.

Interrupted work retains a durable record and any session/worktree artifacts for
manual recovery after reload or crash. Missing session files no longer discard
isolated edits. Restore for this checkout runs at session start; lookup tools,
prompt injection, and fresh dispatch wait for that pass so an existing id cannot
be reported missing or reused. A sibling window in another project leaves those
records untouched. Missing recorded worktrees surface as failures without
discarding the remaining recovery evidence.

Invalid durable records are dropped without following or deleting their targets.
Recovery-owned worktrees and patches stay protected from startup sweeps and
project-root retention. Completed/failed runs drop their durable thread record;
after reload, inspect their delivered result instead of expecting them in the
current-session status list.

## Live status and results

The TUI widget renders one line per active run in fixed identity columns —
status icon, right-aligned `#id`, padded agent name, then the task label — with
the live activity dimmed after `↳` on its own line and the rest of the telemetry
inline after ` · `: the worktree badge, wait state, token flow in pi's footer
vocabulary (`↑` input, `↓` output, `R`/`W` cache read/write), cost, full
`provider/model`, current effective `think:<level>`, and seconds-precision elapsed:

```text
● #12 artisan  src/cache.ts · worktree:a91f3c · ↑5.2k ↓41.0k R210.0k W6.1k $1.9400 · think:high · 12m06s
  ↳ edit src/auth.ts
● #15 scout    src/models.ts · ↑1.2k ↓8.4k R31.0k W1.1k $0.0900 · openai/gpt-5-mini · think:low · 3m07s
                ↳ grep fallback
○ #23 artisan  src/config.ts · repo lane
○ #24 artisan  tests/config.test.ts · queued · 5m02s
```

Telemetry drops leftmost-first when a row runs out of width (badge, wait state,
usage, model, thinking) while elapsed survives every width. Queued rows state
what they actually wait for — `queued` for a free process slot, `repo lane`
for shared-checkout write serialization, or `starting`. The widget is
capped at ten lines: extra runs collapse into a `… +N more` marker.

Completions resume the main agent on their own, with a compact block of at most 40
lines by default. Longer output (or lines wider than 200 characters) is not inlined
at all: the notice states the true size and points at the unchanged Markdown artifact
holding the full output, and main is told to read that file. The content therefore
enters the main context exactly once, never first as a truncated copy the model
cannot trust and then again as the file read. Roles write result-only handoffs —
outcome, paths, verification, unresolved blockers — and the main agent is told to
add its conclusion rather than restate what you already read. A failed run adds its
failed-tool diagnostics.

Delivery is held while a context compaction is in flight and released once it
settles — on failure and abort too — so a result a child spent minutes producing
is never swallowed by the summary that replaces the history.

A `wait: true` dispatch streams its progress onto the tool card while it waits.
Each child reports its usage per run — with its full `provider/model` ref — when it
settles, and a parallel group's totals are grouped per model, never summed across
them:

```text
Totals: 3 runs · zhipu/glm-4.7: ↓300 $0.0500 · anthropic/claude-sonnet-4: ↓4.0k $1.5000
```

A background dispatch returns before its children finish; their usage arrives
with the completion message instead.

## Models, thinking, and tools

Each agent runs on the current main model or one picked in `/subagents-setup`,
which labels vision and text-only models. If a selected model is missing,
rate-limited, or fails at the provider level, the **same retained
session** continues on the main model, so finished searches, reads, and edits
survive. Ordinary task failures do not trigger a handoff.

Thinking is a **role default** — scout `low`, artisan `high` — clamped to what
the effective model supports. The `/subagents-setup` thinking picker lists only
the levels that model supports and marks the role
default; selecting it clears the stored override. There is no
Auto choice and no per-dispatch `thinking` flag. Precedence: your setup override > the
role default, then the model clamp. There is no separate vision mode — assign
a multimodal model and name the image paths in the task.

Every dispatch, startup retry, and model fallback snapshots the parent's live
tools, and all `subagent*` tools are removed so children remain leaves. A broad
role inherits that snapshot — including `codemode` when the session runs it — so
a code-mode parent produces code-mode children under the same `codemode.mode`.
An explicit resolved list that names no MCP tool also excludes MCP tools it does
not name.

Neither role names extension, MCP, or vendor tools. `scout` is a hard
read-only boundary that is derived from the live catalog: it keeps every active
tool the host proves read-only — `annotations.readOnlyHint` for extension and
MCP tools, plus pi's own `read`, `grep`, `find`, and `ls` — and never a shell, a
mutation tool, or a tool that reaches other tools, so `codemode` and
`tool_search` cannot reach a writer through it. A retrieval extension or an MCP
search server therefore works for scout without being named anywhere, and without
reconfiguring the server: a read-only tool the session reaches only through
`codemode` or `tool_search` — pi's default for MCP servers — is handed to scout
directly, which is the same capability without giving scout a way to reach a
writer. Every other MCP tool stays excluded from that child. Tools with no
read-only annotation, whether they are declared by another role or by an active
extension, are conservatively treated as write-capable when isolation is chosen.
An empty resolved snapshot starts the child with `--no-tools`.

For external research scout prefers official documentation, specifications, release
notes, and first-party repositories; it fetches decisive pages rather than citing
search snippets, records material dates/versions, and marks uncertainty.

## Configuration

`scout` and `artisan` are always enabled; the only settings are a model and a
thinking level per role. `/subagents-setup` opens a menu with one row per role —
its summary, current model, and current thinking level — plus a "Both roles"
walk that asks each role's model and then its thinking level. `Esc` moves back,
and the model picker supports fuzzy search. To start over, delete
`~/.pi/agent/pi-subagents.json` and run `/subagents-setup`; the next session
writes the defaults again. Settings live in `~/.pi/agent/pi-subagents.json`
(following `PI_CODING_AGENT_DIR`):

```json
{
  "agentModels": { "scout": "anthropic/claude-haiku-4-5" },
  "agentThinkingLevels": { "artisan": "high" }
}
```

| Field                 | Meaning |
| --------------------- | ------- |
| `agentModels`         | Optional model per role as `provider/model-id`; missing means the current main model. |
| `agentThinkingLevels` | Optional thinking override per role; missing means the role default (`scout` low, `artisan` high). |

Everything else is a fixed constant: result deliveries keep 40 lines before the
on-disk artifact takes over, process capacity is automatic, and a child silent
for 30 minutes is terminated. Obsolete keys left by older config files are
dropped when the canonical shape is persisted, and invalid values fall back to
defaults.

The delegation directive is installed as a `<subagents>` prompt section. Active
leases go in `<subagent_leases>`. Pi 1.0 appends a section delta only when that
text changes, so idle turns keep the cached system prefix. Hosts without a
section map still receive the same contract appended to the system prompt.

At session start, model overrides that pi no longer reports are removed with a
one-time notice. If pi's own session compaction fails mid-thread, a notice surfaces
the error and automatic retry instead of failing quietly.

## Evaluate delegation

Choose delegation settings from your workload. The extension records execution
facts, but its tests do not establish a quality or cost advantage over solo Pi.

1. Select representative tasks: a localized fix with a known cause, unfamiliar
   code exploration, independently verifiable module changes, and a tightly
   coupled debugging task. Define acceptance checks before running them.
2. Use fresh sessions and separate clean checkouts at the same starting commit.
   Keep task prompts, models, thinking levels, tools, and project instructions
   fixed. Keep results from earlier attempts out of later prompts; alternate
   execution order and repeat each comparison several times.
3. Compare a session where main delegates freely against one where you instruct
   it to work solo (or uninstall the extension). Record actual child counts and
   roles as well — a delegation-prone main may still finish some tasks alone.
4. Measure final acceptance and regressions, elapsed time through integration,
   and rework. Record main plus every child's token usage and cost, retaining
   model identities and including failed attempts, review, integration, and
   retries. A child's successful exit or quick first patch is not final success.
5. Compare quality under matched total-cost budgets and matched wall-clock
   limits as separate experiments. Include failed or unfinished runs. The idle
   timeout only detects a silent child; enforce experiment-wide budgets in your
   evaluation process.

The [BOAD coding study](https://arxiv.org/html/2512.23631v2) found a useful small
expert set but declining results when adding more roles; its role-count result
does not prescribe a concurrency limit. A broader
[2026 agent-system study](https://www.nature.com/articles/s42256-026-01268-y)
also found that coordination outcomes depend on the task and single-agent
baseline. These motivate measuring your own workflow, not a universal team size.

## Storage and cleanup

Everything lives under your pi agent directory, grouped per project. Nothing
long-lived is written to the OS temp directory, and every class of file has a rule
that removes it, so this directory does not grow without bound:

| Path                                       | Holds                                                | Removed                                                          |
| ------------------------------------------ | ---------------------------------------------------- | ---------------------------------------------------------------- |
| `pi-subagents.json`                        | Your configuration                                   | Never — it is yours                                              |
| `ferris-pi-subagents/pi-subagents-recovery.json` | Worktree integration and cleanup failures | When the retained patch or worktree it points at is gone |
| `ferris-pi-subagents/<project>/pi-subagents-threads.json` | One record per interrupted thread     | When the thread settles, or after 30 days                        |
| `ferris-pi-subagents/<project>/sessions/`  | Child sessions for in-run fallback and manual recovery | When the owning session ends and no recovery record claims them |
| `ferris-pi-subagents/<project>/worktrees/` | Isolated checkouts for parallel writers              | On integration, or when no thread/recovery record claims them  |
| `ferris-pi-subagents/<project>/results/`   | Full text of truncated results                       | After 7 days, or beyond 50 per project                           |
| `ferris-pi-subagents/<project>/tmp/`       | Child prompt copies and the no-retry policy shim     | When its owning process exits                                    |
| `ferris-pi-subagents/<project>/`           | All of the above for one checkout                     | After 3 idle days unless a thread/recovery record claims it      |

Cleanup runs at session start and is deliberately conservative. A directory goes
away only when the process that created it is gone and no valid manifest record still
claims it, so a live sibling pi instance never loses state and interrupted or recovery-owned
work outlives its own process by design. Thread and recovery references always beat an
age rule. Restore and recovery notices themselves are scoped to the current checkout:
opening pi in another project does not restore, announce, or stop the first project's runs.

## Development

```bash
npm install
npm run check
```

`npm run check` is `tsc --noEmit` plus the unit tests (`npm test`). There are
no bundled runtime dependencies; pi and TypeBox are peers. The source is
grouped by responsibility under `src/`: configuration, delegation, execution, isolation,
lifecycle, and presentation.

`npm test` runs the TypeScript sources on Node's built-in type stripping from
Node 22.19 up, including Node 26, which removed `--experimental-transform-types`;
the source therefore avoids parameter properties and other transform-only
syntax. Pi and TypeBox are peers, and the extension imports only pi's public SDK
surface, so nothing is bundled.

## Changelog

See [CHANGELOG.md](./CHANGELOG.md) for the latest release notes. Every
published version is preserved as a GitHub Release; older entries are trimmed
from the file.

## Release

Pushing to `main` publishes `@ferris1225/pi-subagents` when `package.json`
carries a version npm does not have yet, then opens a matching GitHub Release.
Do not `npm publish` from a laptop. The workflow is
`.github/workflows/publish.yml` (npm trusted publisher or `NPM_TOKEN`).

## License

MIT
