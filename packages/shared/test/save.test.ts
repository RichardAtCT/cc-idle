import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadSave, writeSave } from '../src/save.js';

interface ToyV2 {
  counter: number;
  label: string;
}

function decodeV2(data: unknown): ToyV2 | null {
  if (typeof data !== 'object' || data === null) return null;
  const d = data as Record<string, unknown>;
  if (typeof d.counter !== 'number' || typeof d.label !== 'string') return null;
  return { counter: d.counter, label: d.label };
}

function tmpFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccidle-save-'));
  return path.join(dir, 'deep', 'toy.json');
}

describe('save-file abstraction (Phase 2)', () => {
  it('writes atomically (no tmp file left behind) and loads back', () => {
    const filePath = tmpFile();
    writeSave(filePath, 2, { counter: 7, label: 'x' }, '2026-08-17T10:00:00.000Z');
    expect(fs.readdirSync(path.dirname(filePath))).toEqual(['toy.json']);
    const loaded = loadSave<ToyV2>({ filePath, currentVersion: 2, decode: decodeV2 });
    expect(loaded).toEqual({ counter: 7, label: 'x' });
  });

  it('migrates older versions through the registry', () => {
    const filePath = tmpFile();
    writeSave(filePath, 1, { counter: 3 }, '2026-08-17T10:00:00.000Z');
    const loaded = loadSave<ToyV2>({
      filePath,
      currentVersion: 2,
      decode: decodeV2,
      migrations: {
        1: (data) => ({ ...(data as Record<string, unknown>), label: 'migrated' })
      }
    });
    expect(loaded).toEqual({ counter: 3, label: 'migrated' });
  });

  it('returns null when a migration step is missing', () => {
    const filePath = tmpFile();
    writeSave(filePath, 1, { counter: 3 }, '2026-08-17T10:00:00.000Z');
    expect(loadSave<ToyV2>({ filePath, currentVersion: 2, decode: decodeV2 })).toBeNull();
  });

  it('returns null for missing files, bad JSON, and future versions', () => {
    expect(loadSave<ToyV2>({ filePath: '/nope/toy.json', currentVersion: 2, decode: decodeV2 })).toBeNull();
    const filePath = tmpFile();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, '{broken');
    expect(loadSave<ToyV2>({ filePath, currentVersion: 2, decode: decodeV2 })).toBeNull();
    writeSave(filePath, 3, { counter: 1, label: 'future' });
    expect(loadSave<ToyV2>({ filePath, currentVersion: 2, decode: decodeV2 })).toBeNull();
  });
});
