---
name: code-review
description: Review a change with independent eyes, confirm each finding, and report what was verified.
---

# Code review workflow

Two reviewers read the same change from different angles, a third agent then
tries to *disprove* every finding against the code, and the last node writes the
report the user keeps.

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
      "agent": "scout",
      "task": "Establish what changed and where it matters for a review of the working tree against HEAD. Report: the changed files, what each change is trying to do, the call sites and tests that depend on them, and the checks the repository defines (package.json scripts, CI config, README verification line). Cite path:line for everything. Do not review quality yet."
    },
    {
      "id": "correctness",
      "agent": "artisan",
      "task": "You are the correctness reviewer. Using this map:\n\n{{map}}\n\nRead the changed code yourself and report what is wrong: logic errors, unhandled cases, broken invariants, missing tests that would catch a real failure. For each finding give path:line, what breaks, and the concrete input or state that breaks it. Do not edit any file. Do not report style preferences.",
      "dependsOn": ["map"]
    },
    {
      "id": "risk",
      "agent": "artisan",
      "task": "You are the risk reviewer, with a different lens from the correctness reviewer. Using this map:\n\n{{map}}\n\nLook for what this change breaks outside its own diff: migrations and backward compatibility, concurrency and ordering, error paths, resource lifetime, security and data loss, and behaviour other modules rely on. Give path:line for each risk and say how likely it is to bite. Do not edit any file.",
      "dependsOn": ["map"]
    },
    {
      "id": "confirm",
      "agent": "scout",
      "task": "Two reviewers reported findings. Your job is to try to disprove them, not to agree.\n\nCorrectness findings:\n{{correctness}}\n\nRisk findings:\n{{risk}}\n\nFor each finding, read the cited code and decide: reproduced (state the evidence), wrong (say what the code actually does), or unverified (say what you could not check and why). Keep a finding only when the code supports it.",
      "dependsOn": ["correctness", "risk"]
    },
    {
      "id": "report",
      "agent": "artisan",
      "task": "Write the review the user acts on, from the confirmed findings only:\n\n{{confirm}}\n\nStructure it as: a two-sentence verdict, then each confirmed finding as where / what / evidence / severity, then what was checked and how, then what the review did not cover. Say plainly which findings were confirmed and which stayed unverified. Do not edit code; this node produces the report only.",
      "dependsOn": ["confirm"]
    }
  ]
}
```
