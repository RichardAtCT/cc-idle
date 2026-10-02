import { GameStateSchema, applyInput, initialGameState, type GameInput, type GameState, type Narration } from './game.js';

/**
 * GameSync — one shared economy across every Claude Code session on the machine.
 *
 * Each session runs its own copy of the mod, and all of them share one
 * key-value store (`$.store`), whose get-then-set is not atomic. So the store
 * holds the game state and each session keeps a queue of the inputs it has
 * seen but not yet written. A flush re-reads the store, replays the queue on
 * top of whatever is there now (other sessions' work included) and writes the
 * result back. Only a write landing between that read and that write is lost,
 * and the engine is deterministic, so replaying an input on a newer base is
 * exactly what the daemon would have done had it seen the events in that order.
 */

export const SAVE_KEY = 'save';
export const SAVE_VERSION = 1;

/** The subset of `$.store` the sync needs; tests pass an in-memory map. */
export interface KeyValue {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
}

interface SaveRecord {
  v: typeof SAVE_VERSION;
  /** Who wrote it and when: changes on every write, so readers spot others' writes. */
  stamp: string;
  updatedAt: string;
  game: GameState;
}

interface Pending {
  input: GameInput;
  atMs: number;
}

export class GameSync {
  private base: GameState;
  private baseStamp: string | null = null;
  private pending: Pending[] = [];
  private view: GameState;
  private writes = 0;
  private chain: Promise<unknown> = Promise.resolve();
  /** Bumped whenever `state` changes, so a drawing knows to redraw. */
  version = 0;

  constructor(
    private readonly kv: KeyValue,
    private readonly writerId: string,
    private readonly now: () => number
  ) {
    this.base = initialGameState(new Date(now()).toISOString());
    this.view = this.base;
  }

  /** The economy as this session sees it: the last synced state plus its own queue. */
  get state(): GameState {
    return this.view;
  }

  get pendingCount(): number {
    return this.pending.length;
  }

  /** Apply an input locally at once (the pane updates now); it reaches the store on the next flush. */
  push(input: GameInput): Narration[] {
    const atMs = this.now();
    const result = applyInput(this.view, input, atMs);
    this.view = result.state;
    this.pending.push({ input, atMs });
    this.version += 1;
    return result.effects;
  }

  /** Write the queue onto the latest stored state. Serialized: overlapping calls run in turn. */
  flush(): Promise<void> {
    return this.serial(async () => {
      if (this.pending.length === 0) return;
      const saved = await this.read();
      let game = saved?.game ?? this.base;
      const batch = this.pending.slice();
      for (const { input, atMs } of batch) {
        game = applyInput(game, input, atMs).state;
      }
      this.writes += 1;
      const stamp = `${this.writerId}:${this.writes}:${this.now()}`;
      const record: SaveRecord = { v: SAVE_VERSION, stamp, updatedAt: new Date(this.now()).toISOString(), game };
      await this.kv.set(SAVE_KEY, record);
      this.pending.splice(0, batch.length);
      this.rebase(game, stamp);
    });
  }

  /**
   * Pick up other sessions' writes. With inputs queued this is a flush (which
   * reads first); otherwise it adopts the stored state if someone else wrote it.
   * Resolves true when `state` changed.
   */
  refresh(): Promise<boolean> {
    const before = this.version;
    if (this.pending.length > 0) return this.flush().then(() => this.version !== before);
    return this.serial(async () => {
      const saved = await this.read();
      if (saved && saved.stamp !== this.baseStamp) this.rebase(saved.game, saved.stamp);
      return this.version !== before;
    });
  }

  private rebase(game: GameState, stamp: string): void {
    this.base = game;
    this.baseStamp = stamp;
    let view = game;
    for (const { input, atMs } of this.pending) {
      view = applyInput(view, input, atMs).state;
    }
    this.view = view;
    this.version += 1;
  }

  /** The stored save, or null when absent or unreadable (the next flush replaces it). */
  private async read(): Promise<SaveRecord | null> {
    const raw = await this.kv.get(SAVE_KEY);
    if (!raw || typeof raw !== 'object') return null;
    const record = raw as Partial<SaveRecord>;
    if (record.v !== SAVE_VERSION || typeof record.stamp !== 'string') return null;
    const parsed = GameStateSchema.safeParse(record.game);
    if (!parsed.success) return null;
    return { v: SAVE_VERSION, stamp: record.stamp, updatedAt: String(record.updatedAt ?? ''), game: parsed.data };
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const run = this.chain.then(work, work);
    this.chain = run.catch(() => undefined);
    return run;
  }
}
