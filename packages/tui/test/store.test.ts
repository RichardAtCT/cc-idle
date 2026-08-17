import { describe, it, expect } from 'vitest';
import type { ServerMessage, SessionSnapshot } from '@ccidle/shared';
import { EMPTY_TOKEN_TOTALS } from '@ccidle/shared';
import { initialGameState } from '@ccidle/game';
import { applyMessage, reduce, initialState, orderedSessions } from '../src/store.js';
import type { AppState } from '../src/store.js';

function session(overrides: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    sessionId: 'session-aaaaaaaa',
    state: 'CC_WORKING',
    stateSince: '2026-08-17T10:00:00.000Z',
    toolCallsThisTurn: 0,
    toolCallsTotal: 0,
    turns: 0,
    tokensByModel: {},
    ...overrides
  };
}

describe('applyMessage', () => {
  it('hello populates sessions and connection-relevant fields', () => {
    const hello: ServerMessage = {
      type: 'hello',
      protocol: 1,
      daemonVersion: '0.1.0',
      autofocusPaused: true,
      tmuxAvailable: false,
      sessions: [session()]
    };
    const state = applyMessage(initialState, hello);
    expect(state.connection).toBe('connected');
    expect(state.autofocusPaused).toBe(true);
    expect(state.tmuxAvailable).toBe(false);
    expect(state.sessions['session-aaaaaaaa']).toEqual(session());
    expect(state.sessionOrder).toEqual(['session-aaaaaaaa']);
  });

  it('session-state updates an existing session in place, preserving order', () => {
    let state = applyMessage(initialState, {
      type: 'hello',
      protocol: 1,
      daemonVersion: '0.1.0',
      autofocusPaused: false,
      tmuxAvailable: true,
      sessions: [session({ sessionId: 'a' }), session({ sessionId: 'b' })]
    });
    state = applyMessage(state, {
      type: 'session-state',
      session: session({ sessionId: 'a', state: 'HUMAN_ACTIVE', toolCallsThisTurn: 3 })
    });
    expect(state.sessionOrder).toEqual(['a', 'b']);
    expect(state.sessions.a?.state).toBe('HUMAN_ACTIVE');
    expect(state.sessions.a?.toolCallsThisTurn).toBe(3);
    expect(state.sessions.b?.state).toBe('CC_WORKING');
  });

  it('session-state appends a brand-new session id to the order', () => {
    const state = applyMessage(initialState, {
      type: 'session-state',
      session: session({ sessionId: 'fresh' })
    });
    expect(state.sessionOrder).toEqual(['fresh']);
  });

  it('increments ticks only on PostToolUse events', () => {
    const postToolUse: ServerMessage = {
      type: 'event',
      envelope: {
        v: 1,
        ts: '2026-08-17T10:00:01.000Z',
        session_id: 'a',
        event: 'PostToolUse',
        tool: 'Bash',
        payload: {}
      }
    };
    const other: ServerMessage = {
      type: 'event',
      envelope: {
        v: 1,
        ts: '2026-08-17T10:00:02.000Z',
        session_id: 'a',
        event: 'PreToolUse',
        tool: 'Edit',
        payload: {}
      }
    };
    let state = applyMessage(initialState, postToolUse);
    expect(state.ticks).toBe(1);
    expect(state.lastTool).toBe('Bash');

    state = applyMessage(state, other);
    expect(state.ticks).toBe(1); // unchanged
    expect(state.lastTool).toBe('Bash'); // unchanged, PreToolUse doesn't overwrite

    state = applyMessage(state, postToolUse);
    expect(state.ticks).toBe(2);
  });

  it('needs-you alert sets the queue and active alert; clear resets it for a matching session', () => {
    const alertOn: ServerMessage = {
      type: 'alert',
      kind: 'needs-you',
      sessionId: 'a',
      queue: [session({ sessionId: 'a' }), session({ sessionId: 'b' })]
    };
    let state = applyMessage(initialState, alertOn);
    expect(state.activeAlertSessionId).toBe('a');
    expect(state.needsYouQueue.map((s) => s.sessionId)).toEqual(['a', 'b']);
    // alert queue entries populate the session map too
    expect(state.sessions.a).toBeDefined();

    const clearOther: ServerMessage = { type: 'alert', kind: 'clear', sessionId: 'b', queue: [] };
    state = applyMessage(state, clearOther);
    expect(state.activeAlertSessionId).toBe('a'); // untouched, different session

    const clearActive: ServerMessage = { type: 'alert', kind: 'clear', sessionId: 'a', queue: [] };
    state = applyMessage(state, clearActive);
    expect(state.activeAlertSessionId).toBeNull();
    expect(state.needsYouQueue).toEqual([]);
  });

  it('ignores status/session-state fields it does not care about without crashing', () => {
    const status: ServerMessage = {
      type: 'status',
      autofocusPaused: false,
      tmuxAvailable: true,
      sessions: []
    };
    expect(() => applyMessage(initialState, status)).not.toThrow();
  });
});

describe('reduce', () => {
  it('tracks connection status alongside server messages', () => {
    let state: AppState = initialState;
    state = reduce(state, { kind: 'connection-status', status: 'connected' });
    expect(state.connection).toBe('connected');

    state = reduce(state, {
      kind: 'server-message',
      message: { type: 'status', autofocusPaused: true, tmuxAvailable: true, sessions: [] }
    });
    expect(state.autofocusPaused).toBe(true);

    state = reduce(state, { kind: 'connection-status', status: 'disconnected' });
    expect(state.connection).toBe('disconnected');
    // sessions/ticks survive a disconnect (daemon may resume where it left off)
    expect(state.autofocusPaused).toBe(true);
  });
});

describe('orderedSessions', () => {
  it('returns sessions in first-seen order for strip/keybind indexing', () => {
    let state = initialState;
    state = applyMessage(state, { type: 'session-state', session: session({ sessionId: 'z' }) });
    state = applyMessage(state, { type: 'session-state', session: session({ sessionId: 'a' }) });
    expect(orderedSessions(state).map((s) => s.sessionId)).toEqual(['z', 'a']);
  });
});

// Sanity: EMPTY_TOKEN_TOTALS is re-exported by shared and usable in fixtures.
describe('shared fixtures smoke check', () => {
  it('EMPTY_TOKEN_TOTALS has zeroed fields', () => {
    expect(EMPTY_TOKEN_TOTALS).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0
    });
  });
});

describe('game-state messages', () => {
  function gameWithCompute(compute: number) {
    const game = initialGameState('2026-08-17T10:00:00.000Z');
    game.regions['/p/alpha'] = {
      id: '/p/alpha',
      name: 'alpha',
      foundedAt: '2026-08-17T10:00:00.000Z',
      status: 'idle' as const,
      infrastructure: {},
      window: { startMs: 0, outputTokens: 0 },
      turnAccrual: 0,
      incidents: [],
      lastIncidentAtMs: 0,
      totals: { compute, engineering: 0, research: 0, outputTokens: 0, incidents: 0 }
    };
    return game;
  }

  it('parses and stores pushed game state', () => {
    const game = gameWithCompute(100);
    const state = applyMessage(initialState, { type: 'game-state', game: game as never });
    expect(state.game).not.toBeNull();
    expect(state.game!.regions['/p/alpha']!.totals.compute).toBe(100);
  });

  it('ignores game payloads it cannot parse (version skew tolerance)', () => {
    const state = applyMessage(initialState, { type: 'game-state', game: { bogus: true } });
    expect(state.game).toBeNull();
  });

  it('tracks per-region compute deltas for the sparkline', () => {
    let state = applyMessage(initialState, { type: 'game-state', game: gameWithCompute(100) as never });
    state = applyMessage(state, { type: 'game-state', game: gameWithCompute(160) as never });
    state = applyMessage(state, { type: 'game-state', game: gameWithCompute(160) as never });
    expect(state.computeFlow['/p/alpha']).toEqual([0, 60, 0]);
  });
});
