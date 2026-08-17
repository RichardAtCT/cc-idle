import fs from 'node:fs';
import type { EventEnvelope, SessionState } from '@ccidle/shared';
import {
  GameActionSchema,
  applyInput,
  freshGameSave,
  loadGameSave,
  writeGameSave,
  type GameSaveData,
  type GameState
} from '@ccidle/game';

export interface GameHostLogger {
  info: (msg: string) => void;
  warn: (msg: string) => void;
}

export interface GameHostOptions {
  savePath: string;
  /** Called with the new state after every applied input (throttling is the caller's concern). */
  broadcast: (game: GameState) => void;
  logger?: GameHostLogger;
  clock?: () => number;
  /** Autosave cadence; 0 disables the timer (tests). */
  autosaveMs?: number;
}

const DEFAULT_AUTOSAVE_MS = 15_000;

/**
 * GameHost — the daemon-side shell around the pure @ccidle/game engine.
 *
 * Owns everything the engine deliberately doesn't: the save file, the wall
 * clock, and replay dedup. The daemon's watcher re-reads every event file
 * from byte 0 on startup; the save carries a per-file cursor of how many
 * events the economy has already absorbed, so restarts skip exactly that
 * prefix and anything appended while the daemon was down still counts —
 * it's real work, just processed late.
 */
export class GameHost {
  private save: GameSaveData;
  /** Events observed per file basename during THIS process run. */
  private readonly seen = new Map<string, number>();
  private dirty = false;
  private autosaveTimer: NodeJS.Timeout | null = null;
  private readonly clock: () => number;

  constructor(private readonly options: GameHostOptions) {
    this.clock = options.clock ?? Date.now;
    const loaded = loadGameSave(options.savePath);
    if (loaded) {
      this.save = loaded;
      options.logger?.info(`game save loaded from ${options.savePath}`);
    } else {
      this.save = freshGameSave(new Date(this.clock()).toISOString());
      options.logger?.info('game save missing or unreadable — starting a fresh economy');
    }
    this.pruneCursors();
    const autosaveMs = options.autosaveMs ?? DEFAULT_AUTOSAVE_MS;
    if (autosaveMs > 0) {
      this.autosaveTimer = setInterval(() => this.persist(false), autosaveMs);
      this.autosaveTimer.unref?.();
    }
  }

  /** Drop cursors for event files that no longer exist (retention pruning). */
  private pruneCursors(): void {
    for (const key of Object.keys(this.save.cursors)) {
      if (!fs.existsSync(key)) delete this.save.cursors[key];
    }
  }

  state(): GameState {
    return this.save.game;
  }

  /**
   * Feed one watcher envelope. Applies it only if this file's event ordinal
   * is beyond the persisted cursor (startup replay dedup).
   */
  handleEnvelope(envelope: EventEnvelope, filePath: string): void {
    const ordinal = (this.seen.get(filePath) ?? 0) + 1;
    this.seen.set(filePath, ordinal);
    const cursor = this.save.cursors[filePath] ?? 0;
    if (ordinal <= cursor) return; // already absorbed in a previous run

    this.save.cursors[filePath] = ordinal;
    this.apply({ kind: 'telemetry' as const, envelope });
  }

  /** The file was truncated/rotated: its event ordinals restart from zero. */
  handleFileReset(filePath: string): void {
    this.seen.set(filePath, 0);
    this.save.cursors[filePath] = 0;
    this.dirty = true;
  }

  handleStateChange(sessionId: string, state: SessionState): void {
    this.apply({ kind: 'session-state' as const, sessionId, state });
  }

  /** A game-action message from the TUI; malformed actions are ignored. */
  handleAction(raw: unknown): void {
    const parsed = GameActionSchema.safeParse(raw);
    if (!parsed.success) {
      this.options.logger?.warn('ignoring malformed game action');
      return;
    }
    this.apply({ kind: 'action' as const, action: parsed.data });
    this.persist(false); // player decisions are rare and worth saving eagerly
  }

  private apply(input: Parameters<typeof applyInput>[1]): void {
    const result = applyInput(this.save.game, input, this.clock());
    this.save.game = result.state;
    this.dirty = true;
    this.options.broadcast(result.state);
  }

  /** Write the save if dirty. With force=true, write unconditionally. */
  persist(force: boolean): void {
    if (!this.dirty && !force) return;
    try {
      writeGameSave(this.options.savePath, this.save, new Date(this.clock()).toISOString());
      this.dirty = false;
    } catch (error) {
      this.options.logger?.warn(`game save failed: ${(error as Error).message}`);
    }
  }

  stop(): void {
    if (this.autosaveTimer) {
      clearInterval(this.autosaveTimer);
      this.autosaveTimer = null;
    }
    this.persist(false);
  }
}
