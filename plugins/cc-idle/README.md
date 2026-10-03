# cc-idle (Claude Code mod)

CC Idle as a [Claude Code mod](https://code.claude.com/docs/en/plugins/mods/overview): the
game runs in a pane beside the transcript, fed by Claude Code's own events. No tmux, no daemon,
no hook shims.

Requires Claude Code v2.1.287 or later.

## Install

```text
/plugin marketplace add RichardAtCT/cc-idle
/plugin install cc-idle@cc-idle
```

Or try it from a clone for one session: `claude --plugin-dir ./plugins/cc-idle`.

To pick up new commits from `main` inside Claude Code, refresh the marketplace, then load the new
version into the running session. No restart is needed.

```text
/plugin marketplace update cc-idle
/reload-plugins
```

If the new version does not appear, type `/plugin`, open cc-idle under the installed plugins, choose
update, then run `/reload-plugins` again. From a shell, the same update is:

```text
claude plugin marketplace update cc-idle && claude plugin update cc-idle@cc-idle
```

`plugin.json` sets no `version` on purpose. Claude Code then uses the commit SHA as the version,
so every merge to `main` is an update. `claude plugin validate` warns about the missing version;
ignore that warning.

## Play

- In a terminal at least 144 columns wide, the pane opens beside the transcript by itself.
  Anywhere else, type `/idle`. It works mid-turn, so you can play while Claude works. Until you
  have played once, a toast tells you so.
- The first time, the pane shows a welcome that explains the game. After that, a yellow
  `→` line under the header names the next useful move when there is one.
- `/idle` also gives the pane the keyboard. **Esc** hands it back to the prompt. `/idle close`
  closes the pane.
- When Claude finishes a turn, asks a question or needs permission, a banner at the top of the
  pane says so.
- Your Compute and generation also show on the status line, even with the pane closed.

| Key | Action |
| --- | --- |
| `g` / `r` / `d` | Buy a GPU / rack / datacenter in the focused region |
| `a` | Acknowledge the region's incident (the post-mortem pays engineering) |
| `n` | Next region |
| `h` | Hire a researcher |
| `e` | Run an experiment |
| `s` | Ship the generation (asks `y` / `n` first) |
| `v` | Breakthrough tree (`1`–`6` buy, `v` back) |
| `c` | Talk to the board (Enter on an empty line goes back) |
| `i` | How to play (`i` back) |

The original TUI's `tab` and `P` became `n` and `s`, because a mod's hotkeys must be a single
lowercase letter or digit, and Tab and the arrow keys stay Claude Code's.

## The board

A board member of your lab lives in the pane. It is Haiku, run through your own Claude Code
session, so each line it says is one small Haiku call on your account.

- Press `c` to open the board, type a short line (80 characters at most) and press Enter. It
  answers in one line. The text field takes every key, so Enter on an empty line goes back to
  the game. Esc hands the keyboard to the prompt, as on every screen.
- It knows the rules, so it doubles as help: ask "what does diminishing returns mean?" and it
  answers from the game's real balance numbers.
- The first time you meet a mechanic (an incident, diminishing returns, a second region, a
  shippable model, Breakthroughs to spend), it explains it once, unasked. It never repeats one.
- It also reacts by itself to big moments: a region founded, a generation shipped, a
  breakthrough, an incident. It does so at most once a minute, and only while the pane is in view.
  Unasked lines share that limit. Its last word shows under the hint on the main screen.
- The chat stays in this session. It is not part of the shared save.

## How it works

| Claude Code event | Becomes | Economy |
| --- | --- | --- |
| `turn.start` (main loop) | `UserPromptSubmit` | the region is hot; the turn's accrual starts |
| `turn.step` (every model request, subagents too) | `TokenUsage` | output tokens → Compute, live |
| `tool.call` succeeded | `PostToolUse` | Edit/Write/Bash → engineering, Read/Search/Fetch → research data |
| `tool.call` errored | `PostToolUse` (failed) | an incident |
| `turn.complete` (subagent) | `SubagentStop` | a training run |
| `turn.complete` (main, answered) | `Stop` | milestone shipped: completion bonus and reputation |
| `session.end` | `SessionEnd` | the session leaves its region |

The mod builds the same v1 envelopes the shell hooks wrote, so the engine in `packages/game`, its
balance constants and the replay/backtest tooling are unchanged.

**One economy for all your sessions.** Every Claude Code session running the mod shares one save
in `$.store`. Each session applies events locally at once, then about a second later re-reads the
save, replays its queued events on top and writes it back. Every 5 seconds it picks up the other
sessions' writes. Only a write that lands between another session's read and its write is lost.

**What it touches.** `claude plugin validate plugins/cc-idle` lists every call the mod makes:
`$.store`, `$.state`, `$.ui`, `$.clock`, `$.model.complete`, `$.command.register`, `$.session.id`
and `$.session.cwd`. Its only model calls are the board's Haiku calls. It makes no filesystem,
network or process calls. It never denies or rewrites a tool call,
prompt or turn: every hook passes its event on unchanged.

## Developing

`hooks/register.js` is generated. Its sources are in `packages/mod/src`, bundled with the pure
game engine and zod by `pnpm --filter @ccidle/mod build`. A mod loads no packages and has no Node,
so everything it needs travels in that one file.

```bash
pnpm --filter @ccidle/mod build      # regenerate hooks/register.js
pnpm --filter @ccidle/mod test       # sync, telemetry and view unit tests (vitest)
pnpm --filter @ccidle/mod typecheck  # against the mods API types in packages/mod/types
claude plugin validate plugins/cc-idle
claude plugin test plugins/cc-idle   # hooks and pane tests in Claude Code's own test engine
```

`packages/mod/types/claude-code.d.ts` is the mods API declaration file that Claude Code 2.1.287
writes. When Claude Code updates, copy in the new one; don't edit it by hand.
