import { useEffect, useState } from 'react';
import { useStdout } from 'ink';

/**
 * Height budgeting.
 *
 * Ink repaints by moving the cursor up by the number of rows it believes it
 * wrote. If the frame is taller than the viewport, the rows that scrolled off
 * can no longer be erased, so every tick appends a fresh copy to scrollback.
 * The only durable defence is to never emit a frame taller than the terminal:
 * the panels below have fixed heights, and the two variable-height regions
 * (the incident list and the narration feed) are clipped to whatever is left.
 */

/** Rows each fixed panel occupies, borders included. */
const CHROME = {
  alertBanner: 1,
  header: 1,
  /** round border top+bottom; rows are added per session. */
  sessionStripBorder: 2,
  resourceBar: 1,
  confirmShip: 3,
  /** border + name/infra/rack/flow/rate/buy rows. */
  regionStageFixed: 8,
  /** border + researchers/progress/actions rows. */
  labPanel: 5,
  feedBorder: 2,
  footer: 1
} as const;

/** Never let incidents crowd out the feed entirely, however many are open. */
export const MAX_INCIDENT_ROWS = 3;
/** Matches the Feed component's own default. */
export const MAX_FEED_ROWS = 6;

export interface LayoutInput {
  rows: number;
  sessionCount: number;
  incidentCount: number;
  alertVisible: boolean;
  confirmVisible: boolean;
}

export interface LayoutBudget {
  /** Narration entries the feed may render. */
  feedLimit: number;
  /**
   * Rows the region stage may spend on incidents. The stage spends exactly
   * this many, giving the last row to a "+N more" marker when it has to clip —
   * so the marker never costs a row the budget did not grant.
   */
  incidentLimit: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Splits the rows left over after fixed chrome between the incident list and
 * the feed. Incidents win the first rows because they are actionable; the feed
 * takes the remainder.
 */
export function layoutBudget(input: LayoutInput): LayoutBudget {
  const fixed =
    CHROME.header +
    CHROME.resourceBar +
    CHROME.labPanel +
    CHROME.footer +
    CHROME.feedBorder +
    CHROME.regionStageFixed +
    CHROME.sessionStripBorder +
    Math.max(1, input.sessionCount) +
    (input.alertVisible ? CHROME.alertBanner : 0) +
    (input.confirmVisible ? CHROME.confirmShip : 0);

  const spare = Math.max(0, input.rows - fixed);
  const incidentLimit = clamp(Math.min(input.incidentCount, MAX_INCIDENT_ROWS), 0, spare);
  const feedLimit = clamp(spare - incidentLimit, 0, MAX_FEED_ROWS);

  return { feedLimit, incidentLimit };
}

/** Terminal height, kept current across SIGWINCH-driven resize events. */
export function useTerminalRows(): number {
  const { stdout } = useStdout();
  const [rows, setRows] = useState(() => stdout?.rows ?? 24);

  useEffect(() => {
    if (!stdout) return;
    const onResize = (): void => setRows(stdout.rows ?? 24);
    stdout.on('resize', onResize);
    onResize();
    return () => {
      stdout.off('resize', onResize);
    };
  }, [stdout]);

  return rows;
}
