---
name: code-review
description: Review a change with independent eyes, confirm each finding, and report what was verified.
---

# Code review workflow

Two reviewers read the same change from different angles, a third agent then
tries to *disprove* every finding against the code, and the last node writes the
report the user keeps. This saved template chooses a thorough adversarial review;
for a small diff, combine the map with a reviewer and let main write the report.

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
      "agent": "artisan",
      "isolation": "shared",
      "task": "Read git diff and git status to establish what changed for a review of the working tree against HEAD, including staged and untracked changes. Stay read-only; do not edit files, install dependencies, or change Git state. Report: the changed files, what each change is trying to do, the call sites and tests that depend on them, and the checks the repository defines (package.json scripts, CI config, README verification line). Cite path:line for everything. Do not review quality yet."
    },
    {
      "id": "correctness",
      "agent": "artisan",
      "isolation": "shared",
      "task": "You are the correctness reviewer. Using this map:\n\n{{map}}\n\nRead the changed code yourself and report what is wrong: logic errors, unhandled cases, broken invariants, missing tests that would catch a real failure. For each finding give path:line, what breaks, and the concrete input or state that breaks it. Do not edit any file. Do not report style preferences.",
      "dependsOn": ["map"]
    },
    {
      "id": "risk",
      "agent": "artisan",
      "isolation": "shared",
      "task": "You are the risk reviewer, with a different lens from the correctness reviewer. Using this map:\n\n{{map}}\n\nLook for what this change breaks outside its own diff: migrations and backward compatibility, concurrency and ordering, error paths, resource lifetime, security and data loss, and behaviour other modules rely on. Give path:line for each risk and say how likely it is to bite. Do not edit any file.",
      "dependsOn": ["map"]
    },
    {
      "id": "confirm",
      "agent": "artisan",
      "isolation": "shared",
      "task": "Two reviewers reported findings. Your job is to try to disprove them, not to agree.\n\nCorrectness findings:\n{{correctness}}\n\nRisk findings:\n{{risk}}\n\nFor each finding, look for a counterexample in callers, invariants, and tests. Run a safe focused reproduction when needed and available. Do not edit files, install dependencies, or change Git state. Classify it as reproduced (command and result), source-supported (code evidence, not executed), disproved (counterevidence), or unverified (missing evidence). Return surviving findings with severity and the evidence that would falsify them.",
      "dependsOn": ["correctness", "risk"]
    },
    {
      "id": "report",
      "agent": "scout",
      "task": "Write the review the user acts on, from the surviving findings and evidence:\n\n{{confirm}}\n\nStructure it as: a two-sentence verdict, then each surviving finding as where / what / evidence / severity, then what was checked and how, then what the review did not cover. Say plainly which findings were confirmed and which stayed unverified. Do not edit code; this node produces the report only.",
      "dependsOn": ["confirm"]
    }
  ]
}
```
