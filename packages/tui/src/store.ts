import type { ServerMessage, SessionSnapshot } from '@ccidle/shared';
import { GameStateSchema, type GameState } from '@ccidle/game';

export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected';

/** How many compute samples the region sparkline keeps (one per game-state push). */
const SPARKLINE_SAMPLES = 60;

export interface AppState {
  connection: ConnectionStatus;
  autofocusPaused: boolean;
  tmuxAvailable: boolean;
  /** Sessions keyed by sessionId. */
  sessions: Record<string, SessionSnapshot>;
  /** First-seen order of session ids; gives the strip/queue their stable 1..9 indices. */
  sessionOrder: string[];
  /** Increments on every PostToolUse event, across all sessions. */
  ticks: number;
  /** Tool name from the most recent PostToolUse event. */
  lastTool?: string;
  /** FIFO needs-you queue as last reported by the daemon. */
  needsYouQueue: SessionSnapshot[];
  /** sessionId of the currently active needs-you alert, or null when clear. */
  activeAlertSessionId: string | null;
  /** Latest game state from the daemon (null until the first game-state push). */
  game: GameState | null;
  /** Recent per-push compute deltas, per region id, for the stage sparkline. */
  computeFlow: Record<string, number[]>;
}

export const initialState: AppState = {
  connection: 'connecting',
  autofocusPaused: false,
  tmuxAvailable: true,
  sessions: {},
  sessionOrder: [],
  ticks: 0,
  lastTool: undefined,
  needsYouQueue: [],
  activeAlertSessionId: null,
  game: null,
  computeFlow: {}
};

function upsertSession(state: AppState, session: SessionSnapshot): AppState {
  const isNew = !(session.sessionId in state.sessions);
  return {
    ...state,
    sessions: { ...state.sessions, [session.sessionId]: session },
    sessionOrder: isNew ? [...state.sessionOrder, session.sessionId] : state.sessionOrder
  };
}

function upsertSessions(state: AppState, sessions: SessionSnapshot[]): AppState {
  return sessions.reduce(upsertSession, state);
}

/**
 * Pure reducer over daemon messages. No I/O, no React — fully unit-testable.
 * Connection status is tracked separately (see `reduce`) since it's driven by
 * client-side socket events rather than protocol messages.
 */
export function applyMessage(state: AppState, message: ServerMessage): AppState {
  switch (message.type) {
    case 'hello': {
      const next: AppState = {
        ...state,
        connection: 'connected',
        autofocusPaused: message.autofocusPaused,
        tmuxAvailable: message.tmuxAvailable
      };
      return upsertSessions(next, message.sessions);
    }
    case 'status': {
      const next: AppState = {
        ...state,
        autofocusPaused: message.autofocusPaused,
        tmuxAvailable: message.tmuxAvailable
      };
      return upsertSessions(next, message.sessions);
    }
    case 'session-state': {
      return upsertSession(state, message.session);
    }
    case 'event': {
      if (message.envelope.event === 'PostToolUse') {
        return {
          ...state,
          ticks: state.ticks + 1,
          lastTool: message.envelope.tool ?? state.lastTool
        };
      }
      return state;
    }
    case 'alert': {
      const next = upsertSessions(state, message.queue);
      if (message.kind === 'needs-you') {
        return { ...next, needsYouQueue: message.queue, activeAlertSessionId: message.sessionId };
      }
      // 'clear': only drop the active alert if it's the one being cleared.
      const activeAlertSessionId =
        next.activeAlertSessionId === message.sessionId ? null : next.activeAlertSessionId;
      return { ...next, needsYouQueue: message.queue, activeAlertSessionId };
    }
    case 'game-state': {
      const parsed = GameStateSchema.safeParse(message.game);
      if (!parsed.success) return state; // daemon/tui version skew: ignore, never crash
      return {
        ...state,
        game: parsed.data,
        computeFlow: pushComputeFlow(state, parsed.data)
      };
    }
    default:
      return state;
  }
}

/** Append each region's compute delta since the previous push to its flow ring. */
function pushComputeFlow(state: AppState, game: GameState): Record<string, number[]> {
  const next: Record<string, number[]> = { ...state.computeFlow };
  for (const region of Object.values(game.regions)) {
    const previous = state.game?.regions[region.id]?.totals.compute ?? region.totals.compute;
    const delta = Math.max(0, region.totals.compute - previous);
    const ring = [...(next[region.id] ?? []), delta];
    next[region.id] = ring.slice(-SPARKLINE_SAMPLES);
  }
  return next;
}

export type AppAction =
  | { kind: 'server-message'; message: ServerMessage }
  | { kind: 'connection-status'; status: ConnectionStatus };

/** Top-level reducer used by the TUI: layers connection status onto `applyMessage`. */
export function reduce(state: AppState, action: AppAction): AppState {
  switch (action.kind) {
    case 'server-message':
      return applyMessage(state, action.message);
    case 'connection-status':
      return { ...state, connection: action.status };
    default:
      return state;
  }
}

/** Sessions in first-seen order, ready for 1..9 indexing in the strip and keybinds. */
export function orderedSessions(state: AppState): SessionSnapshot[] {
  const result: SessionSnapshot[] = [];
  for (const id of state.sessionOrder) {
    const session = state.sessions[id];
    if (session) result.push(session);
  }
  return result;
}
