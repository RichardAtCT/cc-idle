import { describe, expect, mock, test } from 'claude-code/testing';
import type { Engine } from 'claude-code/testing';
import type { On } from 'claude-code';

// Run with: claude plugin test plugins/cc-idle
// The hooks registered here stand for the engine beneath the mod.

const SESSION = 'sess-1';
const CWD = '/work/cc-idle';
const START = Date.parse('2026-10-02T10:00:00Z');
const STARTED = { cwd: CWD, surface: 'terminal' as const, isInteractive: true };

/** A returning player unless the store says otherwise; `isPlaced: false` is a narrow terminal. */
function engine(on: On, store: Record<string, unknown> = {}, { isPlaced = true } = {}) {
  const clock = mock.clock(on, { now: START });
  // An in-memory $.store the test can read back.
  const kv = new Map<string, unknown>(Object.entries({ onboarded: true, ...store }));
  on('store.get', async (_$, e) => ({ value: kv.get(e.key) }));
  on('store.set', async (_$, e) => {
    kv.set(e.key, e.value);
    return { value: undefined };
  });
  const seen = { statuses: [] as string[], toasts: [] as string[], opened: [] as string[] };
  on('session.id', async () => ({ value: SESSION }));
  on('session.cwd', async () => ({ value: CWD }));
  on('command.register', async (_$, e) => ({ value: { command: e.name } }));
  on('session.start', async () => ({ cwd: CWD }));
  on('ui.open', async (_$, e) => {
    seen.opened.push(e.id);
    return {
      value: isPlaced
        ? { isPlaced: true as const }
        : { isPlaced: false as const, reason: 'terminal is 100 columns; 144 seat it unasked' }
    };
  });
  on('ui.close', async () => ({ value: undefined }));
  on('ui.status', async (_$, e) => {
    if (e.text !== undefined) seen.statuses.push(e.text);
    return { value: undefined };
  });
  on('ui.toast', async (_$, e) => {
    seen.toasts.push(e.text);
    return { value: undefined };
  });
  // Every model request reports 4,000 output tokens.
  on('turn.step', async function* (_$, e) {
    return {
      turnId: e.turnId,
      index: e.index,
      answer: '',
      toolUses: [],
      stopReason: 'end_turn' as const,
      usage: {
        model: 'claude-test',
        input_tokens: 100,
        output_tokens: 4_000,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0
      }
    };
  });
  on('turn.start', async (_$, e) => ({ turnId: e.turnId }));
  on('turn.complete', async (_$, e) => ({ text: e.answer }));
  // Bash fails; every other tool succeeds.
  on('tool.call', async (_$, e) =>
    e.tool === 'Bash' ? { result: 'exit 1', isError: true as const } : { result: { ok: true } }
  );
  return { clock, seen, kv };
}

const PANE = {
  plugin: 'cc-idle',
  component: 'Pane' as const,
  requestId: 'cc-idle',
  props: {
    title: 'cc-idle',
    isFocused: true,
    bodyColumns: 60,
    placement: 'dock' as const,
    scroll: { offset: 0, bodyRows: 30 },
    view: {}
  }
};

async function step($: Engine, turnId: string) {
  const stream = $.turn.step({ turnId, index: 0, model: 'claude-test', messageCount: 1 });
  for await (const _chunk of stream) {
    // drain
  }
  return stream.result;
}

describe('cc-idle economy', () => {
  test('a working turn earns Compute and founds the region', async ($, on) => {
    const { clock, seen } = engine(on);
    await $.session.start(STARTED);
    expect(seen.opened).toContain('cc-idle');

    await $.turn.start({ text: 'refactor the parser', turnId: 't1' });
    await step($, 't1');
    await step($, 't1');
    await $.tool.call({ tool: 'Edit', tool_use_id: 'tu1', file_path: '/x', old_string: 'a', new_string: 'b' } as never);
    await $.turn.complete({
      answer: 'done',
      durationMs: 60_000,
      isAborted: false,
      turnId: 't1',
      reason: 'answer'
    });
    await clock.advance(2_000);

    const last = seen.statuses.at(-1) ?? '';
    expect(last).toStartWith('cc-idle ');
    expect(last).not.toStartWith('cc-idle 0 FLOPS');

    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ ...PANE, surface });
      expect(await ui.find({ text: /cc-idle/ })).toBeDefined();
      expect(await ui.find({ text: /FLOPS/ })).toBeDefined();
      expect(await ui.find({ text: /your turn/ })).toBeDefined();
      await ui.unmount();
    }
  });

  test('a failed tool call raises an incident the player can acknowledge', async ($, on) => {
    engine(on);
    await $.session.start(STARTED);
    await $.turn.start({ text: 'run the tests', turnId: 't1' });
    await $.tool.call({ tool: 'Bash', tool_use_id: 'tu1', command: 'false' } as never);

    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' });
    expect(await ui.find({ text: /⚡/ })).toBeDefined();
    await ui.press({ key: 'act-a' });
    expect(await ui.find({ text: /post-mortem filed/ })).toBeDefined();
    await ui.unmount();
  });

  test('the breakthrough screen opens and closes on its hotkey buttons', async ($, on) => {
    engine(on);
    await $.session.start(STARTED);
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' });
    await ui.press({ key: 'open-tree' });
    expect(await ui.find({ text: /BREAKTHROUGHS/ })).toBeDefined();
    await ui.press({ key: 'tree-back' });
    expect(await ui.find({ text: /FRONTIER LAB/ })).toBeDefined();
    await ui.unmount();
  });

  test("another session's saved work shows up here", async ($, on) => {
    const other = {
      save: {
        v: 1,
        stamp: 'sess-0:1:0',
        updatedAt: '2026-10-02T09:00:00Z',
        game: {
          createdAt: '2026-10-01T00:00:00Z',
          generation: 3,
          resources: { compute: 123_456, engineering: 0, research: 0, reputation: 0, breakthroughs: 2 }
        }
      }
    };
    const { seen } = engine(on, other);
    await $.session.start(STARTED);
    expect(seen.statuses.at(-1)).toBe('cc-idle 123K FLOPS · Gen-3');
  });

  test('spending Compute buys a GPU in the focused region and persists it', async ($, on) => {
    const saved = {
      save: {
        v: 1,
        stamp: 'sess-0:1:0',
        updatedAt: '2026-10-02T09:00:00Z',
        game: {
          createdAt: '2026-10-01T00:00:00Z',
          resources: { compute: 1_000, engineering: 0, research: 0, reputation: 0, breakthroughs: 0 },
          regions: { [CWD]: { id: CWD, name: 'cc-idle', foundedAt: '2026-10-01T00:00:00Z' } }
        }
      }
    };
    const { clock, kv } = engine(on, saved);
    await $.session.start(STARTED);
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' });
    await ui.press({ key: 'act-g' });
    expect(await ui.find({ text: /GPU #1 online/ })).toBeDefined();
    await clock.advance(2_000);
    const stored = kv.get('save') as { game: { regions: Record<string, { infrastructure: Record<string, number> }> } };
    expect(stored.game.regions[CWD]?.infrastructure['gpu']).toBe(1);
    await ui.unmount();
  });

  test('a new player sees the welcome first, once', async ($, on) => {
    const { kv } = engine(on, { onboarded: undefined });
    await $.session.start(STARTED);
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' });
    expect(await ui.find({ text: /WELCOME TO CC-IDLE/ })).toBeDefined();
    await ui.press({ key: 'help-done' });
    expect(await ui.find({ text: /FRONTIER LAB/ })).toBeDefined();
    expect(await ui.find({ text: /Ask Claude anything/ })).toBeDefined();
    expect(kv.get('onboarded')).toBe(true);
    // Help stays one key away, now without the welcome.
    await ui.press({ key: 'open-help' });
    expect(await ui.find({ text: /HOW TO PLAY/ })).toBeDefined();
    await ui.unmount();
  });

  test('a new player in a narrow terminal is told about /idle', async ($, on) => {
    const { seen } = engine(on, { onboarded: undefined }, { isPlaced: false });
    await $.session.start(STARTED);
    await $.turn.start({ text: 'hi', turnId: 't1' });
    expect(seen.toasts).toContain('cc-idle is installed: type /idle to play');
  });

  test('a returning player in a narrow terminal gets no toast', async ($, on) => {
    const { seen } = engine(on, {}, { isPlaced: false });
    await $.session.start(STARTED);
    await $.turn.start({ text: 'hi', turnId: 't1' });
    expect(seen.toasts).toEqual([]);
  });

  test('a permission prompt flags that Claude needs the person', async ($, on) => {
    engine(on);
    on('tool.check', async () => ({ decision: 'ask' as const }));
    await $.session.start(STARTED);
    await $.turn.start({ text: 'deploy', turnId: 't1' });
    await $.tool.check({ tool: 'Bash', tool_use_id: 'tu1', command: 'make deploy' } as never);
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' });
    expect(await ui.find({ text: /needs your permission/ })).toBeDefined();
    await ui.unmount();

    // Once the call runs (in a subagent here), the banner clears.
    await $.tool.call({ tool: 'Read', tool_use_id: 'tu2', file_path: '/x', agentId: 'agent-1' } as never);
    const after = await $.ui.mount({ ...PANE, surface: 'terminal' });
    expect(await after.find({ text: /needs your permission/ })).toBeUndefined();
    await after.unmount();
  });
});
