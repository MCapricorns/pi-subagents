# Changelog

Published versions of `@ferris1225/pi-subagents`. Unpublished numbers
(`4.2.3`, `4.2.6`, `4.2.9`–`4.2.11`) never shipped on npm; their changes
landed in the next published release.

## 4.2.13

- README: table of contents, a What's new lead-in, and a pointer at this
  changelog. Release notes describe the live `main` → npm path.

## 4.2.12

- Executor confirms each named defect on current code before editing.
- Footer settled counts stay on the line only while a sibling is live, and
  widget truncation no longer lies about what was cut.
- Merging to `main` publishes an unpublished `package.json` version to npm
  and opens a matching GitHub Release.

## 4.2.8

- Always-visible footer roll-up: `subagents 2 running · 1 repo lane · 3 done`.
- `wait: true` streams progress onto the tool card and reports child token
  spend as the call's own usage.
- Completions are held while context compaction rewrites history, then
  released on success, failure, or abort.
- A delivered result no longer enters the parent context a second time.
- Isolated worktrees link `node_modules`.
- Widget worktree badge is spelled out (`worktree:a91f3c`).

## 4.2.7

- Executor routing is a single self-contained deliverable; `thinking` can
  be set per dispatch.
- Child prompt temp directories are removed recursively.

## 4.2.5

- The threads manifest lives per project, beside that project's artifacts.

## 4.2.4

- Explorer findings are one-line retrieval leads.
- Worktree recovery retries cleanup when the patch was already applied.

## 4.2.2

- A single artifact the main agent must fully absorb stays an inline read;
  re-reads are bounded.

## 4.2.1

- Upgraded configs prune retired built-in roles so the setup wizard never
  mixes old and new names.

## 4.2.0

- Built-in team is `explorer` and `executor`. The old
  `worker` / `cleaner` / `documenter` / `synthesizer` / `reviewer` set is
  gone.
- Live widget splits each run into an identity line and a dim activity line.
