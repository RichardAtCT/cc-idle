import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Guards the defect class behind the TUI repaint bug.
 *
 * Ink pads each row so the row fills its box, then repaints by moving the
 * cursor up by the number of rows it believes it wrote. If a row's *rendered*
 * width exceeds the box, the terminal wraps it onto a second physical row that
 * Ink never counted — so the erase falls short and, at one tick per second, the
 * leaked rows pile up as permanent scrollback.
 *
 * `⚡` (U+26A1) did exactly this: Ink budgeted one cell for it, the terminal
 * drew two, and every incident row wrapped.
 *
 * The oracle is a real terminal, not `string-width`. `string-width` disagrees
 * with the terminal in both directions here — it scores `✔ ▪ ☺ ⚠ ▶ ⚙` as two
 * cells when the terminal draws one, and Ink's own padding does not follow it
 * consistently (see test/tmux/pad-check.mjs, which shows `⚡` padded to a
 * 41-cell row inside a 40-cell box while `＋`, also scored two, comes out
 * correct). So every glyph below was measured in a live terminal.
 *
 * To add a glyph, measure it first:
 *   tmux new-session -d -s probe -x 40 -y 20 "node test/tmux/probe-width.mjs '<glyph>' && sleep 30"
 *   tmux capture-pane -t probe -p
 * The row must not wrap its final pad character onto the next line. Then run
 * test/tmux/pad-check.mjs to confirm Ink pads the row to the box width.
 * Do not add a glyph without both checks; test/tmux/scrollback.test.ts is the
 * end-to-end backstop.
 */
const APPROVED_GLYPHS = new Set([
  ...'·×Σ—§…', // punctuation and units
  ...'─│╭╮╯╰', // box drawing
  ...'▪▮▰▱▲▸◂○●▶▓█⬢', // meters, markers, infrastructure
  ...'⡀⣀⣄⣤⣦⣶⣷⣿⠀', // braille sparkline ramp, including the blank
  ...'↯', // incident marker; replaced ⚡ U+26A1, the cause of the repaint bug
  ...'⚠☺✔✓✗★→⚙⚗⛏', // status, lab, and narration markers
  ...'＋🚀' // ceremony markers: both render two cells, and Ink budgets two
]);

/** Glyphs measured to break Ink's row arithmetic. Never re-approve one of these. */
const BANNED_GLYPHS = new Map<string, string>([
  ['⚡', 'U+26A1: terminal draws 2 cells, Ink budgets 1 — rows wrap. Use ↯ (U+21AF).']
]);

const here = path.dirname(fileURLToPath(import.meta.url));
const SOURCE_ROOTS = [path.resolve(here, '../src'), path.resolve(here, '../../game/src')];

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

/**
 * Pulls the glyphs that can reach the screen. Comments are prose and never
 * rendered, so they are stripped first.
 */
function renderableGlyphs(source: string): string[] {
  const withoutComments = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  // Iterating the string yields whole code points, so astral glyphs stay intact.
  return [...withoutComments].filter((ch) => (ch.codePointAt(0) ?? 0) > 0x00a6);
}

describe('rendered glyph widths', () => {
  const files = SOURCE_ROOTS.flatMap(sourceFiles);

  it('finds the source files it means to scan', () => {
    expect(files.length).toBeGreaterThan(5);
  });

  it('renders no glyph outside the terminal-measured allow-list', () => {
    const offenders: string[] = [];
    for (const file of files) {
      for (const glyph of new Set(renderableGlyphs(fs.readFileSync(file, 'utf8')))) {
        if (APPROVED_GLYPHS.has(glyph)) continue;
        const code = `U+${(glyph.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')}`;
        const reason = BANNED_GLYPHS.get(glyph) ?? 'unmeasured — see test/tmux/probe-width.mjs';
        offenders.push(`${path.relative(here, file)}: ${glyph} ${code} — ${reason}`);
      }
    }
    expect(offenders, `\n${offenders.join('\n')}\n`).toEqual([]);
  });

  it('keeps the glyph that caused the repaint defect out of the allow-list', () => {
    for (const banned of BANNED_GLYPHS.keys()) {
      expect(APPROVED_GLYPHS.has(banned), `${banned} must stay banned`).toBe(false);
    }
  });
});
