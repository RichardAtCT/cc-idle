import fs from 'node:fs';
import path from 'node:path';
import { isLiveEventFile, sessionIdFromFilePath, type Watcher } from './watcher.js';

const BYTES_PER_MB = 1024 * 1024;

export interface RotationLogger {
  info: (msg: string) => void;
  warn: (msg: string) => void;
}

/**
 * Compacts live event files over config.log.maxFileMB into
 * {session}.archive.jsonl and truncates the live file, then deletes archive
 * files older than config.log.retentionDays. Coordinates with the watcher's
 * byte offsets so a rotation doesn't cause it to miss or double-read lines.
 */
export class Rotator {
  constructor(
    private readonly dir: string,
    private readonly watcher: Pick<Watcher, 'resetOffset'>,
    private readonly logger?: RotationLogger,
    /** Extra consumers (e.g. the game host) that track per-file positions. */
    private readonly onRotated?: (filePath: string) => void
  ) {}

  /** Run one rotation pass: archive oversized live files, prune stale archives. */
  checkAndRotate(maxFileMB: number, retentionDays: number): void {
    this.rotateOversizedFiles(maxFileMB);
    this.pruneOldArchives(retentionDays);
  }

  private rotateOversizedFiles(maxFileMB: number): void {
    let entries: string[];
    try {
      entries = fs.readdirSync(this.dir);
    } catch {
      return;
    }
    const maxBytes = maxFileMB * BYTES_PER_MB;

    for (const name of entries) {
      const filePath = path.join(this.dir, name);
      if (!isLiveEventFile(filePath)) continue;
      let stat: fs.Stats;
      try {
        stat = fs.statSync(filePath);
      } catch {
        continue;
      }
      if (stat.size <= maxBytes) continue;

      const sessionId = sessionIdFromFilePath(filePath);
      const archivePath = path.join(this.dir, `${sessionId}.archive.jsonl`);
      this.rotateOne(filePath, archivePath);
    }
  }

  private rotateOne(filePath: string, archivePath: string): void {
    try {
      const content = fs.readFileSync(filePath);
      fs.appendFileSync(archivePath, content);
      fs.truncateSync(filePath, 0);
      this.watcher.resetOffset(filePath, 0);
      this.onRotated?.(filePath);
      this.logger?.info(`rotated ${filePath} -> ${archivePath} (${content.byteLength} bytes)`);
    } catch (error) {
      this.logger?.warn(`rotation failed for ${filePath}: ${(error as Error).message}`);
    }
  }

  private pruneOldArchives(retentionDays: number): void {
    let entries: string[];
    try {
      entries = fs.readdirSync(this.dir);
    } catch {
      return;
    }
    const cutoffMs = Date.now() - retentionDays * 24 * 60 * 60 * 1000;

    for (const name of entries) {
      if (!name.endsWith('.archive.jsonl')) continue;
      const filePath = path.join(this.dir, name);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(filePath);
      } catch {
        continue;
      }
      if (stat.mtimeMs < cutoffMs) {
        try {
          fs.unlinkSync(filePath);
          this.logger?.info(`deleted expired archive ${filePath}`);
        } catch (error) {
          this.logger?.warn(`failed to delete archive ${filePath}: ${(error as Error).message}`);
        }
      }
    }
  }
}
