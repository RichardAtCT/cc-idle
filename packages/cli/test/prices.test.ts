import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { serializeEvent, type EventEnvelope } from '@ccidle/shared';
import { runBacktest } from '../src/backtest.js';
import {
  costOf,
  findPriceTablePath,
  formatUsd,
  loadPriceTable,
  priceFor,
  type PriceTable
} from '../src/prices.js';

/**
 * The price table is the only source of cost figures in the report. A model it
 * does not list must render as "n/a" and stay out of every total — a guessed
 * rate would quietly corrupt the numbers it is meant to inform.
 */

describe('config/prices.json', () => {
  const table = loadPriceTable();

  it('is found and parses', () => {
    expect(findPriceTablePath()).not.toBeNull();
    expect(table).not.toBeNull();
  });

  it('records where the rates came from and when', () => {
    expect(table!.metadata.currency).toBe('USD');
    expect(table!.metadata.source).toMatch(/^https:\/\//);
    expect(table!.metadata.retrieved).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(table!.metadata.unit).toBeTruthy();
  });

  it('states the unknown-model policy rather than leaving it implied', () => {
    expect(table!.unknownModel.display).toBe('n/a');
    expect(table!.unknownModel.policy).toBe('omit');
  });

  it('covers every model in the baseline corpus report', () => {
    for (const model of [
      'claude-fable-5',
      'claude-opus-5',
      'claude-opus-4-8',
      'claude-sonnet-5',
      'claude-haiku-4-5-20251001'
    ]) {
      expect(priceFor(table, model), `${model} must be priced`).not.toBeNull();
    }
  });

  it('keeps every rate positive and ordered as the pricing model requires', () => {
    for (const [id, price] of Object.entries(table!.models)) {
      for (const [field, value] of Object.entries(price)) {
        if (typeof value !== 'number') continue;
        expect(value, `${id}.${field}`).toBeGreaterThan(0);
      }
      // Published multipliers: reads are 0.1x input, 5m writes 1.25x, 1h writes 2x.
      expect(price.cacheRead, `${id} cache read`).toBeCloseTo(price.input * 0.1, 6);
      expect(price.cacheWrite5m, `${id} 5m write`).toBeCloseTo(price.input * 1.25, 6);
      expect(price.cacheWrite1h, `${id} 1h write`).toBeCloseTo(price.input * 2, 6);
      expect(price.output, `${id} output`).toBeGreaterThan(price.input);
    }
  });

  it('resolves dated model ids through the alias map', () => {
    expect(priceFor(table, 'claude-haiku-4-5-20251001')).toEqual(priceFor(table, 'claude-haiku-4-5'));
  });
});

describe('costOf', () => {
  const price = { input: 5, output: 25, cacheRead: 0.5, cacheWrite5m: 6.25, cacheWrite1h: 10 };

  it('prices each token category per million', () => {
    const cost = costOf(price, {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheReadTokens: 1_000_000,
      cacheWriteTokens: 1_000_000
    })!;
    expect(cost.input).toBeCloseTo(5);
    expect(cost.output).toBeCloseTo(25);
    expect(cost.cacheRead).toBeCloseTo(0.5);
    expect(cost.cacheWrite).toBeCloseTo(6.25);
    expect(cost.total).toBeCloseTo(36.75);
  });

  it('returns null for an unpriced model rather than zero', () => {
    expect(
      costOf(null, { inputTokens: 1, outputTokens: 1, cacheReadTokens: 1, cacheWriteTokens: 1 })
    ).toBeNull();
  });
});

describe('formatUsd', () => {
  it('renders the unknown marker for a null cost', () => {
    expect(formatUsd(null)).toBe('n/a');
    expect(formatUsd(null, '—')).toBe('—');
  });

  it('distinguishes a true zero from a rounded-away amount', () => {
    expect(formatUsd(0)).toBe('$0.00');
    expect(formatUsd(0.0004)).toBe('<$0.01');
  });

  it('groups thousands', () => {
    expect(formatUsd(1853.6)).toBe('$1,853.60');
  });
});

describe('backtest cost columns', () => {
  function corpusWith(models: string[]): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccidle-prices-'));
    const byModel: Record<string, unknown> = {};
    for (const m of models) {
      byModel[m] = {
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        cacheReadTokens: 0,
        cacheWriteTokens: 0
      };
    }
    const events: EventEnvelope[] = [
      {
        v: 1,
        ts: '2026-08-01T10:00:00.000Z',
        session_id: 's1',
        event: 'SessionStart',
        cwd: '/Users/x/proj',
        origin: 'import',
        payload: {}
      } as EventEnvelope,
      {
        v: 1,
        ts: '2026-08-01T10:01:00.000Z',
        session_id: 's1',
        event: 'UserPromptSubmit',
        cwd: '/Users/x/proj',
        origin: 'import',
        payload: {}
      } as EventEnvelope,
      {
        v: 1,
        ts: '2026-08-01T10:02:00.000Z',
        session_id: 's1',
        event: 'TokenUsage',
        cwd: '/Users/x/proj',
        origin: 'import',
        payload: { byModel }
      } as EventEnvelope
    ];
    fs.writeFileSync(path.join(dir, 's1.jsonl'), events.map(serializeEvent).join(''));
    return dir;
  }

  it('shows a cost column and a labelled approximation notice', async () => {
    const dir = corpusWith(['claude-opus-5']);
    const lines: string[] = [];
    await runBacktest({ corpusDir: dir, out: (l) => lines.push(l), env: { CCIDLE_HOME: dir } });
    const md = lines.join('\n');

    expect(md).toContain('Est. cost');
    expect(md).toContain('**approximate**');
    expect(md).toContain('retrieved 2026-08-17');
    // 1M input @ $5 + 1M output @ $25
    expect(md).toContain('$30.00');
  });

  it('renders n/a for an unpriced model and leaves it out of the total', async () => {
    const dir = corpusWith(['claude-opus-5', 'claude-from-the-future-9']);
    const lines: string[] = [];
    const code = await runBacktest({ corpusDir: dir, out: (l) => lines.push(l), env: { CCIDLE_HOME: dir } });
    const md = lines.join('\n');

    expect(code).toBe(0);
    expect(md).toMatch(/claude-from-the-future-9 \|[^|]*\|[^|]*\|[^|]*\|[^|]*\| n\/a \|/);
    expect(md).toContain('No published rate for `claude-from-the-future-9`');
    // Total stays the priced model's $30.00 — the unpriced one contributes nothing.
    expect(md).toMatch(/\*\*Total\*\*.*\$30\.00/);
  });

  it('costs a model that is priced only through an alias', async () => {
    const dir = corpusWith(['claude-haiku-4-5-20251001']);
    const lines: string[] = [];
    await runBacktest({ corpusDir: dir, out: (l) => lines.push(l), env: { CCIDLE_HOME: dir } });
    // 1M input @ $1 + 1M output @ $5
    expect(lines.join('\n')).toContain('$6.00');
  });

  it('degrades to n/a without erroring when the table is unreadable', () => {
    const missing = loadPriceTable(path.join(os.tmpdir(), 'definitely-not-a-price-table.json'));
    expect(missing).toBeNull();
    expect(priceFor(missing as PriceTable | null, 'claude-opus-5')).toBeNull();
    expect(formatUsd(null)).toBe('n/a');
  });
});
