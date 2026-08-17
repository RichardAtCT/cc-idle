import { describe, it, expect } from 'vitest';
import type { EventEnvelope } from '@ccidle/shared';
import {
  BALANCE,
  INFRA_TIERS,
  applyInput,
  canShipGeneration,
  generationThreshold,
  hireCost,
  initialGameState,
  isToolFailure,
  regionMultiplier,
  tierCost,
  type GameInput,
  type GameState
} from '../src/index.js';

const T0 = Date.parse('2026-08-17T10:00:00.000Z');

function env(overrides: Partial<EventEnvelope> & { event: string }): EventEnvelope {
  return {
    v: 1,
    ts: '2026-08-17T10:00:00.000Z',
    session_id: 'sess-1',
    cwd: '/home/user/projA',
    payload: {},
    ...overrides
  };
}

function apply(state: GameState, input: GameInput, nowMs = T0): GameState {
  return applyInput(state, input, nowMs).state;
}

function telemetry(state: GameState, overrides: Partial<EventEnvelope> & { event: string }): GameState {
  return apply(state, { kind: 'telemetry', envelope: env(overrides) });
}

function tokenUsage(state: GameState, outputTokens: number, ts = '2026-08-17T10:00:00.000Z'): GameState {
  return telemetry(state, {
    event: 'TokenUsage',
    ts,
    cwd: undefined,
    payload: {
      byModel: {
        'claude-test': { inputTokens: 0, outputTokens, cacheReadTokens: 0, cacheWriteTokens: 0 }
      }
    }
  });
}

function fresh(): GameState {
  return initialGameState(new Date(T0).toISOString());
}

/** Founds projA by sending a SessionStart with its cwd. */
function withRegion(): GameState {
  return telemetry(fresh(), { event: 'SessionStart' });
}

describe('regions', () => {
  it('founds a cwd-keyed region on first telemetry with a ceremony', () => {
    const state = withRegion();
    expect(state.regions['/home/user/projA']).toBeDefined();
    expect(state.regions['/home/user/projA']!.name).toBe('projA');
    expect(state.log.some((l) => l.kind === 'ceremony' && l.text.includes('projA'))).toBe(true);
  });

  it('maps sessions to regions so cwd-less TokenUsage lands in the right region', () => {
    let state = withRegion();
    state = tokenUsage(state, 1000);
    expect(state.regions['/home/user/projA']!.totals.outputTokens).toBe(1000);
  });

  it('goes hot on UserPromptSubmit and dark when the daemon reports STALE', () => {
    let state = withRegion();
    state = telemetry(state, { event: 'UserPromptSubmit' });
    expect(state.regions['/home/user/projA']!.status).toBe('hot');
    state = apply(state, { kind: 'session-state', sessionId: 'sess-1', state: 'STALE' });
    expect(state.regions['/home/user/projA']!.status).toBe('dark');
  });
});

describe('compute accrual (PRD §4, §5)', () => {
  it('converts output tokens at full rate below the window threshold', () => {
    let state = withRegion();
    state = tokenUsage(state, 1000);
    expect(state.resources.compute).toBeCloseTo(1000 * BALANCE.compute.perOutputToken, 5);
    expect(state.stats.outputTokensSeen).toBe(1000);
  });

  it('applies diminishing returns beyond the hourly full-rate budget', () => {
    let state = withRegion();
    const n = BALANCE.compute.fullRateTokensPerWindow;
    state = tokenUsage(state, n); // exactly exhausts the full-rate budget
    const atFull = state.resources.compute;
    expect(atFull).toBeCloseTo(n, 5);
    state = tokenUsage(state, n); // same volume again — must yield visibly less
    const marginal = state.resources.compute - atFull;
    expect(marginal).toBeLessThan(n * 0.75);
    expect(marginal).toBeGreaterThan(0);
  });

  it('resets the window after windowMs elapses', () => {
    let state = withRegion();
    const n = BALANCE.compute.fullRateTokensPerWindow;
    state = tokenUsage(state, n * 2, '2026-08-17T10:00:00.000Z');
    const before = state.resources.compute;
    state = tokenUsage(state, 1000, '2026-08-17T11:30:00.000Z'); // next window
    expect(state.resources.compute - before).toBeCloseTo(1000, 5);
  });

  it('infrastructure multiplies incoming telemetry', () => {
    let state = withRegion();
    const region = state.regions['/home/user/projA']!;
    region.infrastructure = { gpu: 10 };
    const expectedMult = 1 + 10 * INFRA_TIERS[0]!.multiplier;
    expect(regionMultiplier(region)).toBeCloseTo(expectedMult, 5);
    state = tokenUsage(state, 1000);
    expect(state.resources.compute).toBeCloseTo(1000 * expectedMult, 5);
  });

  it('grants the retroactive completion bonus on Stop and resets turn accrual', () => {
    let state = withRegion();
    state = telemetry(state, { event: 'UserPromptSubmit' });
    state = tokenUsage(state, 1000);
    state = telemetry(state, { event: 'Stop' });
    expect(state.stats.computeFromCompletionBonus).toBeCloseTo(1000 * BALANCE.compute.turnCompletionBonus, 5);
    expect(state.resources.reputation).toBe(BALANCE.reputation.perStop);
    expect(state.regions['/home/user/projA']!.turnAccrual).toBe(0);
  });

  it('pays the small all-region Stop bonus to live regions but not dark ones', () => {
    let state = withRegion();
    state = telemetry(state, { event: 'SessionStart', session_id: 'sess-2', cwd: '/home/user/projB' });
    state = apply(state, { kind: 'session-state', sessionId: 'sess-2', state: 'DEAD' });
    expect(state.regions['/home/user/projB']!.status).toBe('dark');
    state = telemetry(state, { event: 'Stop' });
    expect(state.stats.computeFromStopBonus).toBe(BALANCE.compute.stopAllRegionBonus); // projA only
  });
});

describe('engineering & research (PRD §3, §5)', () => {
  it('classifies tools into engineering and research', () => {
    let state = withRegion();
    state = telemetry(state, { event: 'PostToolUse', tool: 'Edit' });
    expect(state.resources.engineering).toBe(BALANCE.engineering.perToolCall);
    state = telemetry(state, { event: 'PostToolUse', tool: 'Read' });
    expect(state.resources.research).toBe(BALANCE.research.perToolCall);
    state = telemetry(state, { event: 'PostToolUse', tool: 'SomethingElse' });
    expect(state.resources.engineering).toBe(BALANCE.engineering.perToolCall);
    expect(state.resources.research).toBe(BALANCE.research.perToolCall);
  });

  it('failed tool calls generate nothing but an incident', () => {
    let state = withRegion();
    state = telemetry(state, {
      event: 'PostToolUse',
      tool: 'Bash',
      payload: { tool_response: { success: false } }
    });
    expect(state.resources.engineering).toBe(0);
    expect(state.stats.toolFailures).toBe(1);
    expect(state.regions['/home/user/projA']!.incidents).toHaveLength(1);
  });

  it('detects common failure shapes and defaults ambiguity to success', () => {
    expect(isToolFailure({ tool_response: { success: false } })).toBe(true);
    expect(isToolFailure({ tool_response: { is_error: true } })).toBe(true);
    expect(isToolFailure({ tool_response: { error: 'boom' } })).toBe(true);
    expect(isToolFailure({ tool_response: { output: 'ok' } })).toBe(false);
    expect(isToolFailure({ truncated: true })).toBe(false);
    expect(isToolFailure(undefined)).toBe(false);
  });
});

describe('incidents (PRD §6)', () => {
  function fail(state: GameState, ts: string): GameState {
    return telemetry(state, {
      event: 'PostToolUse',
      tool: 'Bash',
      ts,
      payload: { tool_response: { success: false } }
    });
  }

  it('caps active incidents per region and rate-limits spawns', () => {
    let state = withRegion();
    // Rapid-fire failures: only the first spawns (min interval gate).
    state = fail(state, '2026-08-17T10:00:00.000Z');
    state = fail(state, '2026-08-17T10:00:01.000Z');
    expect(state.regions['/home/user/projA']!.incidents).toHaveLength(1);
    // Spaced failures accumulate up to the cap.
    state = fail(state, '2026-08-17T10:02:00.000Z');
    state = fail(state, '2026-08-17T10:04:00.000Z');
    state = fail(state, '2026-08-17T10:06:00.000Z');
    expect(state.regions['/home/user/projA']!.incidents).toHaveLength(BALANCE.incidents.maxActivePerRegion);
  });

  it('debuffs the region multiplier until acknowledged, then pays the post-mortem', () => {
    let state = withRegion();
    state = fail(state, '2026-08-17T10:00:00.000Z');
    const region = state.regions['/home/user/projA']!;
    expect(regionMultiplier(region)).toBeLessThan(1);
    state = apply(state, { kind: 'action', action: { type: 'ack-incident', regionId: '/home/user/projA' } });
    expect(state.regions['/home/user/projA']!.incidents).toHaveLength(0);
    expect(state.resources.engineering).toBe(BALANCE.engineering.postMortem);
    expect(regionMultiplier(state.regions['/home/user/projA']!)).toBe(1);
  });

  it('self-healing breakthrough auto-acks incidents', () => {
    let state = withRegion();
    state.breakthroughLevels = { 'self-healing': 1 };
    state = fail(state, '2026-08-17T10:00:00.000Z');
    expect(state.regions['/home/user/projA']!.incidents).toHaveLength(0);
    expect(state.resources.engineering).toBe(BALANCE.engineering.postMortem);
    expect(state.stats.incidentsAcked).toBe(1);
  });
});

describe('lab & training (PRD §4, M2)', () => {
  it('SubagentStop completes a training run: progress + compute, consuming research data', () => {
    let state = withRegion();
    state.resources.research = BALANCE.lab.trainingDataCost;
    state = telemetry(state, { event: 'SubagentStop' });
    expect(state.stats.trainingRuns).toBe(1);
    expect(state.lab.modelProgress).toBeGreaterThan(0);
    expect(state.resources.research).toBe(0);
    expect(state.stats.computeFromTraining).toBeGreaterThan(0);
  });

  it('training never blocks: no research data still pays at min efficiency', () => {
    let state = withRegion();
    const rich = (() => {
      let s = withRegion();
      s.resources.research = BALANCE.lab.trainingDataCost;
      s = telemetry(s, { event: 'SubagentStop' });
      return s.lab.modelProgress;
    })();
    state = telemetry(state, { event: 'SubagentStop' });
    expect(state.lab.modelProgress).toBeGreaterThan(0);
    expect(state.lab.modelProgress).toBeCloseTo(rich * BALANCE.lab.trainingMinEfficiency, 5);
  });

  it('scales training by subagent duration when the payload carries one', () => {
    let state = withRegion();
    state = telemetry(state, { event: 'SubagentStop', payload: { duration_ms: 10 * 60_000 } });
    const long = state.lab.modelProgress;
    let quick = withRegion();
    quick = telemetry(quick, { event: 'SubagentStop', payload: { duration_ms: 60_000 } });
    expect(long).toBeGreaterThan(quick.lab.modelProgress);
  });

  it('hiring costs engineering and is soft-gated by reputation', () => {
    let state = withRegion();
    state.resources.engineering = 10_000;
    state = apply(state, { kind: 'action', action: { type: 'hire' } });
    expect(state.lab.researchers).toBe(1); // rep 0 → cap 1
    state = apply(state, { kind: 'action', action: { type: 'hire' } });
    expect(state.lab.researchers).toBe(1); // capped
    state.resources.reputation = BALANCE.lab.reputationPerHireSlot;
    state = apply(state, { kind: 'action', action: { type: 'hire' } });
    expect(state.lab.researchers).toBe(2);
    expect(state.stats.engineeringSpent).toBeCloseTo(hireCost(0) + hireCost(1), 5);
  });

  it('experiments convert research data into model progress', () => {
    let state = withRegion();
    state.resources.research = BALANCE.lab.experimentDataCost;
    state.resources.engineering = BALANCE.lab.experimentEngineeringCost;
    state = apply(state, { kind: 'action', action: { type: 'experiment' } });
    expect(state.lab.modelProgress).toBeCloseTo(BALANCE.lab.experimentProgress, 5);
    expect(state.resources.research).toBe(0);
  });
});

describe('infrastructure purchases', () => {
  it('buys a GPU, spending compute at geometric cost', () => {
    let state = withRegion();
    const cost0 = tierCost(INFRA_TIERS[0]!, 0);
    state.resources.compute = cost0;
    state = apply(state, { kind: 'action', action: { type: 'buy', regionId: '/home/user/projA', tierId: 'gpu' } });
    expect(state.regions['/home/user/projA']!.infrastructure['gpu']).toBe(1);
    expect(state.resources.compute).toBe(0);
    // Second GPU is more expensive and unaffordable now.
    state = apply(state, { kind: 'action', action: { type: 'buy', regionId: '/home/user/projA', tierId: 'gpu' } });
    expect(state.regions['/home/user/projA']!.infrastructure['gpu']).toBe(1);
  });

  it('gates racks behind GPU count', () => {
    let state = withRegion();
    state.resources.compute = 10 ** 9;
    state = apply(state, { kind: 'action', action: { type: 'buy', regionId: '/home/user/projA', tierId: 'rack' } });
    expect(state.regions['/home/user/projA']!.infrastructure['rack']).toBeUndefined();
    state.regions['/home/user/projA']!.infrastructure = { gpu: 8 };
    state = apply(state, { kind: 'action', action: { type: 'buy', regionId: '/home/user/projA', tierId: 'rack' } });
    expect(state.regions['/home/user/projA']!.infrastructure['rack']).toBe(1);
  });

  it('procurement bots auto-buy GPUs from token income', () => {
    let state = withRegion();
    state.breakthroughLevels = { procurement: 1 };
    state.resources.compute = 0;
    state = tokenUsage(state, tierCost(INFRA_TIERS[0]!, 0) + 100);
    expect(state.regions['/home/user/projA']!.infrastructure['gpu']).toBe(1);
  });
});

describe('prestige (PRD §2, M2)', () => {
  it('refuses to ship below the threshold', () => {
    let state = withRegion();
    state = apply(state, { kind: 'action', action: { type: 'ship-generation' } });
    expect(state.generation).toBe(1);
    expect(state.resources.breakthroughs).toBe(0);
  });

  it('ships: banks breakthroughs, resets infra + lab, keeps reputation', () => {
    let state = withRegion();
    state.lab.modelProgress = generationThreshold(1);
    state.lab.researchers = 3;
    state.resources = { compute: 999, engineering: 50, research: 40, reputation: 12, breakthroughs: 0 };
    state.regions['/home/user/projA']!.infrastructure = { gpu: 20, rack: 2 };
    expect(canShipGeneration(state)).toBe(true);

    state = apply(state, { kind: 'action', action: { type: 'ship-generation' } });
    expect(state.generation).toBe(2);
    expect(state.resources.breakthroughs).toBe(BALANCE.generations.breakthroughsPerShip);
    expect(state.resources.compute).toBe(0);
    expect(state.lab.researchers).toBe(0);
    expect(state.lab.modelProgress).toBe(0);
    expect(state.resources.reputation).toBe(12); // a mirror, not a treadmill
    expect(state.regions['/home/user/projA']!.infrastructure).toEqual({});
    // Region itself persists (cwd-keyed, open question #3).
    expect(state.regions['/home/user/projA']).toBeDefined();
  });

  it('blueprints seed GPUs into regions after shipping', () => {
    let state = withRegion();
    state.breakthroughLevels = { blueprints: 2 };
    state.lab.modelProgress = generationThreshold(1);
    state = apply(state, { kind: 'action', action: { type: 'ship-generation' } });
    expect(state.regions['/home/user/projA']!.infrastructure['gpu']).toBe(8);
  });

  it('buys breakthrough levels with banked breakthroughs', () => {
    let state = withRegion();
    state.resources.breakthroughs = 3;
    state = apply(state, { kind: 'action', action: { type: 'buy-breakthrough', nodeId: 'quantization' } });
    expect(state.breakthroughLevels['quantization']).toBe(1);
    expect(state.resources.breakthroughs).toBe(2);
    // Quantization now boosts conversion.
    state = tokenUsage(state, 1000);
    expect(state.resources.compute).toBeCloseTo(1200, 5);
  });
});

describe('design constraints (PRD §1)', () => {
  it('no telemetry, no income: the reducer only moves on events', () => {
    const state = fresh();
    // There is deliberately no tick input — nothing to test but the shape:
    expect(state.resources.compute).toBe(0);
    expect(Object.keys(state.regions)).toHaveLength(0);
  });

  it('is deterministic: same envelopes, same economy', () => {
    const run = (): GameState => {
      let s = withRegion();
      s = telemetry(s, { event: 'UserPromptSubmit' });
      s = telemetry(s, { event: 'PostToolUse', tool: 'Edit' });
      s = tokenUsage(s, 5000);
      s = telemetry(s, { event: 'Stop' });
      return s;
    };
    expect(run()).toEqual(run());
  });
});
