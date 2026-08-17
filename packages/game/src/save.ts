import { loadSave, writeSave, type SaveMigration } from '@ccidle/shared';
import { GameStateSchema, initialGameState, type GameState } from './state.js';
import { z } from 'zod';

/**
 * Game save (mechanics PRD + infrastructure PRD Phase 2): the persisted unit
 * is the game state plus per-event-file cursors, so a daemon restart can
 * replay the JSONL streams without double-counting what the economy already
 * absorbed. Uses the shared versioned/atomic save-file abstraction.
 */

export const GAME_SAVE_VERSION = 1;

const GameSaveDataSchema = z.object({
  game: GameStateSchema,
  /** Events already applied per event-file basename. */
  cursors: z.record(z.number().nonnegative()).default({})
});
export type GameSaveData = z.infer<typeof GameSaveDataSchema>;

/** No migrations yet — the stub exists so v2 has somewhere to live. */
const MIGRATIONS: Record<number, SaveMigration> = {};

export function loadGameSave(filePath: string): GameSaveData | null {
  return loadSave<GameSaveData>({
    filePath,
    currentVersion: GAME_SAVE_VERSION,
    migrations: MIGRATIONS,
    decode: (data) => {
      const parsed = GameSaveDataSchema.safeParse(data);
      return parsed.success ? parsed.data : null;
    }
  });
}

export function writeGameSave(filePath: string, data: GameSaveData, nowIso?: string): void {
  writeSave(filePath, GAME_SAVE_VERSION, data, nowIso);
}

export function freshGameSave(nowIso: string): GameSaveData {
  return { game: initialGameState(nowIso), cursors: {} };
}

export type { GameState };
