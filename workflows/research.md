---
name: research
description: Research a question from independent angles, synthesise the answer, then verify its factual claims.
---

# Research workflow

Three researchers take different angles, a synthesis node turns them into one
answer, and a verification node checks the claims that would embarrass you if
they were wrong.

Set your question in the three researcher briefs (they run concurrently), then
run `subagent_workflow({ "workflow": "research" })`.

```json
{
  "nodes": [
    {
      "id": "primary",
      "agent": "scout",
      "task": "Research <QUESTION> from first-party sources only: official documentation, specifications, release notes, and the project's own repository. Record versions and dates. Cite every fact you state. Mark anything you could only find second-hand."
    },
    {
      "id": "practice",
      "agent": "scout",
      "task": "Research <QUESTION> from practice: issue threads, migration notes, benchmarks, and post-mortems that describe what actually happened when people used it. Separate reported experience from vendor claims and cite each source."
    },
    {
      "id": "codebase",
      "agent": "scout",
      "task": "Establish what this repository already does about <QUESTION>: the relevant modules, configuration, and tests, with path:line citations. State where the code disagrees with the documentation if you find such a place."
    },
    {
      "id": "synthesis",
      "agent": "artisan",
      "task": "Answer <QUESTION> from these three research passes. Reconcile disagreements explicitly instead of averaging them, and prefer first-party evidence over practice reports when they conflict.\n\nFirst-party:\n{{primary}}\n\nPractice:\n{{practice}}\n\nThis repository:\n{{codebase}}\n\nWrite: the answer, the evidence behind it, the open questions, and what would change the answer.",
      "dependsOn": ["primary", "practice", "codebase"]
    },
    {
      "id": "verify",
      "agent": "scout",
      "task": "Check the decisive factual claims in this answer against their sources. Report only claims you could not confirm or that are stale, with what you found instead.\n\n{{synthesis}}",
      "dependsOn": ["synthesis"]
    }
  ]
}
```
