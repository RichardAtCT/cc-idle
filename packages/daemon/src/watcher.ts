import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import chokidar, { type FSWatcher } from 'chokidar';
import { parseEventLine, type EventEnvelope } from '@ccidle/shared';

/** True for live session event files ("{sessionId}.jsonl"), false for archives/others. */
export function isLiveEventFile(filePath: string): boolean {
  return filePath.endsWith('.jsonl') && !filePath.endsWith('.archive.jsonl');
}

export interface IncrementalRead {
  lines: string[];
  /** New byte offset to remember for the next read. */
  offset: number;
  /** True if the file was smaller than the previous offset (rotated/truncated externally). */
  truncated: boolean;
}

/**
 * Read only the bytes appended since `prevOffset`, split into complete lines.
 * A trailing partial line (no terminating \n yet) is left unconsumed — the
 * offset is not advanced past it, so the next read picks it up complete.
 * Safe to call on a file that doesn't exist (returns no lines, offset 0).
 */
export function readNewLines(filePath: string, prevOffset: number): IncrementalRead {
  let size: number;
  try {
    size = fs.statSync(filePath).size;
  } catch {
    return { lines: [], offset: 0, truncated: false };
  }

  if (size < prevOffset) {
    // File shrank (external truncation/rotation) — restart from the top.
    return { ...readNewLines(filePath, 0), truncated: true };
  }
  if (size === prevOffset) {
    return { lines: [], offset: prevOffset, truncated: false };
  }

  const fd = fs.openSync(filePath, 'r');
  let buf: Buffer;
  try {
    const length = size - prevOffset;
    buf = Buffer.alloc(length);
    fs.readSync(fd, buf, 0, length, prevOffset);
  } finally {
    fs.closeSync(fd);
  }

  const lastNewline = buf.lastIndexOf(0x0a); // '\n'
  if (lastNewline === -1) {
    // No complete line yet.
    return { lines: [], offset: prevOffset, truncated: false };
  }

  const complete = buf.subarray(0, lastNewline + 1).toString('utf8');
  const lines = complete.split('\n').filter((l) => l.length > 0);
  return { lines, offset: prevOffset + lastNewline + 1, truncated: false };
}

export interface WatcherEvents {
  event: [envelope: EventEnvelope, filePath: string];
  truncated: [filePath: string];
  ready: [];
  error: [error: Error];
}

/**
 * Watches eventsDir() for *.jsonl (excluding *.archive.jsonl), tailing each
 * file incrementally and emitting parsed envelopes. Pre-existing files are
 * replayed from byte 0 on startup (chokidar's default `add` events for
 * already-present files double as the replay mechanism, since this watcher's
 * offsets start empty).
 */
export class Watcher extends EventEmitter<WatcherEvents> {
  private readonly dir: string;
  private fsWatcher: FSWatcher | null = null;
  private readonly offsets = new Map<string, number>();

  constructor(dir: string) {
    super();
    this.dir = dir;
  }

  async start(): Promise<void> {
    fs.mkdirSync(this.dir, { recursive: true });
    this.fsWatcher = chokidar.watch(this.dir, {
      depth: 0,
      // Only ever exclude archive files here; directory-vs-file can't be told
      // apart from a path string alone (chokidar doesn't stat the watch root
      // before calling this), so non-.jsonl files are filtered in consume().
      ignored: (filePath: string) => filePath.endsWith('.archive.jsonl'),
      awaitWriteFinish: false
    });

    this.fsWatcher.on('add', (filePath) => this.consume(filePath));
    this.fsWatcher.on('change', (filePath) => this.consume(filePath));
    this.fsWatcher.on('error', (error) => this.emit('error', error instanceof Error ? error : new Error(String(error))));

    await new Promise<void>((resolve) => {
      this.fsWatcher!.once('ready', () => {
        this.emit('ready');
        resolve();
      });
    });
  }

  private consume(filePath: string): void {
    if (!isLiveEventFile(filePath)) return;
    const prevOffset = this.offsets.get(filePath) ?? 0;
    const result = readNewLines(filePath, prevOffset);
    this.offsets.set(filePath, result.offset);
    if (result.truncated) this.emit('truncated', filePath);
    for (const line of result.lines) {
      const envelope = parseEventLine(line);
      if (envelope) this.emit('event', envelope, filePath);
    }
  }

  /** Force a re-read of one file right now (e.g. after this daemon appends a synthetic event itself). */
  poke(filePath: string): void {
    this.consume(filePath);
  }

  /** Used by rotation.ts right after it archives+truncates a live file, to keep offsets in sync. */
  resetOffset(filePath: string, offset = 0): void {
    this.offsets.set(filePath, offset);
  }

  getOffset(filePath: string): number {
    return this.offsets.get(filePath) ?? 0;
  }

  eventsDir(): string {
    return this.dir;
  }

  async stop(): Promise<void> {
    await this.fsWatcher?.close();
    this.fsWatcher = null;
  }
}

export function sessionIdFromFilePath(filePath: string): string {
  return path.basename(filePath, '.jsonl');
}
