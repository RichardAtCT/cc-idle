import { describe, expect, it } from 'vitest';
import { EventEnvelopeSchema } from '@ccidle/shared';
import { applyInput, initialGameState } from '../src/game.js';
import { promptSubmitted, sessionEnded, subagentStopped, tokensUsed, toolFinished, turnStopped } from '../src/telemetry.js';

const T0 = Date.parse('2026-10-02T10:00:00Z');
const ref = { sessionId: 's1', cwd: '/work/proj' };

function run(envelopes: ReturnType<typeof promptSubmitted>[]) {
  let state = initialGameState(new Date(T0).toISOString());
  for (const envelope of envelopes) state = applyInput(state, { kind: 'telemetry', envelope }, T0).state;
  return state;
}

describe('mod telemetry envelopes', () => {
  it('are valid v1 envelopes, so replay and backtest tooling can read them', () => {
    const all = [
      promptSubmitted(ref, T0),
      toolFinished(ref, T0, 'Edit', false),
      tokensUsed(ref, T0, { model: 'm', input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 }),
      turnStopped(ref, T0),
      subagentStopped(ref, T0, 120_000),
      sessionEnded(ref, T0)
    ];
    for (const envelope of all) expect(EventEnvelopeSchema.safeParse(envelope).success).toBe(true);
  });

  it('map Claude Code work onto the economy the way the shell hooks did', () => {
    const state = run([
      promptSubmitted(ref, T0),
      tokensUsed(ref, T0, { model: 'm', input_tokens: 0, output_tokens: 5_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }),
      toolFinished(ref, T0, 'Edit', false),
      toolFinished(ref, T0, 'Read', false),
      subagentStopped(ref, T0, 120_000),
      turnStopped(ref, T0)
    ]);
    const region = state.regions['/work/proj'];
    expect(region?.name).toBe('proj');
    expect(state.stats.outputTokensSeen).toBe(5_000);
    expect(state.resources.engineering).toBeGreaterThan(0);
    expect(state.resources.research).toBeGreaterThanOrEqual(0);
    expect(state.stats.trainingRuns).toBe(1);
    expect(state.resources.reputation).toBeGreaterThan(0);
    expect(state.stats.computeFromCompletionBonus).toBeGreaterThan(0);
  });

  it('turn a failed tool call into an incident, not output', () => {
    const state = run([promptSubmitted(ref, T0), toolFinished(ref, T0, 'Bash', true)]);
    expect(state.stats.toolFailures).toBe(1);
    expect(state.regions['/work/proj']?.incidents).toHaveLength(1);
    expect(state.resources.engineering).toBe(0);
  });
});
