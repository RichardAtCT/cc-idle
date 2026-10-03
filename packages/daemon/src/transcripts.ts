import fs from 'node:fs';
import {
  serializeEvent,
  type EventEnvelope,
  type TokenUsagePayload
} from '@ccidle/shared';

interface RawUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

interface RawTranscriptLine {
  uuid?: string;
  requestId?: string;
  message?: {
    id?: string;
    usage?: RawUsage;
    model?: string;
  };
}

/**
 * Parse new transcript JSONL bytes (already sliced to just the new region)
 * into per-model usage deltas. Unreadable/malformed lines are skipped
 * silently — transcripts are CC's own file and not our schema to enforce.
 *
 * One API response is written as one line per content block, and every line
 * repeats the same usage. Each response is counted once, keyed by message.id
 * (fallback requestId, then line uuid). `seen` carries the keys across calls,
 * because a response's lines can straddle two polls.
 */
export function parseUsageDeltas(
  newContent: string,
  seen: Set<string> = new Set(),
  /** Receives each key this call adds to `seen`, in order. */
  added: string[] = []
): Record<string, TokenUsagePayload['byModel'][string]> {
  const byModel: Record<string, TokenUsagePayload['byModel'][string]> = {};
  for (const rawLine of newContent.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    let parsed: RawTranscriptLine;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const usage = parsed.message?.usage;
    const model = parsed.message?.model;
    if (!usage || !model) continue;
    const key = parsed.message?.id ?? parsed.requestId ?? parsed.uuid;
    if (typeof key === 'string' && key !== '') {
      if (seen.has(key)) continue;
      seen.add(key);
      added.push(key);
    }

    const delta = {
      inputTokens: usage.input_tokens ?? 0,
      outputTokens: usage.output_tokens ?? 0,
      cacheReadTokens: usage.cache_read_input_tokens ?? 0,
      cacheWriteTokens: usage.cache_creation_input_tokens ?? 0
    };
    if (
      delta.inputTokens === 0 &&
      delta.outputTokens === 0 &&
      delta.cacheReadTokens === 0 &&
      delta.cacheWriteTokens === 0
    ) {
      continue;
    }

    const existing = byModel[model];
    byModel[model] = existing
      ? {
          inputTokens: existing.inputTokens + delta.inputTokens,
          outputTokens: existing.outputTokens + delta.outputTokens,
          cacheReadTokens: existing.cacheReadTokens + delta.cacheReadTokens,
          cacheWriteTokens: existing.cacheWriteTokens + delta.cacheWriteTokens
        }
      : delta;
  }
  return byModel;
}

interface TrackedTranscript {
  path: string;
  offset: number;
  /** Usage keys already counted; see parseUsageDeltas. */
  seen: Set<string>;
  /** Key of the last response counted; written into TokenUsage so a restart can reseed `seen`. */
  lastKey?: string;
  /** A replayed TokenUsage predates offsets, so its usage was counted up to an unknown point. */
  countedWithoutOffset: boolean;
}

/**
 * Per-session token usage reader (PRD §4B). Tracks each session's
 * transcript_path + byte offset, tails new lines on demand, and appends a
 * synthetic TokenUsage envelope to the session's own event file so it flows
 * through the normal watcher path.
 */
export class TranscriptReader {
  private readonly tracked = new Map<string, TrackedTranscript>();
  private readonly lastPollAt = new Map<string, number>();

  /** Call whenever a hook payload reveals/updates a session's transcript_path. */
  setTranscriptPath(sessionId: string, transcriptPath: string): void {
    const existing = this.tracked.get(sessionId);
    if (existing && existing.path === transcriptPath) return;
    this.tracked.set(sessionId, { path: transcriptPath, offset: 0, seen: new Set(), countedWithoutOffset: false });
  }

  /**
   * Startup replay: a TokenUsage this reader wrote in an earlier run says how
   * far into the transcript it had counted. Continue from there, so usage
   * written while the daemon was down is counted once and nothing twice.
   */
  resume(sessionId: string, payload: TokenUsagePayload): void {
    const tracked = this.tracked.get(sessionId);
    if (!tracked) return;
    if (payload.transcriptOffset === undefined) {
      tracked.countedWithoutOffset = true;
      return;
    }
    if (payload.transcriptPath !== tracked.path) return;
    tracked.offset = payload.transcriptOffset;
    tracked.seen = new Set(payload.lastKey ? [payload.lastKey] : []);
    tracked.lastKey = payload.lastKey;
    tracked.countedWithoutOffset = false;
  }

  /**
   * End of startup replay. A session whose last TokenUsage was written before
   * TokenUsage carried offsets has had its usage counted up to some unknown
   * point, so skip to the transcript's current end rather than count it again.
   */
  finishReplay(): void {
    for (const tracked of this.tracked.values()) {
      if (!tracked.countedWithoutOffset) continue;
      try {
        tracked.offset = fs.statSync(tracked.path).size;
      } catch {
        // missing transcript: poll() tolerates it
      }
      tracked.countedWithoutOffset = false;
    }
  }

  hasTranscript(sessionId: string): boolean {
    return this.tracked.has(sessionId);
  }

  /** Throttle helper: has tokenPollMs elapsed since the last poll for this session? */
  shouldPoll(sessionId: string, nowMs: number, tokenPollMs: number): boolean {
    const last = this.lastPollAt.get(sessionId);
    return last === undefined || nowMs - last >= tokenPollMs;
  }

  markPolled(sessionId: string, nowMs: number): void {
    this.lastPollAt.set(sessionId, nowMs);
  }

  /**
   * Read whatever is new since the last check for this session and, if any
   * usage was found, append a synthetic TokenUsage envelope to
   * `eventFilePath`. Returns the envelope appended, or null if there was
   * nothing new (or the transcript is missing/unreadable — tolerated
   * silently per PRD §4B).
   */
  poll(sessionId: string, eventFilePath: string, nowIso: string): EventEnvelope | null {
    const tracked = this.tracked.get(sessionId);
    if (!tracked) return null;

    let size: number;
    try {
      size = fs.statSync(tracked.path).size;
    } catch {
      return null;
    }
    if (size <= tracked.offset) {
      if (size < tracked.offset) {
        // transcript rotated/truncated; restart
        tracked.offset = 0;
        tracked.seen.clear();
      }
      return null;
    }

    let content: string;
    try {
      const fd = fs.openSync(tracked.path, 'r');
      try {
        const length = size - tracked.offset;
        const buf = Buffer.alloc(length);
        fs.readSync(fd, buf, 0, length, tracked.offset);
        content = buf.toString('utf8');
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return null;
    }

    const lastNewline = content.lastIndexOf('\n');
    const usable = lastNewline === -1 ? '' : content.slice(0, lastNewline + 1);
    if (usable === '') return null;
    const nextOffset = tracked.offset + Buffer.byteLength(usable, 'utf8');

    const added: string[] = [];
    const byModel = parseUsageDeltas(usable, tracked.seen, added);
    if (Object.keys(byModel).length === 0) {
      tracked.offset = nextOffset;
      return null;
    }
    const lastKey = added.at(-1) ?? tracked.lastKey;

    const payload: TokenUsagePayload = { byModel, transcriptPath: tracked.path, transcriptOffset: nextOffset };
    if (lastKey !== undefined) payload.lastKey = lastKey;
    const envelope: EventEnvelope = {
      v: 1,
      ts: nowIso,
      session_id: sessionId,
      event: 'TokenUsage',
      payload
    };

    try {
      fs.appendFileSync(eventFilePath, serializeEvent(envelope));
    } catch {
      // Not recorded: leave offset and keys so the next poll counts this usage.
      for (const key of added) tracked.seen.delete(key);
      return null;
    }
    tracked.offset = nextOffset;
    tracked.lastKey = lastKey;
    return envelope;
  }

  forget(sessionId: string): void {
    this.tracked.delete(sessionId);
    this.lastPollAt.delete(sessionId);
  }
}
