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

## The Game

CC Idle is a productivity mirror: you are building a hyperscaler and the frontier
lab it powers, and the only engine is real delegated work. Telemetry maps to the
economy (see [docs/PRD-MECHANICS.md](docs/PRD-MECHANICS.md)):

- **Output tokens → Compute (FLOPS)** — with per-region diminishing returns, so grinding tokens visibly yields less
- **Successful Edit/Write/Bash → Engineering**; **Read/Search/Fetch → Research Data**
- **Failed tool calls → incidents** (mild regional debuff until acknowledged; the post-mortem pays a sliver of Engineering)
- **`SubagentStop` → training run completes**; **`Stop` → milestone shipped** (+Reputation, retroactive completion bonus)
- Each project folder is a **region** with its own infrastructure multiplier; regions persist across sessions

Spend Compute on GPUs → racks → datacenters, hire researchers (soft-gated by
Reputation), run experiments, and ship model generations: prestige resets
infrastructure and staff but banks permanent **Breakthroughs**.

In-game keys (all single-keypress, interruption-safe): `tab` cycle region,
`g`/`r`/`d` buy infrastructure, `h` hire, `e` experiment, `a` acknowledge
incident, `v` Breakthrough tree, `P` ship generation.

When no Claude Code session is working, the economy stops. There is no offline
progress, nothing purchasable with real money, and no timer that punishes
walking away.

### Balance tuning via replay

Economy constants live in a single file, `packages/game/src/balance.ts`, and are
tuned against recorded real sessions rather than guesses:

```bash
ccidle replay ~/.ccidle/events/<session>.jsonl          # instant, prints the economy report
ccidle replay a.jsonl b.jsonl --speed 60                # paced ×60, narrated live
ccidle replay session.jsonl --json --quiet              # machine-readable stats
```

## Repository Layout

- `packages/shared/src/` — event envelope types, state machine schema, zod validators, config schema, save-file abstraction
- `packages/game/src/` — pure game engine (balance constants, economy reducer, incidents, prestige, replay + economy report)
- `packages/daemon/src/` — ccidled (file watcher, state machine, tmux focus control, IPC socket, transcript reader, game host)
- `packages/tui/src/` — ccidle-tui (Ink/React CLI, session strip, game stage, lab panel, alert overlay)
- `packages/cli/src/` — ccidle CLI (installer, launcher, doctor, attach, register, replay commands)
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

Infrastructure (event bridge, focus orchestration, TUI shell, telemetry pipeline) and game mechanics phases M1–M3 (core economy, lab & prestige, incidents & narration) are implemented. M4 (the read-only web observatory) is deliberately deferred per the mechanics PRD. See [docs/PRD.md](docs/PRD.md) for the infrastructure specification and [docs/PRD-MECHANICS.md](docs/PRD-MECHANICS.md) for the game design.

## License

MIT
