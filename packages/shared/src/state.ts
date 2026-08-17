import { z } from 'zod';

/**
 * Per-session state machine states (PRD §3.3).
 *
 * HUMAN_ACTIVE — CC needs or has the human (Notification, Stop, session start)
 * CC_WORKING   — CC is working autonomously (UserPromptSubmit)
 * STALE        — no events for staleAfterMs while CC_WORKING
 * DEAD         — no events for 2× staleAfterMs; session presumed gone
 */
export const SESSION_STATES = ['HUMAN_ACTIVE', 'CC_WORKING', 'STALE', 'DEAD'] as const;
export type SessionState = (typeof SESSION_STATES)[number];

export const TokenTotalsSchema = z.object({
  inputTokens: z.number().nonnegative(),
  outputTokens: z.number().nonnegative(),
  cacheReadTokens: z.number().nonnegative(),
  cacheWriteTokens: z.number().nonnegative()
});
export type TokenTotals = z.infer<typeof TokenTotalsSchema>;

export const EMPTY_TOKEN_TOTALS: TokenTotals = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0
};

/** Snapshot of one tracked CC session, pushed to TUIs over the socket. */
export const SessionSnapshotSchema = z.object({
  sessionId: z.string(),
  state: z.enum(SESSION_STATES),
  /** ISO timestamp of when the current state was entered. */
  stateSince: z.string(),
  cwd: z.string().optional(),
  /** tmux pane id (e.g. "%3") if known. */
  pane: z.string().optional(),
  /** Full tmux target "session:window.pane" if resolvable. */
  paneTarget: z.string().optional(),
  toolCallsThisTurn: z.number().nonnegative(),
  toolCallsTotal: z.number().nonnegative(),
  turns: z.number().nonnegative(),
  lastEventTs: z.string().optional(),
  lastTool: z.string().optional(),
  model: z.string().optional(),
  tokensByModel: z.record(TokenTotalsSchema).default({})
});
export type SessionSnapshot = z.infer<typeof SessionSnapshotSchema>;
