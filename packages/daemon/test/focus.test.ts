import { describe, it, expect, beforeEach } from 'vitest';
import type { Config } from '@ccidle/shared';
import { FocusEngine, type Clock, type PaneResolver, type AlertEvent } from '../src/focus.js';
import { FakeTmuxClient } from '../src/tmux.js';

class FakeClock implements Clock {
  private currentTime = 0;
  private timers: Array<{ id: number; at: number; fn: () => void }> = [];
  private nextId = 1;

  now(): number {
    return this.currentTime;
  }

  setTimeout(fn: () => void, ms: number): unknown {
    const id = this.nextId++;
    this.timers.push({ id, at: this.currentTime + ms, fn });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.timers = this.timers.filter((t) => t.id !== handle);
  }

  /** Advance time and fire any timers now due, in scheduled order. */
  advance(ms: number): void {
    this.currentTime += ms;
    const due = this.timers.filter((t) => t.at <= this.currentTime).sort((a, b) => a.at - b.at);
    for (const t of due) {
      this.timers = this.timers.filter((x) => x.id !== t.id);
      t.fn();
    }
  }
}

class FakePanes implements PaneResolver {
  cc = new Map<string, string>();
  game: string | null = 'game:0.0';

  async ccPaneTarget(sessionId: string): Promise<string | null> {
    return this.cc.get(sessionId) ?? null;
  }

  async gamePaneTarget(): Promise<string | null> {
    return this.game;
  }
}

/** Flush pending microtask chains kicked off by fired timers. */
async function flush(times = 3): Promise<void> {
  for (let i = 0; i < times; i++) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}

const focusConfig: Config['focus'] = {
  enabled: true,
  graceMs: 3000,
  dwellMs: 5000,
  manualCooldownMs: 10000
};

function makeEngine(overrides?: Partial<Config['focus']>) {
  const tmux = new FakeTmuxClient();
  const clock = new FakeClock();
  const panes = new FakePanes();
  const alerts: AlertEvent[] = [];
  const engine = new FocusEngine({
    tmux,
    clock,
    panes,
    focusConfig: { ...focusConfig, ...overrides },
    onAlert: (a) => alerts.push(a)
  });
  return { tmux, clock, panes, alerts, engine };
}

describe('FocusEngine', () => {
  beforeEach(() => {
    // nothing shared between tests; each test builds its own engine
  });

  it('does not steal focus on grace-switch when the user is not in that session pane', async () => {
    const { tmux, clock, panes, engine } = makeEngine();
    panes.cc.set('sess-a', 'work:0.0');
    tmux.currentTarget = 'work:0.1'; // user is elsewhere, not in sess-a's CC pane

    await engine.onTransition('sess-a', 'HUMAN_ACTIVE', 'CC_WORKING');
    clock.advance(focusConfig.graceMs);
    await flush();

    expect(tmux.focusCalls).toEqual([]);
  });

  it('switches to the game pane after graceMs when the user is in the CC pane', async () => {
    const { tmux, clock, panes, engine } = makeEngine();
    panes.cc.set('sess-a', 'work:0.0');
    tmux.currentTarget = 'work:0.0';

    await engine.onTransition('sess-a', 'HUMAN_ACTIVE', 'CC_WORKING');
    clock.advance(focusConfig.graceMs - 1);
    await flush();
    expect(tmux.focusCalls).toEqual([]); // not yet

    clock.advance(1);
    await flush();
    expect(tmux.focusCalls).toEqual(['game:0.0']);
  });

  it('suppresses the grace switch while another session is HUMAN_ACTIVE', async () => {
    const { tmux, clock, panes, engine } = makeEngine();
    panes.cc.set('sess-a', 'work:0.0');
    panes.cc.set('sess-b', 'work:0.1');
    tmux.currentTarget = 'work:0.0';

    // sess-b is already queued as needs-you
    await engine.onTransition('sess-b', 'CC_WORKING', 'HUMAN_ACTIVE');
    await engine.onTransition('sess-a', 'HUMAN_ACTIVE', 'CC_WORKING');

    clock.advance(focusConfig.graceMs);
    await flush();

    expect(tmux.focusCalls).toEqual([]);
  });

  it('returns to the CC pane immediately on HUMAN_ACTIVE while the user is in the game pane', async () => {
    const { tmux, panes, engine } = makeEngine();
    panes.cc.set('sess-a', 'work:0.0');
    tmux.currentTarget = 'game:0.0';

    await engine.onTransition('sess-a', 'CC_WORKING', 'HUMAN_ACTIVE');

    expect(tmux.focusCalls).toEqual(['work:0.0']);
  });

  it('does not steal focus on HUMAN_ACTIVE if the user is not in the game pane', async () => {
    const { tmux, panes, engine } = makeEngine();
    panes.cc.set('sess-a', 'work:0.0');
    panes.cc.set('sess-b', 'work:0.1');
    tmux.currentTarget = 'work:0.1'; // user is in sess-b's pane, typing

    await engine.onTransition('sess-a', 'CC_WORKING', 'HUMAN_ACTIVE');

    expect(tmux.focusCalls).toEqual([]);
  });

  it('enforces a minimum dwell between auto-switches', async () => {
    const { tmux, clock, panes, engine } = makeEngine();
    panes.cc.set('sess-a', 'work:0.0');
    tmux.currentTarget = 'work:0.0';

    // First grace switch: cc -> game at t=3000.
    await engine.onTransition('sess-a', 'HUMAN_ACTIVE', 'CC_WORKING');
    clock.advance(3000);
    await flush();
    expect(tmux.focusCalls).toEqual(['game:0.0']);

    // Immediate return to CC at t=3100 (urgent path, not dwell-gated) puts the user back in ccA.
    clock.advance(100);
    await engine.onTransition('sess-a', 'CC_WORKING', 'HUMAN_ACTIVE');
    await flush();
    expect(tmux.focusCalls).toEqual(['game:0.0', 'work:0.0']);

    // A second CC_WORKING at t=3200 schedules a grace switch for t=6200 — inside the
    // 5s dwell window measured from the t=3100 auto-switch, so it must be suppressed.
    clock.advance(100);
    await engine.onTransition('sess-a', 'HUMAN_ACTIVE', 'CC_WORKING');
    clock.advance(3000); // now t=6200
    await flush();
    expect(tmux.focusCalls).toEqual(['game:0.0', 'work:0.0']); // unchanged: dwell blocked it
  });

  it('suppresses auto-switch for manualCooldownMs after a detected manual focus change, then resumes', async () => {
    const { tmux, clock, panes, engine } = makeEngine();
    panes.cc.set('sess-a', 'work:0.0');
    tmux.currentTarget = 'work:0.0';

    await engine.onTransition('sess-a', 'HUMAN_ACTIVE', 'CC_WORKING');
    clock.advance(3000); // t=3000: auto grace-switch to game
    await flush();
    expect(tmux.focusCalls).toEqual(['game:0.0']);

    // User manually tmux-jumps back to the CC pane themselves (not via the engine).
    tmux.currentTarget = 'work:0.0';

    // New turn: detectManualOverride notices the mismatch and starts a 10s cooldown.
    clock.advance(100); // t=3100
    await engine.onTransition('sess-a', 'HUMAN_ACTIVE', 'CC_WORKING');
    clock.advance(3000); // fire grace at t=6100 — still within the cooldown window (until 13100)
    await flush();
    expect(tmux.focusCalls).toEqual(['game:0.0']); // suppressed

    // Once the cooldown has elapsed, a fresh CC_WORKING should be free to auto-switch again.
    clock.advance(10000); // now well past 13100
    await engine.onTransition('sess-a', 'HUMAN_ACTIVE', 'CC_WORKING');
    clock.advance(3000);
    await flush();
    expect(tmux.focusCalls).toEqual(['game:0.0', 'game:0.0']);
  });

  it('queues simultaneous HUMAN_ACTIVE sessions FIFO', async () => {
    const { tmux, panes, engine } = makeEngine();
    panes.cc.set('sess-a', 'work:0.0');
    panes.cc.set('sess-b', 'work:0.1');
    panes.cc.set('sess-c', 'work:0.2');
    tmux.currentTarget = 'work:9.9'; // user elsewhere — nothing auto-focuses

    await engine.onTransition('sess-a', 'CC_WORKING', 'HUMAN_ACTIVE');
    await engine.onTransition('sess-b', 'CC_WORKING', 'HUMAN_ACTIVE');
    await engine.onTransition('sess-c', 'CC_WORKING', 'HUMAN_ACTIVE');

    expect(engine.getQueue()).toEqual(['sess-a', 'sess-b', 'sess-c']);

    // Servicing sess-b out of order still preserves FIFO order for the rest.
    await engine.focusSession('sess-b');
    expect(engine.getQueue()).toEqual(['sess-a', 'sess-c']);

    await engine.onTransition('sess-a', 'HUMAN_ACTIVE', 'CC_WORKING');
    expect(engine.getQueue()).toEqual(['sess-c']);
  });

  it('emits needs-you and clear alerts with the live queue', async () => {
    const { panes, engine, alerts } = makeEngine();
    panes.cc.set('sess-a', 'work:0.0');

    await engine.onTransition('sess-a', 'CC_WORKING', 'HUMAN_ACTIVE');
    expect(alerts.at(-1)).toMatchObject({ kind: 'needs-you', sessionId: 'sess-a', queue: ['sess-a'] });

    await engine.onTransition('sess-a', 'HUMAN_ACTIVE', 'CC_WORKING');
    expect(alerts.at(-1)).toMatchObject({ kind: 'clear', sessionId: 'sess-a', queue: [] });
  });

  it('pause()/resume() disables and re-enables auto-switching', async () => {
    const { tmux, clock, panes, engine } = makeEngine();
    panes.cc.set('sess-a', 'work:0.0');
    tmux.currentTarget = 'work:0.0';
    engine.pause();
    expect(engine.isPaused()).toBe(true);

    await engine.onTransition('sess-a', 'HUMAN_ACTIVE', 'CC_WORKING');
    clock.advance(focusConfig.graceMs);
    await flush();
    expect(tmux.focusCalls).toEqual([]);

    engine.resume();
    tmux.currentTarget = 'work:0.0'; // user still in the CC pane
    await engine.onTransition('sess-a', 'CC_WORKING', 'HUMAN_ACTIVE');
    await engine.onTransition('sess-a', 'HUMAN_ACTIVE', 'CC_WORKING');
    clock.advance(focusConfig.graceMs);
    await flush();
    expect(tmux.focusCalls).toEqual(['game:0.0']);
  });
});
