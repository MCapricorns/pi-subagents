# pi-subagents agent instructions

Project-local rules. Pi appends these after the global
`~/.pi/agent/AGENTS.md`, so both are in context — when a rule here and a
global rule differ, treat the one here as the intended behavior for this repo.

## Release on green

After finishing a code change in this repo, once `npm run check`
passes, finalize the work without waiting to be asked:

1. Choose the smallest release version and keep `package.json` plus
   `package-lock.json` synchronized (the root `version` field and the top
   `"packages": { "": { "version" } }` entry).
   - Reuse the current package version when it is already greater than the npm
     release and belongs to the same unpublished body of work; never bump the
     same pending release twice.
   - Otherwise increment only the patch segment for every change, including
     features and breaking changes (`7.0.0` → `7.0.1`). Keep major and minor fixed
     unless the user explicitly supplies a different release version.
   - Patch numbers have no digit limit: `7.0.99` → `7.0.100`, then `7.0.101`.
     Never roll a patch increment into the minor or major segment.
2. Commit the change and the version bump together as one logical change,
   following the commit conventions below.
3. Push to the current branch's upstream. A version that lands on `main` is
   published by `.github/workflows/publish.yml` and tagged as a GitHub
   Release — do not `npm publish` locally.

Before the commit, update the README when the change affects user-visible
behavior (widget display, tool messages, config, commands) — keep it in sync
with what users actually see.

Skip the automatic bump/commit/push only when the user explicitly says not to,
or when the check fails (fix first, then finalize).

## Leaf subagent exception

A leaf subagent never bumps versions, commits, pushes, publishes, tags, or releases.
The parent main agent owns those actions after integrating the child's work and
running the final gate. This exception overrides **Release on green** for leaves.

## Conventions

- Commits: `type(scope): imperative English`; types
  `feat|fix|refactor|docs|test|chore|perf|ci`. Keep one logical change per
  commit; stage only intended paths/hunks from this task.
- Never hardcode, log, or embed secrets.
