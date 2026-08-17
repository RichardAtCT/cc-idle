import {
  TokenUsagePayloadSchema,
  EMPTY_TOKEN_TOTALS,
  type EventEnvelope,
  type SessionSnapshot,
  type SessionState,
  type TokenTotals
} from '@ccidle/shared';

/**
 * Pure per-session state machine (PRD §3.3).
 *
 * | State         | Entered on                              | Exited on          |
 * |---------------|------------------------------------------|--------------------|
 * | HUMAN_ACTIVE  | Notification, Stop, SessionStart          | UserPromptSubmit   |
 * | CC_WORKING    | UserPromptSubmit                          | Stop, Notification |
 * | STALE         | no events for staleAfterMs in CC_WORKING  | any event          |
 * | DEAD          | SessionEnd, or 2x staleAfterMs of silence  | (terminal)         |
 *
 * SubagentStop and tool events (PreToolUse/PostToolUse) never cause a state
 * transition by themselves — they are telemetry only — but they *do* count
 * as activity: if the session was STALE, any such event brings it back to
 * CC_WORKING. The same default applies to the synthetic TokenUsage event and
 * to any event name this build doesn't know about yet (CC version drift,
 * PRD §7) so nothing is ever silently dropped.
 */

/** Transition target for an event name, independent of clocks/counters. */
export function reduce(state: SessionState, event: string): SessionState {
  switch (event) {
    case 'UserPromptSubmit':
      return 'CC_WORKING';
    case 'Stop':
    case 'Notification':
    case 'SessionStart':
      return 'HUMAN_ACTIVE';
    case 'SessionEnd':
      return 'DEAD';
    default:
      // SubagentStop, PreToolUse, PostToolUse, TokenUsage, and any unknown
      // event: no explicit transition, but activity exits STALE.
      return state === 'STALE' ? 'CC_WORKING' : state;
  }
}

/**
 * Clock-driven staleness check, independent of incoming events.
 * `lastEventTsMs` is the epoch-ms of the session's last observed event.
 * Only meaningful for CC_WORKING/STALE; other states are returned unchanged.
 */
export function checkStale(
  state: SessionState,
  lastEventTsMs: number,
  nowMs: number,
  staleAfterMs: number
): SessionState {
  if (state !== 'CC_WORKING' && state !== 'STALE') return state;
  const elapsed = nowMs - lastEventTsMs;
  if (elapsed >= staleAfterMs * 2) return 'DEAD';
  if (elapsed >= staleAfterMs) return 'STALE';
  return state;
}

/** A freshly-seen session, before any event has been applied. */
export function initSnapshot(sessionId: string, nowIso: string): SessionSnapshot {
  return {
    sessionId,
    state: 'HUMAN_ACTIVE',
    stateSince: nowIso,
    toolCallsThisTurn: 0,
    toolCallsTotal: 0,
    turns: 0,
    tokensByModel: {}
  };
}

function addTokens(a: TokenTotals, b: TokenTotals): TokenTotals {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens
  };
}

function mergeTokensByModel(
  current: Record<string, TokenTotals>,
  delta: Record<string, TokenTotals>
): Record<string, TokenTotals> {
  const next: Record<string, TokenTotals> = { ...current };
  for (const [model, d] of Object.entries(delta)) {
    next[model] = addTokens(next[model] ?? EMPTY_TOKEN_TOTALS, d);
  }
  return next;
}

function readString(payload: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = payload?.[key];
  return typeof value === 'string' ? value : undefined;
}

/**
 * Apply one envelope to a session snapshot, producing the next snapshot.
 * Pure: takes "now" as an ISO string so callers own the clock.
 */
export function applyEvent(snapshot: SessionSnapshot, envelope: EventEnvelope, nowIso: string): SessionSnapshot {
  const nextState = reduce(snapshot.state, envelope.event);
  const next: SessionSnapshot = { ...snapshot, state: nextState };

  if (nextState !== snapshot.state) next.stateSince = nowIso;
  next.lastEventTs = envelope.ts;
  if (envelope.cwd) next.cwd = envelope.cwd;
  if (envelope.pane) next.pane = envelope.pane;

  switch (envelope.event) {
    case 'UserPromptSubmit':
      next.turns = snapshot.turns + 1;
      next.toolCallsThisTurn = 0;
      break;
    case 'PostToolUse': {
      next.toolCallsThisTurn = snapshot.toolCallsThisTurn + 1;
      next.toolCallsTotal = snapshot.toolCallsTotal + 1;
      const tool = envelope.tool ?? readString(envelope.payload, 'tool_name');
      if (tool) next.lastTool = tool;
      break;
    }
    case 'SessionStart': {
      const model = readString(envelope.payload, 'model');
      if (model) next.model = model;
      break;
    }
    case 'TokenUsage': {
      const parsed = TokenUsagePayloadSchema.safeParse(envelope.payload);
      if (parsed.success) {
        next.tokensByModel = mergeTokensByModel(snapshot.tokensByModel, parsed.data.byModel);
      }
      break;
    }
    default:
      break;
  }

  return next;
}
