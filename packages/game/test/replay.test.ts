import { describe, it, expect } from 'vitest';
import { serializeEvent, type EventEnvelope } from '@ccidle/shared';
import { formatReplayReport, mergeTimelines, parseEventFile, replayEnvelopes } from '../src/index.js';

function env(ts: string, event: string, extra: Partial<EventEnvelope> = {}): EventEnvelope {
  return { v: 1, ts, session_id: 'sess-1', event, cwd: '/home/user/projA', payload: {}, ...extra };
}

const SAMPLE: EventEnvelope[] = [
  env('2026-08-17T10:00:00.000Z', 'SessionStart'),
  env('2026-08-17T10:00:05.000Z', 'UserPromptSubmit'),
  env('2026-08-17T10:00:10.000Z', 'PostToolUse', { tool: 'Read' }),
  env('2026-08-17T10:00:20.000Z', 'PostToolUse', { tool: 'Edit' }),
  env('2026-08-17T10:00:30.000Z', 'TokenUsage', {
    cwd: undefined,
    payload: { byModel: { m: { inputTokens: 10, outputTokens: 2000, cacheReadTokens: 0, cacheWriteTokens: 0 } } }
  }),
  env('2026-08-17T10:01:00.000Z', 'Stop')
];

describe('parseEventFile', () => {
  it('parses JSONL, skipping malformed lines', () => {
    const content = SAMPLE.map(serializeEvent).join('') + 'not json\n{"v":2}\n';
    const parsed = parseEventFile(content);
    expect(parsed).toHaveLength(SAMPLE.length);
  });
});

describe('mergeTimelines', () => {
  it('interleaves multiple session files by timestamp', () => {
    const a = [env('2026-08-17T10:00:00.000Z', 'SessionStart'), env('2026-08-17T10:02:00.000Z', 'Stop')];
    const b = [env('2026-08-17T10:01:00.000Z', 'SessionStart', { session_id: 'sess-2' })];
    const merged = mergeTimelines([a, b]);
    expect(merged.map((e) => e.ts)).toEqual([
      '2026-08-17T10:00:00.000Z',
      '2026-08-17T10:01:00.000Z',
      '2026-08-17T10:02:00.000Z'
    ]);
  });
});

describe('replayEnvelopes', () => {
  it('produces a full economy from a recorded stream', () => {
    const { state, narration } = replayEnvelopes(SAMPLE);
    expect(state.stats.eventsProcessed).toBe(SAMPLE.length);
    expect(state.resources.compute).toBeGreaterThan(2000); // tokens + completion + stop bonus
    expect(state.resources.engineering).toBeGreaterThan(0);
    expect(state.resources.research).toBeGreaterThan(0);
    expect(state.resources.reputation).toBe(1);
    expect(narration.length).toBeGreaterThan(0);
  });

  it('is deterministic across runs (PRD §5: data-driven tuning)', () => {
    expect(replayEnvelopes(SAMPLE).state).toEqual(replayEnvelopes(SAMPLE).state);
  });
});

describe('formatReplayReport', () => {
  it('reports the economy stats needed for balance tuning', () => {
    const { state } = replayEnvelopes(SAMPLE);
    const report = formatReplayReport(state);
    expect(report).toContain('economy report');
    expect(report).toContain('compute earned by source');
    expect(report).toContain('weighted token efficiency');
    expect(report).toContain('projA');
  });
});
