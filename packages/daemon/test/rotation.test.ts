import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Rotator } from '../src/rotation.js';

function mkTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ccidle-rotation-'));
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

function fakeWatcher() {
  const resets: Array<[string, number]> = [];
  return { resetOffset: (filePath: string, offset = 0) => resets.push([filePath, offset]), resets };
}

describe('Rotator', () => {
  it('archives and truncates a live file over maxFileMB, resetting the watcher offset', () => {
    const dir = mkTmpDir();
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const live = path.join(dir, 'sess-1.jsonl');
    const archive = path.join(dir, 'sess-1.archive.jsonl');
    fs.writeFileSync(live, 'x'.repeat(2 * 1024 * 1024)); // 2MB

    const watcher = fakeWatcher();
    const rotator = new Rotator(dir, watcher);
    rotator.checkAndRotate(1, 30); // 1MB threshold

    expect(fs.statSync(live).size).toBe(0);
    expect(fs.existsSync(archive)).toBe(true);
    expect(fs.statSync(archive).size).toBe(2 * 1024 * 1024);
    expect(watcher.resets).toEqual([[live, 0]]);
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
    expect(watcher.resets).toEqual([]);
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
    expect(watcher.resets).toEqual([]);
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
