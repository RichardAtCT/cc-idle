import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { EventEnvelope } from '@ccidle/shared';
import type { GameState } from '@ccidle/game';
import { GameHost } from '../src/game-host.js';

function tmpSavePath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccidle-host-'));
  return path.join(dir, 'save.json');
}

function env(ts: string, event: string, extra: Partial<EventEnvelope> = {}): EventEnvelope {
  return { v: 1, ts, session_id: 'sess-1', event, cwd: '/p/alpha', payload: {}, ...extra };
}

/**
 * Cursor keys must point at files that exist: on startup the host prunes
 * cursors for event files retention has deleted. Tests therefore use a real
 * (empty) file — the host only cares about the path identity, not content.
 */
function tmpEventFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccidle-host-events-'));
  const file = path.join(dir, 'sess-1.jsonl');
  fs.writeFileSync(file, '');
  return file;
}

const FILE = tmpEventFile();

function makeHost(savePath: string): { host: GameHost; states: GameState[] } {
  const states: GameState[] = [];
  const host = new GameHost({
    savePath,
    broadcast: (game) => states.push(game),
    autosaveMs: 0,
    clock: () => Date.parse('2026-08-17T12:00:00.000Z')
  });
  return { host, states };
}

describe('GameHost', () => {
  it('applies envelopes and broadcasts state', () => {
    const { host, states } = makeHost(tmpSavePath());
    host.handleEnvelope(env('2026-08-17T10:00:00.000Z', 'SessionStart'), FILE);
    host.handleEnvelope(env('2026-08-17T10:00:05.000Z', 'PostToolUse', { tool: 'Edit' }), FILE);
    expect(states.length).toBe(2);
    expect(host.state().resources.engineering).toBeGreaterThan(0);
    expect(host.state().regions['/p/alpha']).toBeDefined();
  });

  it('does not double-count events replayed after a restart', () => {
    const savePath = tmpSavePath();
    const events = [
      env('2026-08-17T10:00:00.000Z', 'SessionStart'),
      env('2026-08-17T10:00:05.000Z', 'PostToolUse', { tool: 'Edit' }),
      env('2026-08-17T10:00:06.000Z', 'PostToolUse', { tool: 'Edit' })
    ];

    const first = makeHost(savePath);
    for (const e of events) first.host.handleEnvelope(e, FILE);
    const engineeringAfterFirstRun = first.host.state().resources.engineering;
    first.host.stop(); // persists

    // Daemon restart: the watcher replays the same file from byte 0, plus one new event.
    const second = makeHost(savePath);
    for (const e of events) second.host.handleEnvelope(e, FILE);
    expect(second.host.state().resources.engineering).toBe(engineeringAfterFirstRun);
    second.host.handleEnvelope(env('2026-08-17T10:00:07.000Z', 'PostToolUse', { tool: 'Edit' }), FILE);
    expect(second.host.state().resources.engineering).toBeGreaterThan(engineeringAfterFirstRun);
  });

  it('counts events appended while the daemon was down (late, but real work)', () => {
    const savePath = tmpSavePath();
    const first = makeHost(savePath);
    first.host.handleEnvelope(env('2026-08-17T10:00:00.000Z', 'SessionStart'), FILE);
    first.host.stop();

    const second = makeHost(savePath);
    second.host.handleEnvelope(env('2026-08-17T10:00:00.000Z', 'SessionStart'), FILE); // replayed
    second.host.handleEnvelope(env('2026-08-17T10:00:05.000Z', 'PostToolUse', { tool: 'Edit' }), FILE); // appended offline
    expect(second.host.state().resources.engineering).toBeGreaterThan(0);
    expect(second.host.state().stats.eventsProcessed).toBe(2);
  });

  it('restarts a file cursor after rotation/truncation', () => {
    const savePath = tmpSavePath();
    const { host } = makeHost(savePath);
    host.handleEnvelope(env('2026-08-17T10:00:00.000Z', 'SessionStart'), FILE);
    host.handleEnvelope(env('2026-08-17T10:00:05.000Z', 'PostToolUse', { tool: 'Edit' }), FILE);
    const before = host.state().resources.engineering;
    host.handleFileReset(FILE);
    // Fresh events in the truncated file start from ordinal 1 again and must count.
    host.handleEnvelope(env('2026-08-17T10:10:00.000Z', 'PostToolUse', { tool: 'Edit' }), FILE);
    expect(host.state().resources.engineering).toBeGreaterThan(before);
  });

  it('applies valid game actions and ignores malformed ones', () => {
    const { host } = makeHost(tmpSavePath());
    host.handleEnvelope(env('2026-08-17T10:00:00.000Z', 'SessionStart'), FILE);
    host.handleAction({ type: 'no-such-action' });
    host.handleAction('garbage');
    const before = host.state().lab.researchers;
    host.handleAction({ type: 'hire' }); // fails (no engineering) but is well-formed
    expect(host.state().lab.researchers).toBe(before);
    expect(host.state().log.some((l) => l.text.includes('hire costs'))).toBe(true);
  });

  it('marks sessions dark via daemon state changes', () => {
    const { host } = makeHost(tmpSavePath());
    host.handleEnvelope(env('2026-08-17T10:00:00.000Z', 'SessionStart'), FILE);
    host.handleStateChange('sess-1', 'STALE');
    expect(host.state().regions['/p/alpha']!.status).toBe('dark');
  });
});
