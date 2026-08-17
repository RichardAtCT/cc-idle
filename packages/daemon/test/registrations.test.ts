import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RegistrationStore } from '../src/registrations.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

function mkHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccidle-reg-'));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

describe('RegistrationStore', () => {
  it('persists the game pane and reloads it from disk', () => {
    const home = mkHome();
    const store = new RegistrationStore({ CCIDLE_HOME: home });
    expect(store.getGamePane()).toBeUndefined();

    store.setGamePane('%2');
    expect(store.getGamePane()).toBe('%2');

    const reloaded = new RegistrationStore({ CCIDLE_HOME: home });
    expect(reloaded.getGamePane()).toBe('%2');
  });

  it('registers a cc pane and resolves it by sessionId first, then cwd', () => {
    const home = mkHome();
    const store = new RegistrationStore({ CCIDLE_HOME: home });

    store.registerCc({ pane: '%3', cwd: '/repo/a' });
    expect(store.resolvePaneForSession('unknown-session', '/repo/a')).toBe('%3');

    store.registerCc({ pane: '%3', cwd: '/repo/a', sessionId: 'sess-1' });
    expect(store.resolvePaneForSession('sess-1')).toBe('%3');
    expect(store.resolvePaneForSession('sess-1', '/some/other/cwd')).toBe('%3');
  });

  it('upserts by matching pane, cwd, or sessionId rather than duplicating', () => {
    const home = mkHome();
    const store = new RegistrationStore({ CCIDLE_HOME: home });

    store.registerCc({ pane: '%3', cwd: '/repo/a' });
    store.registerCc({ pane: '%3', sessionId: 'sess-1' });

    expect(store.all().cc).toHaveLength(1);
    expect(store.resolvePaneForSession('sess-1')).toBe('%3');
  });

  it('falls back to defaults when the registrations file is missing or corrupt', () => {
    const home = mkHome();
    fs.writeFileSync(path.join(home, 'registrations.json'), '{not json');
    const store = new RegistrationStore({ CCIDLE_HOME: home });
    expect(store.getGamePane()).toBeUndefined();
    expect(store.all().cc).toEqual([]);
  });
});
