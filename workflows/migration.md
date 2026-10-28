---
name: migration
description: Apply two already planned migration slices, then challenge the integrated result with the project gate.
---

# Migration workflow

Use this template after main has established the target, interface contract,
and disjoint writer scopes. If discovery determines those boundaries, run that
discovery first and decide in main; a static graph cannot rewrite its own nodes.
Replace <TARGET>, <CONTRACT> (the shared interface contract or its file path),
both slice briefs, and every example scope before running. Each child needs the
contract in its own brief because it cannot see main's conversation.
Each slice owns its implementation and regression tests. Keep coupled changes
with one owner. Use sentinel for a separate implementation review or skeptic
for a named assumption the gate cannot test; main owns final integration and release.

```json
{
  "nodes": [
    {
      "id": "apply-core",
      "agent": "artisan",
      "task": "Migrate the core slice to <TARGET>. <CORE_CHANGE>. Interface contract: <CONTRACT>. Follow the declared write scope. Implement the change and its regression tests together; run the relevant checks. Report changed paths, command results, and blockers. If the plan conflicts with the code or requires another slice's files, stop and report evidence rather than inventing a new scope.",
      "scope": { "paths": ["src/core", "test/core"] }
    },
    {
      "id": "apply-adapters",
      "agent": "artisan",
      "task": "Migrate the adapter slice to <TARGET>. <ADAPTER_CHANGE>. Interface contract: <CONTRACT>. Follow the declared write scope. Implement the change and its regression tests together; run the relevant checks. Report changed paths, command results, and blockers. If the plan conflicts with the code or requires another slice's files, stop and report evidence rather than inventing a new scope.",
      "scope": { "paths": ["src/adapters", "test/adapters"] }
    },
    {
      "id": "gate",
      "agent": "artisan",
      "task": "Challenge the integrated migration using the project's documented required checks. Interface contract: <CONTRACT>. Verify both slices meet their done conditions before proceeding; report missing prerequisites instead of guessing. Run the required commands; inspect cross-slice call sites for mismatches. Fix failures caused by this migration within its authorized scope. Report commands, results, and unverified risks.\n\nCore:\n{{apply-core}}\n\nAdapters:\n{{apply-adapters}}",
      "dependsOn": ["apply-core", "apply-adapters"],
      "scope": { "paths": ["src/core", "test/core", "src/adapters", "test/adapters"] }
    }
  ]
}
```
