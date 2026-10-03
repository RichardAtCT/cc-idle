import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { serializeEvent, type EventEnvelope } from '@ccidle/shared';
import { applyCorpusFilters, formatExcluded, runBacktest, TelemetrySink } from '../src/backtest.js';

/**
 * Corpus hygiene: benchmark-harness sessions under throwaway directories each
 * founded their own micro-region, so region-level stats were polluted by junk
 * with no bearing on the economy. Filtering must be explicit and always visible.
 */

function ev(session: string, cwd: string, ts: string, event: string): EventEnvelope {
  return { v: 1, ts, session_id: session, event, cwd, origin: 'import', payload: {} } as EventEnvelope;
}

function session(id: string, cwd: string, turns: number): EventEnvelope[] {
  const events = [ev(id, cwd, '2026-08-01T10:00:00.000Z', 'SessionStart')];
  for (let i = 0; i < turns; i += 1) {
    events.push(ev(id, cwd, `2026-08-01T10:0${i + 1}:00.000Z`, 'UserPromptSubmit'));
  }
  events.push(ev(id, cwd, '2026-08-01T10:30:00.000Z', 'SessionEnd'));
  return events;
}

const REAL = session('real', '/Users/rich/projects/cc-idle', 5);
const HARNESS = session('harness', '/private/tmp/claude-501/bench', 1);
const SCRATCH = session('scratch', '/Users/rich/projects/x/scratchpad', 1);
const SHORT = session('short', '/Users/rich/projects/tiny', 1);

const DEFAULTS = ['/private/tmp/**', '**/scratchpad/**'];

describe('applyCorpusFilters', () => {
  it('drops sessions whose cwd matches a rule and names the rule', () => {
    const { kept, summary } = applyCorpusFilters([REAL, HARNESS, SCRATCH], DEFAULTS, null);
    expect(kept).toHaveLength(1);
    expect(summary.sessionsExcluded).toBe(2);
    expect(summary.byRule).toEqual({ '/private/tmp/**': 1, '**/scratchpad/**': 1 });
    expect(summary.eventsExcluded).toBe(HARNESS.length + SCRATCH.length);
    expect(summary.sessionsKept).toBe(1);
  });

  it('keeps everything when no rules are active', () => {
    const { kept, summary } = applyCorpusFilters([REAL, HARNESS, SCRATCH], [], null);
    expect(kept).toHaveLength(3);
    expect(summary.sessionsExcluded).toBe(0);
  });

  it('drops sessions below --min-turns and reports it as its own rule', () => {
    const { kept, summary } = applyCorpusFilters([REAL, SHORT], [], 2);
    expect(kept).toHaveLength(1);
    expect(summary.byRule).toEqual({ 'min-turns:2': 1 });
  });

  it('attributes a session to the glob rule when both rules would drop it', () => {
    const { summary } = applyCorpusFilters([HARNESS], DEFAULTS, 2);
    expect(summary.byRule).toEqual({ '/private/tmp/**': 1 });
  });

  it('filters whole sessions, never partial timelines', () => {
    const { kept } = applyCorpusFilters([REAL, HARNESS], DEFAULTS, null);
    expect(kept[0]).toHaveLength(REAL.length);
  });

  it('keeps a session whose events carry no cwd', () => {
    const noCwd = [{ v: 1, ts: '2026-08-01T10:00:00.000Z', session_id: 'x', event: 'Stop', origin: 'import', payload: {} } as EventEnvelope];
    const { kept } = applyCorpusFilters([noCwd], DEFAULTS, null);
    expect(kept).toHaveLength(1);
  });
});

describe('formatExcluded', () => {
  it('states the rules even when nothing was excluded', () => {
    const { summary } = applyCorpusFilters([REAL], DEFAULTS, null);
    expect(formatExcluded(summary)).toContain('0 sessions');
    expect(formatExcluded(summary)).toContain('/private/tmp/**');
  });

  it('says so plainly when no rules are active', () => {
    const { summary } = applyCorpusFilters([REAL], [], null);
    expect(formatExcluded(summary)).toBe('Excluded: none (no hygiene rules active)');
  });

  it('counts sessions and events when rules fire', () => {
    const { summary } = applyCorpusFilters([REAL, HARNESS], DEFAULTS, null);
    expect(formatExcluded(summary)).toContain('1 session(s)');
    expect(formatExcluded(summary)).toContain(`${HARNESS.length} event(s)`);
  });
});

describe('region display names', () => {
  it('disambiguates projects that share a leaf name', () => {
    const sink = new TelemetrySink();
    for (const e of session('a', '/tmp/01-bugfix/opus', 1)) sink.onEvent(e);
    for (const e of session('b', '/tmp/03-refactor/opus', 1)) sink.onEvent(e);
    for (const e of session('c', '/tmp/solo', 1)) sink.onEvent(e);

    const names = Object.values(sink.summary().projects).map((p) => p.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toContain('01-bugfix/opus');
    expect(names).toContain('03-refactor/opus');
    expect(names).toContain('solo');
  });
});

describe('ccidle backtest (corpus hygiene end to end)', () => {
  function writeCorpus(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccidle-hygiene-'));
    for (const [name, events] of [
      ['real', REAL],
      ['harness', HARNESS],
      ['scratch', SCRATCH]
    ] as const) {
      fs.writeFileSync(path.join(dir, `${name}.jsonl`), events.map(serializeEvent).join(''));
    }
    return dir;
  }

  it('applies the defaults and shows the exclusion summary in the report', async () => {
    const dir = writeCorpus();
    const lines: string[] = [];
    const code = await runBacktest({ corpusDir: dir, out: (l) => lines.push(l), env: { CCIDLE_HOME: dir } });
    const md = lines.join('\n');

    expect(code).toBe(0);
    expect(md).toContain('Excluded: 2 session(s)');
    expect(md).toContain('### Excluded by rule');
    expect(md).not.toContain('/private/tmp/claude-501/bench |');
  });

  it('replays the whole corpus when excludes are cleared', async () => {
    const dir = writeCorpus();
    const lines: string[] = [];
    await runBacktest({ corpusDir: dir, exclude: [], out: (l) => lines.push(l), env: { CCIDLE_HOME: dir } });
    const md = lines.join('\n');

    expect(md).toContain('- Sessions: 3');
    expect(md).toContain('Excluded: none');
  });

  it('stays byte-identical across runs', async () => {
    const dir = writeCorpus();
    const first: string[] = [];
    const second: string[] = [];
    await runBacktest({ corpusDir: dir, json: true, out: (l) => first.push(l), env: { CCIDLE_HOME: dir } });
    await runBacktest({ corpusDir: dir, json: true, out: (l) => second.push(l), env: { CCIDLE_HOME: dir } });
    expect(first.join('\n')).toBe(second.join('\n'));
  });

  it('fails clearly when hygiene removes everything', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccidle-hygiene-all-'));
    fs.writeFileSync(path.join(dir, 'harness.jsonl'), HARNESS.map(serializeEvent).join(''));
    const code = await runBacktest({ corpusDir: dir, out: () => {}, env: { CCIDLE_HOME: dir } });
    expect(code).toBe(1);
  });
});
