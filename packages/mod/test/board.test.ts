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
  BOARD_SYSTEM,
  GAME_RULES,
  conceptPrompt,
  isReactable,
  nextConcept,
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

describe('help', () => {
  it('gives the board the real rules', () => {
    expect(GAME_RULES).toContain('first 40K output tokens in a rolling hour');
    expect(GAME_RULES).toContain('Quantization');
    expect(BOARD_SYSTEM).toContain(GAME_RULES);
  });

  it('tells the board when a region is past its full rate', () => {
    const g = withRegion();
    g.regions['/p/a']!.window.outputTokens = 50_000;
    expect(boardContext(g)).toContain('diminishing returns active');
  });

  it('finds the first mechanic met but not yet explained', () => {
    const g = withRegion();
    expect(nextConcept(g, [])).toBeNull();
    g.regions['/p/a']!.incidents.push({ id: 'i1', title: 'pager', openedAt: '2026-10-02T10:00:00Z' } as never);
    g.regions['/p/a']!.window.outputTokens = 50_000;
    expect(nextConcept(g, [])?.id).toBe('incident');
    expect(nextConcept(g, ['incident'])?.id).toBe('diminishing');
    expect(nextConcept(g, ['incident', 'diminishing'])).toBeNull();
    expect(conceptPrompt(g, nextConcept(g, [])!)).toContain('first time: incidents');
  });
});

function withRegion() {
  const g = game();
  g.regions['/p/a'] = {
    id: '/p/a',
    name: 'a',
    foundedAt: '2026-10-01T00:00:00Z',
    status: 'idle',
    infrastructure: {},
    window: { startMs: 0, outputTokens: 0 },
    turnAccrual: 0,
    incidents: [],
    lastIncidentAtMs: 0,
    totals: { compute: 0, engineering: 0, research: 0, outputTokens: 0, incidents: 0 }
  };
  return g;
}
