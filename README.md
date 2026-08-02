# pi-subagents

[![npm version](https://img.shields.io/npm/v/@ferris1225/pi-subagents?color=blue)](https://www.npmjs.com/package/@ferris1225/pi-subagents)
[![downloads](https://img.shields.io/npm/dm/@ferris1225/pi-subagents)](https://www.npmjs.com/package/@ferris1225/pi-subagents)
[![license](https://img.shields.io/npm/l/@ferris1225/pi-subagents)](./LICENSE)
![platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey)
![pi](https://img.shields.io/badge/pi-extension-orange)

English | [中文](./README-zh.md)

A focused [pi](https://pi.dev) extension that gives the main model **sub-agents it will
actually use**: `explore`, `worker`, and `reviewer` (plus an opt-in `plan`), each running
in an isolated `pi` process. The differentiator is not the agents themselves — it is the
**proactive dispatch injection** that makes the model delegate on its own, so you can
delete the dispatch/review rules from your global `AGENTS.md`.

## Why pi-subagents?

Pi ships no sub-agents on purpose. The community fills the gap two ways, and both miss:

- **Too heavy** — frameworks with 9 agents, chain pipelines, worktree swarms, and a
  slash-command for everything. Powerful, but a lot of machinery to carry.
- **Too quiet** — a bare `subagent` tool that the model *rarely calls*, because pi only
  shows the parent model the tool, never the per-agent descriptions. So the agents sit
  idle unless you force them in a global prompt.

`pi-subagents` takes the middle path:

| Advantage | What it means for you |
|-----------|----------------------|
| **Actually gets used** | A `before_agent_start` hook injects the agent catalog + a dispatch/review directive into the system prompt every turn, reinforced by tool `promptGuidelines` and `Use PROACTIVELY when …` descriptions. This is the lever the heavy frameworks rely on too — we just make it the default. |
| **Right-sized** | 3 focused agents (+1 opt-in), not 9. No chain/worktree/swarm machinery. Single and parallel modes only. |
| **Replaces your AGENTS.md rules** | The injected directive is a self-contained replacement for the "Sub-agent Dispatch" and "Review, Verification & Commit" sections. Install it, then delete those sections. |
| **True isolation** | Each agent is a separate `pi` process (`--no-session`), so delegated work never pollutes the main context. |
| **Read-only where it matters** | `explore`, `plan`, and `reviewer` are read-only. The `reviewer` runs in a *separate* context to avoid self-confirmation bias. |
| **Selection-only setup** | No typing of values: a checkbox module picker and a fuzzy-filter, paginated model picker. |
| **Sensible model defaults** | Per-agent model override; if you skip one, it uses the **main session's current model**. |
| **Recursion guard** | The tool is not registered beyond depth 2, preventing runaway nesting. |
| **Zero runtime deps** | Pure pi extension, peer dependencies only, no build step. |

## Install

```bash
pi install npm:@ferris1225/pi-subagents
```

Requires pi **≥ 0.80.6** — sub-agents request `--thinking max`, which that version
introduced (older pi builds would reject the flag value).

Then run the setup wizard (selection-only):

```text
/subagents-setup
```

## Agents

| Agent | Default | Tools | Role |
|-------|:-------:|-------|------|
| `explore` | ✅ | read-only | Fast codebase reconnaissance; returns compressed findings for handoff. |
| `worker` | ✅ | all | Implements / fixes / refactors / tests a self-contained task. **Plans internally.** |
| `reviewer` | ✅ | read-only | Adversarial pre-commit review in a separate context. |
| `plan` | opt-in | read-only | A separate, human-reviewable implementation plan. A worker already plans internally, so this is only for when you want the plan as its own artifact. |

Each agent is a Markdown file (`agents/*.md`: YAML frontmatter + body as system prompt).
Override any of them by dropping a file with the same `name` into `~/.pi/agent/agents/`
(user) or `.pi/agents/` (project).

## How proactive dispatch works

Pi never shows the parent model the per-agent descriptions — it only sees the `subagent`
tool. Three levers fix that:

1. **`before_agent_start` injection** — every turn, the enabled agents plus a
   dispatch/review directive are appended to the parent system prompt.
2. **Tool `promptSnippet` / `promptGuidelines`** — reinforce "when to delegate" whenever
   the tool is active.
3. **`Use PROACTIVELY when …`** descriptions — the trigger phrasing proven across the
   Claude Code agent ecosystem.

The directive encourages a clean flow: **`explore` → `worker` → `reviewer`**, parallel
fan-out for independent tasks, and trust-but-verify handoffs.

## Configuration

Stored at `~/.pi/agent/pi-subagents.json` (honors `PI_CODING_AGENT_DIR`):

```json
{
  "enabledAgents": ["explore", "worker", "reviewer"],
  "agentModels": { "explore": "anthropic/claude-haiku-4-5" },
  "proactiveInjection": true,
  "agentScope": "user"
}
```

- `enabledAgents` — which agents are discoverable and injected.
- `agentModels` — per-agent model override (`"provider/model-id"`).
- `proactiveInjection` — toggle the system-prompt injection.
- `agentScope` — `"user"` (default), `"project"`, or `"both"`.

**Model precedence** for each agent:

```
agentModels[name]  →  current session model  →  the agent's frontmatter default
```

So if you don't pick a model in setup, the agent uses the main window's current model.

## Usage

The main model calls `subagent` on its own, but you can also ask directly:

```text
# single
Use the explore sub-agent to map how authentication is wired up.

# parallel (independent tasks)
Run these in parallel sub-agents: explore the API layer, and explore the DB layer.
```

Tool shape:

```jsonc
// single
{ "agent": "worker", "task": "<self-contained brief>" }
// parallel
{ "tasks": [ { "agent": "explore", "task": "..." }, { "agent": "explore", "task": "..." } ] }
```

## Live status & notifications

While sub-agents run, a widget above the editor shows one line per run — status
icon, agent, model, token usage, elapsed time — plus a second, indented line
with what the agent is doing right now: `thinking`, `writing`,
`read src/index.ts`, `bash npm test`, … (never a raw JSON args blob).

When a run finishes (done **or** failed), its row disappears from the widget and
the main window gets a notification with the final summary
(`✓ worker · openai/gpt-5 · ↑12.4k ↓3.1k · 47s`). The tool result itself
remains the durable record in the conversation.

Sub-agents always request the **strongest thinking level** (`--thinking max`);
pi clamps it adaptively to what the resolved model supports
(`max → xhigh → high → … → off`), so weaker models degrade gracefully.

## Development

```bash
npm install
npm run check   # tsc --noEmit
npm test        # vitest
```

## See also

- [pi-querit-search](https://www.npmjs.com/package/pi-querit-search) — live web search &
  page fetching for pi, by the same author.

## License

MIT
