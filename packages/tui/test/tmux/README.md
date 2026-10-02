# TUI terminal harness

Tools for the class of defect where Ink's idea of a frame disagrees with what
the terminal draws.

## The defect

Ink repaints by moving the cursor up by the number of rows it believes it wrote.
If the terminal emits more rows than Ink counted, the surplus is never erased.
At one tick per second those rows pile up as scrollback, and the TUI appears to
scroll instead of updating in place.

Two things cause the terminal to emit extra rows:

1. **A glyph drawn wider than Ink budgets for it.** `⚡` (U+26A1) is the case
   that bit us: Ink padded its row to the box width assuming one cell, the
   terminal drew two, and the row wrapped. It was replaced with `↯` (U+21AF).
2. **A frame taller than the viewport.** `src/layout.ts` budgets rows and clips
   the feed and incident list so this cannot happen.

`string-width` is **not** a usable oracle here. It disagrees with the terminal in
both directions — it scores `✔ ▪ ☺ ⚠ ▶ ⚙` as two cells when the terminal draws
one — and Ink's own padding does not follow it consistently. Measure in a real
terminal instead.

## Tools

| File | Purpose |
| --- | --- |
| `scrollback.test.ts` | The automated backstop. Runs the TUI in a real tmux pane and asserts nothing ever reaches scrollback. Skips when tmux is absent. |
| `render-harness.mjs` | Renders the real `App` into a TTY, fed by a fake daemon client and a game state replayed from an event file. |
| `probe-width.mjs` | Measures how many cells the terminal actually gives a glyph. |
| `pad-check.mjs` | Shows how Ink pads a row containing a glyph: string length vs `string-width` vs box width. |
| `inventory.mjs` | Lists every distinct non-ASCII glyph the App renders, for maintaining the allow-list in `../glyph-width.test.tsx`. |

## Adding a glyph to the UI

Measure it before you use it. From `packages/tui`:

```
tmux new-session -d -s probe -x 40 -y 20 "node test/tmux/probe-width.mjs '<glyph>' && sleep 30"
tmux capture-pane -t probe -p
tmux kill-session -t probe
```

The glyph's row must not wrap its final pad character onto the next line. Then
confirm Ink pads it to the box width:

```
node test/tmux/pad-check.mjs '<glyph>'
```

`stringWidth` must equal `boxWidth`. Only then add it to `APPROVED_GLYPHS` in
`../glyph-width.test.tsx`.

## Reproducing by hand

```
tmux new-session -d -s repro -x 120 -y 24 "RUN_MS=60000 node test/tmux/render-harness.mjs test/fixtures/scrollback-session.jsonl"
tmux capture-pane -t repro -p -S - | wc -l    # must stay at 24
tmux capture-pane -t repro -p                 # borders must all close
```
