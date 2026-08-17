# pi-subagents

[![npm version](https://img.shields.io/npm/v/@ferris1225/pi-subagents?color=blue)](https://www.npmjs.com/package/@ferris1225/pi-subagents)
[![downloads](https://img.shields.io/npm/dm/@ferris1225/pi-subagents)](https://www.npmjs.com/package/@ferris1225/pi-subagents)
[![license](https://img.shields.io/npm/l/@ferris1225/pi-subagents)](./LICENSE)
![platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey)
![pi](https://img.shields.io/badge/pi-extension-orange)

Focused background delegation for [pi](https://pi.dev): `explore` / `worker` /
`reviewer` agents run in **isolated child processes** and hand their results back
to the main agent automatically. Install it, and the main model starts using it
on its own — no prompt engineering, no babysitting.

## 1.0 — controllable agent threads

Version 1.0 turns pi-subagents from a one-shot background runner into a small
thread runtime. Every dispatch has a stable run id and retained Pi session, so
work can be steered while it runs, parked without losing context, resumed after
settlement, retargeted, or forked into another path. An internal append-only
lifecycle trajectory keeps retries and stale generations from corrupting the
logical thread.

The common quality loop now runs end to end without waking the main agent between
steps:

```text
reviewer (find blockers) → worker (fix) → reviewer (verify) → final PASS/FAIL
```

Each chain is delivered as one concise completion group, while full per-run
reports remain available through `subagent_status`. Ordered model pools keep the
same retained context across provider fallback, and isolated parallel workers
use detached Git worktrees whose changes are applied back without touching the
parent index.

## Highlights

- **Zero-setup proactive dispatch** — the extension injects a delegation directive
  into the main system prompt, so the main model automatically sends broad searches
  to `explore`, self-contained implementations to `worker`, and pre-commit reviews
  to `reviewer`. You just use pi; delegation happens by itself.
- **Vision-capable image tasks** — flag screenshot/mockup/design work with
  `vision: true`. The configured vision primary is followed by that agent's
  backup and the current main-window model. Setup lists only in-scope,
  image-capable models from providers with a configured API key or OAuth session,
  and runtime failures never silently rewrite your configuration.
- **Results come back on their own** — completions are delivered as messages that
  wake the main agent automatically, even mid-turn. No polling, no `sleep`, no
  "go check" step. `subagent_wait` is a **non-blocking** in-turn lookup by default
  (pass `timeoutMs` to block); `subagent_status` inspects runs; `subagent_stop`
  cancels one and delivers its partial output.
- **Results are not re-narrated** — a sub-agent's completion is shown to you
  verbatim, and the main agent is told not to paraphrase it back. It replies with
  only its own conclusion or next step, so the same findings are never paid for
  twice in tokens.
- **A quality gate that closes the loop** — when a reviewer returns `REVIEW_FAIL`,
  the extension dispatches a worker briefed with the concrete findings, then a
  re-review, up to `maxFixRounds` times — and only then wakes the main agent.
  Every round stays in the triggering reviewer's cwd, and chains that target the
  same repository are serialized so shared-checkout edits cannot race.
- **Ordered model pools without config churn** — each agent can have a primary
  and backup; the current main-window model is the final candidate. Transient
  provider failures retry the same candidate with backoff, while permanent stale
  model/config errors and quota/auth errors advance immediately. Saved refs are
  never rewritten behind your back.
- **Resumes, retargets, and forks preserve context** — every run is session-backed.
  `subagent_control` can steer active work, retarget it after a stable abort,
  park/resume it under the same run id, or fork a parked/settled checkpoint into
  a new independent run. Concurrent resume calls are serialized.
- **Honest completions** — a run that ended with failed tool calls (e.g. a broken
  build) is reported as `completed with N failed tool call(s)` with the errors
  attached — a cheerful final text can never hide a failure.
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

## Install

```bash
pi install npm:@ferris1225/pi-subagents
```

Requires pi **>= 0.80.6**. After installation, open the setup wizard in an
interactive TUI session:

```text
/subagents-setup
```

The default configuration enables `explore`, `worker`, and `reviewer` — you can
start delegating immediately.

## The agents

| Agent | Access | Purpose |
| --- | --- | --- |
| `explore` | Read-only | Fast codebase reconnaissance: broad/open-ended search, multi-file lookups, mapping unfamiliar code. Returns compressed, structured findings. |
| `worker` | Full | Implements, fixes, refactors, and tests a self-contained task end to end, then reports honest verification. |
| `reviewer` | Read-only | Adversarial pre-commit quality gate: diff review, plus plans, proposed solutions, codebase health, and PR/issue validation. |

Each agent runs in its own isolated `pi` process with a clean context window; it
has no memory of your conversation, so briefs must be self-contained (goal, exact
paths, constraints, expected output).

## Usage

### Single task

```ts
subagent({ agent: "explore", task: "Map the test setup: which files run what, and how is CI wired? Report exact paths." });
subagent({ agent: "worker", task: "Implement X in src/foo.ts, add tests, run npm test." });
subagent({ agent: "reviewer", task: "Review the diff of src/index.ts and tests/load.test.ts for correctness and edge cases." });
```

### Parallel tasks

```ts
subagent({
  tasks: [
    { agent: "explore", task: "Where is the model fallback logic?" },
    { agent: "worker", task: "Add unit tests for models.ts." },
  ],
});
```

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
vision-flagged run is configured `visionModel` → that agent's configured backup
→ current main-window model (deduplicated). A stale configured ref is attempted
once, then skipped as a permanent candidate error; it is not rewritten. A
vision-flagged auto-fix chain keeps the flag for worker/re-review rounds because
they may need to inspect the same images.

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
caller's live uncommitted tree. Worktree mode requires a Git repository with a
committed `HEAD` and is rejected for read-only agents.

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
set). The `/subagents-setup` wizard drives every field interactively — models, the
default plus each enabled agent's thinking level, the vision model, concurrency,
fix rounds, idle timeout, scope, and injection — with a per-agent "configure
one" menu when the config already exists. Model pickers show only models in the
current session scope that are available through a configured API key or OAuth
session. `notifyOnReviewPass` and `maxResultLines` are edited directly in the file.

```json
{
  "enabledAgents": ["explore", "worker", "reviewer"],
  "agentModels": {
    "explore": "anthropic/claude-haiku-4-5"
  },
  "agentBackupModels": {
    "explore": "openai/gpt-5-mini"
  },
  "agentThinkingLevels": {
    "explore": "low"
  },
  "thinkingLevel": "high",
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
| `agentModels` | Optional primary `provider/model-id` override per agent. |
| `agentBackupModels` | Optional backup per agent, tried after its primary and before the current main-window model. |
| `agentThinkingLevels` | Optional thinking level per agent; agents without an entry use the agent's frontmatter `thinking`, then `thinkingLevel`. |
| `thinkingLevel` | Default thinking level: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max` (default `high`). |
| `visionModel` | Optional vision-capable model for `vision: true` tasks (screenshots/mockups/designs). Unset = falls back to the main session's current model. |
| `notifyOnReviewPass` | When `true`, a passing reviewer result is delivered without waking the main agent (default `false`). |
| `maxResultLines` | Max lines of a sub-agent result carried in the completion message (default `80`). Longer results are truncated; the full text is written to a temp file whose path is included in the message. |
| `proactiveInjection` | Whether to add the delegation directive to the main system prompt. |
| `agentScope` | `user`, `project`, or `both`; controls which user/project agent directories are discovered. |
| `maxConcurrency` | Max sub-agent processes running at once (1–16, default 4), and the max tasks one parallel `subagent` call accepts. Extra work waits in the queue. |
| `maxFixRounds` | Auto-fix rounds when a reviewer returns `REVIEW_FAIL` (default 2; `0` disables the loop). |
| `idleTimeoutSec` | Idle watchdog: a sub-agent whose stdout goes silent for this long is terminated and retried. `0` disables it. Default 90. |

### Model precedence and fallback

Normal run pool:

```text
configured agent primary → configured agent backup → current main-window model
```

If no primary is configured, the current main-window model is primary; the
agent frontmatter model is used only when no current main model exists. For
vision runs, `visionModel` replaces the first slot while the selected agent's
backup and current main model remain the fallbacks. Duplicate refs are removed.

Each candidate gets startup-race retries. Provider failures retry the same
candidate up to five times only when transient (timeouts, network, 429, 5xx).
Permanent model/config failures (`model not found`, unknown provider, 404) and
quota/auth/billing failures skip that delay and advance immediately. No runtime
outcome rewrites `pi-subagents.json`. If the whole pool fails, the result is
handed to the main window with its retained run id and session.

### Resuming retained context

Every run stores its Pi session in a private temp directory. Same-model retries
and pool fallbacks resume that session, so searches, reads, reasoning, and edits
remain in context. A parked, completed, or failed thread can later be resumed
under its stable id:

```ts
subagent_control({ action: "resume", id: 7 });
subagent_control({ action: "resume", id: 7, objective: "Continue with the repaired credentials." });
```

Use `fork` when both paths should remain available. `subagent_stop` is the
explicit destructive operation that retires a retained session; otherwise
sessions live until the parent Pi session shuts down.

### Configuration migration

The config file migrates itself on load — no manual steps after an upgrade:
schema upgrades are normalized and saved back, removed agents are stripped,
legacy keys (`maxParallelTasks`, `maxSubagentDepth`) are folded in or dropped,
and new fields are filled with defaults. New features are announced to you once
after an update via a toast (marker persisted in `announcedFeatures`).

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

- **Ordered model resilience** — transient failures retry the same candidate,
  then advance through configured backup and current-main candidates. Permanent
  stale-model/config and quota/auth/billing errors skip same-model backoff.
- **Startup-race retries** — a silent zero-activity child exit (concurrent pi
  startup lock contention) is relaunched with backoff; only clean silent exits
  qualify, so real work is never duplicated.
- **Idle watchdog** — a stalled provider stream (no output for `idleTimeoutSec`)
  terminates the child and retries via the normal fallback path.
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
`rpc-run.ts` / `spawn.ts` (persistent child transport + model pools),
`worktree.ts` / `session-fork.ts` (filesystem/session branching),
`trajectory.ts` (internal lifecycle history), `tools.ts`
(wait/status/control/stop), `announcements.ts` (recovery and feature notices),
and `runtime.ts` (session-scoped ownership). No runtime dependencies beyond pi peer
dependencies.

## License

MIT
