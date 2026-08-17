import fs from 'node:fs';
import {
  applyInput,
  formatReplayReport,
  initialGameState,
  mergeTimelines,
  parseEventFile,
  replayEnvelopes,
  type GameState
} from '@ccidle/game';
import type { EventEnvelope } from '@ccidle/shared';

export interface ReplayOptions {
  files: string[];
  /** >0 replays paced by event timestamps ÷ speed; 0/undefined is instant. */
  speed?: number;
  /** Emit machine-readable stats instead of the human report. */
  json?: boolean;
  /** Suppress the live narration lines (report only). */
  quiet?: boolean;
  out?: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Cap per-gap waiting so an overnight pause in a recording doesn't stall the replay. */
const MAX_GAP_MS = 5_000;

/**
 * `ccidle replay <session.jsonl>` (infrastructure PRD Phase 2 + mechanics
 * PRD §5): run recorded event files through the game engine and print the
 * economy report, so balance.ts is tuned against real sessions.
 */
export async function runReplay(options: ReplayOptions): Promise<number> {
  const out = options.out ?? ((line: string) => console.log(line));
  const sleep = options.sleep ?? defaultSleep;

  const timelines: EventEnvelope[][] = [];
  for (const file of options.files) {
    let content: string;
    try {
      content = fs.readFileSync(file, 'utf8');
    } catch (error) {
      console.error(`ccidle replay: cannot read ${file}: ${(error as Error).message}`);
      return 1;
    }
    timelines.push(parseEventFile(content));
  }

  const envelopes = mergeTimelines(timelines);
  if (envelopes.length === 0) {
    console.error('ccidle replay: no parseable events in the given file(s)');
    return 1;
  }

  let state: GameState;
  if (options.speed && options.speed > 0) {
    state = await replayPaced(envelopes, options.speed, options.quiet ? undefined : out, sleep);
  } else {
    const result = replayEnvelopes(envelopes);
    state = result.state;
    if (!options.quiet) {
      for (const entry of result.narration) out(`${entry.ts}  ${entry.text}`);
    }
  }

  if (options.json) {
    out(
      JSON.stringify(
        { stats: state.stats, resources: state.resources, lab: state.lab, generation: state.generation },
        null,
        2
      )
    );
  } else {
    out('');
    out(formatReplayReport(state));
  }
  return 0;
}

async function replayPaced(
  envelopes: EventEnvelope[],
  speed: number,
  out: ((line: string) => void) | undefined,
  sleep: (ms: number) => Promise<void>
): Promise<GameState> {
  const firstTs = Date.parse(envelopes[0]!.ts);
  let state = initialGameState(new Date(Number.isFinite(firstTs) ? firstTs : 0).toISOString());
  let prevTs: number | null = null;

  for (const envelope of envelopes) {
    const ts = Date.parse(envelope.ts);
    if (prevTs !== null && Number.isFinite(ts) && ts > prevTs) {
      const wait = Math.min(MAX_GAP_MS, (ts - prevTs) / speed);
      if (wait > 1) await sleep(wait);
    }
    if (Number.isFinite(ts)) prevTs = ts;

    const result = applyInput(state, { kind: 'telemetry', envelope }, Number.isFinite(ts) ? ts : 0);
    state = result.state;
    if (out) {
      for (const entry of result.effects) out(`${entry.ts}  ${entry.text}`);
    }
  }
  return state;
}
