# pi-subagents

[![npm version](https://img.shields.io/npm/v/@ferris1225/pi-subagents?color=blue)](https://www.npmjs.com/package/@ferris1225/pi-subagents)
[![downloads](https://img.shields.io/npm/dm/@ferris1225/pi-subagents)](https://www.npmjs.com/package/@ferris1225/pi-subagents)
[![license](https://img.shields.io/npm/l/@ferris1225/pi-subagents)](./LICENSE)
![platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey)
![pi](https://img.shields.io/badge/pi-extension-orange)

Focused background delegation for [pi](https://pi.dev). `pi-subagents` adds a small set of
specialized agents that run in isolated child processes, report results back to the main
agent, and keep the workflow moving without manual polling.

## Highlights

- **Automatic delegation guidance** — injects the enabled agent catalog and routing rules into
  the main agent's system prompt.
- **Isolated execution** — every sub-agent runs in its own `pi` process with `--no-session`.
- **Automatic continuation** — a completed result is sent to the main session as a custom
  message and automatically starts a follow-up turn. If the main agent is busy, the result
  waits in the follow-up queue.
- **Parallel fan-out** — run independent tasks together, with a bounded background queue.
- **Live progress** — a TUI widget shows each agent's status, activity, model, usage, and
  elapsed time; completion also produces a concise notification.
- **Per-agent configuration** — enable agents, select models, set thinking strength, and
  choose discovery scope from `/subagents-setup`.
- **Leaf processes** — child agents cannot access the `subagent` tool, so delegation cannot
  recurse.

## Install

```bash
pi install npm:@ferris1225/pi-subagents
```

Requires pi **>= 0.80.6**.

After installation, open the setup wizard in an interactive TUI session:

```text
/subagents-setup
```

The default configuration enables `explore`, `worker`, and `reviewer`. `plan` is available
but opt-in.

## Included agents

| Agent | Default | Access | Purpose |
| --- | :---: | --- | --- |
| `explore` | Yes | Read-only | Fast codebase reconnaissance and structured findings. |
| `worker` | Yes | Full | Implements, fixes, refactors, and tests a self-contained task. |
| `reviewer` | Yes | Read-only | Independent adversarial review of a diff before completion. |
| `plan` | No | Read-only | Produces a separate implementation plan when one is useful. |

Agents are Markdown files in `agents/`. Each file contains YAML frontmatter and a system
prompt. User and project scopes can override a built-in agent with the same name.

## Workflow

A typical flow is:

```text
main agent
    │
    ├─ subagent(explore / worker / reviewer)
    │       └─ isolated pi child process
    │                 └─ result message
    │
    └─ automatic follow-up turn with the result
```

1. The main agent calls `subagent` with a self-contained brief.
2. The tool returns immediately and ends that foreground tool turn, leaving the editor ready
   for input.
3. The child process works independently. Up to four queued runs execute at once; a single
   parallel request may contain up to eight tasks.
4. On completion or failure, the extension sends a durable result message to the main
   session. That message automatically wakes the main agent, or waits until its current turn
   finishes.
5. The main agent uses the result to verify the work and continue dependent steps. No later
   user prompt is required to collect a result.

Switching sessions, reloading, or shutting down cancels remaining background runs.

## Usage

The main agent is encouraged to delegate automatically, but you can also ask directly:

```text
Use explore to map how authentication is wired up.
Ask worker to implement the API change after the exploration is complete.
Run reviewer on the final diff before reporting completion.
```

### Single task

```json
{
  "agent": "worker",
  "task": "Implement the requested change. Inspect the existing conventions, update tests, and report the files changed and checks run."
}
```

Optional `cwd` selects the working directory for that child.

### Parallel tasks

Use parallel mode only for independent work:

```json
{
  "tasks": [
    { "agent": "explore", "task": "Map the API layer and its tests." },
    { "agent": "explore", "task": "Map the database layer and its tests." }
  ]
}
```

Start dependent work after the relevant result has been delivered to the main agent.

## Configuration

Configuration is stored at `~/.pi/agent/pi-subagents.json`. The location follows
`PI_CODING_AGENT_DIR` when set.

```json
{
  "enabledAgents": ["explore", "worker", "reviewer"],
  "agentModels": {
    "explore": "anthropic/claude-haiku-4-5"
  },
  "thinkingLevel": "max",
  "proactiveInjection": true,
  "agentScope": "user"
}
```

| Field | Description |
| --- | --- |
| `enabledAgents` | Agent names exposed to discovery and prompt injection. An empty array disables all agents. |
| `agentModels` | Optional `provider/model-id` override per agent. |
| `thinkingLevel` | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`. |
| `proactiveInjection` | Whether to add the delegation directive to the main system prompt. |
| `agentScope` | `user`, `project`, or `both`; controls which user/project agent directories are discovered. |

Model selection uses this precedence:

```text
configured agent model → current main-session model → agent frontmatter model
```

Unavailable configured models are replaced with a usable current-session model when possible
and the repaired configuration is saved.

## Agent discovery and overrides

- Built-in agents are shipped with the package.
- User agents live in `~/.pi/agent/agents/`.
- Project agents live in the nearest `.pi/agents/` directory.
- For duplicate names, project overrides user and user overrides built-in.

Use a matching Markdown filename and `name` field to replace a built-in agent. Keep the task
brief explicit: include the goal, relevant paths, constraints, and expected handoff.

## Development

```bash
npm install
npm run check
npm test
```

The package has no runtime dependencies beyond pi peer dependencies.

## License

MIT
