import { BALANCE, BREAKTHROUGH_NODES, INFRA_TIERS, formatAmount, generationThreshold } from './game.js';
import type { GameState, Narration } from './game.js';
import { labView, regionLines, resourceLine } from './view.js';

/**
 * The board member: Haiku in character, reacting to big moments and answering
 * very short chat lines. Pure text in, text out; register.tsx makes the calls.
 */

export const BOARD_MODEL = 'haiku';
export const BOARD_MAX_TOKENS = 120;
export const BOARD_TIMEOUT_MS = 8_000;
/** At most one unprompted reaction per minute: each one bills the player's account. */
export const REACT_COOLDOWN_MS = 60_000;
export const MAX_INPUT_CHARS = 80;
export const MAX_REPLY_CHARS = 300;
export const BOARD_LINES = 8;

const C = BALANCE.compute;
const L = BALANCE.lab;

/** The rules, from the real balance constants, so the board can answer "how does X work?". */
export const GAME_RULES = [
  'Claude Code does real work; the game turns it into resources.',
  `Output tokens become FLOPS (Compute). Edit/Write/Bash calls give ${BALANCE.engineering.perToolCall} engineering each. Read/Search/Fetch calls give ${BALANCE.research.perToolCall} data each.`,
  `A finished turn adds a ${C.turnCompletionBonus * 100}% completion bonus and ${BALANCE.reputation.perStop} reputation. A subagent is a training run: it uses ${L.trainingDataCost} data and adds model progress.`,
  `Diminishing returns: per region, the first ${formatAmount(C.fullRateTokensPerWindow)} output tokens in a rolling hour convert at full rate; after that each token is worth less (log scale). Burning more tokens is never the best play.`,
  `A failed tool call is an incident. Each open incident cuts that region's rate by ${BALANCE.incidents.debuffPerIncident * 100}% (never below half). Press a to acknowledge it: the post-mortem pays ${BALANCE.engineering.postMortem} engineering.`,
  `Infrastructure, bought with FLOPS per region, raises the region multiplier: ${INFRA_TIERS.map((t) => `${t.name} from ${formatAmount(t.baseCost)}${t.requiresPrevious ? ` (needs ${t.requiresPrevious} ${INFRA_TIERS[INFRA_TIERS.indexOf(t) - 1]?.name}s each)` : ''}`).join(', ')}. Each unit costs more than the last.`,
  `Researchers cost engineering (first ${L.hireBaseCost}) and speed model progress by ${L.progressPerResearcher * 100}% each. Reputation caps hires: one slot per ${L.reputationPerHireSlot} reputation. An experiment costs ${L.experimentDataCost} data and ${L.experimentEngineeringCost} engineering for ${L.experimentProgress} progress.`,
  `Shipping a generation (needs ${generationThreshold(1)} progress for Gen-1, x${BALANCE.generations.progressGrowth} each after) resets infrastructure and lab staff but banks ${BALANCE.generations.breakthroughsPerShip}+ Breakthroughs, which last forever.`,
  `Breakthroughs buy: ${BREAKTHROUGH_NODES.map((n) => `${n.name} (${n.description})`).join('; ')}.`,
  'Keys: g r d buy, a acknowledge, n next region, h hire, e experiment, s ship, v breakthroughs, i help, c the board.'
].join('\n');

export const BOARD_SYSTEM = [
  'You are a board member of a small frontier AI lab in an idle game.',
  'You are dry, slightly anxious about burn rate, and secretly proud of the team.',
  'Answer in ONE line. Banter: at most 20 words.',
  'A question about how the game works: lead with the plain answer from the rules, at most 40 words, then stop.',
  'No markdown, no quotes, no emoji, no lists.',
  'Use the rules and the lab snapshot for facts; never invent numbers or mechanics.',
  `\n\nGame rules:\n${GAME_RULES}`
].join(' ');

export interface BoardLine {
  who: 'you' | 'board' | 'system';
  text: string;
}

/** A compact snapshot of the lab, so the board talks about the real game. */
export function boardContext(game: GameState): string {
  const regions = Object.values(game.regions);
  const incidents = regions.reduce((n, r) => n + r.incidents.length, 0);
  const recent = game.log.slice(-3).map((entry) => `- ${entry.text}`);
  const lab = labView(game, 1);
  return [
    `Generation ${game.generation}. ${resourceLine(game)}.`,
    `${regions.length} region(s), ${incidents} open incident(s).`,
    ...regions.map((r) => `Region ${r.name}: ${regionLines(r).join(' · ')}.`),
    `Lab: ${lab.researchers}, model progress ${lab.progress}.`,
    recent.length > 0 ? `Recent:\n${recent.join('\n')}` : 'Nothing has happened yet.'
  ].join('\n');
}

export function chatPrompt(game: GameState, line: string): string {
  return `${boardContext(game)}\n\nThe lab founder says to you: ${line}`;
}

export function reactionPrompt(game: GameState, effect: Narration): string {
  return `${boardContext(game)}\n\nThis just happened: ${effect.text}\nReact to it.`;
}

/** The player's line: one line, trimmed, at most MAX_INPUT_CHARS. */
export function clipInput(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, MAX_INPUT_CHARS);
}

/** The model's reply as one clean line, or '' when nothing usable is left. */
export function cleanReply(text: string): string {
  const line =
    text
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? '';
  const bare = line
    .replace(/[*_`#>]/g, '')
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, '')
    .trim();
  return bare.length > MAX_REPLY_CHARS ? `${bare.slice(0, MAX_REPLY_CHARS - 1)}…` : bare;
}

/** Only big moments earn a reaction: ceremonies (ship, breakthrough, founding) and incidents. */
export function isReactable(effect: Narration): boolean {
  return effect.kind === 'ceremony' || effect.kind === 'bad';
}

export function canReact(nowMs: number, lastMs: number | null): boolean {
  return lastMs === null || nowMs - lastMs >= REACT_COOLDOWN_MS;
}

/** Appends a line and keeps the last BOARD_LINES. */
export function appendLine(lines: readonly BoardLine[], line: BoardLine): BoardLine[] {
  return [...lines, line].slice(-BOARD_LINES);
}

/** A mechanic the board explains, unasked, the first time the player meets it. */
export interface Concept {
  id: string;
  topic: string;
}

const CONCEPTS: ReadonlyArray<Concept & { isMet: (game: GameState) => boolean }> = [
  {
    id: 'incident',
    topic: 'incidents: what they cost and how to clear one',
    isMet: (g) => Object.values(g.regions).some((r) => r.incidents.length > 0)
  },
  {
    id: 'diminishing',
    topic: 'diminishing returns: why tokens now earn less, and what to do instead',
    isMet: (g) => Object.values(g.regions).some((r) => r.window.outputTokens > C.fullRateTokensPerWindow)
  },
  {
    id: 'second-region',
    topic: 'regions: each project is a region with its own infrastructure and rate',
    isMet: (g) => Object.keys(g.regions).length >= 2
  },
  {
    id: 'shippable',
    topic: 'shipping a generation: what resets and what Breakthroughs are for',
    isMet: (g) => labView(g, 1).isShippable
  },
  {
    id: 'breakthroughs',
    topic: 'spending Breakthroughs: the tree on v, and which node to pick first',
    isMet: (g) => g.resources.breakthroughs > 0
  }
];

/** The first concept the player has met but the board has not explained yet. */
export function nextConcept(game: GameState, explained: readonly string[]): Concept | null {
  const found = CONCEPTS.find((c) => !explained.includes(c.id) && c.isMet(game));
  return found ? { id: found.id, topic: found.topic } : null;
}

export function conceptPrompt(game: GameState, concept: Concept): string {
  return `${boardContext(game)}\n\nThe founder just met this for the first time: ${concept.topic}. Explain it briefly, in character, with one concrete tip.`;
}
