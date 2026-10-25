---
name: migration
description: Map a migration, plan it, change disjoint slices in parallel, then run the project gate.
---

# Migration workflow

One node finds the ground truth, one plans, two independent slices are changed
at the same time, and one gate decides whether the migration is done.

The two `apply` nodes run concurrently, so they must touch disjoint paths:
replace the example `scope.paths` with the directories each slice owns. The
compile step rejects the graph if those scopes overlap without a dependency
between them.

```json
{
  "nodes": [
    {
      "id": "map",
      "agent": "scout",
      "task": "Map the migration to <TARGET>: every module that must change, where the old API is used, the tests that cover it, and the project's verification commands. Cite path:line. Do not change anything."
    },
    {
      "id": "plan",
      "agent": "artisan",
      "task": "Plan the migration in slices that two agents can do concurrently without touching each other's files, in dependency order. For each slice: the paths it owns, the exact change, and the check that proves it.\n\n{{map}}",
      "dependsOn": ["map"]
    },
    {
      "id": "apply-core",
      "agent": "artisan",
      "task": "Implement the core slice of this plan and nothing outside the paths you own. Run the checks that slice needs.\n\n{{plan}}",
      "dependsOn": ["plan"],
      "scope": { "paths": ["src/core"] }
    },
    {
      "id": "apply-adapters",
      "agent": "artisan",
      "task": "Implement the adapter slice of this plan and nothing outside the paths you own. Run the checks that slice needs.\n\n{{plan}}",
      "dependsOn": ["plan"],
      "scope": { "paths": ["src/adapters"] }
    },
    {
      "id": "gate",
      "agent": "artisan",
      "task": "Run the repository's own verification: install if needed, then the full test suite, typecheck, and build the project defines. Fix only what the migration broke, in the smallest correct way. Report each command with its result, and say plainly if something is still failing.\n\nCore slice:\n{{apply-core}}\n\nAdapter slice:\n{{apply-adapters}}",
      "dependsOn": ["apply-core", "apply-adapters"]
    }
  ]
}
```
