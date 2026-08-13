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

## Highlights

- **Zero-setup proactive dispatch** — the extension injects a delegation directive
  into the main system prompt, so the main model automatically sends broad searches
  to `explore`, self-contained implementations to `worker`, and pre-commit reviews
  to `reviewer`. You just use pi; delegation happens by itself.
- **Vision-capable image tasks** — a task that may need to view screenshots,
  mockups, or design files is flagged `vision: true`; the sub-agent then runs on
  the vision model you configure in `/subagents-setup`. Not configured? It falls
  back to the main session's current model. Configured model unavailable? You are
  asked to pick a replacement, which is persisted. The agents know they can `read`
  image files when the brief asks.
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
- **Self-healing model management** — unavailable configured models are repaired
  and persisted automatically; a provider hiccup retries the same model up to 5×
  with backoff, then falls back once to the main window's model; terminal errors
  (quota/auth) short-circuit straight to the main agent; an idle watchdog kills
  runs that go silent; startup races are retried with backoff.
- **Resumes, not restarts, on a model switch** — every run is session-backed, so
  a model quota/auth failure resumes on another model with its earlier searches,
  reads, and edits intact (no re-scanning). When every model is out, the run is
  handed back with its session preserved for a one-call `subagent({ resume })`.
- **Honest completions** — a run that ended with failed tool calls (e.g. a broken
  build) is reported as `completed with N failed tool call(s)` with the errors
  attached — a cheerful final text can never hide a failure.
- **Parallel fan-out** — independent tasks run concurrently up to a configurable
  limit (default 4).
- **Live progress widget** — each run's status, current activity, model, token
  usage, and elapsed time; auto-fix chain rounds hang under their triggering
  review as a tree, each finished round keeping a one-line outcome.
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

The sub-agent reads the images with its `read` tool. Model selection for
vision-flagged runs: configured `visionModel` → main session's current model →
agent's own model. When a configured vision model is no longer available, the
TUI asks you to pick a replacement (persisted); outside the TUI it warns and
falls back. A vision-flagged auto-fix chain keeps its worker/re-review rounds on
the vision model too, since they re-read the same images.

### Waiting, inspecting, stopping

- `subagent_wait` — in-turn result lookup. **Non-blocking by default**: a settled
  run returns its result immediately; a still-active run tells the model to end
  its turn (the wake-up message arrives on its own). Pass `timeoutMs` only when
  you must stay in the turn.
- `subagent_status` — what is running now, what finished this session, full
  result by run id.
- `subagent_stop` — cancel a run (or all); the child is terminated and an aborted
  result with partial output is delivered.

## Configuration

Stored at `~/.pi/agent/pi-subagents.json` (follows `PI_CODING_AGENT_DIR` when
set). The `/subagents-setup` wizard drives every field interactively — models,
thinking levels, the vision model, concurrency, fix rounds, idle timeout, scope,
and injection — with a per-agent "configure one" menu when the config already
exists. `notifyOnReviewPass` and `maxResultLines` are edited directly in the
file.

```json
{
  "enabledAgents": ["explore", "worker", "reviewer"],
  "agentModels": {
    "explore": "anthropic/claude-haiku-4-5"
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
| `agentModels` | Optional `provider/model-id` override per agent. |
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

### Model precedence

```text
per-agent override → current main-session model → agent frontmatter model
```

For vision-flagged runs:

```text
visionModel (configured) → current main-session model → agent model
```

Unavailable configured models are replaced with a usable current-session model
and the repaired config is saved. At runtime, a model that fails at the provider
level before producing output is retried (same model up to 5× on transient
errors, then once with the main window's model — per-run only, never persisted);
if everything fails, the task is handed back to the main window with
instructions to execute it directly.

### Resuming after a model quota/auth failure

Every sub-agent run is **session-backed**: its pi session is persisted to a
temp dir for the run. When a model fails at the provider level, the retry and
the fallback **resume that session** instead of starting over — so a model
switch inherits the sub-agent's earlier searches, reads, and edits and never
re-scans. If every available model is exhausted (e.g. the account is out of
quota), the run is handed back with its session preserved; once you have a
working model again, resume it in-context:

```ts
subagent({ resume: 7 }); // continue run #7 from where its model stopped
```

The session is reclaimed once the resume succeeds (or when the session ends).

### Configuration migration

The config file migrates itself on load — no manual steps after an upgrade:
schema upgrades are normalized and saved back, removed agents are stripped,
legacy keys (`maxParallelTasks`, `maxSubagentDepth`) are folded in or dropped,
and new fields are filled with defaults. New features are announced to you once
after an update via a toast (marker persisted in `announcedFeatures`).

## Agent discovery and overrides

- Built-in agents ship with the package; user agents live in `~/.pi/agent/agents/`;
  project agents in the nearest `.pi/agents/` directory.
- For duplicate names: project overrides user overrides built-in. Keep the
  matching filename and `name` field to replace a built-in agent.
- Optional frontmatter: `model` (default model reference), `thinking` (default
  thinking strength), `tools` (comma-separated tool allow-list; absent = all
  tools). Config overrides win at spawn.

## How it stays reliable

- **Three-layer model resilience** — same-model retry with backoff on transient
  provider errors (503/429/timeout/network), then a one-shot fallback to the main
  window's model. Terminal errors (quota/billing/invalid key/auth) never retry.
- **Startup-race retries** — a silent zero-activity child exit (concurrent pi
  startup lock contention) is relaunched with backoff; only clean silent exits
  qualify, so real work is never duplicated.
- **Idle watchdog** — a stalled provider stream (no output for `idleTimeoutSec`)
  terminates the child and retries via the normal fallback path.
- **Dispatch crashes surface** — an exception in the dispatch layer produces a
  failed result with a notification, never a silent hang.
- **Leaf children** — no nested delegation, no runaway trees.

## Development

```bash
npm install
npm run check
npm test
```

The source is modular: `dispatch.ts` (subagent tool + auto-fix chain + vision
model), `tools.ts` (wait/status/stop), `widget.ts` (widget + announcements),
`runtime.ts` (shared session state), `spawn.ts` (child process layer),
`monitor.ts` (run tracking), `setup.ts` (wizard), `prompt.ts` (delegation
directive). No runtime dependencies beyond pi peer dependencies.

## License

MIT
