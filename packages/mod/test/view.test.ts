import { describe, expect, it } from 'vitest';
import { generationThreshold, hireCost, initialGameState, type GameState } from '../src/game.js';
import { breakthroughRows, focusedRegion, infraActions, labView, nextStep, rackDiagram, statusText } from '../src/view.js';

function game(patch: (g: GameState) => void = () => {}): GameState {
  const g = initialGameState('2026-10-02T10:00:00Z');
  for (const [id, foundedAt] of [
    ['/p/a', '2026-10-01T00:00:00Z'],
    ['/p/b', '2026-10-02T00:00:00Z']
  ] as const) {
    g.regions[id] = {
      id,
      name: id.slice(3),
      foundedAt,
      status: 'idle',
      infrastructure: {},
      window: { startMs: 0, outputTokens: 0 },
      turnAccrual: 0,
      incidents: [],
      lastIncidentAtMs: 0,
      totals: { compute: 0, engineering: 0, research: 0, outputTokens: 0, incidents: 0 }
    };
  }
  patch(g);
  return g;
}

describe('pane view model', () => {
  it('uses only hotkeys a mod Button accepts (one lowercase letter or digit)', () => {
    const g = game();
    const keys = [
      ...infraActions(g, g.regions['/p/a']!).map((a) => a.hotkey),
      ...labView(g, 10).actions.map((a) => a.hotkey),
      ...breakthroughRows(g).map((a) => a.hotkey)
    ];
    for (const key of keys) expect(key).toMatch(/^[a-z0-9]$/);
    // Region buttons and lab buttons share one pane: no collisions.
    const main = [...infraActions(g, g.regions['/p/a']!), ...labView(g, 10).actions].map((a) => a.hotkey);
    expect(new Set([...main, 'a', 'n', 'v', 'i']).size).toBe(main.length + 4);
  });

  describe('next-step hint', () => {
    const a = (g: GameState) => g.regions['/p/a']!;

    it('tells a player with no region to put Claude to work', () => {
      const empty = initialGameState('2026-10-02T10:00:00Z');
      expect(nextStep(empty, null)).toMatch(/Ask Claude/);
    });

    it('puts an open incident first', () => {
      const g = game((s) => {
        s.resources.compute = 1_000;
        a(s).incidents.push({ id: 'i1', title: 'x', startedAt: '2026-10-02T10:00:00Z' });
      });
      expect(nextStep(g, a(g))).toMatch(/Press a/);
    });

    it('points at the first GPU only once it is affordable', () => {
      expect(nextStep(game(), a(game()))).toBeNull();
      const g = game((s) => (s.resources.compute = 1_000));
      expect(nextStep(g, a(g))).toMatch(/Press g/);
      const owned = game((s) => {
        s.resources.compute = 1_000;
        a(s).infrastructure['gpu'] = 1;
      });
      expect(nextStep(owned, a(owned))).toBeNull();
    });

    it('points at the first researcher once one is affordable', () => {
      const g = game((s) => {
        s.resources.reputation = 1_000;
        s.resources.engineering = hireCost(0);
        a(s).infrastructure['gpu'] = 1;
      });
      expect(labView(g, 1).actions[0]?.isReady).toBe(true);
      expect(nextStep(g, a(g))).toMatch(/Press h/);
    });

    it('points at shipping once the model bar is full', () => {
      const g = game((s) => {
        a(s).infrastructure['gpu'] = 1;
        s.lab.modelProgress = generationThreshold(1);
      });
      expect(nextStep(g, a(g))).toBe('Press s to ship Gen-1.');
    });
  });

  it('marks purchases ready only when affordable', () => {
    const poor = game();
    expect(infraActions(poor, poor.regions['/p/a']!)[0]?.isReady).toBe(false);
    const rich = game((g) => (g.resources.compute = 1_000));
    const [gpu] = infraActions(rich, rich.regions['/p/a']!);
    expect(gpu).toMatchObject({ hotkey: 'g', tierId: 'gpu', isReady: true });
  });

  it('cycles regions in founding order, wrapping both ways', () => {
    const g = game();
    expect(focusedRegion(g, 0)?.region.id).toBe('/p/a');
    expect(focusedRegion(g, 1)?.region.id).toBe('/p/b');
    expect(focusedRegion(g, 2)?.region.id).toBe('/p/a');
    expect(focusedRegion(g, -1)?.region.id).toBe('/p/b');
    expect(focusedRegion(initialGameState('2026-10-02T10:00:00Z'), 0)).toBeNull();
  });

  it('fits the rack diagram to the pane width', () => {
    const g = game((s) => (s.regions['/p/a']!.infrastructure['gpu'] = 40));
    const narrow = rackDiagram(g.regions['/p/a']!, 30);
    expect(narrow.length).toBeLessThanOrEqual(30);
    expect(narrow).toMatch(/\+\d+$/);
  });

  it('puts compute, generation and open incidents on the status line', () => {
    const g = game((s) => {
      s.resources.compute = 12_345;
      s.regions['/p/b']!.incidents.push({ id: 'i1', title: 'x', startedAt: '2026-10-02T10:00:00Z' });
    });
    expect(statusText(g)).toBe('cc-idle 12.3K FLOPS · Gen-1 · ↯1');
  });
});
