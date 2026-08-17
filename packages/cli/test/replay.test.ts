import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { serializeEvent, type EventEnvelope } from '@ccidle/shared';
import { runReplay } from '../src/replay.js';

function env(ts: string, event: string, extra: Partial<EventEnvelope> = {}): EventEnvelope {
  return { v: 1, ts, session_id: 'sess-1', event, cwd: '/p/alpha', payload: {}, ...extra };
}

function writeFixture(events: EventEnvelope[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccidle-replay-'));
  const file = path.join(dir, 'sess-1.jsonl');
  fs.writeFileSync(file, events.map(serializeEvent).join(''));
  return file;
}

const EVENTS: EventEnvelope[] = [
  env('2026-08-17T10:00:00.000Z', 'SessionStart'),
  env('2026-08-17T10:00:05.000Z', 'UserPromptSubmit'),
  env('2026-08-17T10:00:10.000Z', 'PostToolUse', { tool: 'Edit' }),
  env('2026-08-17T10:00:30.000Z', 'TokenUsage', {
    cwd: undefined,
    payload: { byModel: { m: { inputTokens: 0, outputTokens: 3000, cacheReadTokens: 0, cacheWriteTokens: 0 } } }
  }),
  env('2026-08-17T10:01:00.000Z', 'Stop')
];

describe('ccidle replay', () => {
  it('replays a recorded session file and prints the economy report', async () => {
    const file = writeFixture(EVENTS);
    const lines: string[] = [];
    const code = await runReplay({ files: [file], out: (l) => lines.push(l) });
    expect(code).toBe(0);
    const output = lines.join('\n');
    expect(output).toContain('economy report');
    expect(output).toContain('alpha');
    expect(output).toContain('region "alpha" founded'); // narration included by default
  });

  it('emits machine-readable stats with --json', async () => {
    const file = writeFixture(EVENTS);
    const lines: string[] = [];
    const code = await runReplay({ files: [file], json: true, quiet: true, out: (l) => lines.push(l) });
    expect(code).toBe(0);
    const parsed = JSON.parse(lines.join('\n')) as { stats: { eventsProcessed: number }; generation: number };
    expect(parsed.stats.eventsProcessed).toBe(EVENTS.length);
    expect(parsed.generation).toBe(1);
  });

  it('paces the replay by event timestamps when --speed is set', async () => {
    const file = writeFixture(EVENTS);
    const waits: number[] = [];
    const code = await runReplay({
      files: [file],
      speed: 10,
      quiet: true,
      out: () => {},
      sleep: async (ms) => {
        waits.push(ms);
      }
    });
    expect(code).toBe(0);
    expect(waits.length).toBeGreaterThan(0);
    expect(Math.max(...waits)).toBeLessThanOrEqual(5000);
  });

  it('fails cleanly on a missing file', async () => {
    const code = await runReplay({ files: ['/nope/missing.jsonl'], quiet: true, out: () => {} });
    expect(code).toBe(1);
  });
});
