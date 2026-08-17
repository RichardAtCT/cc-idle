import fs from 'node:fs';
import path from 'node:path';
import {
  isToolFailure,
  mergeTimelines,
  parseEventFile,
  replayEnvelopes
} from '@ccidle/game';
import {
  TokenUsagePayloadSchema,
  corpusDir as defaultCorpusDir,
  type EventEnvelope
} from '@ccidle/shared';

/**
 * `ccidle backtest` — batch-replay an imported corpus headless and emit a
 * telemetry/economy report (handoff §3). Uses only pure @ccidle/game
 * functions and local file reads: no daemon socket, no tmux, no TUI, no
 * focus side-effects, no wall clock — same corpus + same code ⇒ byte-identical
 * JSON. The BacktestSink interface is the forward-looking mechanics socket:
 * M1's economy simulator later plugs into this exact harness.
 */

export interface BacktestSink {
  readonly name: string;
  onEvent(envelope: EventEnvelope): void;
  summary(): unknown;
}

interface TokenTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

const zeroTokens = (): TokenTotals => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });

function addTokens(into: TokenTotals, from: TokenTotals): void {
  into.inputTokens += from.inputTokens;
  into.outputTokens += from.outputTokens;
  into.cacheReadTokens += from.cacheReadTokens;
  into.cacheWriteTokens += from.cacheWriteTokens;
}

interface SessionAgg {
  sessionId: string;
  project: string;
  events: number;
  turns: number;
  toolCalls: number;
  toolFailures: number;
  subagentStops: number;
  tokens: TokenTotals;
  firstTsMs: number;
  lastTsMs: number;
}

interface ProjectAgg {
  project: string;
  name: string;
  sessions: Set<string>;
  events: number;
  turns: number;
  toolCalls: number;
  toolCallsByTool: Record<string, number>;
  toolFailures: number;
  subagentStops: number;
  tokensByModel: Record<string, TokenTotals>;
}

const UNKNOWN_PROJECT = '(unknown)';

/**
 * First BacktestSink implementation: the telemetry aggregation behind the
 * corpus report. Pure accumulation — no I/O, no clock.
 */
export class TelemetrySink implements BacktestSink {
  readonly name = 'telemetry';
  private readonly sessions = new Map<string, SessionAgg>();
  private readonly projects = new Map<string, ProjectAgg>();
  private readonly eventsByHourUtc: number[] = new Array(24).fill(0) as number[];
  private readonly tokensByDay = new Map<string, { inputTokens: number; outputTokens: number }>();
  private readonly byEvent: Record<string, number> = {};
  private events = 0;
  private firstTsMs = Number.POSITIVE_INFINITY;
  private lastTsMs = Number.NEGATIVE_INFINITY;

  onEvent(envelope: EventEnvelope): void {
    const tsMs = Date.parse(envelope.ts);
    const hasTs = Number.isFinite(tsMs);
    this.events += 1;
    this.byEvent[envelope.event] = (this.byEvent[envelope.event] ?? 0) + 1;
    if (hasTs) {
      this.firstTsMs = Math.min(this.firstTsMs, tsMs);
      this.lastTsMs = Math.max(this.lastTsMs, tsMs);
      const hour = new Date(tsMs).getUTCHours();
      this.eventsByHourUtc[hour] = (this.eventsByHourUtc[hour] ?? 0) + 1;
    }

    const session = this.session(envelope.session_id);
    if (session.project === UNKNOWN_PROJECT && envelope.cwd) session.project = envelope.cwd;
    session.events += 1;
    if (hasTs) {
      session.firstTsMs = Math.min(session.firstTsMs, tsMs);
      session.lastTsMs = Math.max(session.lastTsMs, tsMs);
    }
    const project = this.project(session.project);
    project.sessions.add(session.sessionId);
    project.events += 1;

    switch (envelope.event) {
      case 'UserPromptSubmit':
        session.turns += 1;
        project.turns += 1;
        break;
      case 'PostToolUse': {
        const tool =
          envelope.tool ??
          (typeof envelope.payload?.tool_name === 'string' ? (envelope.payload.tool_name as string) : '(unknown)');
        session.toolCalls += 1;
        project.toolCalls += 1;
        project.toolCallsByTool[tool] = (project.toolCallsByTool[tool] ?? 0) + 1;
        if (isToolFailure(envelope.payload)) {
          session.toolFailures += 1;
          project.toolFailures += 1;
        }
        break;
      }
      case 'SubagentStop':
        session.subagentStops += 1;
        project.subagentStops += 1;
        break;
      case 'TokenUsage': {
        const parsed = TokenUsagePayloadSchema.safeParse(envelope.payload);
        if (!parsed.success) break;
        for (const [model, totals] of Object.entries(parsed.data.byModel)) {
          addTokens(session.tokens, totals);
          addTokens((project.tokensByModel[model] ??= zeroTokens()), totals);
          if (hasTs) {
            const day = new Date(tsMs).toISOString().slice(0, 10);
            const dayAgg = this.tokensByDay.get(day) ?? { inputTokens: 0, outputTokens: 0 };
            dayAgg.inputTokens += totals.inputTokens;
            dayAgg.outputTokens += totals.outputTokens;
            this.tokensByDay.set(day, dayAgg);
          }
        }
        break;
      }
      default:
        break;
    }
  }

  private session(sessionId: string): SessionAgg {
    let agg = this.sessions.get(sessionId);
    if (!agg) {
      agg = {
        sessionId,
        project: UNKNOWN_PROJECT,
        events: 0,
        turns: 0,
        toolCalls: 0,
        toolFailures: 0,
        subagentStops: 0,
        tokens: zeroTokens(),
        firstTsMs: Number.POSITIVE_INFINITY,
        lastTsMs: Number.NEGATIVE_INFINITY
      };
      this.sessions.set(sessionId, agg);
    }
    return agg;
  }

  private project(projectId: string): ProjectAgg {
    let agg = this.projects.get(projectId);
    if (!agg) {
      const trimmed = projectId.replace(/\/+$/, '');
      const idx = trimmed.lastIndexOf('/');
      agg = {
        project: projectId,
        name: projectId === UNKNOWN_PROJECT ? UNKNOWN_PROJECT : idx >= 0 ? trimmed.slice(idx + 1) : trimmed,
        sessions: new Set(),
        events: 0,
        turns: 0,
        toolCalls: 0,
        toolCallsByTool: {},
        toolFailures: 0,
        subagentStops: 0,
        tokensByModel: {}
      };
      this.projects.set(projectId, agg);
    }
    return agg;
  }

  summary(): TelemetrySummary {
    const sessions = [...this.sessions.values()].sort((a, b) => a.sessionId.localeCompare(b.sessionId));
    const projects = [...this.projects.values()].sort((a, b) => a.project.localeCompare(b.project));

    const totals = {
      events: this.events,
      byEvent: sortRecord(this.byEvent),
      turns: 0,
      toolCalls: 0,
      toolFailures: 0,
      subagentStops: 0,
      tokensByModel: {} as Record<string, TokenTotals>,
      tokens: zeroTokens()
    };
    for (const p of projects) {
      totals.turns += p.turns;
      totals.toolCalls += p.toolCalls;
      totals.toolFailures += p.toolFailures;
      totals.subagentStops += p.subagentStops;
      for (const [model, t] of Object.entries(p.tokensByModel)) {
        addTokens((totals.tokensByModel[model] ??= zeroTokens()), t);
        addTokens(totals.tokens, t);
      }
    }
    totals.tokensByModel = sortRecord(totals.tokensByModel);

    const hasSpan = Number.isFinite(this.firstTsMs) && Number.isFinite(this.lastTsMs);
    const DAY_MS = 86_400_000;
    const spanDays = hasSpan ? Math.floor(this.lastTsMs / DAY_MS) - Math.floor(this.firstTsMs / DAY_MS) + 1 : 0;

    const topSessions = [...sessions]
      .sort(
        (a, b) =>
          b.tokens.outputTokens - a.tokens.outputTokens ||
          b.events - a.events ||
          a.sessionId.localeCompare(b.sessionId)
      )
      .slice(0, 5)
      .map((s) => ({
        sessionId: s.sessionId,
        project: s.project,
        events: s.events,
        turns: s.turns,
        toolCalls: s.toolCalls,
        outputTokens: s.tokens.outputTokens,
        totalTokens: s.tokens.inputTokens + s.tokens.outputTokens + s.tokens.cacheReadTokens + s.tokens.cacheWriteTokens,
        firstEvent: Number.isFinite(s.firstTsMs) ? new Date(s.firstTsMs).toISOString() : null,
        lastEvent: Number.isFinite(s.lastTsMs) ? new Date(s.lastTsMs).toISOString() : null
      }));

    return {
      corpus: {
        sessions: sessions.length,
        events: this.events,
        firstEvent: hasSpan ? new Date(this.firstTsMs).toISOString() : null,
        lastEvent: hasSpan ? new Date(this.lastTsMs).toISOString() : null,
        spanDays
      },
      totals,
      projects: Object.fromEntries(
        projects.map((p) => [
          p.project,
          {
            name: p.name,
            sessions: p.sessions.size,
            events: p.events,
            turns: p.turns,
            toolCalls: p.toolCalls,
            toolCallsByTool: sortRecord(p.toolCallsByTool),
            toolFailures: p.toolFailures,
            toolSuccessRatio: p.toolCalls > 0 ? round4((p.toolCalls - p.toolFailures) / p.toolCalls) : null,
            subagentStops: p.subagentStops,
            tokensByModel: sortRecord(p.tokensByModel)
          }
        ])
      ),
      histograms: {
        eventsByHourUtc: [...this.eventsByHourUtc],
        tokensByDay: Object.fromEntries([...this.tokensByDay.entries()].sort(([a], [b]) => a.localeCompare(b)))
      },
      topSessions
    };
  }
}

function sortRecord<T>(record: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)));
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

export interface TelemetrySummary {
  corpus: {
    sessions: number;
    events: number;
    firstEvent: string | null;
    lastEvent: string | null;
    spanDays: number;
  };
  totals: {
    events: number;
    byEvent: Record<string, number>;
    turns: number;
    toolCalls: number;
    toolFailures: number;
    subagentStops: number;
    tokensByModel: Record<string, TokenTotals>;
    tokens: TokenTotals;
  };
  projects: Record<
    string,
    {
      name: string;
      sessions: number;
      events: number;
      turns: number;
      toolCalls: number;
      toolCallsByTool: Record<string, number>;
      toolFailures: number;
      toolSuccessRatio: number | null;
      subagentStops: number;
      tokensByModel: Record<string, TokenTotals>;
    }
  >;
  histograms: {
    eventsByHourUtc: number[];
    tokensByDay: Record<string, { inputTokens: number; outputTokens: number }>;
  };
  topSessions: Array<{
    sessionId: string;
    project: string;
    events: number;
    turns: number;
    toolCalls: number;
    outputTokens: number;
    totalTokens: number;
    firstEvent: string | null;
    lastEvent: string | null;
  }>;
}

/** Known gaps of imported corpora, stated on every report (handoff §2). */
export const IMPORT_GAPS: readonly string[] = [
  'Notification events (permission prompts / idle alerts) leave no transcript trace and are not reconstructed — no HUMAN_ACTIVE signal exists in imported data.',
  'tmux pane fields are runtime-only and absent from imported envelopes.',
  'Stop timing is approximated by the last assistant message of each turn.',
  'Estimated cost is omitted: the repo has no model price table.'
];

export interface BacktestOptions {
  /** Explicit event files; default is every *.jsonl in the corpus dir. */
  files?: string[];
  corpusDir?: string;
  /** Print the JSON report instead of markdown. */
  json?: boolean;
  /** Also write the markdown report to this path. */
  mdOut?: string;
  /** Also write the JSON report to this path. */
  jsonOut?: string;
  extraSinks?: BacktestSink[];
  env?: NodeJS.ProcessEnv;
  out?: (line: string) => void;
}

export interface BacktestReport {
  telemetry: TelemetrySummary;
  economy: {
    stats: unknown;
    resources: unknown;
    generation: unknown;
  };
  sinks: Record<string, unknown>;
  gaps: string[];
}

function corpusFiles(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.jsonl'))
      .sort()
      .map((f) => path.join(dir, f));
  } catch {
    return [];
  }
}

export async function runBacktest(options: BacktestOptions = {}): Promise<number> {
  const out = options.out ?? ((line: string) => console.log(line));
  const env = options.env ?? process.env;
  const dir = options.corpusDir ?? defaultCorpusDir(env);
  const files = options.files && options.files.length > 0 ? options.files : corpusFiles(dir);
  if (files.length === 0) {
    console.error(`ccidle backtest: no event files (looked in ${dir}; run 'ccidle import' first)`);
    return 1;
  }

  const timelines: EventEnvelope[][] = [];
  for (const file of files) {
    let content: string;
    try {
      content = fs.readFileSync(file, 'utf8');
    } catch (error) {
      console.error(`ccidle backtest: cannot read ${file}: ${(error as Error).message}`);
      return 1;
    }
    timelines.push(parseEventFile(content));
  }

  const envelopes = mergeTimelines(timelines);
  if (envelopes.length === 0) {
    console.error('ccidle backtest: no parseable events in the corpus');
    return 1;
  }

  const telemetry = new TelemetrySink();
  const sinks: BacktestSink[] = [telemetry, ...(options.extraSinks ?? [])];
  for (const envelope of envelopes) {
    for (const sink of sinks) sink.onEvent(envelope);
  }

  // The existing replay path, at max speed: a single pure engine pass.
  const { state } = replayEnvelopes(envelopes);

  const report: BacktestReport = {
    telemetry: telemetry.summary(),
    economy: { stats: state.stats, resources: state.resources, generation: state.generation },
    sinks: Object.fromEntries(options.extraSinks?.map((s) => [s.name, s.summary()]) ?? []),
    gaps: [...IMPORT_GAPS]
  };

  const jsonText = JSON.stringify(report, null, 2) + '\n';
  const mdText = formatBacktestMarkdown(report, files.length);

  if (options.jsonOut) fs.writeFileSync(options.jsonOut, jsonText);
  if (options.mdOut) fs.writeFileSync(options.mdOut, mdText);

  if (options.json) {
    out(jsonText.trimEnd());
  } else {
    out(mdText.trimEnd());
  }
  return 0;
}

function formatTokens(t: TokenTotals): string {
  return `in ${t.inputTokens.toLocaleString('en-US')} · out ${t.outputTokens.toLocaleString('en-US')} · cache-r ${t.cacheReadTokens.toLocaleString('en-US')} · cache-w ${t.cacheWriteTokens.toLocaleString('en-US')}`;
}

export function formatBacktestMarkdown(report: BacktestReport, fileCount: number): string {
  const t = report.telemetry;
  const lines: string[] = [];
  lines.push('# CC Idle backtest report');
  lines.push('');
  lines.push('## Corpus');
  lines.push('');
  lines.push(`- Event files replayed: ${fileCount}`);
  lines.push(`- Sessions: ${t.corpus.sessions}`);
  lines.push(`- Events: ${t.corpus.events}`);
  lines.push(`- Span: ${t.corpus.firstEvent ?? 'n/a'} → ${t.corpus.lastEvent ?? 'n/a'} (${t.corpus.spanDays} day(s))`);
  lines.push('');
  lines.push('## Totals');
  lines.push('');
  lines.push(`- Turns (UserPromptSubmit): ${t.totals.turns}`);
  const okCalls = t.totals.toolCalls - t.totals.toolFailures;
  const ratio = t.totals.toolCalls > 0 ? ` (${((okCalls / t.totals.toolCalls) * 100).toFixed(1)}% ok)` : '';
  lines.push(`- Tool calls: ${t.totals.toolCalls} — ${okCalls} ok / ${t.totals.toolFailures} failed${ratio}`);
  lines.push(`- Subagent completions: ${t.totals.subagentStops}`);
  lines.push(`- Tokens: ${formatTokens(t.totals.tokens)}`);
  lines.push('');
  lines.push('| Model | Input | Output | Cache read | Cache write |');
  lines.push('|---|---:|---:|---:|---:|');
  for (const [model, tok] of Object.entries(t.totals.tokensByModel)) {
    lines.push(
      `| ${model} | ${tok.inputTokens.toLocaleString('en-US')} | ${tok.outputTokens.toLocaleString('en-US')} | ${tok.cacheReadTokens.toLocaleString('en-US')} | ${tok.cacheWriteTokens.toLocaleString('en-US')} |`
    );
  }
  lines.push('');
  lines.push('## Projects (regions)');
  lines.push('');
  lines.push('| Project | Sessions | Turns | Tool calls | Failures | Subagents | Output tokens |');
  lines.push('|---|---:|---:|---:|---:|---:|---:|');
  for (const [id, p] of Object.entries(t.projects)) {
    const output = Object.values(p.tokensByModel).reduce((sum, tok) => sum + tok.outputTokens, 0);
    lines.push(
      `| ${p.name === id ? id : `${p.name} (\`${id}\`)`} | ${p.sessions} | ${p.turns} | ${p.toolCalls} | ${p.toolFailures} | ${p.subagentStops} | ${output.toLocaleString('en-US')} |`
    );
  }
  lines.push('');
  lines.push('### Tool calls by type');
  lines.push('');
  const toolTotals: Record<string, number> = {};
  for (const p of Object.values(t.projects)) {
    for (const [tool, n] of Object.entries(p.toolCallsByTool)) toolTotals[tool] = (toolTotals[tool] ?? 0) + n;
  }
  lines.push('| Tool | Calls |');
  lines.push('|---|---:|');
  for (const [tool, n] of Object.entries(toolTotals).sort(([, a], [, b]) => b - a || 0)) {
    lines.push(`| ${tool} | ${n} |`);
  }
  lines.push('');
  lines.push('## Activity histograms');
  lines.push('');
  lines.push('### Events by hour of day (UTC)');
  lines.push('');
  lines.push('```');
  const maxHour = Math.max(1, ...t.histograms.eventsByHourUtc);
  t.histograms.eventsByHourUtc.forEach((n, hour) => {
    const bar = '█'.repeat(Math.round((n / maxHour) * 40));
    lines.push(`${String(hour).padStart(2, '0')}:00 ${String(n).padStart(6)} ${bar}`);
  });
  lines.push('```');
  lines.push('');
  lines.push('### Tokens by day');
  lines.push('');
  lines.push('| Day | Input | Output |');
  lines.push('|---|---:|---:|');
  for (const [day, tok] of Object.entries(t.histograms.tokensByDay)) {
    lines.push(`| ${day} | ${tok.inputTokens.toLocaleString('en-US')} | ${tok.outputTokens.toLocaleString('en-US')} |`);
  }
  lines.push('');
  lines.push('## Top 5 heaviest sessions (by output tokens)');
  lines.push('');
  lines.push('| Session | Project | Events | Turns | Tool calls | Output tokens | Total tokens |');
  lines.push('|---|---|---:|---:|---:|---:|---:|');
  for (const s of t.topSessions) {
    lines.push(
      `| \`${s.sessionId}\` | ${s.project} | ${s.events} | ${s.turns} | ${s.toolCalls} | ${s.outputTokens.toLocaleString('en-US')} | ${s.totalTokens.toLocaleString('en-US')} |`
    );
  }
  lines.push('');
  lines.push('## Economy (game engine replay)');
  lines.push('');
  lines.push('```json');
  lines.push(JSON.stringify(report.economy.stats, null, 2));
  lines.push('```');
  lines.push('');
  lines.push('## Known gaps in imported data');
  lines.push('');
  for (const gap of report.gaps) lines.push(`- ${gap}`);
  lines.push('');
  return lines.join('\n');
}
