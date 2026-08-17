import { parseEventLine, type EventEnvelope } from '@ccidle/shared';
import { BALANCE, generationThreshold } from './balance.js';
import { applyInput, regionMultiplier, regionsByFounded } from './engine.js';
import { formatAmount } from './format.js';
import { initialGameState, type GameState, type Narration } from './state.js';

/**
 * Replay support (mechanics PRD §5, M1): run recorded event streams through
 * the engine and report the resulting economy, so balance.ts is tuned from
 * real sessions instead of guesses. Time comes entirely from envelope
 * timestamps — a replay is deterministic and instant.
 */

export function parseEventFile(content: string): EventEnvelope[] {
  const envelopes: EventEnvelope[] = [];
  for (const line of content.split('\n')) {
    const envelope = parseEventLine(line);
    if (envelope) envelopes.push(envelope);
  }
  return envelopes;
}

/** Merge multiple session streams into one timeline, ordered by timestamp. */
export function mergeTimelines(files: EventEnvelope[][]): EventEnvelope[] {
  return files
    .flat()
    .map((envelope, index) => ({ envelope, index }))
    .sort((a, b) => {
      const ta = Date.parse(a.envelope.ts);
      const tb = Date.parse(b.envelope.ts);
      if (Number.isFinite(ta) && Number.isFinite(tb) && ta !== tb) return ta - tb;
      return a.index - b.index; // stable for equal/unparseable timestamps
    })
    .map((entry) => entry.envelope);
}

export interface ReplayResult {
  state: GameState;
  narration: Narration[];
}

export function replayEnvelopes(envelopes: EventEnvelope[], initial?: GameState): ReplayResult {
  const firstTs = envelopes[0] ? Date.parse(envelopes[0].ts) : NaN;
  let state = initial ?? initialGameState(new Date(Number.isFinite(firstTs) ? firstTs : 0).toISOString());
  const narration: Narration[] = [];
  for (const envelope of envelopes) {
    const ts = Date.parse(envelope.ts);
    const result = applyInput(state, { kind: 'telemetry', envelope }, Number.isFinite(ts) ? ts : 0);
    state = result.state;
    narration.push(...result.effects);
  }
  return { state, narration };
}

/** The §5 balance-telemetry report: what the economy did and why. */
export function formatReplayReport(state: GameState): string {
  const s = state.stats;
  const r = state.resources;
  const lines: string[] = [];
  const computeEarned = s.computeFromTokens + s.computeFromCompletionBonus + s.computeFromStopBonus + s.computeFromTraining;
  const tokenEfficiency = s.outputTokensSeen > 0 ? s.computeFromTokens / (s.outputTokensSeen * BALANCE.compute.perOutputToken) : 0;

  lines.push('── CC Idle economy report ──────────────────────────────');
  lines.push(`events processed      ${s.eventsProcessed}`);
  lines.push(`output tokens seen    ${formatAmount(s.outputTokensSeen)}`);
  lines.push('');
  lines.push('resources (final balance)');
  lines.push(`  compute       ${formatAmount(r.compute)} FLOPS`);
  lines.push(`  engineering   ${formatAmount(r.engineering)}`);
  lines.push(`  research      ${formatAmount(r.research)}`);
  lines.push(`  reputation    ${formatAmount(r.reputation)}`);
  lines.push(`  breakthroughs ${formatAmount(r.breakthroughs)}`);
  lines.push('');
  lines.push('compute earned by source');
  lines.push(`  tokens            ${formatAmount(s.computeFromTokens)}`);
  lines.push(`  completion bonus  ${formatAmount(s.computeFromCompletionBonus)}`);
  lines.push(`  stop bonus        ${formatAmount(s.computeFromStopBonus)}`);
  lines.push(`  training runs     ${formatAmount(s.computeFromTraining)}`);
  lines.push(`  total ${formatAmount(computeEarned)} · spent ${formatAmount(s.computeSpent)}`);
  lines.push(`  weighted token efficiency ${(tokenEfficiency * 100).toFixed(1)}% (100% = no diminishing returns hit)`);
  lines.push('');
  lines.push('engineering / research');
  lines.push(`  eng from tools ${formatAmount(s.engineeringFromTools)} · post-mortems ${formatAmount(s.engineeringFromPostMortems)} · spent ${formatAmount(s.engineeringSpent)}`);
  lines.push(`  research from tools ${formatAmount(s.researchFromTools)} · spent ${formatAmount(s.researchSpent)}`);
  lines.push('');
  lines.push('activity');
  lines.push(`  tool calls ${s.toolSuccesses} ok / ${s.toolFailures} failed`);
  lines.push(`  incidents ${s.incidentsSpawned} spawned / ${s.incidentsAcked} acked`);
  lines.push(`  training runs ${s.trainingRuns} · experiments ${s.experiments}`);
  lines.push(
    `  lab: ${state.lab.researchers} researcher(s), progress ${formatAmount(state.lab.modelProgress)}/${formatAmount(generationThreshold(state.generation))} toward Gen-${state.generation}` +
      (s.generationsShipped > 0 ? ` (${s.generationsShipped} shipped)` : '')
  );
  lines.push('');
  lines.push('regions');
  const regions = regionsByFounded(state);
  if (regions.length === 0) {
    lines.push('  (none founded)');
  }
  for (const region of regions) {
    const infra = Object.entries(region.infrastructure)
      .filter(([, count]) => count > 0)
      .map(([tier, count]) => `${count}×${tier}`)
      .join(' ');
    lines.push(
      `  ${region.name.padEnd(20)} ×${regionMultiplier(region).toFixed(2)} ` +
        `compute ${formatAmount(region.totals.compute).padEnd(8)} tokens ${formatAmount(region.totals.outputTokens).padEnd(8)} ` +
        `incidents ${region.totals.incidents}${infra ? `  [${infra}]` : ''}`
    );
  }
  lines.push('────────────────────────────────────────────────────────');
  return lines.join('\n');
}
