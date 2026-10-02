import { describe, expect, it } from 'vitest';
import { GameSync, SAVE_KEY, type KeyValue } from '../src/sync.js';
import { promptSubmitted, tokensUsed, turnStopped } from '../src/telemetry.js';

function memoryStore(): KeyValue & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  return {
    data,
    get: async (key) => structuredClone(data.get(key)),
    set: async (key, value) => {
      data.set(key, structuredClone(value));
    }
  };
}

const T0 = Date.parse('2026-10-02T10:00:00Z');
const usage = (output: number) => ({
  model: 'm',
  input_tokens: 0,
  output_tokens: output,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0
});

describe('GameSync', () => {
  it('applies inputs locally at once and persists them on flush', async () => {
    const kv = memoryStore();
    const sync = new GameSync(kv, 'a', () => T0);
    const ref = { sessionId: 'a', cwd: '/p/one' };
    sync.push({ kind: 'telemetry', envelope: promptSubmitted(ref, T0) });
    sync.push({ kind: 'telemetry', envelope: tokensUsed(ref, T0, usage(1_000)) });
    expect(sync.state.resources.compute).toBeGreaterThan(0);
    expect(kv.data.has(SAVE_KEY)).toBe(false);

    await sync.flush();
    expect(sync.pendingCount).toBe(0);
    const saved = kv.data.get(SAVE_KEY) as { game: { resources: { compute: number } } };
    expect(saved.game.resources.compute).toBe(sync.state.resources.compute);
  });

  it('merges two sessions onto one economy without losing either', async () => {
    const kv = memoryStore();
    const a = new GameSync(kv, 'a', () => T0);
    const b = new GameSync(kv, 'b', () => T0);
    const refA = { sessionId: 'a', cwd: '/p/one' };
    const refB = { sessionId: 'b', cwd: '/p/two' };

    // Both start from an empty store and work concurrently.
    a.push({ kind: 'telemetry', envelope: tokensUsed(refA, T0, usage(1_000)) });
    b.push({ kind: 'telemetry', envelope: tokensUsed(refB, T0, usage(2_000)) });
    await a.flush();
    await b.flush();

    // A single session that saw both events would land on the same state.
    const solo = new GameSync(memoryStore(), 'solo', () => T0);
    solo.push({ kind: 'telemetry', envelope: tokensUsed(refA, T0, usage(1_000)) });
    solo.push({ kind: 'telemetry', envelope: tokensUsed(refB, T0, usage(2_000)) });

    expect(b.state.resources.compute).toBeCloseTo(solo.state.resources.compute);
    expect(Object.keys(b.state.regions).sort()).toEqual(['/p/one', '/p/two']);

    // A picks up B's work on refresh.
    expect(await a.refresh()).toBe(true);
    expect(a.state.resources.compute).toBeCloseTo(solo.state.resources.compute);
    expect(await a.refresh()).toBe(false);
  });

  it('keeps queued inputs on top when another session writes first', async () => {
    const kv = memoryStore();
    const a = new GameSync(kv, 'a', () => T0);
    const b = new GameSync(kv, 'b', () => T0);
    const ref = { sessionId: 'b', cwd: '/p/one' };
    b.push({ kind: 'telemetry', envelope: promptSubmitted(ref, T0) });
    b.push({ kind: 'telemetry', envelope: turnStopped(ref, T0) });
    await b.flush();
    a.push({ kind: 'action', action: { type: 'hire' } }); // fails for lack of eng, but narrates
    await a.refresh();
    expect(a.state.resources.reputation).toBe(b.state.resources.reputation);
    expect(a.pendingCount).toBe(0);
    expect(a.state.log.at(-1)?.text).toMatch(/hire costs/);
  });

  it('ignores an unreadable save and replaces it on the next flush', async () => {
    const kv = memoryStore();
    kv.data.set(SAVE_KEY, { v: 99, junk: true });
    const sync = new GameSync(kv, 'a', () => T0);
    expect(await sync.refresh()).toBe(false);
    sync.push({ kind: 'telemetry', envelope: tokensUsed({ sessionId: 'a', cwd: '/p' }, T0, usage(10)) });
    await sync.flush();
    expect((kv.data.get(SAVE_KEY) as { v: number }).v).toBe(1);
  });

  it('serializes overlapping flushes', async () => {
    const kv = memoryStore();
    const sync = new GameSync(kv, 'a', () => T0);
    const ref = { sessionId: 'a', cwd: '/p' };
    sync.push({ kind: 'telemetry', envelope: tokensUsed(ref, T0, usage(100)) });
    const first = sync.flush();
    sync.push({ kind: 'telemetry', envelope: tokensUsed(ref, T0, usage(100)) });
    await Promise.all([first, sync.flush()]);
    const saved = kv.data.get(SAVE_KEY) as { game: { stats: { outputTokensSeen: number } } };
    expect(saved.game.stats.outputTokensSeen).toBe(200);
  });
});
