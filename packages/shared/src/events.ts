import { z } from 'zod';

/**
 * Known Claude Code hook event names, plus synthetic events emitted by the
 * daemon itself (TokenUsage). Unknown event names are preserved verbatim —
 * the envelope schema accepts any string so CC version drift never drops data.
 */
export const KNOWN_EVENTS = [
  'SessionStart',
  'SessionEnd',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'Stop',
  'SubagentStop',
  'Notification',
  'TokenUsage'
] as const;

export type KnownEvent = (typeof KNOWN_EVENTS)[number];

/**
 * Canonical envelope, v1. One JSON object per line in
 * ~/.ccidle/events/{session_id}.jsonl.
 */
export const EventEnvelopeSchema = z
  .object({
    v: z.literal(1),
    ts: z.string(), // ISO 8601
    session_id: z.string().min(1),
    event: z.string().min(1), // KnownEvent or a future CC event name — never dropped
    tool: z.string().optional(),
    cwd: z.string().optional(),
    /** $TMUX_PANE inherited by the hook shim; empty/absent outside tmux. */
    pane: z.string().optional(),
    /** Raw hook input, possibly truncated to PAYLOAD_MAX_BYTES before write. */
    payload: z.record(z.unknown()).default({})
  })
  .passthrough();

export type EventEnvelope = z.infer<typeof EventEnvelopeSchema>;

export const PAYLOAD_MAX_BYTES = 4096;

/**
 * Parse a single JSONL line into an envelope.
 * Returns null for blank lines, malformed JSON, or schema mismatches —
 * callers treat the stream as best-effort and never crash on bad lines.
 */
export function parseEventLine(line: string): EventEnvelope | null {
  const trimmed = line.trim();
  if (trimmed === '') return null;
  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    return null;
  }
  const result = EventEnvelopeSchema.safeParse(raw);
  return result.success ? result.data : null;
}

export function serializeEvent(envelope: EventEnvelope): string {
  return JSON.stringify(envelope) + '\n';
}

/** Payload of the synthetic TokenUsage event the daemon's transcript reader emits. */
export const TokenUsagePayloadSchema = z.object({
  /** Usage deltas since the previous TokenUsage emission, keyed by model id. */
  byModel: z.record(
    z.object({
      inputTokens: z.number().nonnegative(),
      outputTokens: z.number().nonnegative(),
      cacheReadTokens: z.number().nonnegative(),
      cacheWriteTokens: z.number().nonnegative()
    })
  )
});

export type TokenUsagePayload = z.infer<typeof TokenUsagePayloadSchema>;
