import {
  BALANCE,
  BREAKTHROUGH_NODES,
  INFRA_TIERS,
  breakthroughLevel,
  canShipGeneration,
  formatAmount,
  generationThreshold,
  hireCap,
  hireCost,
  labMultiplier,
  regionMultiplier,
  regionsByFounded,
  tierCost,
  type GameState,
  type Narration,
  type Region
} from './game.js';

/**
 * view.ts — what the pane shows, as plain data. The render hook only lays
 * these lines out with the surface's elements, so everything the player
 * reads (and every affordability rule) is testable without a session.
 */

export type Tone = 'good' | 'bad' | 'warn' | 'info' | 'accent' | 'dim';

export interface Action {
  /** One lowercase letter or digit: what a mod's Button takes as `hotkey`. */
  hotkey: string;
  label: string;
  isReady: boolean;
}

/** Text progress bar like ▰▰▰▱▱▱▱ clamped to [0, 1]. */
export function progressBar(fraction: number, width: number): string {
  const clamped = Math.max(0, Math.min(1, fraction));
  const filled = Math.round(clamped * width);
  return '▰'.repeat(filled) + '▱'.repeat(width - filled);
}

const GPUS_PER_RACK_FRAME = 8;

/** Each rack frame holds 8 GPU cells, filling as GPUs come online; fits `width` columns. */
export function rackDiagram(region: Region, width: number): string {
  const gpus = region.infrastructure['gpu'] ?? 0;
  const frames = Math.max(1, Math.ceil(gpus / GPUS_PER_RACK_FRAME));
  const frameWidth = GPUS_PER_RACK_FRAME + 3;
  const room = Math.max(1, Math.floor((width - 4) / frameWidth));
  const shown = Math.min(frames, room);
  const parts: string[] = [];
  for (let i = 0; i < shown; i += 1) {
    const cells = Math.max(0, Math.min(GPUS_PER_RACK_FRAME, gpus - i * GPUS_PER_RACK_FRAME));
    parts.push(`[${'█'.repeat(cells)}${'·'.repeat(GPUS_PER_RACK_FRAME - cells)}]`);
  }
  if (frames > shown) parts.push(`+${frames - shown}`);
  return parts.join(' ');
}

export const REGION_STATUS: Record<Region['status'], { text: string; tone: Tone }> = {
  hot: { text: '● hot', tone: 'good' },
  idle: { text: '○ idle', tone: 'dim' },
  dark: { text: '▓ dark', tone: 'bad' }
};

/** The focused region, cycling through regions in founding order. */
export function focusedRegion(game: GameState, index: number): { region: Region; position: number; count: number } | null {
  const regions = regionsByFounded(game);
  if (regions.length === 0) return null;
  const position = ((index % regions.length) + regions.length) % regions.length;
  return { region: regions[position]!, position: position + 1, count: regions.length };
}

export function resourceLine(game: GameState): string {
  const r = game.resources;
  return [
    `${formatAmount(r.compute)} FLOPS`,
    `${formatAmount(r.engineering)} eng`,
    `${formatAmount(r.research)} data`,
    `${formatAmount(r.reputation)} rep`,
    `${formatAmount(r.breakthroughs)} ★`
  ].join(' · ');
}

const TIER_HOTKEYS = ['g', 'r', 'd'];

export function infraActions(game: GameState, region: Region): Array<Action & { tierId: string }> {
  return INFRA_TIERS.map((tier, index) => {
    const cost = tierCost(tier, region.infrastructure[tier.id] ?? 0);
    return {
      tierId: tier.id,
      hotkey: TIER_HOTKEYS[index] ?? String(index + 1),
      label: `${tier.name} ${formatAmount(cost)}`,
      isReady: game.resources.compute >= cost
    };
  });
}

export function regionLines(region: Region): string[] {
  const infra = INFRA_TIERS.map((tier) => `${tier.glyph} ${region.infrastructure[tier.id] ?? 0} ${tier.name}`).join('  ');
  const fullRate = BALANCE.compute.fullRateTokensPerWindow;
  const used = region.window.outputTokens;
  const rate =
    used > fullRate
      ? 'diminishing returns active'
      : `${formatAmount(fullRate - used)} full-rate tokens left`;
  return [infra, `×${regionMultiplier(region).toFixed(2)} · Σ${formatAmount(region.totals.compute)} FLOPS · ${rate}`];
}

export interface LabView {
  researchers: string;
  progressBar: string;
  progress: string;
  isShippable: boolean;
  actions: Action[];
}

export function labView(game: GameState, barWidth: number): LabView {
  const threshold = generationThreshold(game.generation);
  const cap = hireCap(game.resources.reputation);
  const nextHire = hireCost(game.lab.researchers);
  const isShippable = canShipGeneration(game);
  return {
    researchers: `☺ ${game.lab.researchers}/${cap} researchers · progress ×${labMultiplier(game).toFixed(2)}`,
    progressBar: progressBar(game.lab.modelProgress / threshold, barWidth),
    progress: `${formatAmount(game.lab.modelProgress)}/${formatAmount(threshold)}`,
    isShippable,
    actions: [
      {
        hotkey: 'h',
        label: `hire ${formatAmount(nextHire)} eng`,
        isReady: game.lab.researchers < cap && game.resources.engineering >= nextHire
      },
      {
        hotkey: 'e',
        label: `experiment ${BALANCE.lab.experimentDataCost} data`,
        isReady:
          game.resources.research >= BALANCE.lab.experimentDataCost &&
          game.resources.engineering >= BALANCE.lab.experimentEngineeringCost
      },
      { hotkey: 's', label: `ship Gen-${game.generation}`, isReady: isShippable }
    ]
  };
}

export interface BreakthroughRow extends Action {
  nodeId: string;
  detail: string;
  isMaxed: boolean;
}

export function breakthroughRows(game: GameState): BreakthroughRow[] {
  return BREAKTHROUGH_NODES.slice(0, 9).map((node, index) => {
    const level = breakthroughLevel(game, node.id);
    const isMaxed = level >= node.maxLevel;
    const cost = isMaxed ? 0 : node.cost(level);
    return {
      nodeId: node.id,
      hotkey: String(index + 1),
      label: `${node.name} ${level}/${node.maxLevel}${isMaxed ? ' max' : ` — ${cost} ★`}`,
      detail: node.description,
      isMaxed,
      isReady: !isMaxed && game.resources.breakthroughs >= cost
    };
  });
}

export const NARRATION_TONE: Record<Narration['kind'], Tone> = {
  info: 'dim',
  good: 'good',
  bad: 'bad',
  ceremony: 'accent'
};

/** One status-line entry, readable even with the pane closed. */
export function statusText(game: GameState): string {
  const incidents = Object.values(game.regions).reduce((n, region) => n + region.incidents.length, 0);
  const alert = incidents > 0 ? ` · ↯${incidents}` : '';
  return `cc-idle ${formatAmount(game.resources.compute)} FLOPS · Gen-${game.generation}${alert}`;
}

/**
 * The one move worth making next, for a player still learning the game.
 * Built from the same rules as the buttons, so it never points at a dim one.
 */
export function nextStep(game: GameState, region: Region | null): string | null {
  if (!region) return 'Ask Claude anything: its work here founds your first region.';
  if (region.incidents.length > 0) return 'Press a to acknowledge the incident.';
  const gpu = infraActions(game, region)[0];
  if ((region.infrastructure['gpu'] ?? 0) === 0 && gpu?.isReady) return 'Press g to buy your first GPU.';
  const lab = labView(game, 1);
  if (game.lab.researchers === 0 && lab.actions[0]?.isReady) return 'Press h to hire your first researcher.';
  if (lab.isShippable) return `Press s to ship Gen-${game.generation}.`;
  // Researchers only multiply progress, so the first hire needs a source of it.
  if (game.lab.researchers > 0 && game.lab.modelProgress === 0) {
    if (lab.actions[1]?.isReady) return 'Press e to run an experiment: researchers multiply its progress.';
    if (game.resources.research < BALANCE.lab.experimentDataCost) {
      return `Experiments need ${BALANCE.lab.experimentDataCost} data (have ${formatAmount(game.resources.research)}). Ask Claude to use a subagent: each run adds progress, even with no data.`;
    }
  }
  return null;
}

/** The welcome and help screen: how Claude's work becomes the economy, and what to spend it on. */
export const HELP_LINES: ReadonlyArray<{ text: string; tone: Tone }> = [
  { text: 'You run an AI lab. Claude does the work; you spend what it earns.', tone: 'info' },
  { text: 'Output tokens → FLOPS · Edit/Write/Bash → eng · Read/Search → data', tone: 'accent' },
  { text: 'A finished turn pays a bonus. A subagent is a training run. A failed tool is an incident.', tone: 'accent' },
  { text: 'g r d buy GPUs, racks and datacenters: more FLOPS per token.', tone: 'info' },
  { text: 'e runs an experiment and a subagent runs training: both fill the model bar. h hires researchers to multiply it.', tone: 'info' },
  { text: 's ships the generation for ★ Breakthroughs (v), which outlast the reset.', tone: 'info' },
  { text: 'Esc hands the keyboard back. /idle takes it again. /idle close hides the pane.', tone: 'dim' }
];
