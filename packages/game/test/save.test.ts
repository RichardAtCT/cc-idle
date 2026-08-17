import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { freshGameSave, loadGameSave, writeGameSave, GAME_SAVE_VERSION } from '../src/index.js';

function tmpSavePath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccidle-game-save-'));
  return path.join(dir, 'nested', 'save.json');
}

describe('game save', () => {
  it('round-trips through the versioned save file, creating directories', () => {
    const savePath = tmpSavePath();
    const data = freshGameSave('2026-08-17T10:00:00.000Z');
    data.game.resources.compute = 1234;
    data.cursors['/x/events/a.jsonl'] = 42;
    writeGameSave(savePath, data, '2026-08-17T10:00:01.000Z');

    const loaded = loadGameSave(savePath);
    expect(loaded).not.toBeNull();
    expect(loaded!.game.resources.compute).toBe(1234);
    expect(loaded!.cursors['/x/events/a.jsonl']).toBe(42);
  });

  it('returns null for a missing or corrupt file', () => {
    expect(loadGameSave('/nonexistent/save.json')).toBeNull();
    const savePath = tmpSavePath();
    fs.mkdirSync(path.dirname(savePath), { recursive: true });
    fs.writeFileSync(savePath, 'not json');
    expect(loadGameSave(savePath)).toBeNull();
  });

  it('rejects saves from a future version', () => {
    const savePath = tmpSavePath();
    fs.mkdirSync(path.dirname(savePath), { recursive: true });
    fs.writeFileSync(
      savePath,
      JSON.stringify({ v: GAME_SAVE_VERSION + 1, savedAt: 'x', data: freshGameSave('2026-08-17T10:00:00.000Z') })
    );
    expect(loadGameSave(savePath)).toBeNull();
  });
});
