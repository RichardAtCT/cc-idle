import { z } from 'zod';
import { EventEnvelopeSchema } from './events.js';
import { SessionSnapshotSchema } from './state.js';

/**
 * ndjson protocol on ~/.ccidle/ccidled.sock.
 * Every line is one JSON message; unknown message types must be ignored
 * (never crash) by both sides so daemon and TUI can be upgraded independently.
 */

// ---- daemon → client ----

export const HelloMessageSchema = z.object({
  type: z.literal('hello'),
  protocol: z.literal(1),
  daemonVersion: z.string(),
  autofocusPaused: z.boolean(),
  tmuxAvailable: z.boolean(),
  sessions: z.array(SessionSnapshotSchema)
});

export const SessionStateMessageSchema = z.object({
  type: z.literal('session-state'),
  session: SessionSnapshotSchema,
  /** Present when this message announces a transition (not a periodic refresh). */
  previousState: z.string().optional()
});

export const EventMessageSchema = z.object({
  type: z.literal('event'),
  envelope: EventEnvelopeSchema
});

export const StatusMessageSchema = z.object({
  type: z.literal('status'),
  autofocusPaused: z.boolean(),
  tmuxAvailable: z.boolean(),
  sessions: z.array(SessionSnapshotSchema)
});

/** Tells the TUI to raise/clear the needs-you alert (banner + bell). */
export const AlertMessageSchema = z.object({
  type: z.literal('alert'),
  kind: z.enum(['needs-you', 'clear']),
  sessionId: z.string(),
  /** FIFO needs-you queue, in service order; keybinds 1..9 map to indexes 0..8. */
  queue: z.array(SessionSnapshotSchema)
});

export const ServerMessageSchema = z.discriminatedUnion('type', [
  HelloMessageSchema,
  SessionStateMessageSchema,
  EventMessageSchema,
  StatusMessageSchema,
  AlertMessageSchema
]);
export type ServerMessage = z.infer<typeof ServerMessageSchema>;

// ---- client → daemon ----

export const CommandMessageSchema = z.object({
  type: z.literal('command'),
  command: z.enum(['pause-autofocus', 'resume-autofocus', 'status'])
});

/** Sent by `ccidle register` / launcher; the game pane is unique ("mission control"). */
export const RegisterMessageSchema = z.object({
  type: z.literal('register'),
  role: z.enum(['cc', 'game']),
  pane: z.string().optional(),
  cwd: z.string().optional(),
  sessionId: z.string().optional()
});

/** TUI asks the daemon to focus a specific CC session's pane (queue keybinds). */
export const FocusSessionMessageSchema = z.object({
  type: z.literal('focus-session'),
  sessionId: z.string()
});

export const ClientMessageSchema = z.discriminatedUnion('type', [
  CommandMessageSchema,
  RegisterMessageSchema,
  FocusSessionMessageSchema
]);
export type ClientMessage = z.infer<typeof ClientMessageSchema>;

// ---- helpers ----

export function parseServerMessage(line: string): ServerMessage | null {
  return parseLine(line, ServerMessageSchema);
}

export function parseClientMessage(line: string): ClientMessage | null {
  return parseLine(line, ClientMessageSchema);
}

function parseLine<T>(
  line: string,
  schema: { safeParse: (raw: unknown) => { success: boolean; data?: T } }
): T | null {
  const trimmed = line.trim();
  if (trimmed === '') return null;
  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    return null;
  }
  const result = schema.safeParse(raw);
  return result.success && result.data !== undefined ? result.data : null;
}

export function serializeMessage(message: ServerMessage | ClientMessage): string {
  return JSON.stringify(message) + '\n';
}
