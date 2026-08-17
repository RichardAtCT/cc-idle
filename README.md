# CC Idle

A terminal idle game that runs alongside [Claude Code](https://claude.com/claude-code).

When Claude Code works autonomously, CC Idle takes the stage: a tmux-driven game pane
fed by real Claude Code telemetry (hook events, tool calls, token usage). The moment
Claude Code needs you — permission prompt, question, turn complete — focus snaps back
to the Claude Code pane with a clear "you're needed" signal.

## How It Works

CC Idle bridges Claude Code to a terminal game through four decoupled components:

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

- **Hook shims** (`hooks/`) capture Claude Code lifecycle events as POSIX shell scripts, appending them to an append-only JSONL event stream.
- **Event stream** (`~/.ccidle/events/{session_id}.jsonl`) stores canonicalized envelopes; daemon watches and rotates files.
- **ccidled daemon** maintains per-session state (HUMAN_ACTIVE, CC_WORKING, STALE), controls tmux focus, and exposes an IPC socket for the TUI.
- **ccidle-tui** (Ink/React CLI) renders the session strip, tick counter, and alert overlays, connecting over the daemon socket.

## Quick Start

Install dependencies and build:

```bash
pnpm install
pnpm build
```

Register hooks globally (makes CC Idle run automatically):

```bash
ccidle install
```

Launch the game pane alongside Claude Code:

```bash
ccidle up
```

This creates or attaches to a tmux session with CC pane + game pane, starts the daemon if needed, and registers both panes.

Verify the setup:

```bash
ccidle doctor
```

This checks for tmux, jq, node, and validates hook installation.

## Configuration

CC Idle reads `~/.ccidle/config.json`:

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
    "redactPatterns": ["sk-[A-Za-z0-9-]{10,}", "ghp_[A-Za-z0-9]{20,}", "..."]
  }
}
```

All values override via environment: `CCIDLE_FOCUS_ENABLED=false`, `CCIDLE_LOG_RETENTION_DAYS=7`, etc.

**Environment variables:**
- `CCIDLE_HOME` — config and events directory (default: `~/.ccidle`)

## Repository Layout

- `packages/shared/src/` — event envelope types, state machine schema, zod validators, config schema
- `packages/daemon/src/` — ccidled (file watcher, state machine, tmux focus control, IPC socket, transcript reader)
- `packages/tui/src/` — ccidle-tui (Ink/React CLI, session strip, tick counter, alert overlay)
- `packages/cli/src/` — ccidle CLI (installer, launcher, doctor, attach, register commands)
- `hooks/` — POSIX sh hook shims (on-session-start.sh, on-pre-tool-use.sh, etc.)

## Development

Build all packages:

```bash
pnpm build
```

Run tests:

```bash
pnpm test
```

Lint and typecheck:

```bash
pnpm lint
pnpm typecheck
```

**Requirements:** Node ≥20, pnpm 10.x, tmux, jq

## Status

Currently in infrastructure phase: event bridge, focus orchestration, TUI shell, and telemetry pipeline are implemented. Game mechanics (hyperscaler theme, economy, progression) are specified in a separate phase. See [docs/PRD.md](docs/PRD.md) for the full technical specification.

## License

MIT
