/**
 * balance.ts — every tuning constant for the CC Idle economy lives here and
 * ONLY here (mechanics PRD §7). Numbers are deliberately first-draft: the
 * intended tuning loop is `ccidle replay` runs against recorded real
 * sessions, reading the economy report, and editing this file.
 */

export interface InfraTier {
  id: string;
  name: string;
  /** Cost in Compute for the first unit. */
  baseCost: number;
  /** Geometric cost growth per unit already owned. */
  costGrowth: number;
  /** Additive contribution to the region multiplier per unit. */
  multiplier: number;
  /** Units of the previous tier required per unit of this one (0 = none). */
  requiresPrevious: number;
  /** Glyph used by the TUI rack diagram. */
  glyph: string;
}

/** Ordered smallest → largest; `requiresPrevious` refers to the tier before it. */
export const INFRA_TIERS: readonly InfraTier[] = [
  { id: 'gpu', name: 'GPU', baseCost: 500, costGrowth: 1.15, multiplier: 0.02, requiresPrevious: 0, glyph: '▪' },
  { id: 'rack', name: 'Rack', baseCost: 12_000, costGrowth: 1.18, multiplier: 0.3, requiresPrevious: 8, glyph: '▮' },
  { id: 'datacenter', name: 'Datacenter', baseCost: 250_000, costGrowth: 1.22, multiplier: 2.0, requiresPrevious: 4, glyph: '⬢' }
] as const;

export const BALANCE = {
  compute: {
    /** Compute (FLOPS) granted per weighted output token. */
    perOutputToken: 1,
    /**
     * Diminishing returns (PRD §5): per region, the first
     * `fullRateTokensPerWindow` output tokens in a rolling `windowMs` window
     * convert at full rate; beyond that the marginal rate is
     * 1 / (1 + log2(windowTokens / fullRateTokensPerWindow)).
     */
    fullRateTokensPerWindow: 40_000,
    windowMs: 3_600_000,
    /** Retroactive completion multiplier on a turn's accrual when it ends in Stop. */
    turnCompletionBonus: 0.25,
    /** Small flat Compute granted to every live region on any Stop (PRD §4). */
    stopAllRegionBonus: 10
  },

  engineering: {
    /** Engineering per successful engineering-class tool call. */
    perToolCall: 2,
    /** Engineering granted for acknowledging an incident ("post-mortem"). */
    postMortem: 3
  },

  research: {
    /** Research Data per successful research-class tool call. */
    perToolCall: 1
  },

  reputation: {
    /** Reputation per clean Stop (completed turn). */
    perStop: 1,
    /** Open question #1 resolved per the PRD lean: a mirror, not a treadmill. */
    decayPerDay: 0
  },

  /** Tool classification for resource accrual (PRD §3). */
  tools: {
    engineering: ['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash'],
    research: ['Read', 'WebSearch', 'WebFetch', 'Grep', 'Glob']
  },

  lab: {
    /** First researcher's cost in Engineering; geometric growth per hire. */
    hireBaseCost: 60,
    hireCostGrowth: 1.35,
    /** Hire cap = 1 + floor(reputation / reputationPerHireSlot) — the §3 soft gate. */
    reputationPerHireSlot: 5,
    /** Each researcher adds this to the lab progress multiplier. */
    progressPerResearcher: 0.25,
    /** Manual experiment: costs and Model Progress payout. */
    experimentDataCost: 25,
    experimentEngineeringCost: 10,
    experimentProgress: 10,
    /** Training run (fires on SubagentStop): Research Data consumed per run. */
    trainingDataCost: 15,
    /** Progress payout = base + perMinute × clamped subagent minutes. */
    trainingBaseProgress: 5,
    trainingProgressPerMinute: 4,
    trainingMaxMinutes: 30,
    /** Assumed duration when the SubagentStop payload carries none. */
    trainingDefaultMinutes: 2,
    /** Compute payout per training-run minute (scaled by the region multiplier). */
    trainingComputePerMinute: 100,
    /**
     * With no Research Data banked a run still pays this fraction — training
     * never blocks (PRD §1.4), data just makes it much better.
     */
    trainingMinEfficiency: 0.25
  },

  generations: {
    /** Model Progress required to ship Gen-1; geometric growth per generation. */
    baseProgress: 100,
    progressGrowth: 2.5,
    /** Breakthroughs banked per shipped generation, plus overshoot bonus below. */
    breakthroughsPerShip: 3,
    /** +1 Breakthrough per whole extra multiple of the threshold, capped here. */
    overshootBonusCap: 3
  },

  incidents: {
    /** Frequency caps (PRD §6): alert fatigue guard. */
    maxActivePerRegion: 3,
    minIntervalMs: 60_000,
    /** Multiplicative regional debuff per active incident (mild by design). */
    debuffPerIncident: 0.08,
    /** Floor so a noisy region never drops below half rate. */
    debuffFloor: 0.5
  },

  /** Bounded narration log kept in game state for the TUI feed. */
  logLimit: 100
} as const;

/** Cost of the next unit of a tier given how many are already owned. */
export function tierCost(tier: InfraTier, owned: number): number {
  return Math.ceil(tier.baseCost * Math.pow(tier.costGrowth, owned));
}

/** Cost in Engineering of the next researcher hire. */
export function hireCost(researchers: number): number {
  return Math.ceil(BALANCE.lab.hireBaseCost * Math.pow(BALANCE.lab.hireCostGrowth, researchers));
}

/** Model Progress required to ship the given generation (1-based). */
export function generationThreshold(generation: number): number {
  return Math.ceil(
    BALANCE.generations.baseProgress * Math.pow(BALANCE.generations.progressGrowth, generation - 1)
  );
}

/** Max researchers employable at a given Reputation (soft gate, PRD §3). */
export function hireCap(reputation: number): number {
  return 1 + Math.floor(reputation / BALANCE.lab.reputationPerHireSlot);
}
