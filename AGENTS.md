# pi-subagents agent instructions

Project-local rules. Pi appends these after the global
`~/.pi/agent/AGENTS.md`, so both are in context — when a rule here and a
global rule differ, treat the one here as the intended behavior for this repo.

## Release on green

After finishing a code change in this repo, once `npm run check` and `npm test`
both pass, finalize the work without waiting to be asked:

1. Bump the version in both `package.json` and `package-lock.json` (the root
   `version` field and the top `"packages": { "": { "version" } }` entry).
   - patch (`0.20.0` → `0.20.1`) for bug fixes
   - minor (`0.20.0` → `0.21.0`) for features / enhancements (default when unsure)
   - major only for breaking changes
2. Commit the change and the version bump together (one logical change per
   commit; `type(scope): imperative English`). Stage only paths from this task.
3. Push to the current branch's upstream.

Skip the automatic bump/commit/push only when the user explicitly says not to,
or when tests/checks fail (fix first, then finalize).

## Conventions

- Commits: `type(scope): imperative English`; types
  `feat|fix|refactor|docs|test|chore|perf|ci`. Keep one logical change per
  commit; stage only intended paths/hunks from this task.
- Never hardcode, log, or embed secrets.
