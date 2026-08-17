import { z } from 'zod';

/**
 * Game state (mechanics PRD §3). Serialized as-is into the save file and
 * broadcast opaquely over the daemon socket, so everything here must stay
 * plain JSON. All mutation happens in engine.ts; this module is shape only.
 */

export const IncidentSchema = z.object({
  id: z.string(),
  title: z.string(),
  startedAt: z.string()
});
export type Incident = z.infer<typeof IncidentSchema>;

/** One region = one project folder (open question #3: cwd-keyed persistence). */
export const RegionSchema = z.object({
  /** The project cwd (or 'unassigned' for telemetry we can't place). */
  id: z.string(),
  /** Display name — the cwd's basename. */
  name: z.string(),
  foundedAt: z.string(),
  /** 'hot' = a session is working; 'dark' = sessions stale/dead; else idle. */
  status: z.enum(['hot', 'idle', 'dark']).default('idle'),
  /** Units owned per infrastructure tier id. */
  infrastructure: z.record(z.number().nonnegative()).default({}),
  /** Diminishing-returns rolling window (PRD §5). */
  window: z
    .object({
      startMs: z.number().nonnegative(),
      outputTokens: z.number().nonnegative()
    })
    .default({ startMs: 0, outputTokens: 0 }),
  /** Compute accrued this turn; the Stop completion bonus applies to it. */
  turnAccrual: z.number().nonnegative().default(0),
  incidents: z.array(IncidentSchema).default([]),
  lastIncidentAtMs: z.number().nonnegative().default(0),
  totals: z
    .object({
      compute: z.number().nonnegative(),
      engineering: z.number().nonnegative(),
      research: z.number().nonnegative(),
      outputTokens: z.number().nonnegative(),
      incidents: z.number().nonnegative()
    })
    .default({ compute: 0, engineering: 0, research: 0, outputTokens: 0, incidents: 0 })
});
export type Region = z.infer<typeof RegionSchema>;

export const NarrationSchema = z.object({
  ts: z.string(),
  text: z.string(),
  kind: z.enum(['info', 'good', 'bad', 'ceremony'])
});
export type Narration = z.infer<typeof NarrationSchema>;

/** Balance telemetry (PRD §5): the economy logs its own stats for replay tuning. */
export const EconomyStatsSchema = z.object({
  eventsProcessed: z.number().nonnegative().default(0),
  outputTokensSeen: z.number().nonnegative().default(0),
  computeFromTokens: z.number().nonnegative().default(0),
  computeFromCompletionBonus: z.number().nonnegative().default(0),
  computeFromStopBonus: z.number().nonnegative().default(0),
  computeFromTraining: z.number().nonnegative().default(0),
  computeSpent: z.number().nonnegative().default(0),
  engineeringFromTools: z.number().nonnegative().default(0),
  engineeringFromPostMortems: z.number().nonnegative().default(0),
  engineeringSpent: z.number().nonnegative().default(0),
  researchFromTools: z.number().nonnegative().default(0),
  researchSpent: z.number().nonnegative().default(0),
  reputationEarned: z.number().nonnegative().default(0),
  toolSuccesses: z.number().nonnegative().default(0),
  toolFailures: z.number().nonnegative().default(0),
  incidentsSpawned: z.number().nonnegative().default(0),
  incidentsAcked: z.number().nonnegative().default(0),
  trainingRuns: z.number().nonnegative().default(0),
  experiments: z.number().nonnegative().default(0),
  generationsShipped: z.number().nonnegative().default(0),
  breakthroughsEarned: z.number().nonnegative().default(0),
  breakthroughsSpent: z.number().nonnegative().default(0)
});
export type EconomyStats = z.infer<typeof EconomyStatsSchema>;

export const GameStateSchema = z.object({
  createdAt: z.string(),
  /** Generation currently being built (1-based). */
  generation: z.number().int().positive().default(1),
  resources: z
    .object({
      compute: z.number().nonnegative(),
      engineering: z.number().nonnegative(),
      research: z.number().nonnegative(),
      reputation: z.number().nonnegative(),
      breakthroughs: z.number().nonnegative()
    })
    .default({ compute: 0, engineering: 0, research: 0, reputation: 0, breakthroughs: 0 }),
  /** Purchased Breakthrough levels, keyed by node id. Survives prestige. */
  breakthroughLevels: z.record(z.number().nonnegative()).default({}),
  lab: z
    .object({
      researchers: z.number().nonnegative(),
      modelProgress: z.number().nonnegative()
    })
    .default({ researchers: 0, modelProgress: 0 }),
  /** Regions keyed by region id (project cwd). */
  regions: z.record(RegionSchema).default({}),
  /** sessionId → regionId, learned from envelopes carrying cwd. */
  sessionRegions: z.record(z.string()).default({}),
  /** sessionId → coarse liveness used to derive region status. */
  sessionStatus: z.record(z.enum(['working', 'idle', 'dark'])).default({}),
  stats: EconomyStatsSchema.default({}),
  /** Bounded narration feed (newest last). */
  log: z.array(NarrationSchema).default([])
});
export type GameState = z.infer<typeof GameStateSchema>;

export function initialGameState(nowIso: string): GameState {
  return GameStateSchema.parse({ createdAt: nowIso });
}

/** Region id for telemetry whose session→cwd mapping is (still) unknown. */
export const UNASSIGNED_REGION_ID = 'unassigned';
