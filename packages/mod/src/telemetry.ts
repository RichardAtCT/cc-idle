import type { EventEnvelope } from '@ccidle/shared';

/**
 * Mod events → the v1 telemetry envelopes the game engine consumes.
 *
 * The shell shims wrote these to JSONL and the daemon replayed them; a mod
 * sees the same moments in-process, so it builds the identical envelopes and
 * the engine (and every replay/backtest tool built on it) stays unchanged.
 */

export interface SessionRef {
  sessionId: string;
  /** Project directory: one region per folder, as with the shell hooks. */
  cwd: string;
}

/** The token counts a mod's `turn.step` result reports (ModelUsage + model). */
export interface StepUsage {
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
}

function envelope(ref: SessionRef, event: string, nowMs: number, extra: Partial<EventEnvelope> = {}): EventEnvelope {
  return {
    v: 1,
    ts: new Date(nowMs).toISOString(),
    session_id: ref.sessionId,
    event,
    cwd: ref.cwd,
    payload: {},
    ...extra
  };
}

/** A main-loop turn begins (the shell hooks' UserPromptSubmit). */
export function promptSubmitted(ref: SessionRef, nowMs: number): EventEnvelope {
  return envelope(ref, 'UserPromptSubmit', nowMs);
}

/** A tool call finished; `isError` marks the failures that become incidents. */
export function toolFinished(ref: SessionRef, nowMs: number, tool: string, isError: boolean): EventEnvelope {
  return envelope(ref, 'PostToolUse', nowMs, {
    tool,
    payload: { tool_name: tool, tool_response: isError ? { is_error: true } : {} }
  });
}

/** One model request's usage, in the daemon's synthetic TokenUsage shape. */
export function tokensUsed(ref: SessionRef, nowMs: number, usage: StepUsage): EventEnvelope {
  return envelope(ref, 'TokenUsage', nowMs, {
    payload: {
      byModel: {
        [usage.model]: {
          inputTokens: usage.input_tokens,
          outputTokens: usage.output_tokens,
          cacheReadTokens: usage.cache_read_input_tokens,
          cacheWriteTokens: usage.cache_creation_input_tokens
        }
      }
    }
  });
}

/** A main-loop turn answered (Stop): the milestone with its completion bonus. */
export function turnStopped(ref: SessionRef, nowMs: number): EventEnvelope {
  return envelope(ref, 'Stop', nowMs);
}

/** A subagent's run finished (SubagentStop): a training run of that length. */
export function subagentStopped(ref: SessionRef, nowMs: number, durationMs: number): EventEnvelope {
  return envelope(ref, 'SubagentStop', nowMs, { payload: { duration_ms: durationMs } });
}

export function sessionEnded(ref: SessionRef, nowMs: number): EventEnvelope {
  return envelope(ref, 'SessionEnd', nowMs);
}
