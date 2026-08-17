import fs from 'node:fs';
import path from 'node:path';

/**
 * Save-file abstraction (infrastructure PRD Phase 2): versioned JSON with
 * atomic writes (tmp + rename) and a migration registry so future schema
 * changes can upgrade old saves in place instead of discarding them.
 */
export interface SaveEnvelope<T> {
  v: number;
  savedAt: string;
  data: T;
}

/** Upgrades a save's `data` from version `k` to `k + 1`. */
export type SaveMigration = (data: unknown) => unknown;

export interface SaveFileOptions<T> {
  filePath: string;
  /** Version this build writes. Loads at higher versions are rejected (null). */
  currentVersion: number;
  /** Validates/decodes migrated data; return null to reject a corrupt save. */
  decode: (data: unknown) => T | null;
  /** Keyed by from-version: migrations[2] upgrades v2 data to v3 data. */
  migrations?: Record<number, SaveMigration>;
}

/**
 * Load a save file. Returns null (never throws) for a missing file, malformed
 * JSON, a version newer than this build, a missing migration step, or data
 * the decoder rejects — callers fall back to a fresh initial state.
 */
export function loadSave<T>(options: SaveFileOptions<T>): T | null {
  let raw: string;
  try {
    raw = fs.readFileSync(options.filePath, 'utf8');
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof (parsed as SaveEnvelope<unknown>).v !== 'number'
  ) {
    return null;
  }

  const envelope = parsed as SaveEnvelope<unknown>;
  if (envelope.v > options.currentVersion) return null;

  let data: unknown = envelope.data;
  for (let v = envelope.v; v < options.currentVersion; v += 1) {
    const migrate = options.migrations?.[v];
    if (!migrate) return null;
    try {
      data = migrate(data);
    } catch {
      return null;
    }
  }

  return options.decode(data);
}

/**
 * Atomically persist a save: write to a sibling tmp file, fsync, rename over
 * the target. The directory is created on demand. Throws on I/O failure —
 * callers decide whether a failed save is fatal (daemon shutdown) or
 * tolerable (periodic autosave).
 */
export function writeSave<T>(
  filePath: string,
  currentVersion: number,
  data: T,
  nowIso: string = new Date().toISOString()
): void {
  const envelope: SaveEnvelope<T> = { v: currentVersion, savedAt: nowIso, data };
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = path.join(dir, `.${path.basename(filePath)}.tmp`);
  const fd = fs.openSync(tmpPath, 'w');
  try {
    fs.writeSync(fd, JSON.stringify(envelope));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmpPath, filePath);
}
