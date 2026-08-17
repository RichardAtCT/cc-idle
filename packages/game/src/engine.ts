import {
  TokenUsagePayloadSchema,
  type EventEnvelope,
  type SessionState
} from '@ccidle/shared';
import { z } from 'zod';
import { BALANCE, INFRA_TIERS, generationThreshold, hireCap, hireCost, tierCost, type InfraTier } from './balance.js';
import { INCIDENT_FLAVOURS, breakthroughNode } from './content.js';
import {
  UNASSIGNED_REGION_ID,
  type GameState,
  type Narration,
  type Region
} from './state.js';
import { formatAmount } from './format.js';

/**
 * engine.ts — the pure CC Idle reducer (mechanics PRD §4, §5, §6).
 *
 * Inputs are telemetry envelopes (the ONLY real-work interface, per the
 * PRD's input contract), daemon session-state changes, and player actions.
 * No wall clock, no randomness, no I/O: time comes from envelope timestamps
 * or the caller, and "random" flavour is picked by deterministic counters —
 * so a replayed session always produces the identical economy.
 */

// ---- player actions ----

export const GameActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('buy'), regionId: z.string(), tierId: z.string() }),
  z.object({ type: z.literal('hire') }),
  z.object({ type: z.literal('experiment') }),
  z.object({ type: z.literal('ack-incident'), regionId: z.string() }),
  z.object({ type: z.literal('ship-generation') }),
  z.object({ type: z.literal('buy-breakthrough'), nodeId: z.string() })
]);
export type GameAction = z.infer<typeof GameActionSchema>;

export type GameInput =
  | { kind: 'telemetry'; envelope: EventEnvelope }
  | { kind: 'session-state'; sessionId: string; state: SessionState }
  | { kind: 'action'; action: GameAction };

export interface ApplyResult {
  state: GameState;
  /** Narration produced by this input (also appended to state.log, capped). */
  effects: Narration[];
}

// ---- derived values (used by both the engine and the TUI) ----

export function breakthroughLevel(state: GameState, nodeId: string): number {
  return state.breakthroughLevels[nodeId] ?? 0;
}

/** Infrastructure amplifier × incident debuff for one region (PRD §2, §6). */
export function regionMultiplier(region: Region): number {
  let infra = 1;
  for (const tier of INFRA_TIERS) {
    infra += (region.infrastructure[tier.id] ?? 0) * tier.multiplier;
  }
  const debuff = Math.max(
    BALANCE.incidents.debuffFloor,
    1 - BALANCE.incidents.debuffPerIncident * region.incidents.length
  );
  return infra * debuff;
}

/** Global token→Compute conversion multiplier from Breakthroughs. */
export function conversionMultiplier(state: GameState): number {
  return 1 + 0.2 * breakthroughLevel(state, 'quantization');
}

/** Research Data multiplier from Breakthroughs. */
export function researchMultiplier(state: GameState): number {
  return 1 + 0.25 * breakthroughLevel(state, 'synthetic-data');
}

/** Lab progress multiplier: researchers + Scaling Laws breakthrough. */
export function labMultiplier(state: GameState): number {
  return (
    1 +
    state.lab.researchers * BALANCE.lab.progressPerResearcher +
    0.25 * breakthroughLevel(state, 'scaling-laws')
  );
}

export function canShipGeneration(state: GameState): boolean {
  return state.lab.modelProgress >= generationThreshold(state.generation);
}

/** Regions in founding order — the TUI's stable region list. */
export function regionsByFounded(state: GameState): Region[] {
  return Object.values(state.regions).sort((a, b) =>
    a.foundedAt === b.foundedAt ? a.id.localeCompare(b.id) : a.foundedAt.localeCompare(b.foundedAt)
  );
}

/**
 * Failure detection for PostToolUse (PRD §4). Hook payloads vary by CC
 * version and may be truncated; ambiguity counts as success so we never
 * punish what we can't see.
 */
export function isToolFailure(payload: Record<string, unknown> | undefined): boolean {
  if (!payload) return false;
  if (payload.success === false) return true;
  const response = payload.tool_response;
  if (response && typeof response === 'object' && !Array.isArray(response)) {
    const r = response as Record<string, unknown>;
    if (r.success === false) return true;
    if (r.is_error === true) return true;
    if (typeof r.error === 'string' && r.error !== '') return true;
  }
  return false;
}

// ---- the reducer ----

export function applyInput(state: GameState, input: GameInput, fallbackNowMs: number): ApplyResult {
  const draft = structuredClone(state);
  const effects: Narration[] = [];

  switch (input.kind) {
    case 'telemetry':
      applyTelemetry(draft, input.envelope, fallbackNowMs, effects);
      break;
    case 'session-state':
      applySessionState(draft, input.sessionId, input.state, fallbackNowMs, effects);
      break;
    case 'action':
      applyAction(draft, input.action, fallbackNowMs, effects);
      break;
  }

  if (draft.log.length > BALANCE.logLimit) {
    draft.log = draft.log.slice(-BALANCE.logLimit);
  }
  return { state: draft, effects };
}

function narrate(draft: GameState, effects: Narration[], nowMs: number, text: string, kind: Narration['kind']): void {
  const entry: Narration = { ts: new Date(nowMs).toISOString(), text, kind };
  draft.log.push(entry);
  effects.push(entry);
}

function regionName(cwd: string): string {
  const trimmed = cwd.replace(/\/+$/, '');
  const idx = trimmed.lastIndexOf('/');
  const base = idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
  return base === '' ? cwd : base;
}

function ensureRegion(draft: GameState, effects: Narration[], regionId: string, nowMs: number): Region {
  const existing = draft.regions[regionId];
  if (existing) return existing;
  const region: Region = {
    id: regionId,
    name: regionId === UNASSIGNED_REGION_ID ? 'unassigned' : regionName(regionId),
    foundedAt: new Date(nowMs).toISOString(),
    status: 'idle',
    infrastructure: {},
    window: { startMs: 0, outputTokens: 0 },
    turnAccrual: 0,
    incidents: [],
    lastIncidentAtMs: 0,
    totals: { compute: 0, engineering: 0, research: 0, outputTokens: 0, incidents: 0 }
  };
  draft.regions[regionId] = region;
  narrate(draft, effects, nowMs, `⛏ region "${region.name}" founded`, 'ceremony');
  return region;
}

function refreshRegionStatus(draft: GameState, effects: Narration[], regionId: string, nowMs: number): void {
  const region = draft.regions[regionId];
  if (!region) return;
  const statuses = Object.entries(draft.sessionRegions)
    .filter(([, rid]) => rid === regionId)
    .map(([sid]) => draft.sessionStatus[sid])
    .filter((s): s is 'working' | 'idle' | 'dark' => s !== undefined);

  let next: Region['status'] = 'idle';
  if (statuses.includes('working')) next = 'hot';
  else if (statuses.length > 0 && statuses.every((s) => s === 'dark')) next = 'dark';

  if (next !== region.status) {
    if (next === 'dark') {
      narrate(draft, effects, nowMs, `▓ region "${region.name}" goes dark — multipliers suspended`, 'info');
    }
    region.status = next;
  }
}

/** Resolve (and learn) the region for a session, founding it if new. */
function resolveRegion(draft: GameState, effects: Narration[], envelope: EventEnvelope, nowMs: number): Region {
  const sessionId = envelope.session_id;
  let regionId = envelope.cwd && envelope.cwd !== '' ? envelope.cwd : draft.sessionRegions[sessionId];
  if (!regionId) regionId = UNASSIGNED_REGION_ID;
  const region = ensureRegion(draft, effects, regionId, nowMs);
  if (draft.sessionRegions[sessionId] !== regionId) {
    draft.sessionRegions[sessionId] = regionId;
  }
  return region;
}

function applyTelemetry(draft: GameState, envelope: EventEnvelope, fallbackNowMs: number, effects: Narration[]): void {
  const parsedTs = Date.parse(envelope.ts);
  const nowMs = Number.isFinite(parsedTs) ? parsedTs : fallbackNowMs;
  const sessionId = envelope.session_id;

  draft.stats.eventsProcessed += 1;
  const region = resolveRegion(draft, effects, envelope, nowMs);

  // Liveness mirror of the daemon's state machine: activity wakes a dark session.
  switch (envelope.event) {
    case 'UserPromptSubmit':
      draft.sessionStatus[sessionId] = 'working';
      break;
    case 'Stop':
    case 'Notification':
    case 'SessionStart':
      draft.sessionStatus[sessionId] = 'idle';
      break;
    case 'SessionEnd':
      break; // handled below
    default:
      if (draft.sessionStatus[sessionId] === 'dark' || draft.sessionStatus[sessionId] === undefined) {
        draft.sessionStatus[sessionId] = 'working';
      }
      break;
  }

  switch (envelope.event) {
    case 'UserPromptSubmit':
      region.turnAccrual = 0;
      break;
    case 'PostToolUse':
      applyToolCall(draft, region, envelope, nowMs, effects);
      break;
    case 'TokenUsage':
      applyTokenUsage(draft, region, envelope, nowMs, effects);
      break;
    case 'Stop':
      applyStop(draft, region, nowMs, effects);
      break;
    case 'SubagentStop':
      applyTrainingRun(draft, region, envelope, nowMs, effects);
      break;
    case 'SessionEnd':
      delete draft.sessionRegions[sessionId];
      delete draft.sessionStatus[sessionId];
      break;
    default:
      break;
  }

  refreshRegionStatus(draft, effects, region.id, nowMs);
}

function applyToolCall(draft: GameState, region: Region, envelope: EventEnvelope, nowMs: number, effects: Narration[]): void {
  const tool = envelope.tool ?? (typeof envelope.payload?.tool_name === 'string' ? envelope.payload.tool_name : undefined);

  if (isToolFailure(envelope.payload)) {
    draft.stats.toolFailures += 1;
    spawnIncident(draft, region, nowMs, effects);
    return; // failed calls generate nothing but incidents (PRD §5)
  }

  draft.stats.toolSuccesses += 1;
  if (!tool) return;

  const engineeringTools: readonly string[] = BALANCE.tools.engineering;
  const researchTools: readonly string[] = BALANCE.tools.research;
  if (engineeringTools.includes(tool)) {
    const gain = BALANCE.engineering.perToolCall;
    draft.resources.engineering += gain;
    draft.stats.engineeringFromTools += gain;
    region.totals.engineering += gain;
  } else if (researchTools.includes(tool)) {
    const gain = BALANCE.research.perToolCall * researchMultiplier(draft);
    draft.resources.research += gain;
    draft.stats.researchFromTools += gain;
    region.totals.research += gain;
  }
}

/**
 * Token→Compute conversion with the §5 diminishing-returns curve: full rate
 * for the first `fullRateTokensPerWindow` output tokens per region per
 * rolling window, then a log-scaled marginal rate. Grinding tokens visibly
 * yields less; the curve resets as the window rolls over.
 */
function applyTokenUsage(draft: GameState, region: Region, envelope: EventEnvelope, nowMs: number, effects: Narration[]): void {
  const parsed = TokenUsagePayloadSchema.safeParse(envelope.payload);
  if (!parsed.success) return;
  let outputTokens = 0;
  for (const totals of Object.values(parsed.data.byModel)) {
    outputTokens += totals.outputTokens;
  }
  if (outputTokens <= 0) return;

  const { fullRateTokensPerWindow: fullN, windowMs, perOutputToken } = BALANCE.compute;
  if (region.window.startMs === 0 || (nowMs >= region.window.startMs && nowMs - region.window.startMs > windowMs)) {
    region.window = { startMs: nowMs, outputTokens: 0 };
  }

  let weighted = 0;
  let remaining = outputTokens;
  let windowTokens = region.window.outputTokens;
  const fullLeft = Math.max(0, fullN - windowTokens);
  const atFullRate = Math.min(remaining, fullLeft);
  weighted += atFullRate;
  remaining -= atFullRate;
  windowTokens += atFullRate;
  if (remaining > 0) {
    // Marginal log-scaled rate, evaluated at the midpoint of this delta.
    const rate = 1 / (1 + Math.log2((windowTokens + remaining / 2) / fullN));
    weighted += remaining * rate;
    windowTokens += remaining;
  }
  region.window.outputTokens = windowTokens;

  const gained = weighted * perOutputToken * regionMultiplier(region) * conversionMultiplier(draft);
  draft.resources.compute += gained;
  draft.stats.computeFromTokens += gained;
  draft.stats.outputTokensSeen += outputTokens;
  region.turnAccrual += gained;
  region.totals.compute += gained;
  region.totals.outputTokens += outputTokens;

  autoProcure(draft, region, nowMs, effects);
}

/** Procurement Bots breakthrough: auto-buy GPUs while the region can afford them. */
function autoProcure(draft: GameState, region: Region, nowMs: number, effects: Narration[]): void {
  if (breakthroughLevel(draft, 'procurement') < 1) return;
  const gpuTier = INFRA_TIERS[0]!;
  let bought = 0;
  while (bought < 10) {
    const owned = region.infrastructure[gpuTier.id] ?? 0;
    const cost = tierCost(gpuTier, owned);
    if (draft.resources.compute < cost) break;
    draft.resources.compute -= cost;
    draft.stats.computeSpent += cost;
    region.infrastructure[gpuTier.id] = owned + 1;
    bought += 1;
  }
  if (bought > 0) {
    narrate(draft, effects, nowMs, `⚙ procurement bots installed ${bought} GPU${bought > 1 ? 's' : ''} in "${region.name}"`, 'info');
  }
}

function applyStop(draft: GameState, region: Region, nowMs: number, effects: Narration[]): void {
  // Retroactive completion multiplier: finished work is worth more than churn (§5).
  const bonus = region.turnAccrual * BALANCE.compute.turnCompletionBonus;
  if (bonus > 0) {
    draft.resources.compute += bonus;
    draft.stats.computeFromCompletionBonus += bonus;
    region.totals.compute += bonus;
  }
  region.turnAccrual = 0;

  draft.resources.reputation += BALANCE.reputation.perStop;
  draft.stats.reputationEarned += BALANCE.reputation.perStop;

  // Small all-region bonus — dark regions have their multipliers suspended (§4).
  let liveRegions = 0;
  for (const other of Object.values(draft.regions)) {
    if (other.status === 'dark') continue;
    draft.resources.compute += BALANCE.compute.stopAllRegionBonus;
    draft.stats.computeFromStopBonus += BALANCE.compute.stopAllRegionBonus;
    other.totals.compute += BALANCE.compute.stopAllRegionBonus;
    liveRegions += 1;
  }

  if (bonus >= 1) {
    narrate(
      draft,
      effects,
      nowMs,
      `✔ milestone shipped in "${region.name}": +${formatAmount(bonus)} FLOPS completion bonus, +${BALANCE.reputation.perStop} rep${liveRegions > 1 ? `, ${liveRegions} regions cheer` : ''}`,
      'good'
    );
  }
}

/** SubagentStop = a training run completes (PRD §4), scaled by duration. */
function applyTrainingRun(draft: GameState, region: Region, envelope: EventEnvelope, nowMs: number, effects: Narration[]): void {
  const lab = BALANCE.lab;
  const minutes = Math.min(lab.trainingMaxMinutes, subagentMinutes(envelope.payload) ?? lab.trainingDefaultMinutes);

  // Research Data fuels the run but never blocks it (§1.4): efficiency scales.
  const dataFraction = lab.trainingDataCost > 0 ? Math.min(1, draft.resources.research / lab.trainingDataCost) : 1;
  const consumed = lab.trainingDataCost * dataFraction;
  draft.resources.research -= consumed;
  draft.stats.researchSpent += consumed;
  const efficiency = lab.trainingMinEfficiency + (1 - lab.trainingMinEfficiency) * dataFraction;

  const progress = (lab.trainingBaseProgress + lab.trainingProgressPerMinute * minutes) * efficiency * labMultiplier(draft);
  draft.lab.modelProgress += progress;

  const payout = lab.trainingComputePerMinute * minutes * efficiency * regionMultiplier(region) * conversionMultiplier(draft);
  draft.resources.compute += payout;
  draft.stats.computeFromTraining += payout;
  region.totals.compute += payout;

  draft.stats.trainingRuns += 1;
  narrate(
    draft,
    effects,
    nowMs,
    `▲ training run complete in "${region.name}": +${formatAmount(progress)} progress, +${formatAmount(payout)} FLOPS`,
    'good'
  );
}

function subagentMinutes(payload: Record<string, unknown> | undefined): number | null {
  if (!payload) return null;
  for (const key of ['duration_ms', 'durationMs', 'total_duration_ms']) {
    const value = payload[key];
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
      return Math.max(0.1, value / 60_000);
    }
  }
  return null;
}

function spawnIncident(draft: GameState, region: Region, nowMs: number, effects: Narration[]): void {
  const caps = BALANCE.incidents;
  if (region.incidents.length >= caps.maxActivePerRegion) return;
  if (region.lastIncidentAtMs !== 0 && nowMs - region.lastIncidentAtMs < caps.minIntervalMs) return;

  const seq = draft.stats.incidentsSpawned + 1;
  const title = INCIDENT_FLAVOURS[(seq - 1) % INCIDENT_FLAVOURS.length]!;
  draft.stats.incidentsSpawned = seq;
  region.lastIncidentAtMs = nowMs;
  region.totals.incidents += 1;

  if (breakthroughLevel(draft, 'self-healing') >= 1) {
    // Auto-ack: incident resolves instantly, post-mortem still pays out.
    draft.stats.incidentsAcked += 1;
    draft.resources.engineering += BALANCE.engineering.postMortem;
    draft.stats.engineeringFromPostMortems += BALANCE.engineering.postMortem;
    region.totals.engineering += BALANCE.engineering.postMortem;
    narrate(draft, effects, nowMs, `⚡ ${title} in "${region.name}" — self-healed (+${BALANCE.engineering.postMortem} eng)`, 'info');
    return;
  }

  region.incidents.push({ id: `inc-${seq}`, title, startedAt: new Date(nowMs).toISOString() });
  narrate(draft, effects, nowMs, `⚡ incident in "${region.name}": ${title} — [a] to acknowledge`, 'bad');
}

// ---- player actions ----

function applyAction(draft: GameState, action: GameAction, nowMs: number, effects: Narration[]): void {
  switch (action.type) {
    case 'buy':
      actionBuy(draft, action.regionId, action.tierId, nowMs, effects);
      break;
    case 'hire':
      actionHire(draft, nowMs, effects);
      break;
    case 'experiment':
      actionExperiment(draft, nowMs, effects);
      break;
    case 'ack-incident':
      actionAckIncident(draft, action.regionId, nowMs, effects);
      break;
    case 'ship-generation':
      actionShipGeneration(draft, nowMs, effects);
      break;
    case 'buy-breakthrough':
      actionBuyBreakthrough(draft, action.nodeId, nowMs, effects);
      break;
  }
}

function findTier(tierId: string): { tier: InfraTier; index: number } | null {
  const index = INFRA_TIERS.findIndex((t) => t.id === tierId);
  if (index === -1) return null;
  return { tier: INFRA_TIERS[index]!, index };
}

function actionBuy(draft: GameState, regionId: string, tierId: string, nowMs: number, effects: Narration[]): void {
  const region = draft.regions[regionId];
  const found = findTier(tierId);
  if (!region || !found) return;
  const { tier, index } = found;

  const owned = region.infrastructure[tier.id] ?? 0;
  if (index > 0 && tier.requiresPrevious > 0) {
    const prevTier = INFRA_TIERS[index - 1]!;
    const prevOwned = region.infrastructure[prevTier.id] ?? 0;
    const needed = tier.requiresPrevious * (owned + 1);
    if (prevOwned < needed) {
      narrate(draft, effects, nowMs, `✗ ${tier.name} needs ${needed} ${prevTier.name}s in "${region.name}" (have ${prevOwned})`, 'info');
      return;
    }
  }

  const cost = tierCost(tier, owned);
  if (draft.resources.compute < cost) {
    narrate(draft, effects, nowMs, `✗ ${tier.name} costs ${formatAmount(cost)} FLOPS (have ${formatAmount(draft.resources.compute)})`, 'info');
    return;
  }

  draft.resources.compute -= cost;
  draft.stats.computeSpent += cost;
  region.infrastructure[tier.id] = owned + 1;
  narrate(
    draft,
    effects,
    nowMs,
    `＋ ${tier.name} #${owned + 1} online in "${region.name}" — multiplier ×${regionMultiplier(region).toFixed(2)}`,
    'good'
  );
}

function actionHire(draft: GameState, nowMs: number, effects: Narration[]): void {
  const cap = hireCap(draft.resources.reputation);
  if (draft.lab.researchers >= cap) {
    narrate(draft, effects, nowMs, `✗ hiring capped at ${cap} — earn Reputation by finishing turns`, 'info');
    return;
  }
  const cost = hireCost(draft.lab.researchers);
  if (draft.resources.engineering < cost) {
    narrate(draft, effects, nowMs, `✗ hire costs ${formatAmount(cost)} eng (have ${formatAmount(draft.resources.engineering)})`, 'info');
    return;
  }
  draft.resources.engineering -= cost;
  draft.stats.engineeringSpent += cost;
  draft.lab.researchers += 1;
  narrate(draft, effects, nowMs, `☺ researcher #${draft.lab.researchers} joins the lab (progress ×${labMultiplier(draft).toFixed(2)})`, 'good');
}

function actionExperiment(draft: GameState, nowMs: number, effects: Narration[]): void {
  const lab = BALANCE.lab;
  if (draft.resources.research < lab.experimentDataCost) {
    narrate(draft, effects, nowMs, `✗ experiment needs ${lab.experimentDataCost} data (have ${formatAmount(draft.resources.research)})`, 'info');
    return;
  }
  if (draft.resources.engineering < lab.experimentEngineeringCost) {
    narrate(draft, effects, nowMs, `✗ experiment needs ${lab.experimentEngineeringCost} eng (have ${formatAmount(draft.resources.engineering)})`, 'info');
    return;
  }
  draft.resources.research -= lab.experimentDataCost;
  draft.stats.researchSpent += lab.experimentDataCost;
  draft.resources.engineering -= lab.experimentEngineeringCost;
  draft.stats.engineeringSpent += lab.experimentEngineeringCost;
  const progress = lab.experimentProgress * labMultiplier(draft);
  draft.lab.modelProgress += progress;
  draft.stats.experiments += 1;
  narrate(draft, effects, nowMs, `⚗ experiment complete: +${formatAmount(progress)} model progress`, 'good');
}

function actionAckIncident(draft: GameState, regionId: string, nowMs: number, effects: Narration[]): void {
  const region = draft.regions[regionId];
  if (!region || region.incidents.length === 0) return;
  const incident = region.incidents.shift()!;
  draft.stats.incidentsAcked += 1;
  draft.resources.engineering += BALANCE.engineering.postMortem;
  draft.stats.engineeringFromPostMortems += BALANCE.engineering.postMortem;
  region.totals.engineering += BALANCE.engineering.postMortem;
  narrate(draft, effects, nowMs, `✓ post-mortem filed for "${incident.title}" (+${BALANCE.engineering.postMortem} eng)`, 'good');
}

/** Prestige (PRD §2): ship the generation, reset infra + lab, bank Breakthroughs. */
function actionShipGeneration(draft: GameState, nowMs: number, effects: Narration[]): void {
  const threshold = generationThreshold(draft.generation);
  if (draft.lab.modelProgress < threshold) {
    narrate(
      draft,
      effects,
      nowMs,
      `✗ Gen-${draft.generation} needs ${formatAmount(threshold)} model progress (have ${formatAmount(draft.lab.modelProgress)})`,
      'info'
    );
    return;
  }

  const gens = BALANCE.generations;
  const overshoot = Math.min(gens.overshootBonusCap, Math.floor(draft.lab.modelProgress / threshold) - 1);
  const earned = gens.breakthroughsPerShip + Math.max(0, overshoot);
  const shipped = draft.generation;

  draft.resources.breakthroughs += earned;
  draft.stats.breakthroughsEarned += earned;
  draft.stats.generationsShipped += 1;
  draft.generation += 1;

  // Reset: infrastructure and lab staff go; Reputation and Breakthroughs persist.
  draft.resources.compute = 0;
  draft.resources.engineering = 0;
  draft.resources.research = 0;
  draft.lab.researchers = 0;
  draft.lab.modelProgress = 0;

  const startingGpus = 4 * breakthroughLevel(draft, 'blueprints');
  for (const region of Object.values(draft.regions)) {
    region.infrastructure = startingGpus > 0 ? { gpu: startingGpus } : {};
    region.incidents = [];
    region.window = { startMs: 0, outputTokens: 0 };
    region.turnAccrual = 0;
    region.lastIncidentAtMs = 0;
  }

  narrate(
    draft,
    effects,
    nowMs,
    `🚀 Gen-${shipped} SHIPPED — +${earned} Breakthrough${earned === 1 ? '' : 's'} banked. The lab turns to Gen-${draft.generation}.`,
    'ceremony'
  );
  if (startingGpus > 0) {
    narrate(draft, effects, nowMs, `⚙ reference designs seed ${startingGpus} GPUs into every region`, 'info');
  }
}

function actionBuyBreakthrough(draft: GameState, nodeId: string, nowMs: number, effects: Narration[]): void {
  const node = breakthroughNode(nodeId);
  if (!node) return;
  const level = breakthroughLevel(draft, nodeId);
  if (level >= node.maxLevel) {
    narrate(draft, effects, nowMs, `✗ ${node.name} is already at max level`, 'info');
    return;
  }
  const cost = node.cost(level);
  if (draft.resources.breakthroughs < cost) {
    narrate(draft, effects, nowMs, `✗ ${node.name} costs ${cost} Breakthroughs (have ${draft.resources.breakthroughs})`, 'info');
    return;
  }
  draft.resources.breakthroughs -= cost;
  draft.stats.breakthroughsSpent += cost;
  draft.breakthroughLevels[nodeId] = level + 1;
  narrate(draft, effects, nowMs, `★ breakthrough: ${node.name} → level ${level + 1}`, 'ceremony');
}

function applySessionState(
  draft: GameState,
  sessionId: string,
  state: SessionState,
  nowMs: number,
  effects: Narration[]
): void {
  const status = state === 'CC_WORKING' ? 'working' : state === 'STALE' || state === 'DEAD' ? 'dark' : 'idle';
  draft.sessionStatus[sessionId] = status;
  const regionId = draft.sessionRegions[sessionId];
  if (regionId) refreshRegionStatus(draft, effects, regionId, nowMs);
}
