---
name: code-review
description: Review a change from independent angles and return evidence-checked findings.
---

# Code review workflow

A mapping node establishes the target, two reviewers inspect it from different
angles, and a critic checks their findings and returns the final review. Use this
four-node template for a broad change that warrants independent review lenses;
for a small diff, use one reviewer and let main assess the findings.

Copy this file to `.pi/workflows/code-review.md` in the repository you are
reviewing. Two things are yours to set before you run it:

- Replace the review target in the `map` brief with the branch, commit range, or
  paths actually under review.
- Nothing else needs to change to start; the reviewers inherit the target from
  `{{map}}`.

Run it with `subagent_workflow({ "workflow": "code-review" })`, or by path with
`file: ".pi/workflows/code-review.md"`.

```json
{
  "nodes": [
    {
      "id": "map",
      "agent": "reviewer",
      "isolation": "shared",
      "task": "Read git diff and git status to establish what changed for a review of the working tree against HEAD, including staged and untracked changes. Stay read-only; do not edit files, install dependencies, or change Git state. Report: the changed files, what each change is trying to do, the call sites and tests that depend on them, and the checks the repository defines (package.json scripts, CI config, README verification line). Cite path:line for everything. Do not review quality yet."
    },
    {
      "id": "correctness",
      "agent": "reviewer",
      "isolation": "shared",
      "task": "You are the correctness reviewer. Using this map:\n\n{{map}}\n\nRead the changed code yourself and report what is wrong: logic errors, unhandled cases, broken invariants, missing tests that would catch a real failure. For each finding give path:line, what breaks, the concrete input or state that breaks it, and the smallest change that fixes it. Do not edit any file. Do not report style preferences.",
      "dependsOn": ["map"]
    },
    {
      "id": "risk",
      "agent": "reviewer",
      "isolation": "shared",
      "task": "You are the risk reviewer, with a different lens from the correctness reviewer. Using this map:\n\n{{map}}\n\nLook for what this change breaks outside its own diff: migrations and backward compatibility, concurrency and ordering, error paths, resource lifetime, security and data loss, and behaviour other modules rely on. Give path:line for each risk and say how likely it is to bite. Do not edit any file.",
      "dependsOn": ["map"]
    },
    {
      "id": "confirm",
      "agent": "critic",
      "isolation": "shared",
      "task": "Two reviewers reported findings. Try to disprove each one against callers, invariants, and tests. A review with no surviving findings is valid.\n\nCorrectness findings:\n{{correctness}}\n\nRisk findings:\n{{risk}}\n\nRun a safe focused reproduction when needed and available. Do not edit files, install dependencies, or change Git state. Classify each finding as reproduced (command and result), source-supported (code evidence, not executed), disproved (counterevidence), or unverified (missing evidence). Return the final review: a concise verdict, surviving actionable findings ordered by severity with path:line, trigger, consequence, evidence and smallest fix, then checks performed and material gaps. Keep rejected findings brief; do not promote unverified concerns to confirmed defects.",
      "dependsOn": ["correctness", "risk"]
    }
  ]
}
```
