# PRD / Technical Spec — "CC Idle" Infrastructure

**Status:** Draft v1
**Scope:** Event bridge, focus orchestration, and TUI shell for a terminal idle game that runs alongside Claude Code. **Game mechanics are explicitly out of scope** — this spec covers everything up to (and including) a working placeholder game surface.

---

## 1. Problem & Vision

When Claude Code (CC) works autonomously, the human sits idle watching a scrolling log. CC Idle fills that dead time with a terminal idle game that:

1. **Takes the stage** when CC begins autonomous work.
2. **Runs off real telemetry** — CC's tool calls and lifecycle events drive the game's tick economy (mechanics later; the pipeline is built now).
3. **Gets out of the way instantly** when CC needs the human (permission prompt, question, turn complete), snapping focus back to the CC pane with a clear "you're needed" signal.

The product bet: the focus choreography must feel *seamless*. If switching is janky, no game on top will save it. Hence Phase 1 is entirely about the plumbing.

## 2. Goals / Non-Goals

**Goals**
- G1: Reliable, low-latency detection of CC state (working / needs-human / idle) via Claude Code hooks.
- G2: Automatic focus switching between the CC pane and the game pane with zero manual keystrokes in the happy path.
- G3: A durable, append-only event stream that any future game logic can consume (replayable, session-scoped).
- G4: Zero measurable slowdown of Claude Code (hooks are fire-and-forget, <10ms).
- G5: Graceful degradation: everything still works (minus auto-focus) without tmux.
- G6: Multi-session awareness: two CC sessions running simultaneously must not corrupt state.

**Non-Goals (for now)**
- NG1: Game mechanics, economy, progression, theme content (hyperscaler / frontier lab) — specced separately in [PRD-MECHANICS.md](PRD-MECHANICS.md).
- NG2: GUI / web frontend. Terminal only.
- NG3: Windows support. Target macOS + Linux, tmux-first.
- NG4: Historical analytics dashboards.

## 3. Architecture Overview

Four components, deliberately decoupled:

```
┌────────────────────┐   append JSONL    ┌──────────────────────┐
│ Claude Code hooks  │ ────────────────▶ │ Event stream         │
│ (tiny shell shims) │                   │ ~/.ccidle/events/    │
└────────────────────┘                   │   {session_id}.jsonl │
                                         └──────────┬───────────┘
                                                    │ tail -f (chokidar)
                                         ┌──────────▼───────────┐
                                         │ ccidled (daemon)     │
                                         │ - state machine      │
                                         │ - tmux focus control │
                                         │ - IPC socket for TUI │
                                         └──────────┬───────────┘
                                                    │ unix socket (ndjson)
                                         ┌──────────▼───────────┐
                                         │ ccidle-tui (Ink)     │
                                         │ placeholder game UI  │
                                         └──────────────────────┘
```

### 3.1 Hook shims (`hooks/`)
- One POSIX-sh script per hook event: `on-user-prompt-submit.sh`, `on-pre-tool-use.sh`, `on-post-tool-use.sh`, `on-stop.sh`, `on-notification.sh`, `on-subagent-stop.sh`, `on-session-start.sh`, `on-session-end.sh` (if available).
- Behaviour: read stdin JSON, enrich with `{ts, event, session_id, cwd, pane}`, append one line to the session's JSONL file, exit 0. `pane` is `$TMUX_PANE` (inherited from the CC process's environment; empty if not under tmux) — this is the primary session→pane mapping mechanism for multi-instance support. Verify inheritance during implementation; fall back to registration-time cwd matching if unavailable. **Never block, never write to stdout in a way CC interprets as a decision, never exit non-zero.**
- Registered in `.claude/settings.json` (project) or `~/.claude/settings.json` (global). Installer generates the JSON fragment.
- Budget: <10ms wall time. No node startup in the shim path — pure shell + `jq` (or shell-only fallback if jq absent).

### 3.2 Event stream (`~/.ccidle/events/`)
- Append-only JSONL, one file per CC `session_id` (from hook input).
- Canonical envelope:
```json
{"v":1,"ts":"2026-08-17T10:14:03.201Z","session_id":"<uuid>","event":"PostToolUse","tool":"Bash","cwd":"/path/to/repo","payload":{}}
```
- `payload` carries the raw (possibly truncated to 4KB) hook input for future mechanics use.
- Rotation: daemon compacts files >5MB into a summarised `.archive.jsonl`; live file truncated.

### 3.3 `ccidled` — orchestration daemon (TypeScript/Node)
- Watches the events directory; maintains a per-session state machine:

| State | Entered on | Exited on |
|---|---|---|
| `HUMAN_ACTIVE` | Notification, Stop, session start | UserPromptSubmit |
| `CC_WORKING` | UserPromptSubmit | Stop, Notification |
| `STALE` | no events for N min in CC_WORKING | any event |

- **Focus policy** (tmux, multi-instance):
  - Core rule: **the daemon only ever auto-moves focus when the user's cursor is currently in the game pane.** If the user is in any CC pane (or elsewhere), needs-you events never steal focus — they light the session strip, raise the banner, and ring the bell instead. Current pane checked via `tmux display -p '#{session_name}:#{window_index}.#{pane_index}'` at decision time.
  - `→ CC_WORKING` (the session whose pane you're in): after a grace delay (default 3s), switch to the game pane — but only if **no** tracked session is currently HUMAN_ACTIVE.
  - `→ HUMAN_ACTIVE` while user is in the game pane: focus that session's pane (full target `session:window.pane`, so cross-tmux-session jumps via `switch-client` work) in <500ms.
  - **Needs-you queue**: simultaneous HUMAN_ACTIVE sessions are queued FIFO in the TUI; keybinds `1..9` jump to the corresponding session's pane. Returning to the game pane after servicing one auto-offers the next.
  - Anti-flap: minimum dwell time (default 5s) between auto-switches; any manual focus change suppresses auto-switch for a cooldown.
- Exposes a Unix domain socket (`~/.ccidle/ccidled.sock`) speaking ndjson: pushes state transitions + raw events to any connected TUI; accepts commands (`pause-autofocus`, `resume`, `status`).
- Discovers CC/game panes via a registration step (see 3.5) rather than heuristics.
- Single instance enforced via pidfile/lockfile.

### 3.4 `ccidle-tui` — game shell (TypeScript, Ink)
- Connects to the daemon socket; renders:
  - Session strip: one row per active CC session with state, elapsed time in state, tool-call count this turn.
  - Placeholder "game" panel: a big tick counter incrementing on `PostToolUse` (proves the telemetry loop end-to-end).
  - Alert overlay: full-width inverse-video banner on `HUMAN_ACTIVE` transitions.
- Reconnects automatically if daemon restarts; renders a degraded "daemon offline" state.
- Keybinds: `q` quit, `f` toggle auto-focus, `s` cycle sessions. Nothing else yet.

### 3.5 Launcher (`ccidle up` / `ccidle attach`)
- One command that makes the whole thing feel like a product:
  1. Ensures daemon running (spawns if not).
  2. If inside tmux: splits/creates a window layout — CC pane + game pane — and **registers pane IDs with the daemon** (`ccidle register --role cc --pane %3`).
  3. If not inside tmux: starts a tmux session `ccidle` with the layout, or falls back to TUI-only mode (no auto-focus, banner + bell only).
  4. Optionally launches `claude` in the CC pane.
- `ccidle attach [--cwd <dir>]`: adds another CC instance to an already-running setup — opens a new pane/window for the given project, registers it, launches `claude`. There is exactly **one game pane** ("mission control") regardless of how many CC instances are attached; the session strip and needs-you queue scale to N. Running `ccidle up` inside an existing CC pane started outside the launcher performs registration-only (adopts the instance via its next hook event's `pane` field).

## 4. Telemetry Sources & Token Capture

Two complementary sources, both keyed by `session_id`:

**A. Hook event stream (already specced).** Every hook payload carries `session_id`, `transcript_path`, `cwd`, `hook_event_name` plus event-specific fields. Derivable without any extra work: tool-call counts by tool, bash commands run, files touched, lines added/removed (from Edit/Write `tool_input`), turns (UserPromptSubmit count), subagent completions, session lifecycle, model (from SessionStart).

**B. Transcript reader (new daemon module).** Raw token usage is NOT in hook payloads — it lives in the session transcript JSONL at `transcript_path`, which preserves the API's per-response usage data (input tokens, output tokens, cache read/write tokens, model). The daemon maintains a per-session byte offset and tail-parses only new transcript lines:
- On every `Stop`: parse new entries, emit a synthetic `TokenUsage` event into the same event stream (envelope `event:"TokenUsage"`, payload: usage deltas per model).
- During `CC_WORKING`: throttled poll (default every 10s) for live token ticking in the TUI.
- Hooks stay dumb — no transcript parsing in the <10ms shim path.
- Caveat: background subagent tool_responses carry no usage fields; their tokens are attributed only via the transcript.
- Cost estimation: optional static price table in config (`prices.json`), clearly marked approximate.

**Privacy/retention:** `tool_input`/`tool_output` payloads may contain secrets. Config gains `log.redactPatterns` (regex list applied before write, defaults covering common key/token formats) and `log.retentionDays` (default 30, archive compaction deletes beyond it). Transcript files are CC's own — read-only, never copied wholesale.

## 5. Tech Stack
- TypeScript / Node ≥20, single monorepo (`packages/daemon`, `packages/tui`, `hooks/`, `packages/shared` for event types + zod schemas).
- Ink (React for CLIs) for the TUI; chokidar for file watching; no DB — JSONL is the source of truth (SQLite can come with mechanics if needed).
- Hook shims: POSIX sh + jq. No Node in the hot path.
- Tests: vitest. Hook shims tested by piping fixture JSON.

## 6. Configuration (`~/.ccidle/config.json`)
```json
{
  "focus": {"enabled": true, "graceMs": 3000, "dwellMs": 5000},
  "alerts": {"bell": true, "banner": true},
  "tmux": {"autoLayout": true},
  "log": {"level": "info", "maxFileMB": 5}
}
```
All values overridable via env (`CCIDLE_*`).

## 7. Edge Cases & Risks
- **Hook events without matchers vs with**: `Stop` and `UserPromptSubmit` fire unconditionally; `Notification` should be filtered to human-attention matchers (permission/idle prompts) so auth noise doesn't yank focus. Verify exact matcher names against the current hooks reference during implementation.
- **Multiple sessions**: state machine and focus policy are per-session; focus contention resolved by "most recent HUMAN_ACTIVE wins", others queue in the TUI session strip.
- **Subagents**: `SubagentStop` must NOT trigger HUMAN_ACTIVE (parent still working). Recorded for telemetry only.
- **CC crash / killed pane**: STALE timeout returns focus to human and marks session dead after 2×N.
- **No tmux**: daemon detects absence at registration; auto-focus disabled; banner/bell path unchanged.
- **Hook path fragility**: installer writes absolute paths into settings.json; `ccidle doctor` command validates hooks fire (emits a synthetic test event).
- **CC version drift**: hook event names/schemas evolve; envelope is versioned (`"v":1`) and unknown events are stored, never dropped.

## 8. Phases

### Phase 0 — Scaffold (half a day)
Monorepo, shared event schema (zod), config loader, `ccidle doctor` skeleton, CI (lint + vitest).
**Done when:** `pnpm test` green; `ccidle doctor` reports environment (tmux? jq? claude?).

### Phase 1 — Seamless loop (the milestone that matters)
Hook shims + installer, event stream, daemon state machine, tmux focus control, launcher, placeholder TUI (session strip + tick counter + banner).
**Acceptance criteria:**
1. Run `ccidle up`, start a CC task → within graceMs of prompt submit, focus lands on the game pane without any keypress.
2. CC hits a permission prompt → focus returns to CC pane in <500ms with banner + bell.
3. CC finishes its turn (Stop) → same return behaviour.
4. Tick counter visibly increments during CC tool use, and a per-session token total updates within one poll interval (proves both telemetry paths: hook stream + transcript reader).
5. Three concurrent CC sessions in three different project folders tracked independently in the session strip; no cross-talk. While typing in session B's pane, session A going HUMAN_ACTIVE does NOT steal focus (banner/bell only). From the game pane, two simultaneous needs-you events are serviceable in order via the queue keybinds.
6. Measured hook overhead <10ms per event; CC feels unchanged.
7. Kill the daemon mid-run → TUI shows offline state; restart recovers from JSONL with correct session states.
8. Manual focus override respected (no fighting the user for the cursor).

### Phase 2 — Game-ready foundation
Only after Phase 1 "looks/feels good":
- Telemetry aggregation layer: rolling counters per session/day (tool calls by type, turns, subagent completions, lines changed, **input/output/cache tokens by model, estimated cost**) exposed over the socket as a stable read API.
- Persistence for game state: save-file abstraction (JSON, atomic writes) with schema versioning + migration stub.
- TUI layout system: reserve regions (header/session strip/main stage/alert layer) so the game slot-in doesn't require re-architecture.
- `ccidle replay <session.jsonl>` dev tool: replays an event file at configurable speed for developing mechanics without live CC runs.
**Done when:** a toy consumer can subscribe to aggregated telemetry and persist a counter across restarts, driven entirely by replay.

### Phase 3 — Game mechanics (separate PRD)
Hyperscaler / frontier-lab theme, economy design, progression. Deliberately unspecified here — see [PRD-MECHANICS.md](PRD-MECHANICS.md). Input contract: Phase 2's telemetry API and replay tool are the only interfaces mechanics may touch.

## 9. Open Questions
1. Window-level vs pane-level focus switching — pane feels slicker, window is more robust with user's existing tmux config. Default? (Proposal: pane within a dedicated window.)
2. Should `Stop` always pull focus back, or only when the turn ended with a question/needs-input? (Proposal: always in v1; refine with Notification matcher data later.)
3. ~~Global vs per-project hook install~~ **Resolved: global (`~/.claude/settings.json`)** — required for parallel work across arbitrary project folders without per-repo setup; per-project opt-out via config.
