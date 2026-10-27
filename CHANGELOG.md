# Changelog

## 5.0.0

### Breaking changes

- Run children through Pi's native `--mode json` CLI instead of the custom RPC
  transport. Pi owns provider adapters, retries, and session persistence.
- Cancelling the parent stops its child work. Aborted awaited results no longer
  return through background completion.
- Conversation-tree navigation stops unfinished work. New/resume/fork/reload
  ends old children and retains interrupted artifacts for manual recovery.

### Changes

- Restore ordinary subagent completion delivery.
- Fix workflow isolation, transitive result interpolation, output limits, and
  failure propagation. Checkpoint live graphs and reserve pending phases.
- Share cancellation and worktree finalization across runs and graphs. Stop all
  writers before waiting for cleanup.
- Show graph progress, dependency waits, queue reasons, failures, and blocked
  nodes in the widget.
- Keep adversarial review, independent confirmation, and synthesis flexible.
  Keep fixes with their tests and use command-capable roles for reproduction.
- Validate saved definitions before dispatch, reject unfilled templates, and
  honor call-level name and description overrides.
