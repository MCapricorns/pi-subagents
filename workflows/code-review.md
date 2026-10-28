---
name: code-review
description: Inspect an implementation, then challenge only the reported findings.
---

# Code review workflow

Use one `sentinel` run for an ordinary review. This two-node template is for a
substantial change where independent verification of findings earns another
session. The sentinel inspects the implementation; the skeptic checks its named
claims and returns the final review. They do not perform two general reviews.

Copy this file to `.pi/workflows/code-review.md` and replace `<TARGET>` with the
branch, commit range, or paths under review. Include any existing main research
and checks in the review brief so the sentinel can reuse them. If the first
result must decide whether a second phase is needed, dispatch only the sentinel
and make that decision in main.

Run with `subagent_workflow({ workflow: "code-review" })`, or use an explicit
`file` path. Omit isolation overrides for these read-only reviews.

```json
{
  "nodes": [
    {
      "id": "review",
      "agent": "sentinel",
      "task": "Review <TARGET> against the stated requirements and relevant callers. Establish the diff once, then inspect correctness, regressions, compatibility, and concrete failure paths within that target. Reuse existing research and valid checks; run a focused reproduction only to resolve a suspected defect. Stay read-only and do not change Git state. Return confirmed actionable findings with path:line, trigger, consequence, evidence, and smallest fix; include checks and material gaps. State clearly if no confirmed findings were found."
    },
    {
      "id": "verify",
      "agent": "skeptic",
      "dependsOn": ["review"],
      "task": "Test only the specific defect claims reported here:\n\n{{review}}\n\nTry to disprove each claim against its callers, invariants, or focused checks. Reuse valid evidence; do not repeat the general review. If there are no defect claims, report that and stop. Stay read-only and do not change Git state. Return the final review: surviving confirmed findings ordered by severity with trigger, consequence, evidence, and smallest fix; briefly state refuted or unresolved claims, checks, and remaining limits."
    }
  ]
}
```
