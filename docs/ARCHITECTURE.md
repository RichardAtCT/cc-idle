# Architecture — CC Idle Infrastructure

Engineering specification for the event bridge, state machine, focus orchestration, and telemetry pipeline that power CC Idle.
For the full product vision and phase roadmap, see [docs/PRD.md](PRD.md).

## Component Responsibilities

### 1. Hook Shims (`hooks/`)

Claude Code fires lifecycle events via configured commands in `~/.claude/settings.json` (global) or `.claude/settings.json` (project).
Eight POSIX shell scripts capture these events in <10ms per call:

- `on-session-start.sh` — session begins
- `on-pre-tool-use.sh` — before a tool invocation
- `on-post-tool-use.sh` — after tool completion
- `on-user-prompt-submit.sh` — human submits a prompt
- `on-stop.sh` — session ends
- `on-notification.sh` — permission prompt, idle alert, or other human attention
- `on-subagent-stop.sh` — subagent task completes (record only, not a session event)
- `on-session-end.sh` — session cleanup (if available)

**Behaviour:**
Each hook reads JSON from stdin, enriches with `{ts, event, session_id, cwd, pane}`, and appends one JSONL line to `~/.ccidle/events/{session_id}.jsonl`.
The `pane` field captures `$TMUX_PANE` (inherited from Claude Code's tmux environment), providing the primary session→pane mapping for multi-instance support.

**Constraints:**
- No blocking I/O, no stdout/stderr except for fatal errors.
- Must exit 0 (failures are logged but never propagate to Claude Code).
- Implementation uses shell + jq only; no Node startup (<10ms requirement).
- Output is captured and truncated to 4KB per envelope before write.

### 2. Event Stream (`~/.ccidle/events/`)

Append-only JSONL files (one per session_id) form the source of truth for all replayed state and telemetry.

**Canonical envelope format (v1):**
```json
{"v":1,"ts":"2026-08-17T10:14:03.201Z","session_id":"abc-123","event":"PostToolUse","tool":"Bash","cwd":"/home/user/project","pane":"%3","payload":{}}
```

Fields:
- `v` — envelope version (1); future-proofs against breaking changes.
- `ts` — ISO 8601 timestamp from the hook or daemon.
- `session_id` — Claude Code session UUID; groups all events for one CC instance.
- `event` — hook event name (SessionStart, PreToolUse, PostToolUse, UserPromptSubmit, Stop, Notification, SubagentStop) or daemon-synthetic (TokenUsage).
- `tool` — tool name (Bash, Bash.Write, Python.Read, etc.) if the event is tool-related.
- `cwd` — working directory from the hook context.
- `pane` — tmux pane ID ($TMUX_PANE) for multi-instance disambiguation; empty/absent outside tmux.
- `payload` — raw hook input JSON, possibly truncated; preserved for future analytics.

**Rotation & retention:**
- Live files are appended to continuously.
- When a live file exceeds 5MB, the daemon compacts it into `.archive.jsonl` with summary stats; live file truncated.
- Events older than `log.retentionDays` (default 30) are deleted during compaction.

### 3. ccidled Daemon

Node.js process that watches the events directory, maintains per-session state, orchestrates tmux focus, and exposes the TUI socket.

**State machine (per-session):**

| State | Entered on | Exited on | Notes |
|---|---|---|---|
| HUMAN_ACTIVE | Notification, Stop, session start | UserPromptSubmit | Human needs attention or is present. |
| CC_WORKING | UserPromptSubmit | Stop, Notification | CC is autonomous; hold the game pane. |
| STALE | no events for N min in CC_WORKING | any event | CC might have crashed; fail-safe timeout. |
| DEAD | no events for 2×N min in CC_WORKING | (terminal; pruned from tracking) | Session presumed gone; clean up. |

**Focus policy (tmux multi-instance):**

The daemon only auto-moves focus when the user's cursor is currently in the game pane. If the user is in any CC pane or elsewhere, needs-you events light the session strip and ring the bell—they never steal focus.

- **Transition to CC_WORKING** (the session whose pane is tracked): After a grace delay (default 3s), focus switches to the game pane, but only if no other tracked session is HUMAN_ACTIVE.
- **Transition to HUMAN_ACTIVE while user is in game pane:** Focus that session's pane (full tmux target `session:window.pane`) in <500ms. Cross-tmux-session jumps use `switch-client`.
- **Needs-you queue:** Multiple simultaneous HUMAN_ACTIVE sessions queue FIFO in the TUI; keybinds `1..9` jump to the corresponding session's pane. Returning to the game pane after servicing one automatically presents the next.
- **Anti-flap:** Minimum 5s dwell time (default) between auto-switches. Any manual focus change suppresses auto-switch for a cooldown period.

**Pane discovery:**
The daemon does not use heuristics; it learns pane IDs via explicit registration:
- `ccidle register --role cc --pane %3` — binds a pane to a CC session.
- The next event from that session's hooks carries `pane` field; daemon matches it to the registration.
- Fallback (if pane not registered): match on cwd from hook events.

**Multi-instance handling:**
- Each session_id has independent state and event stream.
- Pane contention: the daemon tracks which pane is currently focused via `tmux display -p '#{session_name}:#{window_index}.#{pane_index}'`.
- Single daemon enforces via pidfile/lockfile (one ccidled per host).

**IPC socket (`~/.ccidle/ccidled.sock`):**
- Unix domain socket speaking newline-delimited JSON (ndjson).
- Pushes: state transitions (`{type:"StateTransition",sessionId:"...",newState:"CC_WORKING",...}`), raw events.
- Commands: `pause-autofocus`, `resume`, `status`.
- Automatically reconnects if daemon restarts.

### 4. Telemetry: Two Paths

**A. Hook event stream** (already described):
Provides tool-call counts, command names, file edits, turn count, session lifecycle, model, subagent completions—all derivable from the envelope stream without parsing CC internals.

**B. Transcript reader (daemon module):**
Raw token usage is not in hook payloads; it lives in the session transcript JSONL (`~/.claude/.../{session_id}/transcript.jsonl`), which preserves the Claude API's per-response usage data (input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, model).

- The daemon maintains a per-session byte offset into the transcript file.
- On every `Stop` event: parse new transcript entries; emit a synthetic `TokenUsage` envelope into the event stream with usage deltas per model.
- During `CC_WORKING`: throttled poll (default 10s) for live token ticking in the TUI (reflects in-flight requests).
- Hooks never parse the transcript (stays in <10ms budget); transcript parsing lives only in the daemon.

**Why two paths?**
- Hooks cannot capture token usage (not available in CC's hook input; requires parsing the transcript file).
- Transcript reading is daemon-only because hooks must stay fire-and-forget.
- Combining both: hook stream counts tool calls; transcript reader tallies tokens.

**Privacy & retention:**
Tool payloads may contain secrets (API keys, passwords). The daemon:
- Applies `log.redactPatterns` (regex list, defaults: `password`, `token`, `api_key`, `secret`) before writing to disk.
- Enforces `log.retentionDays` (default 30) during archive compaction.
- Never copies transcript files wholesale; only reads them (via byte offset) for token extraction.

### 5. ccidle-tui (Ink/React CLI)

Terminal UI for game mechanics and session monitoring. Connects to daemon socket; renders:

- **Session strip:** One row per active CC session; columns show state (HUMAN_ACTIVE/CC_WORKING/STALE), elapsed time in state, tool-call count this turn, last tool, token total, session cwd/pane.
- **Placeholder game panel:** Big tick counter (increments on `PostToolUse` events) to prove the telemetry loop end-to-end.
- **Alert overlay:** Full-width inverse-video banner that flashes on `HUMAN_ACTIVE` transitions ("Session 1 needs you!"); accompanied by a bell ring if configured.

**Keybinds:**
- `q` — quit
- `f` — toggle auto-focus
- `s` — cycle sessions
- `1..9` — jump to corresponding session's CC pane (from needs-you queue)

**Robustness:**
- Reconnects to daemon socket automatically if it restarts.
- Degraded rendering if daemon is offline ("daemon offline, awaiting reconnect").

### 6. Launcher & Registration (`ccidle install`, `ccidle up`, `ccidle attach`)

Stitches the components together into a seamless product experience.

**`ccidle install`:**
- Writes hook shim paths into `~/.claude/settings.json` (global, so all CC instances inherit).
- Generates the hook configuration JSON fragment pointing to the actual scripts.

**`ccidle up`:**
1. Ensures daemon is running (spawns if not).
2. If inside tmux: splits/creates a window layout (CC pane + game pane) and registers pane IDs with the daemon.
3. If not in tmux: starts a tmux session `ccidle` with the layout, or degrades to TUI-only mode (no auto-focus, but banner + bell still work).
4. Optionally launches `claude` in the CC pane.

**`ccidle attach [--cwd <dir>]`:**
- Adds another CC instance to an already-running setup.
- Opens a new pane/window for the given project, registers it, launches `claude`.
- There is exactly **one game pane** ("mission control") regardless of N concurrent CC instances.

**Registration flow:**
- Pane IDs are registered via `ccidle register --role cc --pane %3` (called by the launcher or manually).
- Daemon stores the mapping; next hook event from that session includes `pane`, completing the loop.

## Failure Modes & Resilience

| Mode | Cause | Recovery |
|---|---|---|
| No tmux | Not running in a tmux session | Auto-focus disabled; banner + bell still work. |
| Daemon killed | ccidled process terminated | TUI shows "daemon offline"; next event respawns daemon. Session state recovered from JSONL. |
| CC crash / killed pane | Claude Code process dies | No events arrive. After STALE timeout (2×N minutes), session marked DEAD. |
| Version drift | CC changes hook event names/schemas | Envelope versioned (`v:1`); unknown events stored, never dropped. Future CC versions can be read. |
| Concurrent CC instances | Two CC sessions in separate folders | Each has independent session_id, event stream, and state. Pane field prevents cross-talk. |

## Multi-Session Example

Alice runs two CC instances in separate tmux panes:
1. `ccidle up` in `/home/alice/project-a` → registers CC pane %1, game pane %2.
2. `ccidle attach --cwd /home/alice/project-b` in a different terminal → opens CC pane %3.

Game pane %2 is shared (singleton). Session strip shows:
```
[ALICE-PROJECT-A: CC_WORKING, 0.5s, 3 tool calls, last: Bash]
[ALICE-PROJECT-B: HUMAN_ACTIVE, 0.2s, needs you!]
```

Alice is in pane %3 (project-b). Project-a goes HUMAN_ACTIVE (permission prompt): no focus steal (she's not in game pane). Banner + bell only. Keybind `1` jumps to %1 (project-a's CC pane). After resolving the prompt, keybind `2` returns to the game pane and offers the next queue entry.

## Configuration Schema

`~/.ccidle/config.json` (all fields optional; defaults listed):

```json
{
  "focus": {
    "enabled": true,
    "graceMs": 3000,
    "dwellMs": 5000
  },
  "alerts": {
    "bell": true,
    "banner": true
  },
  "tmux": {
    "autoLayout": true
  },
  "log": {
    "level": "info",
    "maxFileMB": 5,
    "retentionDays": 30,
    "redactPatterns": ["password", "token", "key", "secret", "api_key"]
  }
}
```

Environment overrides: `CCIDLE_FOCUS_ENABLED`, `CCIDLE_LOG_RETENTION_DAYS`, etc.
Home override: `CCIDLE_HOME` (default: `~/.ccidle`).

## Testing & Validation

- **Hook shims:** Tested via shell syntax check (`sh -n hooks/*.sh`); fixture JSON piped to validate behavior.
- **State machine:** Unit tests for transitions and event ordering (vitest).
- **Telemetry:** Integration tests verify event stream parsing, JSONL format correctness, token tallying.
- **Focus policy:** Manual testing with multiple tmux panes; automated focus-steal prevention checks.
- **Multi-instance:** Separate JSONL streams, pane IDs, session state isolation verified.

## Relationship to Product Phases

- **Phase 0 (Scaffold):** Infrastructure, CI, zod schemas, config loader, `ccidle doctor`.
- **Phase 1 (Seamless loop):** This document; the full event bridge, state machine, focus control, placeholder TUI.
- **Phase 2 (Game-ready):** Telemetry aggregation API, save-file persistence, TUI layout system, replay tool.
- **Phase 3 (Game mechanics):** Hyperscaler theme, economy, progression (separate PRD; uses only Phase 2's APIs).

---

**Source:** [docs/PRD.md](PRD.md), §1–9. Last updated: August 2026.
