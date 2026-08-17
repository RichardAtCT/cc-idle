import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Watcher, readNewLines, isLiveEventFile, sessionIdFromFilePath } from '../src/watcher.js';

function mkTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ccidle-watcher-'));
}

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length > 0) {
    const fn = cleanups.pop()!;
    await fn();
  }
});

function line(sessionId: string, event: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ v: 1, ts: '2026-08-17T10:00:00.000Z', session_id: sessionId, event, payload: {}, ...extra }) + '\n';
}

describe('isLiveEventFile', () => {
  it('accepts *.jsonl but rejects *.archive.jsonl', () => {
    expect(isLiveEventFile('/x/abc.jsonl')).toBe(true);
    expect(isLiveEventFile('/x/abc.archive.jsonl')).toBe(false);
    expect(isLiveEventFile('/x/abc.txt')).toBe(false);
  });
});

describe('sessionIdFromFilePath', () => {
  it('strips the .jsonl extension', () => {
    expect(sessionIdFromFilePath('/x/sess-123.jsonl')).toBe('sess-123');
  });
});

describe('readNewLines (pure incremental read)', () => {
  it('returns nothing for a file that does not exist', () => {
    const result = readNewLines('/nonexistent/path.jsonl', 0);
    expect(result).toEqual({ lines: [], offset: 0, truncated: false });
  });

  it('reads only bytes appended since the offset', () => {
    const dir = mkTmpDir();
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, 'sess.jsonl');
    fs.writeFileSync(file, line('sess-1', 'SessionStart'));

    const first = readNewLines(file, 0);
    expect(first.lines).toHaveLength(1);
    expect(first.truncated).toBe(false);

    fs.appendFileSync(file, line('sess-1', 'UserPromptSubmit'));
    const second = readNewLines(file, first.offset);
    expect(second.lines).toHaveLength(1);
    expect(JSON.parse(second.lines[0]!).event).toBe('UserPromptSubmit');

    // nothing new
    const third = readNewLines(file, second.offset);
    expect(third.lines).toHaveLength(0);
    expect(third.offset).toBe(second.offset);
  });

  it('does not advance past a partial trailing line', () => {
    const dir = mkTmpDir();
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, 'sess.jsonl');
    fs.writeFileSync(file, line('sess-1', 'SessionStart') + '{"v":1,"partial'); // no trailing \n

    const result = readNewLines(file, 0);
    expect(result.lines).toHaveLength(1);
    // offset should sit right after the first complete line
    expect(result.offset).toBe(Buffer.byteLength(line('sess-1', 'SessionStart')));

    fs.appendFileSync(file, '":true}\n');
    const next = readNewLines(file, result.offset);
    expect(next.lines).toHaveLength(1);
    expect(JSON.parse(next.lines[0]!).partial).toBe(true);
  });

  it('detects truncation and restarts from byte 0', () => {
    const dir = mkTmpDir();
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, 'sess.jsonl');
    fs.writeFileSync(file, line('sess-1', 'SessionStart') + line('sess-1', 'UserPromptSubmit'));
    const first = readNewLines(file, 0);
    const bigOffset = first.offset;

    // simulate rotation: truncate then write a fresh, shorter file
    fs.writeFileSync(file, line('sess-1', 'Stop'));
    const result = readNewLines(file, bigOffset);
    expect(result.truncated).toBe(true);
    expect(result.lines).toHaveLength(1);
    expect(JSON.parse(result.lines[0]!).event).toBe('Stop');
  });
});

describe('Watcher', () => {
  it('replays pre-existing files from byte 0 on startup', async () => {
    const dir = mkTmpDir();
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, 'sess-1.jsonl');
    fs.writeFileSync(file, line('sess-1', 'SessionStart') + line('sess-1', 'UserPromptSubmit'));

    const watcher = new Watcher(dir);
    const seen: string[] = [];
    watcher.on('event', (envelope) => seen.push(envelope.event));
    await watcher.start();
    cleanups.push(() => watcher.stop());

    expect(seen).toEqual(['SessionStart', 'UserPromptSubmit']);
  });

  it('emits only newly appended lines on change, ignoring .archive.jsonl', async () => {
    const dir = mkTmpDir();
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, 'sess-2.jsonl');
    fs.writeFileSync(file, line('sess-2', 'SessionStart'));
    fs.writeFileSync(path.join(dir, 'sess-2.archive.jsonl'), line('sess-2', 'Stop'));

    const watcher = new Watcher(dir);
    const seen: string[] = [];
    watcher.on('event', (envelope) => seen.push(envelope.event));
    await watcher.start();
    cleanups.push(() => watcher.stop());

    expect(seen).toEqual(['SessionStart']);

    fs.appendFileSync(file, line('sess-2', 'UserPromptSubmit'));

    await new Promise<void>((resolve) => {
      watcher.on('event', function onEvent(envelope) {
        if (envelope.event === 'UserPromptSubmit') {
          watcher.off('event', onEvent);
          resolve();
        }
      });
      // in case chokidar is slow, also poll
      const start = Date.now();
      const interval = setInterval(() => {
        if (seen.includes('UserPromptSubmit') || Date.now() - start > 4000) {
          clearInterval(interval);
          resolve();
        }
      }, 50);
    });

    expect(seen).toEqual(['SessionStart', 'UserPromptSubmit']);
  });

  it('handles truncation via resetOffset from rotation', async () => {
    const dir = mkTmpDir();
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, 'sess-3.jsonl');
    fs.writeFileSync(file, line('sess-3', 'SessionStart'));

    const watcher = new Watcher(dir);
    await watcher.start();
    cleanups.push(() => watcher.stop());
    expect(watcher.getOffset(file)).toBeGreaterThan(0);

    watcher.resetOffset(file, 0);
    expect(watcher.getOffset(file)).toBe(0);
  });
});
