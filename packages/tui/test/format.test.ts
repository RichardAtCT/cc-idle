import { describe, it, expect } from 'vitest';
import type { SessionSnapshot } from '@ccidle/shared';
import { shortSessionId, totalTokens, cwdBasename, formatElapsed, elapsedSince } from '../src/format.js';

describe('shortSessionId', () => {
  it('truncates to the first 8 characters', () => {
    expect(shortSessionId('0123456789abcdef')).toBe('01234567');
  });

  it('passes short ids through unchanged', () => {
    expect(shortSessionId('abc')).toBe('abc');
  });
});

describe('totalTokens', () => {
  it('sums input+output across all models, ignoring cache fields', () => {
    const session = {
      tokensByModel: {
        'claude-a': { inputTokens: 10, outputTokens: 5, cacheReadTokens: 100, cacheWriteTokens: 50 },
        'claude-b': { inputTokens: 3, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 }
      }
    } as unknown as SessionSnapshot;
    expect(totalTokens(session)).toBe(20);
  });

  it('returns 0 for a session with no model usage', () => {
    const session = { tokensByModel: {} } as unknown as SessionSnapshot;
    expect(totalTokens(session)).toBe(0);
  });
});

describe('cwdBasename', () => {
  it('returns the last path segment', () => {
    expect(cwdBasename('/home/user/cc-idle')).toBe('cc-idle');
  });

  it('handles a trailing slash', () => {
    expect(cwdBasename('/home/user/cc-idle/')).toBe('cc-idle');
  });

  it('returns "?" for undefined', () => {
    expect(cwdBasename(undefined)).toBe('?');
  });

  it('returns "/" for the root path', () => {
    expect(cwdBasename('/')).toBe('/');
  });
});

describe('formatElapsed', () => {
  it('formats seconds as mm:ss', () => {
    expect(formatElapsed(0)).toBe('00:00');
    expect(formatElapsed(59_000)).toBe('00:59');
    expect(formatElapsed(60_000)).toBe('01:00');
    expect(formatElapsed(3_661_000)).toBe('61:01');
  });

  it('clamps negative durations to 00:00', () => {
    expect(formatElapsed(-500)).toBe('00:00');
  });
});

describe('elapsedSince', () => {
  it('computes elapsed time from an ISO timestamp to now', () => {
    const since = '2026-08-17T10:00:00.000Z';
    const now = Date.parse('2026-08-17T10:01:05.000Z');
    expect(elapsedSince(since, now)).toBe('01:05');
  });

  it('returns 00:00 for an unparsable timestamp', () => {
    expect(elapsedSince('not-a-date', Date.now())).toBe('00:00');
  });
});
