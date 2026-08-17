import { PAYLOAD_MAX_BYTES, type EventEnvelope } from '@ccidle/shared';

/**
 * Pure transcript → event-stream synthesis for `ccidle import`
 * (docs/decisions.md §2–3). Consumes the JSONL content of one historical
 * Claude Code session transcript (plus optional subagent transcripts) and
 * emits envelopes byte-compatible with the live hook/daemon stream.
 *
 * Every field is treated defensively: transcripts are CC's own files across
 * many CC versions, so malformed or unknown lines are counted and skipped —
 * never fabricated, and never a reason to abort the file.
 */

interface RawUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

interface RawContentBlock {
  type?: string;
  id?: string;
  name?: string;
  input?: unknown;
  text?: string;
  tool_use_id?: string;
  is_error?: boolean;
}

interface RawTranscriptLine {
  type?: string;
  timestamp?: string;
  sessionId?: string;
  cwd?: string;
  uuid?: string;
  parentUuid?: string | null;
  requestId?: string;
  isSidechain?: boolean;
  isMeta?: boolean;
  version?: string;
  toolUseResult?: unknown;
  message?: {
    id?: string;
    model?: string;
    role?: string;
    usage?: RawUsage;
    content?: unknown;
  };
}

/** Line types that are CC bookkeeping, not conversation events. */
const METADATA_TYPES = new Set([
  'attachment',
  'queue-operation',
  'last-prompt',
  'summary',
  'system',
  'progress',
  'file-history-snapshot'
]);

export interface SynthesisStats {
  totalLines: number;
  malformedLines: number;
  metadataLines: number;
  events: number;
  /** Per-event counts, for the import summary. */
  byEvent: Record<string, number>;
}

export interface SynthesisResult {
  sessionId: string;
  envelopes: EventEnvelope[];
  stats: SynthesisStats;
  firstTs: string | null;
  lastTs: string | null;
}

export type Redactor = (value: string) => string;

/**
 * Compile config `log.redactPatterns` into a single string redactor
 * (the importer's equivalent of the hook shim's pre-write redact.sed pass).
 * Invalid regexes are skipped rather than failing the import.
 */
export function buildRedactor(patterns: string[]): Redactor {
  const regexes: RegExp[] = [];
  for (const pattern of patterns) {
    try {
      regexes.push(new RegExp(pattern, 'g'));
    } catch {
      // invalid pattern in user config — skip it, same spirit as loadConfig fallbacks
    }
  }
  if (regexes.length === 0) return (value) => value;
  return (value) => {
    let out = value;
    for (const re of regexes) out = out.replace(re, '[REDACTED]');
    return out;
  };
}

/** Apply the redactor to every string nested anywhere inside a payload value. */
function redactDeep(value: unknown, redact: Redactor): unknown {
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, redact));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactDeep(v, redact);
    }
    return out;
  }
  return value;
}

/** The hook shim's 4KB rule: oversized payloads collapse to {truncated, tool_name?}. */
function capPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const raw = JSON.stringify(payload);
  if (Buffer.byteLength(raw, 'utf8') <= PAYLOAD_MAX_BYTES) return payload;
  const capped: Record<string, unknown> = { truncated: true };
  if (typeof payload.tool_name === 'string') capped.tool_name = payload.tool_name;
  return capped;
}

function parseLine(raw: string): RawTranscriptLine | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  return parsed as RawTranscriptLine;
}

function contentBlocks(line: RawTranscriptLine): RawContentBlock[] {
  const content = line.message?.content;
  if (!Array.isArray(content)) return [];
  return content.filter((b): b is RawContentBlock => !!b && typeof b === 'object');
}

/** Extract prompt text from a real user line (string content or text blocks). */
function promptText(line: RawTranscriptLine): string | null {
  const content = line.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const texts = contentBlocks(line)
      .filter((b) => b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text as string);
    if (texts.length > 0) return texts.join('\n');
  }
  return null;
}

function isToolResultLine(line: RawTranscriptLine): boolean {
  if (line.toolUseResult !== undefined && line.toolUseResult !== null) return true;
  return contentBlocks(line).some((b) => b.type === 'tool_result');
}

interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

function usageTotals(usage: RawUsage): UsageTotals {
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);
  return {
    inputTokens: num(usage.input_tokens),
    outputTokens: num(usage.output_tokens),
    cacheReadTokens: num(usage.cache_read_input_tokens),
    cacheWriteTokens: num(usage.cache_creation_input_tokens)
  };
}

interface PendingEvent {
  seq: number;
  tsMs: number;
  envelope: EventEnvelope;
}

/** Internal mutable synthesis context shared between main and subagent passes. */
class Synth {
  readonly events: PendingEvent[] = [];
  readonly toolNames = new Map<string, string>(); // tool_use_id → name
  readonly seenUsageKeys = new Set<string>(); // message.id / requestId / uuid dedupe
  readonly stats: SynthesisStats = { totalLines: 0, malformedLines: 0, metadataLines: 0, events: 0, byEvent: {} };
  sessionId: string;
  firstTsMs = Number.POSITIVE_INFINITY;
  lastTsMs = Number.NEGATIVE_INFINITY;
  private seq = 0;

  constructor(
    fallbackSessionId: string,
    private readonly redact: Redactor
  ) {
    this.sessionId = fallbackSessionId;
  }

  push(tsMs: number, event: string, extra: { tool?: string; cwd?: string; payload?: Record<string, unknown> }): void {
    const payload = capPayload((redactDeep(extra.payload ?? {}, this.redact) as Record<string, unknown>) ?? {});
    const envelope: EventEnvelope = {
      v: 1,
      ts: new Date(tsMs).toISOString(),
      session_id: this.sessionId,
      event,
      ...(extra.tool ? { tool: extra.tool } : {}),
      ...(extra.cwd ? { cwd: extra.cwd } : {}),
      origin: 'import',
      payload
    };
    this.events.push({ seq: this.seq++, tsMs, envelope });
    this.stats.events += 1;
    this.stats.byEvent[event] = (this.stats.byEvent[event] ?? 0) + 1;
  }

  observeTs(tsMs: number): void {
    if (tsMs < this.firstTsMs) this.firstTsMs = tsMs;
    if (tsMs > this.lastTsMs) this.lastTsMs = tsMs;
  }
}

function lineTsMs(line: RawTranscriptLine): number | null {
  if (typeof line.timestamp !== 'string') return null;
  const parsed = Date.parse(line.timestamp);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Emit one TokenUsage envelope per unique API response. v2.1.x transcripts
 * repeat the same message.id + identical usage across one line per content
 * block (docs/decisions.md §2) — deduping by message.id (fallback requestId,
 * then line uuid) makes both streamed and legacy single-line layouts count
 * each response exactly once.
 */
function maybeEmitTokenUsage(synth: Synth, line: RawTranscriptLine, tsMs: number): void {
  const usage = line.message?.usage;
  const model = line.message?.model;
  if (!usage || typeof model !== 'string' || model === '') return;
  const key = line.message?.id ?? line.requestId ?? line.uuid;
  if (typeof key !== 'string' || key === '') return;
  if (synth.seenUsageKeys.has(key)) return;
  synth.seenUsageKeys.add(key);

  const totals = usageTotals(usage);
  if (totals.inputTokens + totals.outputTokens + totals.cacheReadTokens + totals.cacheWriteTokens === 0) return;
  synth.push(tsMs, 'TokenUsage', {
    cwd: typeof line.cwd === 'string' ? line.cwd : undefined,
    payload: { byModel: { [model]: totals } }
  });
}

function emitToolEvents(synth: Synth, line: RawTranscriptLine, tsMs: number): void {
  const cwd = typeof line.cwd === 'string' ? line.cwd : undefined;
  for (const block of contentBlocks(line)) {
    if (block.type === 'tool_use' && typeof block.name === 'string') {
      if (typeof block.id === 'string') synth.toolNames.set(block.id, block.name);
      synth.push(tsMs, 'PreToolUse', {
        tool: block.name,
        cwd,
        payload: { tool_name: block.name, ...(block.input !== undefined ? { tool_input: block.input } : {}) }
      });
    } else if (block.type === 'tool_result') {
      const toolName = typeof block.tool_use_id === 'string' ? synth.toolNames.get(block.tool_use_id) : undefined;
      synth.push(tsMs, 'PostToolUse', {
        tool: toolName,
        cwd,
        payload: {
          ...(toolName ? { tool_name: toolName } : {}),
          tool_response: { is_error: block.is_error === true }
        }
      });
    }
  }
}

/** Walk parentUuid links to the root of an inline sidechain chain. */
function sidechainRoot(uuid: string, byUuid: Map<string, RawTranscriptLine>): string {
  let current = uuid;
  const guard = new Set<string>();
  for (;;) {
    if (guard.has(current)) return current; // cycle — treat as its own root
    guard.add(current);
    const line = byUuid.get(current);
    const parent = line?.parentUuid;
    if (typeof parent !== 'string' || !byUuid.has(parent)) return current;
    current = parent;
  }
}

export interface SynthesizeOptions {
  /** Fallback session id when no line carries one (typically the filename stem). */
  fallbackSessionId: string;
  /** Contents of <session>/subagents/*.jsonl, in a deterministic (sorted) order. */
  subagentContents?: string[];
  redact?: Redactor;
}

/** Convert one historical session (main transcript + subagent sidecars) into envelopes. */
export function synthesizeSessionEvents(mainContent: string, options: SynthesizeOptions): SynthesisResult {
  const redact = options.redact ?? ((v: string) => v);
  const synth = new Synth(options.fallbackSessionId, redact);

  const mainLines: RawTranscriptLine[] = [];
  for (const raw of mainContent.split('\n')) {
    const trimmed = raw.trim();
    if (trimmed === '') continue;
    synth.stats.totalLines += 1;
    const line = parseLine(trimmed);
    if (!line) {
      synth.stats.malformedLines += 1;
      continue;
    }
    mainLines.push(line);
  }

  // Session id: first line that carries one wins (they all agree in practice).
  for (const line of mainLines) {
    if (typeof line.sessionId === 'string' && line.sessionId !== '') {
      synth.sessionId = line.sessionId;
      break;
    }
  }

  const sidechain = mainLines.filter((l) => l.isSidechain === true);
  let sessionCwd: string | undefined;
  let sessionVersion: string | undefined;

  // Track timestamps across every parseable line (metadata included) so
  // SessionStart/End span the whole recording.
  for (const line of mainLines) {
    const tsMs = lineTsMs(line);
    if (tsMs !== null) synth.observeTs(tsMs);
    if (!sessionCwd && typeof line.cwd === 'string' && line.cwd !== '') sessionCwd = line.cwd;
    if (!sessionVersion && typeof line.version === 'string') sessionVersion = line.version;
  }

  // ---- main-chain pass: prompts, tools, token usage, turn boundaries ----
  let lastAssistantTsMs: number | null = null;
  let sawAssistantThisTurn = false;

  for (const line of mainLines) {
    if (line.isSidechain === true) continue;
    const tsMs = lineTsMs(line);
    if (tsMs === null) continue;

    if (line.type === 'assistant') {
      emitToolEvents(synth, line, tsMs);
      maybeEmitTokenUsage(synth, line, tsMs);
      lastAssistantTsMs = tsMs;
      sawAssistantThisTurn = true;
    } else if (line.type === 'user') {
      if (isToolResultLine(line)) {
        emitToolEvents(synth, line, tsMs);
      } else if (line.isMeta !== true) {
        const prompt = promptText(line);
        if (prompt !== null) {
          // A new human turn ends the previous one: Stop at the last assistant ts.
          if (sawAssistantThisTurn && lastAssistantTsMs !== null) {
            synth.push(lastAssistantTsMs, 'Stop', { cwd: sessionCwd, payload: {} });
            sawAssistantThisTurn = false;
          }
          synth.push(tsMs, 'UserPromptSubmit', {
            cwd: typeof line.cwd === 'string' ? line.cwd : undefined,
            payload: { prompt }
          });
        }
      }
    } else if (line.type !== undefined && METADATA_TYPES.has(line.type)) {
      synth.stats.metadataLines += 1;
    } else if (line.type !== 'user' && line.type !== 'assistant') {
      // Unknown line type from a CC version we haven't seen — bookkeeping, not an event.
      synth.stats.metadataLines += 1;
    }
  }
  if (sawAssistantThisTurn && lastAssistantTsMs !== null) {
    synth.push(lastAssistantTsMs, 'Stop', { cwd: sessionCwd, payload: {} });
  }

  // ---- inline sidechains (older layout): tool events + usage + SubagentStop per chain ----
  if (sidechain.length > 0) {
    const byUuid = new Map<string, RawTranscriptLine>();
    for (const line of sidechain) {
      if (typeof line.uuid === 'string') byUuid.set(line.uuid, line);
    }
    const chains = new Map<string, { minTsMs: number; maxTsMs: number }>();
    for (const line of sidechain) {
      const tsMs = lineTsMs(line);
      if (tsMs === null) continue;
      if (line.type === 'assistant') {
        emitToolEvents(synth, line, tsMs);
        maybeEmitTokenUsage(synth, line, tsMs);
      } else if (line.type === 'user' && isToolResultLine(line)) {
        emitToolEvents(synth, line, tsMs);
      }
      const root = typeof line.uuid === 'string' ? sidechainRoot(line.uuid, byUuid) : 'unrooted';
      const chain = chains.get(root);
      if (!chain) {
        chains.set(root, { minTsMs: tsMs, maxTsMs: tsMs });
      } else {
        chain.minTsMs = Math.min(chain.minTsMs, tsMs);
        chain.maxTsMs = Math.max(chain.maxTsMs, tsMs);
      }
    }
    for (const root of [...chains.keys()].sort()) {
      const { minTsMs, maxTsMs } = chains.get(root)!;
      synth.push(maxTsMs, 'SubagentStop', {
        cwd: sessionCwd,
        payload: maxTsMs > minTsMs ? { duration_ms: maxTsMs - minTsMs } : {}
      });
    }
  }

  // ---- subagent sidecar files (current layout): one SubagentStop per file ----
  for (const content of options.subagentContents ?? []) {
    let minTsMs = Number.POSITIVE_INFINITY;
    let maxTsMs = Number.NEGATIVE_INFINITY;
    for (const raw of content.split('\n')) {
      const trimmed = raw.trim();
      if (trimmed === '') continue;
      synth.stats.totalLines += 1;
      const line = parseLine(trimmed);
      if (!line) {
        synth.stats.malformedLines += 1;
        continue;
      }
      const tsMs = lineTsMs(line);
      if (tsMs === null) continue;
      minTsMs = Math.min(minTsMs, tsMs);
      maxTsMs = Math.max(maxTsMs, tsMs);
      synth.observeTs(tsMs);
      if (line.type === 'assistant') {
        emitToolEvents(synth, line, tsMs);
        maybeEmitTokenUsage(synth, line, tsMs);
      } else if (line.type === 'user' && isToolResultLine(line)) {
        emitToolEvents(synth, line, tsMs);
      }
    }
    if (Number.isFinite(maxTsMs)) {
      synth.push(maxTsMs, 'SubagentStop', {
        cwd: sessionCwd,
        payload: maxTsMs > minTsMs ? { duration_ms: maxTsMs - minTsMs } : {}
      });
    }
  }

  // ---- session lifecycle bookends ----
  const hasSpan = Number.isFinite(synth.firstTsMs) && Number.isFinite(synth.lastTsMs);
  if (hasSpan) {
    synth.push(synth.firstTsMs, 'SessionStart', {
      cwd: sessionCwd,
      payload: { source: 'import', ...(sessionVersion ? { claude_code_version: sessionVersion } : {}) }
    });
    synth.push(synth.lastTsMs, 'SessionEnd', { cwd: sessionCwd, payload: { source: 'import' } });
  }

  // Deterministic timeline: sort by timestamp; synthesis order breaks ties,
  // except lifecycle bookends which pin to the very start/end of their instant.
  const rank = (e: PendingEvent): number =>
    e.envelope.event === 'SessionStart' ? -1 : e.envelope.event === 'SessionEnd' ? 1 : 0;
  const ordered = [...synth.events].sort((a, b) => a.tsMs - b.tsMs || rank(a) - rank(b) || a.seq - b.seq);

  return {
    sessionId: synth.sessionId,
    envelopes: ordered.map((e) => e.envelope),
    stats: synth.stats,
    firstTs: hasSpan ? new Date(synth.firstTsMs).toISOString() : null,
    lastTs: hasSpan ? new Date(synth.lastTsMs).toISOString() : null
  };
}
