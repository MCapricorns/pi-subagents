# pi-subagents

[![npm version](https://img.shields.io/npm/v/@ferris1225/pi-subagents?color=blue)](https://www.npmjs.com/package/@ferris1225/pi-subagents)
[![downloads](https://img.shields.io/npm/dm/@ferris1225/pi-subagents)](https://www.npmjs.com/package/@ferris1225/pi-subagents)
[![license](https://img.shields.io/npm/l/@ferris1225/pi-subagents)](./LICENSE)
![platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey)
![pi](https://img.shields.io/badge/pi-extension-orange)

[English](./README.md) | 中文

一个聚焦的 [pi](https://pi.dev) 扩展，给主模型提供**它真的会去用**的 sub-agent：
`explore`、`worker`、`reviewer`（外加可选的 `plan`），每个都跑在独立的 `pi` 进程里。
真正的差异点不是 agent 本身，而是**主动派发注入**——让模型自己主动去委派任务，
于是你可以把全局 `AGENTS.md` 里那两段派发/审查规则删掉。

## 为什么选 pi-subagents？

pi 故意不内置 sub-agent。社区的补位方案分两种，但都没踩中：

- **太重** —— 9 个 agent、链式流水线、worktree 集群、到处都是 slash 命令。强大，但机器太多。
- **太安静** —— 只给一个 `subagent` 工具，模型**很少主动调用**，因为 pi 只把工具本身展示给主模型，
  从不展示每个 agent 的描述。于是除非你在全局提示词里强制，否则这些 agent 一直吃灰。

`pi-subagents` 走中间路线：

| 优势 | 对你意味着什么 |
|------|----------------|
| **真的会被用** | `before_agent_start` hook 每轮把 agent 清单 + 派发/审查指令注入系统提示词，再由 tool `promptGuidelines` 和 `Use PROACTIVELY when …` 描述加强。这正是重型框架依赖的那根杠杆——我们只是把它变成默认行为。 |
| **体量合适** | 3 个聚焦的 agent（+1 可选），不是 9 个。没有链式/worktree/集群机器。只有 single 和 parallel 两种模式。 |
| **替代你的 AGENTS.md 规则** | 注入的指令是 "Sub-agent Dispatch" 和 "Review, Verification & Commit" 两段的自包含替代。装上它，然后把那两段删掉。 |
| **真隔离** | 每个 agent 都是独立 `pi` 进程（`--no-session`），委派出去的活绝不污染主上下文。 |
| **该只读就只读** | `explore`、`plan`、`reviewer` 都是只读。`reviewer` 跑在**独立**上下文，避免自我确认偏差。 |
| **纯选择式配置** | 不用手敲值：勾选式模块选择器 + 模糊过滤、可翻页的模型选择器。 |
| **合理的模型默认** | 每 agent 可单独覆盖模型；不选就**用主窗口当前 session 的模型**。 |
| **递归守卫** | 深度超过 2 不再注册该工具，防止无限嵌套。 |
| **零运行时依赖** | 纯 pi 扩展，仅 peer 依赖，无需构建步骤。 |

## 安装

```bash
pi install npm:@ferris1225/pi-subagents
```

然后运行配置向导（纯选择）：

```text
/subagents-setup
```

## Agent 一览

| Agent | 默认启用 | 工具 | 职责 |
|-------|:--------:|------|------|
| `explore` | ✅ | 只读 | 快速代码侦察；返回压缩后的发现以便交接。 |
| `worker` | ✅ | 全部 | 实现/修复/重构/测试一个自包含任务。**内部先规划后动手。** |
| `reviewer` | ✅ | 只读 | 在独立上下文做对抗式提交前审查。 |
| `plan` | 可选 | 只读 | 产出可人工审阅的独立实现计划。worker 本就会内部规划，所以只在你需要把计划作为独立产物时才用它。 |

每个 agent 都是一个 Markdown 文件（`agents/*.md`：YAML frontmatter + 正文作为 system prompt）。
想覆盖任意一个，只需把同名 `name` 的文件放进 `~/.pi/agent/agents/`（用户级）或 `.pi/agents/`（项目级）。

## 主动派发是怎么工作的

pi 从不把每个 agent 的描述展示给主模型——它只看到 `subagent` 这个工具。三根杠杆解决这一点：

1. **`before_agent_start` 注入** —— 每一轮，把启用的 agent 加上一段派发/审查指令追加进父模型系统提示词。
2. **tool `promptSnippet` / `promptGuidelines`** —— 在工具激活时持续强化「何时该委派」。
3. **`Use PROACTIVELY when …` 描述** —— 在 Claude Code agent 生态被验证过的触发措辞。

这段指令会引导出一条干净的流程：**`explore` → `worker` → `reviewer`**，独立任务并行扇出，
以及「信任但需验证」的交接。

## 配置

存放在 `~/.pi/agent/pi-subagents.json`（尊重 `PI_CODING_AGENT_DIR`）：

```json
{
  "enabledAgents": ["explore", "worker", "reviewer"],
  "agentModels": { "explore": "anthropic/claude-haiku-4-5" },
  "proactiveInjection": true,
  "agentScope": "user"
}
```

- `enabledAgents` —— 哪些 agent 可被发现并注入。
- `agentModels` —— 每 agent 的模型覆盖（`"provider/model-id"`）。
- `proactiveInjection` —— 开关系统提示词注入。
- `agentScope` —— `"user"`（默认）、`"project"` 或 `"both"`。

**每个 agent 的模型优先级**：

```
agentModels[name]  →  当前 session 模型  →  agent frontmatter 里的默认
```

所以如果你在配置里没选模型，该 agent 就用主窗口当前的模型。

## 使用

主模型会自己调用 `subagent`，你也可以直接要求：

```text
# 单个
用 explore sub-agent 梳理一下认证是怎么接起来的。

# 并行（独立任务）
用并行 sub-agent 跑这两件：探索 API 层，以及探索 DB 层。
```

工具参数形态：

```jsonc
// 单个
{ "agent": "worker", "task": "<自包含的任务简报>" }
// 并行
{ "tasks": [ { "agent": "explore", "task": "..." }, { "agent": "explore", "task": "..." } ] }
```

## 开发

```bash
npm install
npm run check   # tsc --noEmit
npm test        # vitest
```

## 相关项目

- [pi-querit-search](https://www.npmjs.com/package/pi-querit-search) —— 为 pi 提供实时网络搜索与网页抓取，同一作者。

## 许可证

MIT
