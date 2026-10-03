import { describe, expect, it } from 'vitest';
import { initialGameState } from '../src/game.js';
import {
  BOARD_LINES,
  MAX_INPUT_CHARS,
  MAX_REPLY_CHARS,
  REACT_COOLDOWN_MS,
  appendLine,
  boardContext,
  canReact,
  chatPrompt,
  cleanReply,
  clipInput,
  isReactable,
  reactionPrompt
} from '../src/board.js';

const game = () => initialGameState('2026-10-02T10:00:00Z');

describe('board prompts', () => {
  it('describes the lab from the real state', () => {
    const g = game();
    g.log.push({
      ts: '2026-10-02T10:00:00Z',
      text: '★ breakthrough: Scaling → level 1',
      kind: 'ceremony'
    });
    const context = boardContext(g);
    expect(context).toContain(`Generation ${g.generation}`);
    expect(context).toContain('FLOPS');
    expect(context).toContain('★ breakthrough: Scaling');
  });

  it('puts the player line and the event into their prompts', () => {
    expect(chatPrompt(game(), 'are we doomed?')).toMatch(/says to you: are we doomed\?$/);
    expect(reactionPrompt(game(), { ts: '', text: '↯ incident', kind: 'bad' })).toContain('↯ incident');
  });
});

describe('clipInput', () => {
  it('trims, joins lines and caps the length', () => {
    expect(clipInput('  hi\n there  ')).toBe('hi there');
    expect(clipInput('x'.repeat(200))).toHaveLength(MAX_INPUT_CHARS);
  });
});

describe('cleanReply', () => {
  it('keeps the first non-empty line without markdown or quotes', () => {
    expect(cleanReply('\n  "**Burn rate** is fine."  \nsecond line')).toBe('Burn rate is fine.');
  });

  it('caps a long reply with an ellipsis', () => {
    const reply = cleanReply('y'.repeat(500));
    expect(reply).toHaveLength(MAX_REPLY_CHARS);
    expect(reply.endsWith('…')).toBe(true);
  });

  it('returns empty for an empty reply', () => {
    expect(cleanReply('  \n ')).toBe('');
  });
});

describe('reactions', () => {
  it('only reacts to ceremonies and incidents', () => {
    expect(isReactable({ ts: '', text: '', kind: 'ceremony' })).toBe(true);
    expect(isReactable({ ts: '', text: '', kind: 'bad' })).toBe(true);
    expect(isReactable({ ts: '', text: '', kind: 'good' })).toBe(false);
    expect(isReactable({ ts: '', text: '', kind: 'info' })).toBe(false);
  });

  it('waits out the cooldown', () => {
    expect(canReact(1_000, null)).toBe(true);
    expect(canReact(1_000 + REACT_COOLDOWN_MS - 1, 1_000)).toBe(false);
    expect(canReact(1_000 + REACT_COOLDOWN_MS, 1_000)).toBe(true);
  });

  it('keeps the last lines only', () => {
    let lines = [] as ReturnType<typeof appendLine>;
    for (let i = 0; i < BOARD_LINES + 3; i++) lines = appendLine(lines, { who: 'board', text: `${i}` });
    expect(lines).toHaveLength(BOARD_LINES);
    expect(lines[0]?.text).toBe('3');
  });
});
