import type { ServerMessage, SessionSnapshot } from '@ccidle/shared';

export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected';

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
  activeAlertSessionId: null
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
    default:
      return state;
  }
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
