import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * End-to-end backstop for the repaint defect.
 *
 * Ink erases a frame by moving the cursor up its own row count. Anything that
 * makes the terminal emit more rows than Ink counted — a glyph drawn wider than
 * budgeted, a wrapped line, an unclipped panel, a stray write to stdout — leaves
 * rows behind that scroll into history and never come back. So the assertion is
 * simply: after many ticks, the pane's history has not grown.
 *
 * This runs a real TUI in a real terminal, which is the only oracle that covers
 * every cause at once. It needs tmux, and skips without it.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const HARNESS = path.join(here, 'render-harness.mjs');
const FIXTURE = path.resolve(here, '../fixtures/scrollback-session.jsonl');
const SESSION = 'ccidle-scrollback-test';

/** Ticks to observe. The App repaints once a second, so this is ~12 repaints. */
const OBSERVED_TICKS = 12;

/**
 * Deliberately tight. The height budget clips the frame to the viewport, so a
 * roomy pane leaves slack that would hide a row-too-wide regression. At this
 * height the budget saturates and the frame fills the pane exactly, which makes
 * a single extra physical row overflow — and show up as scrollback.
 */
const PANE_ROWS = 24;

function hasTmux(): boolean {
  return spawnSync('tmux', ['-V'], { stdio: 'ignore' }).status === 0;
}

function tmux(...args: string[]): string {
  return execFileSync('tmux', args, { encoding: 'utf8' });
}

function killSession(): void {
  spawnSync('tmux', ['kill-session', '-t', SESSION], { stdio: 'ignore' });
}

/** Total lines tmux is holding for the pane, scrollback included. */
function historyLines(): number {
  const captured = tmux('capture-pane', '-t', SESSION, '-p', '-S', '-');
  // capture-pane terminates the last line, so drop the empty tail split leaves.
  return captured.replace(/\n$/, '').split('\n').length;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const describeTmux = hasTmux() ? describe : describe.skip;

describeTmux('TUI scrollback', () => {
  afterEach(() => {
    killSession();
  });

  it('does not grow the pane history while it repaints', async () => {
    killSession();
    tmux(
      'new-session',
      '-d',
      '-s',
      SESSION,
      '-x',
      '120',
      '-y',
      String(PANE_ROWS),
      `RUN_MS=${(OBSERVED_TICKS + 8) * 1000} node ${JSON.stringify(HARNESS)} ${JSON.stringify(FIXTURE)}`
    );

    // Let the harness render its first full frame before taking the baseline.
    await sleep(2500);
    const baseline = historyLines();
    expect(baseline, 'the TUI should have rendered something').toBeGreaterThan(1);

    await sleep(OBSERVED_TICKS * 1000);
    const after = historyLines();

    expect(
      after - baseline,
      `pane history grew by ${after - baseline} lines over ${OBSERVED_TICKS} repaints ` +
        `(${baseline} -> ${after}); the frame is taller than Ink believes`
    ).toBe(0);

    // Stronger than "stopped growing": nothing may ever reach scrollback. A
    // frame one row too tall scrolls once and then repaints in place, which the
    // growth check above would miss — but it leaves the header off-screen.
    expect(
      after,
      `pane holds ${after} lines for a ${PANE_ROWS}-row pane, so ${after - PANE_ROWS} ` +
        'row(s) scrolled into history'
    ).toBe(PANE_ROWS);
  }, 40_000);

  it('still updates the frame in place while history stays flat', async () => {
    killSession();
    tmux(
      'new-session',
      '-d',
      '-s',
      SESSION,
      '-x',
      '120',
      '-y',
      String(PANE_ROWS),
      `RUN_MS=20000 node ${JSON.stringify(HARNESS)} ${JSON.stringify(FIXTURE)}`
    );

    await sleep(2500);
    const first = tmux('capture-pane', '-t', SESSION, '-p');
    const historyBefore = historyLines();

    await sleep(4000);
    const second = tmux('capture-pane', '-t', SESSION, '-p');

    // The session strip's elapsed clock advances every second, so a live frame
    // must differ; an identical frame would mean the UI had stopped repainting.
    expect(second).not.toBe(first);
    expect(second).toContain('CC IDLE');
    expect(historyLines()).toBe(historyBefore);
  }, 30_000);
});
