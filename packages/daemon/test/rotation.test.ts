import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Rotator } from '../src/rotation.js';
import { Watcher } from '../src/watcher.js';

function mkTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ccidle-rotation-'));
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

function fakeWatcher() {
  const drains: Array<[string, string]> = [];
  return { drainRotated: (livePath: string, rotatedPath: string) => drains.push([livePath, rotatedPath]), drains };
}

function line(n: number): string {
  return JSON.stringify({ v: 1, ts: '2026-08-17T10:00:00.000Z', session_id: 'sess-1', event: `E${n}`, payload: {} }) + '\n';
}

describe('Rotator', () => {
  it('moves a live file over maxFileMB into the archive and drains the watcher', () => {
    const dir = mkTmpDir();
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const live = path.join(dir, 'sess-1.jsonl');
    const archive = path.join(dir, 'sess-1.archive.jsonl');
    fs.writeFileSync(live, 'x'.repeat(2 * 1024 * 1024)); // 2MB

    const watcher = fakeWatcher();
    const rotator = new Rotator(dir, watcher);
    rotator.checkAndRotate(1, 30); // 1MB threshold

    expect(fs.existsSync(live)).toBe(false);
    expect(fs.existsSync(`${live}.rotating`)).toBe(false);
    expect(fs.statSync(archive).size).toBe(2 * 1024 * 1024);
    expect(watcher.drains).toEqual([[live, `${live}.rotating`]]);
  });

  it('leaves files under the threshold untouched', () => {
    const dir = mkTmpDir();
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const live = path.join(dir, 'sess-1.jsonl');
    fs.writeFileSync(live, 'small content\n');

    const watcher = fakeWatcher();
    const rotator = new Rotator(dir, watcher);
    rotator.checkAndRotate(5, 30);

    expect(fs.readFileSync(live, 'utf8')).toBe('small content\n');
    expect(watcher.drains).toEqual([]);
  });

  it('never rotates archive files themselves', () => {
    const dir = mkTmpDir();
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const archive = path.join(dir, 'sess-1.archive.jsonl');
    fs.writeFileSync(archive, 'x'.repeat(2 * 1024 * 1024));

    const watcher = fakeWatcher();
    const rotator = new Rotator(dir, watcher);
    rotator.checkAndRotate(1, 30);

    expect(fs.statSync(archive).size).toBe(2 * 1024 * 1024);
    expect(watcher.drains).toEqual([]);
  });

  it('emits lines the watcher had not read yet, once each, and keeps tailing the new live file', async () => {
    const dir = mkTmpDir();
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const live = path.join(dir, 'sess-1.jsonl');
    const archive = path.join(dir, 'sess-1.archive.jsonl');
    fs.writeFileSync(live, line(1) + line(2));

    const watcher = new Watcher(dir);
    const seen: string[] = [];
    watcher.on('event', (envelope, filePath) => {
      expect(filePath).toBe(live);
      seen.push(envelope.event);
    });
    await watcher.start();
    cleanups.push(() => watcher.stop());
    expect(seen).toEqual(['E1', 'E2']);

    // Appended and rotated in one tick, before the watcher sees the change.
    fs.appendFileSync(live, line(3) + line(4));
    new Rotator(dir, watcher).checkAndRotate(0, 30);
    expect(seen).toEqual(['E1', 'E2', 'E3', 'E4']);
    expect(fs.readFileSync(archive, 'utf8')).toBe(line(1) + line(2) + line(3) + line(4));

    // A hook writes the next event to a fresh live file.
    fs.writeFileSync(live, line(5));
    const deadline = Date.now() + 3000;
    while (seen.length < 5 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
    expect(seen).toEqual(['E1', 'E2', 'E3', 'E4', 'E5']);
  });

  it('deletes archive files older than retentionDays, keeps fresh ones', () => {
    const dir = mkTmpDir();
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const oldArchive = path.join(dir, 'old.archive.jsonl');
    const freshArchive = path.join(dir, 'fresh.archive.jsonl');
    fs.writeFileSync(oldArchive, 'old\n');
    fs.writeFileSync(freshArchive, 'fresh\n');

    const oldTime = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
    fs.utimesSync(oldArchive, oldTime, oldTime);

    const watcher = fakeWatcher();
    const rotator = new Rotator(dir, watcher);
    rotator.checkAndRotate(5, 30);

    expect(fs.existsSync(oldArchive)).toBe(false);
    expect(fs.existsSync(freshArchive)).toBe(true);
  });
});
