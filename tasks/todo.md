# Review findings: daemon replay + log rotation

Branch `fix/review-findings`, cut from `fix/hook-macos-timestamp` (PR #6 still open).

## Scope

This PR fixes the watcher offset bookkeeping only. The other review findings go to later PRs.

## Verified

- Replay double count. Three restarts with an unchanged 100-token transcript gave 1, 2, 3 TokenUsage lines. Expected: 1.
- Replay also runs `transition()`, so focus moves and game state changes fire for old events. Seen in code.

## Plan

### Replay (daemon.ts, transcripts.ts, shared/events.ts)
- [x] Add a `replaying` flag. It is true until `watcher.start()` resolves.
- [x] During replay, skip `transition()` and the Stop poll. Keep `applyEvent`, `setTranscriptPath` and `gameHost.handleEnvelope`.
- [x] After replay, send each session's final state to `gameHost.handleStateChange` once.
- [x] TokenUsage payload gets optional `transcriptPath`, `transcriptOffset` and `lastKey`. `poll()` writes them.
- [x] On a replayed TokenUsage with a matching path, resume the reader at that offset and seed `seen` with `lastKey`.
- [x] After replay, skip a transcript to its current end only when its last TokenUsage has no offset (legacy logs). A session with no TokenUsage starts at 0.
- [x] `poll()` advances the offset only after the append succeeds.
- [x] Add `.finite()` to the token counts.

### Rotation (rotation.ts, watcher.ts, game-host.ts)
- [x] Rename the live file to `{session}.rotating`, not copy-truncate.
- [x] The watcher drains the renamed file from the live offset and emits under the live path.
- [x] Then reset the offset, reset the game cursor, append to the archive, and delete the temp file.
- [x] `handleFileReset` saves the game at once.

### Tests (each fails without its fix)
- [x] Daemon restart test: replayed Stops add no TokenUsage over three starts. A live Stop counts the transcript once. Usage written while down is counted once.
- [x] Replay does not call `transition()`. Inject the tmux client into `startDaemon` and assert no pane moves.
- [x] Rotation test: write N lines, the watcher consumes K, rotate, all N are emitted and archived.
- [x] `poll()` append failure keeps the offset.

### Finish
- [x] Rebuild the mod bundle if shared changes affect it.
- [x] Lint, typecheck, tests. Commit and push. Open PR against `fix/hook-macos-timestamp`.

## Review

- Every new test failed against the pre-fix code and passes now. Each was checked one file at a time.
- Old code with the replay guard removed: three restarts wrote TokenUsage `[100, 100, 100]` for one unchanged transcript.
- Old rotation lost the lines appended just before a rotation (E3, E4 in the test).
- All package tests, typecheck and lint pass. The mod bundle is rebuilt; its diff is only the schema change.
- Left open: a crash between the rename and the archive append leaves `{session}.jsonl.rotating` behind. Its unread events are not replayed.
