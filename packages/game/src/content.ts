/**
 * content.ts — flavour and the Breakthrough tree (mechanics PRD §6, §7).
 * Naming follows open question #2's safe middle: real-world-adjacent but
 * generic terms, no trademarks.
 */

/** Incident flavour titles; picked deterministically (spawn counter modulo). */
export const INCIDENT_FLAVOURS: readonly string[] = [
  'GPU thermal event in hall B',
  'eval regression on the nightly suite',
  'on-call page: gradient overflow',
  'checkpoint corruption detected',
  'dataloader stall in shard 7',
  'spot capacity reclaimed mid-epoch',
  'network fabric flapping',
  'cooling loop pressure warning'
] as const;

export interface BreakthroughNode {
  id: string;
  name: string;
  description: string;
  maxLevel: number;
  /** Breakthrough cost of the next level (0-based current level). */
  cost: (level: number) => number;
}

/**
 * Breakthrough tree v1 (M2). Emphasis on automation per PRD §7 — the game
 * should demand *less* interaction as it progresses.
 */
export const BREAKTHROUGH_NODES: readonly BreakthroughNode[] = [
  {
    id: 'quantization',
    name: 'Quantization',
    description: '+20% Compute conversion per level',
    maxLevel: 5,
    cost: (level) => 1 + level
  },
  {
    id: 'synthetic-data',
    name: 'Synthetic Data',
    description: '+25% Research Data per level',
    maxLevel: 5,
    cost: (level) => 1 + level
  },
  {
    id: 'scaling-laws',
    name: 'Scaling Laws',
    description: '+25% Model Progress from training & experiments per level',
    maxLevel: 5,
    cost: (level) => 1 + level
  },
  {
    id: 'self-healing',
    name: 'Self-Healing Infra',
    description: 'incidents auto-acknowledge (post-mortem included)',
    maxLevel: 1,
    cost: () => 2
  },
  {
    id: 'procurement',
    name: 'Procurement Bots',
    description: 'auto-buy GPUs whenever a region can afford them',
    maxLevel: 1,
    cost: () => 2
  },
  {
    id: 'blueprints',
    name: 'Reference Designs',
    description: 'each new generation starts with 4 GPUs per region per level',
    maxLevel: 3,
    cost: (level) => 2 + level
  }
] as const;

export function breakthroughNode(id: string): BreakthroughNode | undefined {
  return BREAKTHROUGH_NODES.find((node) => node.id === id);
}
