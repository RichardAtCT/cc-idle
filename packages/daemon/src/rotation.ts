import fs from 'node:fs';
import path from 'node:path';
import { isLiveEventFile, sessionIdFromFilePath, type Watcher } from './watcher.js';

const BYTES_PER_MB = 1024 * 1024;

export interface RotationLogger {
  info: (msg: string) => void;
  warn: (msg: string) => void;
}

/**
 * Moves live event files over config.log.maxFileMB into
 * {session}.archive.jsonl, then deletes archive files older than
 * config.log.retentionDays. The live file is renamed aside rather than
 * copied and truncated: a hook that appends mid-rotation then writes to a
 * fresh live file instead of into bytes about to be cut. The watcher drains
 * what it has not read yet from the renamed file before its offset restarts.
 */
export class Rotator {
  constructor(
    private readonly dir: string,
    private readonly watcher: Pick<Watcher, 'drainRotated'>,
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
    // Not *.jsonl, so the watcher ignores it.
    const rotatingPath = `${filePath}.rotating`;
    try {
      // Left by a crash mid-rotation. Archive it now: the rename below would overwrite it.
      if (fs.existsSync(rotatingPath)) {
        fs.appendFileSync(archivePath, fs.readFileSync(rotatingPath));
        fs.unlinkSync(rotatingPath);
      }
      fs.renameSync(filePath, rotatingPath);
      this.watcher.drainRotated(filePath, rotatingPath);
      this.onRotated?.(filePath);
      const content = fs.readFileSync(rotatingPath);
      fs.appendFileSync(archivePath, content);
      fs.unlinkSync(rotatingPath);
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
