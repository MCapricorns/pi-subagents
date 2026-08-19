# pi-subagents

[![npm version](https://img.shields.io/npm/v/@ferris1225/pi-subagents?color=blue)](https://www.npmjs.com/package/@ferris1225/pi-subagents)
[![downloads](https://img.shields.io/npm/dm/@ferris1225/pi-subagents)](https://www.npmjs.com/package/@ferris1225/pi-subagents)
[![license](https://img.shields.io/npm/l/@ferris1225/pi-subagents)](./LICENSE)
![platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey)
![pi](https://img.shields.io/badge/pi-extension-orange)

Focused background delegation for [pi](https://pi.dev): `explore` / `worker` /
`cleaner` / `reviewer` agents run in **isolated child processes** and hand their
results back to the main agent automatically. Install it, and the main model
starts using it on its own — no prompt engineering, no babysitting.

## 2.0.0 — direct model handoff and capability-aware thinking

Version 2 removes backup pools and global thinking strength. Every agent now has
one optional selected model; any model/provider failure hands its retained session
directly to the current main model, while ordinary tool/task failures stay put.
Thinking defaults to Auto and is clamped through Pi's real model capability map.
The setup menu and normalized config drop the obsolete options instead of carrying
compatibility aliases.

This release also adds semantic routing to a dedicated evidence-first `cleaner`
and makes the active widget show each run's task, effective model/thinking,
activity, and elapsed time. Every dispatch has a stable run id, so work can be
steered while it runs, parked without losing context, resumed after settlement,
retargeted, or forked into another path. Generation ownership keeps startup-race
retries and stale child processes from corrupting the logical thread without
retaining a duplicate event history.

The common quality loop now runs end to end without waking the main agent between
steps:

```text
reviewer (find blockers) → worker (fix) → reviewer (verify) → final PASS/FAIL
```

Cleanup stays a separate lifecycle: explicit cleanup intent can dispatch the
evidence-first `cleaner`; any edits still go through the independent `reviewer`
gate.

Each chain is delivered as one concise completion group, while full per-run
reports remain available through `subagent_status`. Its parent stays `running`
until the whole chain settles; completed internal rounds leave active status
immediately, so no `done` row keeps accumulating elapsed time. Selected-to-main
model handoffs keep the same retained context, and isolated parallel workers use
detached Git worktrees whose changes are applied back without touching the parent
index.

## Highlights

- **Zero-setup proactive dispatch** — the extension injects a delegation directive
  into the main system prompt, so the main model sends broad searches to `explore`,
  self-contained implementations to `worker`, explicit cleanup intent to `cleaner`,
  and pre-commit reviews to `reviewer`. You just use pi; delegation happens by itself.
- **Vision-capable image tasks** — flag screenshot/mockup/design work with
  `vision: true`. The configured vision model hands directly to the current main
  model on model/provider failure. Setup lists only in-scope, image-capable models
  from providers with configured authentication, and failures never silently
  rewrite your configuration.
- **Results come back on their own** — completions are delivered as messages that
  wake the main agent automatically, even mid-turn. No polling, no `sleep`, no
  "go check" step. `subagent_wait` is a **non-blocking** in-turn lookup by default
  (pass `timeoutMs` to block); `subagent_status` inspects runs; `subagent_stop`
  cancels one and delivers its partial output.
- **Active-only live widget** — each queued or running sub-agent gets one compact
  width-aware primary line with task, effective model/thinking, and elapsed time;
  current activity appears only when present on an indented second line:
  ```text
  #7 cleaner · remove dead code in src/cache.ts · claude-sonnet-4-5/high · 42s
    grep cacheKey
  ```
  Long tasks and activity paths truncate first (preserving a useful path tail when
  possible), groups have no blank rows, and settled/parked runs disappear immediately.
- **Results are not re-narrated** — a sub-agent's completion is shown to you
  verbatim, and the main agent is told not to paraphrase it back. It replies with
  only its own conclusion or next step, so the same findings are never paid for
  twice in tokens.
- **Evidence-first cleanup, not deletion by guesswork** — `cleaner` distinguishes
  read-only audit wording from explicit apply wording, proves consumers and dynamic
  entrypoints before cutting, and treats finding nothing safe as a valid outcome.
  It is periodic/intent-driven, never PR-count-driven or an automatic commit gate.
- **A quality gate that closes the loop** — when a reviewer returns `REVIEW_FAIL`,
  the extension dispatches a worker briefed with the concrete findings, then a
  re-review, up to `maxFixRounds` times — and only then wakes the main agent.
  Every round stays in the triggering reviewer's cwd, and chains that target the
  same repository are serialized so shared-checkout edits cannot race.
- **Direct fallback with real thinking capabilities** — each agent has at most
  one selected model. An unavailable selection, rate limit, invalid key, quota,
  missing model, or provider failure hands directly to the current main model.
  A child-only provider adapter forces inner request retries to zero; transient
  stream drops still use Pi's outer turn retry, and only a settled model-level
  failure hands off, without changing user settings. Auto thinking clamps the
  agent preference to the
  effective model's real `thinkingLevelMap`; manual setup shows only levels that
  model supports.
- **Resumes, retargets, and forks preserve context** — every run is session-backed.
  `subagent_control` can steer active work, retarget it after a stable abort,
  park/resume it under the same run id, or fork a parked/settled checkpoint into
  a new independent run. Concurrent resume calls are serialized.
- **Concise but honest completions** — a clean process that contained failed tool
  calls adds one short warning with its run id; individual errors stay out of the
  main context and remain available through `subagent_status`. Actual process,
  model, and integration failures still surface as failures.
- **Parallel fan-out with filesystem isolation** — independent tasks run up to a
  configurable limit (default 4). Parallel workers default to detached Git
  worktrees; tracked, deleted, untracked, and binary changes are applied back
  without touching the parent index. Failed integration keeps recovery artifacts.
- **Recursion is structurally impossible** — children are leaf processes; the
  `subagent` tool is excluded from their toolset.
- **Zero runtime dependencies** — agents are plain Markdown files; overriding or
  adding one is writing a file.
- **Update announcements** — when a new configurable feature ships, you are told
  about it once (a persisted marker stops the notice from nagging).

## What this adds beyond generic subagent dispatch

This package combines several concrete runtime behaviors rather than only exposing
an undifferentiated child-agent launcher:

- language-agnostic semantic role guidance for cleanup intent;
- a dedicated evidence-first cleaner, with cleanup kept separate from the
  independent reviewer gate;
- isolated, retained threads that can be steered, parked, resumed, retargeted, or
  forked under stable run ids;
- the reviewer → worker auto-fix → reviewer loop;
- compact failed-tool warnings with full diagnostics available by run id;
- direct selected→main fallback plus capability-aware Auto thinking;
- detached Git worktree isolation for parallel workers and opt-in write-capable
  cleaner runs.

## Install

```bash
pi install npm:@ferris1225/pi-subagents
```

Requires pi **>= 0.83.0**. After installation, open the setup wizard in an
interactive TUI session:

```text
/subagents-setup
```

Fresh installs enable `explore`, `worker`, `cleaner`, and `reviewer` — you can
start delegating immediately. Existing explicit `enabledAgents` lists are never
silently extended; users upgrading with an existing explicit list get a one-time
notice to opt into `cleaner` with `/subagents-setup`.

## The agents

| Agent | Access | Purpose |
| --- | --- | --- |
| `explore` | Read-only | Fast codebase reconnaissance: broad/open-ended search, multi-file lookups, mapping unfamiliar code. Returns compressed, structured findings. |
| `worker` | Full | Implements, fixes, refactors, and tests a self-contained task end to end, then reports honest verification. |
| `cleaner` | Full | Evidence-first cleanup. Audits and ranks candidates read-only, or applies the smallest proven cuts when removal is explicit; supports worktree isolation. |
| `reviewer` | Read-only | Adversarial pre-commit quality gate: independently reviews worker and cleaner edits, plus plans, proposed solutions, codebase health, and PR/issue validation. |

Each agent runs in its own isolated `pi` process with a clean context window; it
has no memory of your conversation, so briefs must be self-contained (goal, exact
paths, constraints, expected output).

## Usage

### Single task

```ts
subagent({ agent: "explore", task: "Map the test setup: which files run what, and how is CI wired? Report exact paths." });
subagent({ agent: "worker", task: "Implement X in src/foo.ts, add tests, run npm test." });
subagent({ agent: "cleaner", task: "Audit src/cache for dead code and redundant state; report ranked evidence only." });
subagent({ agent: "cleaner", task: "Remove the proven dead cache adapter, update its tests/docs, and verify the smallest then broad checks." });
subagent({ agent: "reviewer", task: "Review the diff of src/index.ts and tests/load.test.ts for correctness and edge cases." });
```

### Parallel tasks

```ts
subagent({
  tasks: [
    { agent: "explore", task: "Where is the selected-to-main handoff logic?" },
    { agent: "worker", task: "Add unit tests for models.ts." },
  ],
});
```

### Cleanup routing and lifecycle

The injected guidance routes `cleaner` by explicit semantic intent: **code cleanup**,
**dead code**, **代码清理**, **精简**, **清理冗余**, **简化**, or **去除过度设计**.
Requested periodic maintenance passes also qualify; PR counts do not, and cleaner is
never run automatically as the pre-commit gate.

- **Audit mode:** audit/find/report/review or 审计/查找/检查/报告 wording produces
  read-only ranked evidence.
- **Apply mode:** explicit remove/clean/simplify/refactor or 清理/删除/移除/精简/简化/重构
  wording permits the smallest proven edits plus narrow-then-broad verification.

```text
explicit cleanup intent → cleaner (audit or apply)
cleaner apply → reviewer gate → worker auto-fix (on REVIEW_FAIL) → reviewer
```

`reviewer` remains the independent gate for non-trivial cleaner edits. The auto-fix
portion runs only when enabled by `maxFixRounds`; cleaner itself is not a pre-commit
hook or a PR-count scheduler.

### Vision tasks (screenshots / mockups / designs)

When a task may require viewing images — frontend work, UI review, design
comparisons — set `vision: true` and give the sub-agent the exact image paths:

```ts
subagent({
  agent: "reviewer",
  task: "Compare the UI in screenshots/settings.png against the mockup design.png; list every visual mismatch.",
  vision: true,
});
```

The sub-agent reads images with its `read` tool. Runtime order for a
vision-flagged run is `visionModel` → current main-window model. A stale or
currently unavailable vision selection is skipped immediately without rewriting
it. A vision-flagged auto-fix chain keeps the flag for worker/re-review rounds
because they may need to inspect the same images.

### Controlling and stopping

Dispatch confirmations, tool result rows, and completion blocks all show the
stable `#id`, so a thread remains directly controllable after its live UI is gone.

- `subagent_control` — `steer`, `retarget`, `park`, `resume`, or `fork` a logical
  thread by stable run id. Resume accepts an optional replacement objective;
  fork creates a new id and leaves the source unchanged. Park active work before
  forking it.
- `subagent_wait` — in-turn result lookup. **Non-blocking by default**: a settled
  run returns immediately; an active run tells the model to end its turn. Pass
  `timeoutMs` only when you must stay in the turn.
- `subagent_status` — active/parked/finished runs and full result by run id.
- `subagent_stop` — destructive cancellation. It retires that thread's retained
  session (independent forks survive) and delivers exactly one aborted partial
  result after the run and any worktree integration have quiesced.

Examples:

```ts
subagent_control({ action: "steer", id: 7, instruction: "Check the Windows path too." });
subagent_control({ action: "park", id: 7 });
subagent_control({ action: "resume", id: 7, objective: "Finish the tests." });
subagent_control({ action: "fork", id: 7, objective: "Try the smaller alternative." });
```

### Worktree isolation

Single tasks default to `isolation: "shared"`. Parallel `worker` tasks default
to `isolation: "worktree"`; opt into shared mode only when a worker must see the
caller's live uncommitted tree. `cleaner` is also write-capable and supports
worktree mode when explicitly requested (its default remains shared). Worktree
mode requires a Git repository with a committed `HEAD` and is rejected for the
read-only `explore` and `reviewer` agents.

A parked isolated thread keeps its current worktree. Resume it there; fork is
available after that isolated checkpoint settles and its seed is integrated.
Resuming or forking a settled isolated thread creates a fresh worktree, merges a
recorded checkpoint onto the current `HEAD` (including when the seed was already
committed), and clones the Pi session with the new cwd. Forks then integrate only
their unique follow-on edits, so a shared seed is applied once. A run remains
active while final Git integration is in progress and becomes `done` only after
that boundary finishes.

Every Git operation has a 120-second deadline and process-tree cleanup; captured
Git output and binary patches are capped at 64 MiB. Setup/bound failures surface
instead of hanging. Finalization failures retain the patch/worktree when
available and are recorded in `~/.pi/agent/pi-subagents-recovery.json`; later
sessions show the recovery paths again until the artifacts are removed.

## Configuration

Stored at `~/.pi/agent/pi-subagents.json` (follows `PI_CODING_AGENT_DIR` when
set). `/subagents-setup` has five top-level choices: enable agents, configure one
agent's model/thinking, choose a vision model, runtime settings, or full setup.
After one agent's model + thinking picks, the wizard returns to the agent picker
so several agents can be configured in one pass; Esc at any step ends the pass
and keeps every agent already configured. There is no backup pool or global thinking menu. Model pickers show only in-scope
models with configured authentication and display their real supported thinking
levels. Thinking defaults to **Auto**; manual overrides show only levels supported
by that agent's effective model. `notifyOnReviewPass` and `maxResultLines` remain
direct-file settings.

```json
{
  "enabledAgents": ["explore", "worker", "cleaner", "reviewer"],
  "agentModels": {
    "explore": "anthropic/claude-haiku-4-5"
  },
  "agentThinkingLevels": {
    "reviewer": "high"
  },
  "visionModel": "anthropic/claude-sonnet-4-5",
  "notifyOnReviewPass": false,
  "maxResultLines": 80,
  "proactiveInjection": true,
  "agentScope": "user",
  "maxConcurrency": 4,
  "maxFixRounds": 2,
  "idleTimeoutSec": 90
}
```

| Field | Description |
| --- | --- |
| `enabledAgents` | Agent names exposed to discovery and prompt injection. An empty array disables all agents. |
| `agentModels` | Optional selected `provider/model-id` per agent. Missing = current main model. Model-level failure hands directly to current main. |
| `agentThinkingLevels` | Optional manual preference per agent. Missing = Auto (agent frontmatter preference, or `high`, clamped to the effective model's supported levels). |
| `visionModel` | Optional vision-capable model for `vision: true` tasks (screenshots/mockups/designs). Unset = falls back to the main session's current model. |
| `notifyOnReviewPass` | When `true`, a passing reviewer result is delivered without waking the main agent (default `false`). |
| `maxResultLines` | Max lines of a sub-agent result carried in the completion message (default `80`). Longer results are truncated; full text is written to an extension-named temporary `.md`. At session start and on each write, only recognized result files older than 7 days are removed; each canonical project path has its own newest-50 bucket. |
| `proactiveInjection` | Whether to add the delegation directive to the main system prompt. |
| `agentScope` | `user`, `project`, or `both`; controls which user/project agent directories are discovered. |
| `maxConcurrency` | Max sub-agent processes running at once (1–16, default 4), and the max tasks one parallel `subagent` call accepts. Extra work waits in the queue. |
| `maxFixRounds` | Auto-fix rounds when a reviewer returns `REVIEW_FAIL` (default 2; `0` disables the loop). |
| `idleTimeoutSec` | Idle watchdog: a sub-agent whose stdout goes silent for this long is terminated; a selected model then hands to current main. `0` disables it. Default 90. |

### Model routing and thinking

```text
selected agent/vision model → current main-window model
```

Without a selected model, current main runs immediately; agent frontmatter model
is used only when no main model exists. A selection missing from Pi's live
available catalog is skipped. Any model-level runtime failure — rate limit,
quota, invalid key/auth, missing model, provider error, or idle model stream —
hands directly to current main, including stream errors that retain partial text.
A child-only Pi extension wraps the selected provider's registered API stream
with `maxRetries: 0` so a deterministic auth/quota miss fails fast. Transient
stream drops such as xAI `terminated` still use Pi's outer turn retry — the
parent does not `abort_retry` them — and only a settled model-level failure
hands off to current main. This uses supported extension/RPC surfaces in Node
and standalone/Bun builds, never rewrites global or project settings, and does
not alter descendant tool environments. Tool/test failures stay on the same
model because they are task failures, not model availability failures. Only a truly
zero-activity process startup race can retry; an accepted prompt or any
agent/turn/stream/tool activity forbids replay.

Auto thinking starts from the Agent's declared preference (`low` for `explore`,
`high` for the other built-ins) and uses Pi's capability map to clamp it to the
actual model. Non-reasoning models resolve to `off`; `xhigh`/`max` appear in setup
only when that model explicitly supports them. A selected→main handoff re-clamps
thinking for the main model.

### Choosing an explore model

Choose a competent fast code model for `explore`, not automatically the cheapest
model. Cheap reconnaissance is useful for mechanical symbol/path discovery, but
a missed dynamic entrypoint or ownership edge can cost more through downstream
rework. Direct main-model handoff handles provider/runtime failure; it cannot
detect a plausible but incomplete answer.

`explore` therefore returns an index of exact paths, lines, symbols, and explicit
uncertainty. The main agent, worker, or cleaner must re-read load-bearing files
before editing or deciding deletion, security, compatibility, persistence, or
dynamic reachability. Prefer a stronger model or direct specialist for complex
dynamic loading, concurrency, migrations, and security-sensitive code.

### Resuming retained context

Every run stores its Pi session in a private temp directory. A selected→main
handoff resumes that same session, so searches, reads, reasoning, and edits remain
in context. A parked, completed, or failed thread can later be resumed under its
stable id:

```ts
subagent_control({ action: "resume", id: 7 });
subagent_control({ action: "resume", id: 7, objective: "Continue with the repaired credentials." });
```

Use `fork` when both paths should remain available. `subagent_stop` is the
explicit destructive operation that retires a retained session; otherwise
sessions live until the parent Pi session shuts down.

### Configuration migration

The config file normalizes itself on load — no manual steps after an upgrade.
Configured non-empty agent names are preserved, while invalid and obsolete keys
are removed. This release deletes `agentBackupModels` and global `thinkingLevel`
in addition to older `maxParallelTasks` / `maxSubagentDepth`; per-agent thinking
preferences remain and are capability-clamped at runtime. A pre-existing explicit
`enabledAgents` array is still preserved without appending `cleaner`. Existing
configs without it receive a one-time `/subagents-setup` notice, tracked internally
in `announcedFeatures`.

## Agent discovery and overrides

- Built-in agents ship with the package; user agents live in `~/.pi/agent/agents/`;
  project agents in the nearest `.pi/agents/` directory are loaded only when Pi
  trusts that project.
- For duplicate names: project overrides user overrides built-in. Keep the
  matching filename and `name` field to replace a built-in agent.
- Optional frontmatter: `model` (default model reference), `thinking` (default
  thinking strength), `tools` (comma-separated tool allow-list; absent = all
  tools). Config overrides win at spawn.

## How it stays reliable

- **Direct model recovery** — unavailable selections skip immediately; any
  selected-model provider/auth/quota/rate-limit failure hands directly to current
  main with thinking re-clamped to the main model.
- **Startup-race retries** — a silent zero-activity child exit (concurrent pi
  startup lock contention) is relaunched with backoff; only clean silent exits
  qualify, so real work is never duplicated.
- **Idle watchdog** — a stalled selected-model stream (no output for
  `idleTimeoutSec`) terminates the child and hands the retained session to current
  main.
- **Dispatch failures surface** — partial parallel startup reports every failed
  item and reason; if none start, the tool throws so Pi records a real tool error.
  Dispatch crashes likewise produce a failed result instead of a silent hang.
- **Safe live status** — tool activity is credential-redacted and stripped of terminal control sequences before `subagent_status` can return it.
- **Leaf children** — no nested delegation, no runaway trees.

## Development

```bash
npm install
npm run check
npm test
```

The source is modular: `dispatch.ts` (dispatch, controls, isolation, auto-fix),
`rpc-run.ts` / `spawn.ts` (persistent child transport + selected→main handoff),
`worktree.ts` / `session-fork.ts` (filesystem/session branching), `tools.ts`
(wait/status/control/stop), `widget.ts` (active-only TUI status), `announcements.ts`
(recovery and feature notices), and `runtime.ts` (session-scoped ownership). No runtime dependencies beyond pi peer
dependencies.

## License

MIT
