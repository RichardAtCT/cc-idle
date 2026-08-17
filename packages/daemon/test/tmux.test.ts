import { describe, it, expect } from 'vitest';
import { FakeTmuxClient } from '../src/tmux.js';

describe('FakeTmuxClient', () => {
  it('reports availability and current pane target', async () => {
    const tmux = new FakeTmuxClient();
    expect(await tmux.isAvailable()).toBe(true);
    expect(await tmux.currentPaneTarget()).toBe('work:0.0');
  });

  it('resolves pane ids to targets via the panes map', async () => {
    const tmux = new FakeTmuxClient();
    tmux.panes.set('%3', 'work:1.0');
    expect(await tmux.resolvePaneTarget('%3')).toBe('work:1.0');
    expect(await tmux.resolvePaneTarget('%99')).toBeNull();
  });

  it('focusPane updates currentTarget and records the call', async () => {
    const tmux = new FakeTmuxClient();
    const ok = await tmux.focusPane('game:0.1');
    expect(ok).toBe(true);
    expect(tmux.currentTarget).toBe('game:0.1');
    expect(tmux.focusCalls).toEqual(['game:0.1']);
  });

  it('returns null/false when unavailable', async () => {
    const tmux = new FakeTmuxClient();
    tmux.available = false;
    expect(await tmux.currentPaneTarget()).toBeNull();
    expect(await tmux.focusPane('game:0.1')).toBe(false);
  });

  it('records bell calls', async () => {
    const tmux = new FakeTmuxClient();
    await tmux.bell('work:0.0');
    expect(tmux.bellCalls).toEqual(['work:0.0']);
  });
});
