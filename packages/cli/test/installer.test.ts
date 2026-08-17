import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runInstall, runUninstall } from '../src/installer.js';
import { readSettings } from '../src/settings.js';
import { EVENT_SCRIPTS } from '../src/repo-paths.js';

describe('runInstall / runUninstall (end-to-end against temp files)', () => {
  let dir: string;
  let settingsPath: string;
  let hooksDirOverride: string;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccidle-installer-test-'));
    settingsPath = path.join(dir, 'claude-settings.json');
    // Must literally be named "hooks" — install/uninstall identify their own
    // entries by the "/hooks/on-" substring in the command path, matching
    // the real repo layout (<repoRoot>/hooks/on-*.sh).
    hooksDirOverride = path.join(dir, 'hooks');
    process.env.CCIDLE_HOME = path.join(dir, 'ccidle-home');
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    logSpy.mockRestore();
    stdoutSpy.mockRestore();
    delete process.env.CCIDLE_HOME;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('creates settings.json when missing and registers all 8 events', () => {
    runInstall({ settingsPath, hooksDirOverride });
    const settings = readSettings(settingsPath);
    expect(Object.keys(settings.hooks ?? {}).sort()).toEqual(Object.keys(EVENT_SCRIPTS).sort());
    for (const [event, script] of Object.entries(EVENT_SCRIPTS)) {
      const command = settings.hooks![event]![0]!.hooks[0]!.command;
      expect(command).toBe(path.join(hooksDirOverride, script));
    }
  });

  it('running install twice is idempotent (no duplicate entries)', () => {
    runInstall({ settingsPath, hooksDirOverride });
    runInstall({ settingsPath, hooksDirOverride });
    const settings = readSettings(settingsPath);
    for (const event of Object.keys(EVENT_SCRIPTS)) {
      const commands = settings.hooks![event]!.flatMap((g) => g.hooks.map((h) => h.command));
      expect(commands).toHaveLength(1);
    }
  });

  it('preserves pre-existing unrelated settings content', () => {
    fs.writeFileSync(settingsPath, JSON.stringify({ theme: 'dark', hooks: {} }));
    runInstall({ settingsPath, hooksDirOverride });
    const settings = readSettings(settingsPath);
    expect(settings.theme).toBe('dark');
  });

  it('writes redact.sed under CCIDLE_HOME from the default config patterns', () => {
    runInstall({ settingsPath, hooksDirOverride });
    const sedPath = path.join(process.env.CCIDLE_HOME!, 'redact.sed');
    const content = fs.readFileSync(sedPath, 'utf8');
    expect(content).toContain('s/sk-[A-Za-z0-9-]{10,}/[REDACTED]/g');
  });

  it('--dry-run prints the fragment and does not touch settings.json', () => {
    runInstall({ settingsPath, hooksDirOverride, dryRun: true });
    expect(fs.existsSync(settingsPath)).toBe(false);
  });

  it('uninstall removes exactly what install added, round-tripping cleanly', () => {
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({
        hooks: { Notification: [{ hooks: [{ type: 'command', command: '/foreign/notify.sh' }] }] }
      })
    );
    runInstall({ settingsPath, hooksDirOverride });
    runUninstall({ settingsPath });
    const settings = readSettings(settingsPath);
    expect(settings.hooks!.Notification).toEqual([
      { hooks: [{ type: 'command', command: '/foreign/notify.sh' }] }
    ]);
    // none of our events should have any owned command left
    for (const event of Object.keys(EVENT_SCRIPTS)) {
      const groups = settings.hooks?.[event] ?? [];
      const commands = groups.flatMap((g) => g.hooks.map((h) => h.command));
      expect(commands.every((c) => !c.includes(hooksDirOverride))).toBe(true);
    }
  });

  it('refuses to clobber malformed existing settings.json', () => {
    fs.writeFileSync(settingsPath, '{ this is not json');
    expect(() => runInstall({ settingsPath, hooksDirOverride })).toThrow();
  });
});
