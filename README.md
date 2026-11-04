# pi-subagents

Sub-agents for [Pi](https://github.com/earendil-works/pi): research, implementation,
independent review, interactive follow-ups, and Git worktree isolation.

## Install

Requires **Pi >= 1.5.0** and **Node.js >= 22.19.0**. Development and native
integration tests use the Pi 1.5.0 SDK.

```bash
pi install npm:@ferris1225/pi-subagents
```

Run `/subagents-setup` to open a standalone centered modal panel rather than
squeezing menus into the input editor dock. Wide panels place the role register
and the focused role's settings side by side; narrow panels stack them. ↑/↓
changes the role, ←/→ selects **Model**, **Thinking**, or **Reset**, and Enter
edits it in a searchable modal picker. The selected role shows its full model
reference, effective reasoning level, requested level when clamped, and
default/override source. Each selection saves immediately; Esc returns without
applying a picker selection and keeps focus. Model pickers support search,
paste, and paging. On short terminals, PgUp/PgDn scrolls the settings while the
selected role and field stay pinned.

All roles follow the main model by default; thinking defaults to `low` for scout
and `high` for artisan and sentinel. The panel distinguishes defaults from overrides and
shows the effective level when model capabilities clamp a preference. Changing
a model preserves the thinking preference. Settings live in
`~/.pi/agent/pi-subagents.json` as `agentModels` and `agentThinkingLevels`.
Session start removes a model override that no authenticated provider offers
anymore; an override outside the session's model scope is kept and only skipped
while routing that session.

## Agents

| Agent | Use for | Access |
| --- | --- | --- |
| `scout` | Code, documentation, and web research with citations | Read-only tools; no commands or edits |
| `artisan` | Implementation and fixes with tests and checks | Parent's tool surface, including codemode |
| `sentinel` | Inspect an implementation or diff and challenge claims or assumptions for defects and regressions | Parent's tool surface; instructed not to edit |

The main model chooses from these role descriptions; names alone do not route a
task. Use `sentinel` to inspect implementations/diffs or challenge a specific claim
or assumption with counterexamples and focused checks.

Sentinel may run focused checks, so its no-edit boundary is an instruction, not
a tool-enforced restriction. Change reviews focus on introduced defects; a wider
audit needs an explicit brief. All roles reuse existing facts and valid checks,
filling gaps rather than repeating main or upstream work.

Only `scout`, `artisan`, and `sentinel` are valid runtime role names.
Existing model/thinking settings and interrupted run records migrate on load
(`reviewer`, `critic`, and `skeptic` map to `sentinel`) and are saved with the
current names. Explicit valid settings under the current names win. Custom roles
are not supported. Retained records from older releases remain available for recovery.

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
sources; artisan implements, while sentinel can execute focused checks. This policy applies the context-isolation,
focused-role, and coordination-cost guidance in the official
[Codex subagents](https://developers.openai.com/codex/subagents) and
[Claude Code subagents](https://code.claude.com/docs/en/sub-agents) docs to Pi's
one-shot leaf runs.

A review request produces findings. Main applies fixes when changes are
authorized and requests focused confirmation only when material uncertainty
remains. Before reporting success, main checks each done condition and any
blockers in the child's answer as well as the integrated diff.

Ask Pi to delegate explicitly, or call the tool directly:

```ts
subagent({
  agent: "artisan",
  task: "Fix cache invalidation in src/cache, add regression tests, and run the checks.",
});
```

Independent tasks can run together:

```ts
subagent({
  tasks: [
    {
      agent: "artisan",
      task: "Fix config validation and its regression tests.",
    },
    {
      agent: "artisan",
      task: "Update docs/providers.md from the established API citations.",
    },
  ],
});
```

Use `wait: true` when the next step needs the result. `subagent` and completed-run
`subagent_message` follow-ups default to waiting in one-shot `pi -p` / JSON sessions,
so the parent stays alive until the work finishes. TUI and RPC sessions default
to background delivery; `wait: false` explicitly selects it in any mode. Each
result is delivered once, after integration, either in the waiting tool call or
as a background completion. Awaited failures are tool errors with retained evidence.
An answer longer than 40 lines or 8,000 characters is not inlined; its delivery
names the full-result file instead.

A launch receipt only confirms delegation and lists every started run id. Main
continues independent work or pauses until the completion wakes it, then
finishes the requested outcome and final checks. It does not poll or treat a
successful launch as task completion.
Equal normalized tasks in the same cwd are rejected as duplicates while active
or settled in the current session. Reuse the result, or use `subagent_message`
for an additional bounded step.

## Status, cancellation, and recovery

| Tool | Use |
| --- | --- |
| `subagent_status({ id: 12 })` | Inspect a run's progress, result, and recovery paths |
| `subagent_message({ id: 12, message: "Check the caller too" })` | Steer a running child, or continue a completed run using its session when available and a summary otherwise |
| `subagent_message({ id: 12, message: "Add the test", context: "summary" })` | Start a new next step with only a bounded summary of the earlier run |
| `subagent_stop({ id: "12" })` | Stop a run and retire its retained session |
| `subagent_stop({ all: true })` | Stop all active runs in this session |

The widget is a terminal task board capped at 10 lines: a quiet overview, then
task rows with status/time at the right. Failures get space before optional
telemetry; narrow terminals keep task identity visible. Model, thinking, token
usage, and worktree state appear as secondary detail. Failed work stays until
the next dispatch. Completion messages and status lookups retain the results.
Overflow reports hidden tasks. Runs preparing their child process show `starting`.
The refresh timer runs only while visible active work needs it. There is no
process-count limit or shared-checkout startup lock: independent runs start
together, including separate dispatch calls while another call awaits results.

Usually omit `isolation`: implementation tasks use detached Git worktrees in
single calls and parallel batches. Reading and review use the current directory.
Without a Git repository or committed `HEAD`, automatic isolation uses the
caller's directory and reports why. Unexpected setup or integration failures
remain failures; an explicit `isolation: "worktree"` requires isolation and never
falls back. `isolation: "shared"` is an advanced override for tasks that need to
write directly in the caller's checkout.

Each worktree starts from the caller's current tracked files and non-ignored
untracked files, including uncommitted changes. Its initial snapshot is also the
integration base, so dependent tasks see earlier results without reapplying them.
The caller's index, branch, and `HEAD` stay unchanged. The child is told the
original checkout and its worktree path, so it maps paths from the brief into the
worktree. Worktrees isolate Git changes, not tool permissions. Independent tasks
start together; only the final application of worktree changes to the original
checkout is serialized.
Integration leaves your index untouched, and failures retain recovery artifacts.

Cancelling the parent run with Escape stops unfinished work without waking the
parent. A cancellation receipt is supplied on the next user turn with the stopped
run ids, so main knows no additional `subagent_stop` is needed. Cancelled work
must not restart automatically. Conversation-tree navigation also stops
unfinished work. New/resume/fork/reload ends old children and retains interrupted
work for manual recovery. Runs do not resume automatically; main finishes
incomplete work from partial changes and artifacts.

A steering call waits for the child's existing RPC channel to acknowledge the
matching request ID. The tool card shows **Received · queued** when Pi confirms
queueing, **Received · handled** when an input hook consumes the message, or
**Accepted · queue state unconfirmed** when no disposition is available.
`subagent_status` retains the latest acknowledgement, request ID, age, and message
summary. Rejection or a missing acknowledgement is an error, not a receipt.
Queueing delivers at a Pi steering boundary; it does not prove that the model
has executed the instruction.

To continue a successfully completed run, choose the context that fits the follow-up:

- `context: "auto"` (default) continues a private copy of the retained session
  when available. If cleanup has removed it, the follow-up starts with a bounded
  summary and explicitly reports that full history is unavailable. No retry is
  needed for an expired session.
- `context: "session"` requires full history for rework that depends on earlier
  details. If the session is unavailable, the call fails without starting a run.
- `context: "summary"` always starts fresh for a new next step, with the earlier
  objective, final result and touched files. It cannot rely on omitted details
  or reuse the earlier provider cache.

Session continuations retain the earlier history and provider prompt-cache key
(`sessionId`). Their private copy is bound to the new run's working directory,
including when a previous temporary worktree has already been removed. Child
startup and the copied session header use the same physical directory, so macOS
path aliases and Windows junctions do not trigger a cross-project fork prompt.
The continuation is instructed to re-read files before editing in the current cwd.

Every follow-up preserves the role and workspace and passes through normal
admission and isolation. Set `wait: true` to receive its final result in the same
call; this waiting option applies to newly started follow-ups, while steering a
running child returns its acknowledgement. `subagent_status` reports whether a
completed run has a session available or only summary context. Results and summaries remain
available within the current parent runtime; completed runs are not restored
after reload. Pending runs cannot be steered.

Children use Pi's native `--mode rpc` CLI with piped input/output, retries, and
session persistence. On Windows, console hiding covers the Pi child and Node
process launches made by its tools and extensions, including `pi.exec`, `pwsh`,
and `powershell`. The child preloads this policy before Pi starts and passes it
to Node descendants through `NODE_OPTIONS`, preserving existing options. An
explicit child extension installs the same policy for runtimes without Node
preloading. Windows launches stay attached so detachment cannot open a console.
On macOS and Linux, the policy leaves shell options unchanged; the Pi child uses
a separate process group for cancellation and does not launch a terminal app.
RPC communication and process-tree cancellation remain active. Child startup
errors are reported as failed runs. If Windows cannot launch `taskkill`,
termination falls back to killing the child directly. Commands that explicitly
open a terminal or GUI control their own windows.
A settled provider failure can hand off once to the main model in the same
session. State and full-result files live under
`~/.pi/agent/ferris-pi-subagents/`, grouped by project. `PI_CODING_AGENT_DIR`
overrides the agent directory.

## Pi codemode compatibility

Call `subagent` and the control tools directly. They use Pi's `model-only`
exposure and are intentionally unavailable as nested `tools.subagent(...)` calls
inside codemode. Children can still use codemode with their inherited callable
tools. Indirect tools retain their exposure; scout promotes approved read-only
tools for direct use. It waits up to ten seconds for startup registration and
activates later arrivals between turns. Read-only classification uses Pi tool
metadata.

Child RPC dialogs that require confirmation, selection, or text input are
cancelled with a matching response and an explanation, so an unattended child
does not hang waiting for an invisible dialog. No confirmation is approved
automatically.

## Storage and cleanup

Each project root holds `sessions/`, `worktrees/`, `tmp/` and `results/`. Startup
hygiene already drops temp leftovers, artifacts whose Pi process is gone, result
files past their retention window, and project roots idle for three days. Parked
recovery work and manifest references are protected during these sweeps.
Interrupted checkpoints expire after 30 days when no recorded owner or child
from the current boot is alive; expired checkpoints are pruned before restore.
Missing session files do not erase validated recovery paths. Unreadable or
malformed manifests leave artifacts intact and skip automatic reclamation;
explicit cleanup reports the error. Startup warns about failed recovery inspection
and continues initializing the progress widget.

Reclamation is automatic: a settlement may trigger one paced sweep (at most every
five minutes) that drops dead-owner artifacts, expired result files, and settled
session copies older than 30 minutes, then trims the oldest settled sessions
until a project fits its 1.5 GB budget. Under budget pressure, settled sessions
older than five minutes can be removed. Live runs, parked recovery work, and
manifest references remain protected. Automatic follow-ups use the retained
summary when a completed run's transcript has expired. Session shutdown waits
for cleanup already in progress and prevents new settlement sweeps.

`/subagents-cleanup` immediately reclaims unclaimed dead-owner artifacts and idle
project roots, reporting usage and freed bytes. `/subagents-cleanup dry-run`
measures without deleting anything; any other argument is rejected without
deleting. Session age and budget reclamation runs automatically on settlement.

## Development

Runtime code lives under `src/`; the package has no skill or workflow resource
directories. Built-in prompts change with the code and its tests.

| Module | Responsibility |
| --- | --- |
| `delegation/` | Built-in roles, parent routing prompt, and duplicate-dispatch admission |
| `configuration/` | Model and thinking settings, plus the standalone setup modal panel |
| `presentation/` | Running task board, activity, status, and result formatting |
| `execution/`, `lifecycle/`, `isolation/` | Child processes, durable state, cancellation, worktrees, and recovery |

```bash
npm ci
npm run check
```

Pushing an unpublished package version to `main` runs the checks on Windows,
macOS, and Linux before triggering
[publishing and a GitHub Release](./.github/workflows/publish.yml).

[Changelog](./CHANGELOG.md) · [MIT license](./LICENSE)
