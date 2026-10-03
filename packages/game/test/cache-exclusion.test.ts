import { describe, it, expect } from 'vitest';
import type { EventEnvelope } from '@ccidle/shared';
import { economyTokens } from '../src/engine.js';
import { replayEnvelopes } from '../src/replay.js';
import type { GameState } from '../src/state.js';

/**
 * Cache tokens must never reach the economy.
 *
 * The 2026-08-17 baseline corpus carried 2.07 billion cache-read tokens against
 * 6.2 million output tokens. If any resource formula ever picked up a cache
 * counter, that formula would be ~300× more sensitive to prompt-cache
 * behaviour than to work actually done, and one long-context session would
 * swamp every other signal in the game.
 *
 * The exclusion is enforced by `economyTokens` in engine.ts. These tests are
 * what makes it a contract rather than a coincidence: the fixture below is
 * deliberately lopsided — vast cache traffic, almost no output — so any leak
 * shows up as an enormous, obviously wrong number.
 */

const SESSION = 'cache-heavy-session';
const CWD = '/Users/dev/long-context-project';

interface CacheScale {
  /** Multiplies only the cache counters; output and input stay fixed. */
  factor: number;
}

function tokenEvent(ts: string, output: number, { factor }: CacheScale): EventEnvelope {
  return {
    v: 1,
    ts,
    session_id: SESSION,
    event: 'TokenUsage',
    cwd: CWD,
    origin: 'import',
    payload: {
      byModel: {
        'claude-opus-5': {
          inputTokens: 120,
          outputTokens: output,
          // Absurd on purpose: a leak cannot hide behind rounding.
          cacheReadTokens: 900_000_000 * factor,
          cacheWriteTokens: 40_000_000 * factor
        }
      }
    }
  } as EventEnvelope;
}

/** A session that reads enormously from cache and produces almost nothing. */
function cacheHeavySession(scale: CacheScale): EventEnvelope[] {
  const base = (ts: string, event: string, payload: Record<string, unknown> = {}): EventEnvelope =>
    ({ v: 1, ts, session_id: SESSION, event, cwd: CWD, origin: 'import', payload }) as EventEnvelope;

  return [
    base('2026-08-01T09:00:00.000Z', 'SessionStart'),
    base('2026-08-01T09:00:10.000Z', 'UserPromptSubmit'),
    base('2026-08-01T09:00:20.000Z', 'PostToolUse', { tool_name: 'Read' }),
    base('2026-08-01T09:00:30.000Z', 'PostToolUse', { tool_name: 'Edit' }),
    tokenEvent('2026-08-01T09:01:00.000Z', 500, scale),
    base('2026-08-01T09:01:30.000Z', 'Stop'),
    base('2026-08-01T09:02:00.000Z', 'UserPromptSubmit'),
    tokenEvent('2026-08-01T09:03:00.000Z', 250, scale),
    base('2026-08-01T09:03:30.000Z', 'SubagentStop', { duration_ms: 45_000 }),
    base('2026-08-01T09:04:00.000Z', 'Stop'),
    base('2026-08-01T09:05:00.000Z', 'SessionEnd')
  ];
}

/** Everything the economy tracks, flattened for comparison. */
function economySnapshot(state: GameState): Record<string, unknown> {
  return {
    resources: state.resources,
    stats: state.stats,
    generation: state.generation,
    lab: state.lab,
    regions: Object.fromEntries(
      Object.entries(state.regions).map(([id, r]) => [
        id,
        { infrastructure: r.infrastructure, totals: r.totals, window: r.window, status: r.status }
      ])
    )
  };
}

describe('economyTokens', () => {
  it('sums output tokens and nothing else', () => {
    const tokens = economyTokens({
      byModel: {
        a: { inputTokens: 1e9, outputTokens: 10, cacheReadTokens: 1e9, cacheWriteTokens: 1e9 },
        b: { inputTokens: 1e9, outputTokens: 5, cacheReadTokens: 1e9, cacheWriteTokens: 1e9 }
      }
    });
    expect(tokens.outputTokens).toBe(15);
    expect(Object.keys(tokens)).toEqual(['outputTokens']);
  });

  it('is unmoved by cache counters of any size', () => {
    const small = economyTokens({
      byModel: { a: { inputTokens: 1, outputTokens: 42, cacheReadTokens: 0, cacheWriteTokens: 0 } }
    });
    const huge = economyTokens({
      byModel: {
        a: { inputTokens: 1, outputTokens: 42, cacheReadTokens: 5e11, cacheWriteTokens: 5e11 }
      }
    });
    expect(huge).toEqual(small);
  });
});

describe('economy under extreme cache traffic', () => {
  const baseline = replayEnvelopes(cacheHeavySession({ factor: 1 })).state;

  it('derives compute from output tokens alone, not the 940M cache tokens', () => {
    // 750 output tokens is a trivial amount of work. If cache tokens leaked in,
    // compute would be in the millions rather than the tens.
    expect(baseline.stats.outputTokensSeen).toBe(750);
    expect(baseline.resources.compute).toBeLessThan(10_000);
    expect(baseline.stats.computeFromTokens).toBeGreaterThan(0);
    expect(baseline.stats.computeFromTokens).toBeLessThan(10_000);
  });

  it('leaves every economy counter unchanged when cache tokens are multiplied 10x', () => {
    const tenfold = replayEnvelopes(cacheHeavySession({ factor: 10 })).state;
    expect(economySnapshot(tenfold)).toEqual(economySnapshot(baseline));
  });

  it('is still unchanged at 1000x, where any leak would be unmistakable', () => {
    const thousandfold = replayEnvelopes(cacheHeavySession({ factor: 1000 })).state;
    expect(thousandfold.resources.compute).toBe(baseline.resources.compute);
    expect(thousandfold.stats.computeFromTokens).toBe(baseline.stats.computeFromTokens);
    expect(economySnapshot(thousandfold)).toEqual(economySnapshot(baseline));
  });

  it('keeps the region window keyed to output tokens only', () => {
    const region = Object.values(baseline.regions).find((r) => r.name !== 'unassigned')!;
    expect(region.window.outputTokens).toBe(750);
    expect(region.totals.outputTokens).toBe(750);
  });

  it('scales with output tokens, proving the economy is not simply inert', () => {
    const doubled = replayEnvelopes(
      cacheHeavySession({ factor: 1 }).map((e) =>
        e.event === 'TokenUsage'
          ? ({
              ...e,
              payload: {
                byModel: {
                  'claude-opus-5': {
                    ...(e.payload as { byModel: Record<string, Record<string, number>> }).byModel[
                      'claude-opus-5'
                    ]!,
                    outputTokens:
                      (e.payload as { byModel: Record<string, Record<string, number>> }).byModel[
                        'claude-opus-5'
                      ]!.outputTokens * 2
                  }
                }
              }
            } as EventEnvelope)
          : e
      )
    ).state;

    expect(doubled.stats.outputTokensSeen).toBe(1500);
    expect(doubled.resources.compute).toBeGreaterThan(baseline.resources.compute);
  });
});
