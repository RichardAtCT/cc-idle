/**
 * Width probe: for each candidate glyph, emit one row padded to the terminal
 * width by JS string length — exactly what Ink does when string-width scores
 * the glyph as 1. Each row is positioned absolutely, so a spill on one row
 * cannot shift the next (otherwise a single wide glyph makes every later row
 * look wide too).
 *
 * Usage: run inside a tmux pane, then `tmux capture-pane -p`.
 * A row whose pad runs to the last column is width 1; a row that wraps its
 * final pad character onto the next line is width 2.
 */
const cols = process.stdout.columns ?? 80;
const glyphs = [...(process.argv.slice(2).join('') || '⚡✔⬢☺▲▪▮')];

process.stdout.write('\x1b[2J');
glyphs.forEach((g, i) => {
  const row = i * 2 + 1; // blank row between each, so spill is unambiguous
  const label = `U+${g.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`;
  const body = `${g} ${label} `;
  const line = body + '.'.repeat(Math.max(0, cols - body.length));
  process.stdout.write(`\x1b[${row};1H${line}`);
});
process.stdout.write(`\x1b[${glyphs.length * 2 + 1};1H`);
