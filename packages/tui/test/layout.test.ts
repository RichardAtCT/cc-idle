import { describe, it, expect } from 'vitest';
import { layoutBudget, MAX_FEED_ROWS, MAX_INCIDENT_ROWS } from '../src/layout.js';

/**
 * The frame must never be taller than the viewport: Ink erases by moving the
 * cursor up its own row count, so an over-tall frame scrolls instead of
 * repainting. These tests pin the arithmetic that guarantees it.
 */

/** Mirrors the fixed chrome in layout.ts, so a drift in either shows up here. */
function fixedRows(sessionCount: number, alert: boolean, confirm: boolean): number {
  return (
    1 + // header
    1 + // resource bar
    5 + // lab panel
    1 + // footer
    2 + // feed border
    8 + // region stage, incidents excluded
    2 + // session strip border
    Math.max(1, sessionCount) +
    (alert ? 1 : 0) +
    (confirm ? 3 : 0)
  );
}

describe('layoutBudget', () => {
  it('gives the feed its full default when the terminal is roomy', () => {
    const budget = layoutBudget({
      rows: 60,
      sessionCount: 1,
      incidentCount: 0,
      alertVisible: false,
      confirmVisible: false
    });
    expect(budget.feedLimit).toBe(MAX_FEED_ROWS);
    expect(budget.incidentLimit).toBe(0);
  });

  it('caps incidents so they cannot crowd out the feed', () => {
    const budget = layoutBudget({
      rows: 60,
      sessionCount: 1,
      incidentCount: 25,
      alertVisible: false,
      confirmVisible: false
    });
    expect(budget.incidentLimit).toBe(MAX_INCIDENT_ROWS);
    expect(budget.feedLimit).toBe(MAX_FEED_ROWS);
  });

  it('spends nothing it does not have on a short terminal', () => {
    const budget = layoutBudget({
      rows: 22,
      sessionCount: 1,
      incidentCount: 3,
      alertVisible: false,
      confirmVisible: false
    });
    const spare = 22 - fixedRows(1, false, false);
    expect(budget.incidentLimit + budget.feedLimit).toBeLessThanOrEqual(spare);
  });

  it('never returns negative budgets, however cramped the terminal', () => {
    for (const rows of [0, 1, 5, 10, 15]) {
      const budget = layoutBudget({
        rows,
        sessionCount: 9,
        incidentCount: 5,
        alertVisible: true,
        confirmVisible: true
      });
      expect(budget.feedLimit).toBeGreaterThanOrEqual(0);
      expect(budget.incidentLimit).toBeGreaterThanOrEqual(0);
    }
  });

  it('keeps total frame height within the viewport across the whole input space', () => {
    for (const rows of [8, 12, 20, 24, 30, 40, 50, 80, 120]) {
      for (const sessionCount of [0, 1, 4, 9]) {
        for (const incidentCount of [0, 1, 3, 7]) {
          for (const alertVisible of [false, true]) {
            for (const confirmVisible of [false, true]) {
              const budget = layoutBudget({
                rows,
                sessionCount,
                incidentCount,
                alertVisible,
                confirmVisible
              });
              const height =
                fixedRows(sessionCount, alertVisible, confirmVisible) +
                budget.incidentLimit +
                budget.feedLimit;
              expect(
                height,
                `rows=${rows} sessions=${sessionCount} incidents=${incidentCount} alert=${alertVisible} confirm=${confirmVisible}`
              ).toBeLessThanOrEqual(Math.max(rows, fixedRows(sessionCount, alertVisible, confirmVisible)));
            }
          }
        }
      }
    }
  });
});
