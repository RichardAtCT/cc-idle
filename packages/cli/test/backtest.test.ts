import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { serializeEvent, type EventEnvelope } from '@ccidle/shared';
import { runBacktest, TelemetrySink, type BacktestSink } from '../src/backtest.js';

function env(ts: string, event: string, extra: Partial<EventEnvelope> = {}): EventEnvelope {
  return { v: 1, ts, session_id: 'sess-1', event, cwd: '/p/alpha', origin: 'import', payload: {}, ...extra } as EventEnvelope;
}

const SESSION_A: EventEnvelope[] = [
  env('2026-08-01T10:00:00.000Z', 'SessionStart'),
  env('2026-08-01T10:00:05.000Z', 'UserPromptSubmit'),
  env('2026-08-01T10:00:07.000Z', 'PreToolUse', { tool: 'Bash' }),
  env('2026-08-01T10:00:10.000Z', 'PostToolUse', { tool: 'Bash', payload: { tool_name: 'Bash', tool_response: { is_error: false } } }),
  env('2026-08-01T10:00:12.000Z', 'PostToolUse', { tool: 'Edit', payload: { tool_name: 'Edit', tool_response: { is_error: true } } }),
  env('2026-08-01T10:00:30.000Z', 'TokenUsage', {
    payload: { byModel: { 'claude-fable-5': { inputTokens: 10, outputTokens: 3000, cacheReadTokens: 100, cacheWriteTokens: 20 } } }
  }),
  env('2026-08-01T10:01:00.000Z', 'SubagentStop', { payload: { duration_ms: 60000 } }),
  env('2026-08-01T10:02:00.000Z', 'Stop'),
  env('2026-08-01T10:02:00.000Z', 'SessionEnd')
];

const SESSION_B: EventEnvelope[] = [
  env('2026-08-03T22:00:00.000Z', 'SessionStart', { session_id: 'sess-2', cwd: '/p/beta' }),
  env('2026-08-03T22:00:05.000Z', 'UserPromptSubmit', { session_id: 'sess-2', cwd: '/p/beta' }),
  env('2026-08-03T22:00:40.000Z', 'TokenUsage', {
    session_id: 'sess-2',
    cwd: '/p/beta',
    payload: { byModel: { 'claude-opus-5': { inputTokens: 5, outputTokens: 500, cacheReadTokens: 0, cacheWriteTokens: 0 } } }
  }),
  env('2026-08-03T22:01:00.000Z', 'Stop', { session_id: 'sess-2', cwd: '/p/beta' })
];

function writeCorpus(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccidle-backtest-'));
  fs.writeFileSync(path.join(dir, 'sess-1.jsonl'), SESSION_A.map(serializeEvent).join(''));
  fs.writeFileSync(path.join(dir, 'sess-2.jsonl'), SESSION_B.map(serializeEvent).join(''));
  return dir;
}

describe('TelemetrySink', () => {
  it('aggregates turns, tools, subagents, tokens, and histograms per project', () => {
    const sink = new TelemetrySink();
    for (const e of [...SESSION_A, ...SESSION_B]) sink.onEvent(e);
    const s = sink.summary();

    expect(s.corpus.sessions).toBe(2);
    expect(s.corpus.spanDays).toBe(3); // Aug 1 → Aug 3 inclusive
    expect(s.totals.turns).toBe(2);
    expect(s.totals.toolCalls).toBe(2);
    expect(s.totals.toolFailures).toBe(1);
    expect(s.totals.subagentStops).toBe(1);
    expect(s.totals.tokens.outputTokens).toBe(3500);
    expect(s.projects['/p/alpha']!.toolCallsByTool).toEqual({ Bash: 1, Edit: 1 });
    expect(s.projects['/p/alpha']!.toolSuccessRatio).toBe(0.5);
    expect(s.projects['/p/beta']!.tokensByModel['claude-opus-5']!.outputTokens).toBe(500);
    expect(s.histograms.eventsByHourUtc[10]).toBe(9);
    expect(s.histograms.eventsByHourUtc[22]).toBe(4);
    expect(s.histograms.tokensByDay).toEqual({
      '2026-08-01': { inputTokens: 10, outputTokens: 3000 },
      '2026-08-03': { inputTokens: 5, outputTokens: 500 }
    });
    expect(s.topSessions[0]!.sessionId).toBe('sess-1');
  });
});

describe('ccidle backtest (command)', () => {
  it('runs headless over a corpus dir and emits the markdown report', async () => {
    const dir = writeCorpus();
    const lines: string[] = [];
    const code = await runBacktest({ corpusDir: dir, out: (l) => lines.push(l) });
    expect(code).toBe(0);
    const md = lines.join('\n');
    expect(md).toContain('# CC Idle backtest report');
    expect(md).toContain('Sessions: 2');
    expect(md).toContain('Top 5 heaviest sessions');
    expect(md).toContain('Known gaps in imported data');
  });

  it('produces byte-identical JSON on repeated runs (determinism)', async () => {
    const dir = writeCorpus();
    const a = path.join(dir, 'a.json');
    const b = path.join(dir, 'b.json');
    expect(await runBacktest({ corpusDir: dir, jsonOut: a, out: () => {} })).toBe(0);
    expect(await runBacktest({ corpusDir: dir, jsonOut: b, out: () => {} })).toBe(0);
    const bufA = fs.readFileSync(a);
    const bufB = fs.readFileSync(b);
    expect(bufA.equals(bufB)).toBe(true);
    // corpus files a.json/b.json are not .jsonl so they don't pollute later runs
  });

  it('includes the economy replay and supports extra sinks (the M1 socket)', async () => {
    const dir = writeCorpus();
    const seen: string[] = [];
    const countingSink: BacktestSink = {
      name: 'counter',
      onEvent: (e) => void seen.push(e.event),
      summary: () => ({ count: seen.length })
    };
    const lines: string[] = [];
    const code = await runBacktest({ corpusDir: dir, json: true, extraSinks: [countingSink], out: (l) => lines.push(l) });
    expect(code).toBe(0);
    const report = JSON.parse(lines.join('\n')) as {
      economy: { stats: { eventsProcessed: number } };
      sinks: { counter: { count: number } };
    };
    expect(report.economy.stats.eventsProcessed).toBe(SESSION_A.length + SESSION_B.length);
    expect(report.sinks.counter.count).toBe(SESSION_A.length + SESSION_B.length);
  });

  it('stays headless: no daemon, tmux, or TUI modules are imported', () => {
    const source = fs.readFileSync(new URL('../src/backtest.ts', import.meta.url), 'utf8');
    const imports = source.match(/from '[^']+'/g) ?? [];
    for (const forbidden of ['tmux', 'daemon-control', 'ipc', '@ccidle/tui', 'node:net', 'child_process']) {
      expect(imports.some((i) => i.includes(forbidden))).toBe(false);
    }
  });

  it('fails cleanly on an empty corpus', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccidle-empty-'));
    const code = await runBacktest({ corpusDir: dir, out: () => {} });
    expect(code).toBe(1);
  });
});
