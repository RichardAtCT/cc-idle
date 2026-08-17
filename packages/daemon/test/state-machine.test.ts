import { describe, it, expect } from 'vitest';
import type { EventEnvelope } from '@ccidle/shared';
import { applyEvent, checkStale, initSnapshot, reduce } from '../src/state-machine.js';

function envelope(overrides: Partial<EventEnvelope> & { event: string }): EventEnvelope {
  return {
    v: 1,
    ts: '2026-08-17T10:00:00.000Z',
    session_id: 'sess-1',
    payload: {},
    ...overrides
  };
}

describe('reduce', () => {
  it('UserPromptSubmit -> CC_WORKING from any state', () => {
    expect(reduce('HUMAN_ACTIVE', 'UserPromptSubmit')).toBe('CC_WORKING');
    expect(reduce('STALE', 'UserPromptSubmit')).toBe('CC_WORKING');
    expect(reduce('CC_WORKING', 'UserPromptSubmit')).toBe('CC_WORKING');
  });

  it('Stop, Notification, SessionStart -> HUMAN_ACTIVE', () => {
    for (const event of ['Stop', 'Notification', 'SessionStart']) {
      expect(reduce('CC_WORKING', event)).toBe('HUMAN_ACTIVE');
    }
  });

  it('SessionEnd -> DEAD', () => {
    expect(reduce('CC_WORKING', 'SessionEnd')).toBe('DEAD');
    expect(reduce('HUMAN_ACTIVE', 'SessionEnd')).toBe('DEAD');
  });

  it('SubagentStop and tool events cause no transition outside STALE', () => {
    expect(reduce('CC_WORKING', 'SubagentStop')).toBe('CC_WORKING');
    expect(reduce('CC_WORKING', 'PreToolUse')).toBe('CC_WORKING');
    expect(reduce('CC_WORKING', 'PostToolUse')).toBe('CC_WORKING');
    expect(reduce('HUMAN_ACTIVE', 'SubagentStop')).toBe('HUMAN_ACTIVE');
  });

  it('SubagentStop and tool events exit STALE back to CC_WORKING (activity)', () => {
    expect(reduce('STALE', 'SubagentStop')).toBe('CC_WORKING');
    expect(reduce('STALE', 'PostToolUse')).toBe('CC_WORKING');
    expect(reduce('STALE', 'PreToolUse')).toBe('CC_WORKING');
  });

  it('unknown/future event names behave like telemetry-only activity', () => {
    expect(reduce('CC_WORKING', 'SomeFutureEvent')).toBe('CC_WORKING');
    expect(reduce('STALE', 'SomeFutureEvent')).toBe('CC_WORKING');
  });

  it('TokenUsage never transitions but exits STALE', () => {
    expect(reduce('CC_WORKING', 'TokenUsage')).toBe('CC_WORKING');
    expect(reduce('STALE', 'TokenUsage')).toBe('CC_WORKING');
  });
});

describe('checkStale', () => {
  const staleAfterMs = 300_000;

  it('leaves HUMAN_ACTIVE and DEAD untouched regardless of elapsed time', () => {
    expect(checkStale('HUMAN_ACTIVE', 0, 10_000_000, staleAfterMs)).toBe('HUMAN_ACTIVE');
    expect(checkStale('DEAD', 0, 10_000_000, staleAfterMs)).toBe('DEAD');
  });

  it('CC_WORKING -> STALE after staleAfterMs of silence', () => {
    expect(checkStale('CC_WORKING', 0, staleAfterMs - 1, staleAfterMs)).toBe('CC_WORKING');
    expect(checkStale('CC_WORKING', 0, staleAfterMs, staleAfterMs)).toBe('STALE');
  });

  it('CC_WORKING -> DEAD after 2x staleAfterMs of silence', () => {
    expect(checkStale('CC_WORKING', 0, staleAfterMs * 2 - 1, staleAfterMs)).toBe('STALE');
    expect(checkStale('CC_WORKING', 0, staleAfterMs * 2, staleAfterMs)).toBe('DEAD');
  });

  it('STALE -> DEAD after 2x staleAfterMs total silence since last event', () => {
    expect(checkStale('STALE', 0, staleAfterMs * 2 - 1, staleAfterMs)).toBe('STALE');
    expect(checkStale('STALE', 0, staleAfterMs * 2, staleAfterMs)).toBe('DEAD');
  });
});

describe('applyEvent snapshot bookkeeping', () => {
  const now = '2026-08-17T10:00:05.000Z';

  it('increments turns and resets toolCallsThisTurn on UserPromptSubmit', () => {
    let snapshot = initSnapshot('sess-1', now);
    snapshot = applyEvent(snapshot, envelope({ event: 'UserPromptSubmit' }), now);
    expect(snapshot.state).toBe('CC_WORKING');
    expect(snapshot.turns).toBe(1);
    expect(snapshot.toolCallsThisTurn).toBe(0);

    snapshot = applyEvent(snapshot, envelope({ event: 'PostToolUse', tool: 'Bash' }), now);
    snapshot = applyEvent(snapshot, envelope({ event: 'PostToolUse', tool: 'Edit' }), now);
    expect(snapshot.toolCallsThisTurn).toBe(2);
    expect(snapshot.toolCallsTotal).toBe(2);
    expect(snapshot.lastTool).toBe('Edit');

    snapshot = applyEvent(snapshot, envelope({ event: 'UserPromptSubmit' }), now);
    expect(snapshot.turns).toBe(2);
    expect(snapshot.toolCallsThisTurn).toBe(0);
    expect(snapshot.toolCallsTotal).toBe(2); // total is never reset
  });

  it('falls back to payload.tool_name when envelope.tool is absent', () => {
    let snapshot = initSnapshot('sess-1', now);
    snapshot = applyEvent(
      snapshot,
      envelope({ event: 'PostToolUse', payload: { tool_name: 'Grep' } }),
      now
    );
    expect(snapshot.lastTool).toBe('Grep');
  });

  it('captures model from SessionStart payload', () => {
    let snapshot = initSnapshot('sess-1', now);
    snapshot = applyEvent(
      snapshot,
      envelope({ event: 'SessionStart', payload: { model: 'claude-opus-4' } }),
      now
    );
    expect(snapshot.model).toBe('claude-opus-4');
    expect(snapshot.state).toBe('HUMAN_ACTIVE');
  });

  it('tracks cwd and pane from the envelope', () => {
    let snapshot = initSnapshot('sess-1', now);
    snapshot = applyEvent(
      snapshot,
      envelope({ event: 'PostToolUse', cwd: '/repo', pane: '%3' }),
      now
    );
    expect(snapshot.cwd).toBe('/repo');
    expect(snapshot.pane).toBe('%3');
  });

  it('accumulates tokensByModel deltas across TokenUsage events', () => {
    let snapshot = initSnapshot('sess-1', now);
    snapshot = applyEvent(
      snapshot,
      envelope({
        event: 'TokenUsage',
        payload: {
          byModel: {
            'claude-opus-4': { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 }
          }
        }
      }),
      now
    );
    snapshot = applyEvent(
      snapshot,
      envelope({
        event: 'TokenUsage',
        payload: {
          byModel: {
            'claude-opus-4': { inputTokens: 20, outputTokens: 5, cacheReadTokens: 10, cacheWriteTokens: 1 },
            'claude-haiku-4': { inputTokens: 3, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }
          }
        }
      }),
      now
    );
    expect(snapshot.tokensByModel['claude-opus-4']).toEqual({
      inputTokens: 120,
      outputTokens: 55,
      cacheReadTokens: 10,
      cacheWriteTokens: 1
    });
    expect(snapshot.tokensByModel['claude-haiku-4']).toEqual({
      inputTokens: 3,
      outputTokens: 1,
      cacheReadTokens: 0,
      cacheWriteTokens: 0
    });
  });

  it('ignores malformed TokenUsage payloads without throwing', () => {
    let snapshot = initSnapshot('sess-1', now);
    snapshot = applyEvent(snapshot, envelope({ event: 'TokenUsage', payload: { bogus: true } }), now);
    expect(snapshot.tokensByModel).toEqual({});
  });

  it('updates stateSince only when the state actually changes', () => {
    let snapshot = initSnapshot('sess-1', '2026-08-17T09:00:00.000Z');
    snapshot = applyEvent(
      snapshot,
      envelope({ event: 'UserPromptSubmit', ts: '2026-08-17T09:00:01.000Z' }),
      '2026-08-17T09:00:01.000Z'
    );
    expect(snapshot.stateSince).toBe('2026-08-17T09:00:01.000Z');

    snapshot = applyEvent(
      snapshot,
      envelope({ event: 'PostToolUse', ts: '2026-08-17T09:00:02.000Z' }),
      '2026-08-17T09:00:02.000Z'
    );
    // still CC_WORKING: stateSince must not move
    expect(snapshot.stateSince).toBe('2026-08-17T09:00:01.000Z');
    expect(snapshot.lastEventTs).toBe('2026-08-17T09:00:02.000Z');
  });
});
