import type { GameState, Narration } from './game.js';
import { resourceLine } from './view.js';

/**
 * The board member: Haiku in character, reacting to big moments and answering
 * very short chat lines. Pure text in, text out; register.tsx makes the calls.
 */

export const BOARD_MODEL = 'haiku';
export const BOARD_MAX_TOKENS = 80;
export const BOARD_TIMEOUT_MS = 8_000;
/** At most one unprompted reaction per minute: each one bills the player's account. */
export const REACT_COOLDOWN_MS = 60_000;
export const MAX_INPUT_CHARS = 80;
export const MAX_REPLY_CHARS = 140;
export const BOARD_LINES = 8;

export const BOARD_SYSTEM = [
  'You are a board member of a small frontier AI lab in an idle game.',
  'You are dry, slightly anxious about burn rate, and secretly proud of the team.',
  'Answer in ONE short line of at most 20 words. Stay in character.',
  'No markdown, no quotes, no emoji, no lists.',
  'Use the lab snapshot for facts; never invent numbers.'
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
  return [
    `Generation ${game.generation}. ${resourceLine(game)}.`,
    `${regions.length} region(s), ${incidents} open incident(s).`,
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
