import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildHookFragment,
  buildRedactSed,
  hooksInstalled,
  isOwnCommand,
  mergeSettings,
  readSettings,
  unmergeSettings,
  writeSettings,
  type ClaudeSettings
} from '../src/settings.js';
import { EVENT_SCRIPTS } from '../src/repo-paths.js';

const HOOKS_DIR_A = '/repo-a/hooks';
const HOOKS_DIR_B = '/repo-b/hooks';

describe('buildHookFragment', () => {
  it('registers all 8 PRD events with absolute script paths', () => {
    const fragment = buildHookFragment(HOOKS_DIR_A);
    expect(Object.keys(fragment).sort()).toEqual(Object.keys(EVENT_SCRIPTS).sort());
    for (const [event, script] of Object.entries(EVENT_SCRIPTS)) {
      expect(fragment[event]![0]!.hooks[0]!.command).toBe(path.join(HOOKS_DIR_A, script));
    }
  });

  it('uses matcher "*" only for PreToolUse/PostToolUse; lifecycle events omit matcher', () => {
    const fragment = buildHookFragment(HOOKS_DIR_A);
    expect(fragment.PreToolUse![0]!.matcher).toBe('*');
    expect(fragment.PostToolUse![0]!.matcher).toBe('*');
    expect(fragment.SessionStart![0]!.matcher).toBeUndefined();
    expect(fragment.Stop![0]!.matcher).toBeUndefined();
  });
});

describe('mergeSettings', () => {
  it('installs into an empty settings object', () => {
    const next = mergeSettings({}, HOOKS_DIR_A);
    expect(hooksInstalled(next).installed).toBe(true);
  });

  it('is idempotent: merging twice yields exactly one hook entry per event', () => {
    let settings: ClaudeSettings = {};
    settings = mergeSettings(settings, HOOKS_DIR_A);
    settings = mergeSettings(settings, HOOKS_DIR_A);
    for (const event of Object.keys(EVENT_SCRIPTS)) {
      const groups = settings.hooks![event]!;
      const commands = groups.flatMap((g) => g.hooks.map((h) => h.command));
      expect(commands).toHaveLength(1);
    }
  });

  it('self-corrects a stale hooks dir (e.g. repo moved) without leaving duplicates', () => {
    let settings: ClaudeSettings = {};
    settings = mergeSettings(settings, HOOKS_DIR_A);
    settings = mergeSettings(settings, HOOKS_DIR_B);
    const commands = settings.hooks!.SessionStart!.flatMap((g) => g.hooks.map((h) => h.command));
    expect(commands).toEqual([path.join(HOOKS_DIR_B, 'on-session-start.sh')]);
  });

  it('preserves unrelated existing settings content untouched', () => {
    const existing: ClaudeSettings = {
      someOtherTopLevelKey: { nested: true },
      hooks: {
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: '/other/tool/hook.sh' }] }]
      }
    };
    const next = mergeSettings(existing, HOOKS_DIR_A);
    expect(next.someOtherTopLevelKey).toEqual({ nested: true });
    // foreign PreToolUse hook (not ours) must survive alongside our matcher:"*" entry
    const preToolGroups = next.hooks!.PreToolUse!;
    const foreignGroup = preToolGroups.find((g) => g.matcher === 'Bash');
    expect(foreignGroup?.hooks[0]?.command).toBe('/other/tool/hook.sh');
    const ownGroup = preToolGroups.find((g) => g.hooks.some((h) => isOwnCommand(h.command)));
    expect(ownGroup).toBeDefined();
  });

  it('deep-merges preserving other event registrations already present', () => {
    const existing: ClaudeSettings = {
      hooks: {
        Stop: [{ hooks: [{ type: 'command', command: '/some/other/stop-hook.sh' }] }]
      }
    };
    const next = mergeSettings(existing, HOOKS_DIR_A);
    const stopCommands = next.hooks!.Stop!.flatMap((g) => g.hooks.map((h) => h.command));
    expect(stopCommands).toContain('/some/other/stop-hook.sh');
    expect(stopCommands).toContain(path.join(HOOKS_DIR_A, 'on-stop.sh'));
  });
});

describe('unmergeSettings (round trip with mergeSettings)', () => {
  it('removes exactly the entries install added, leaving foreign hooks intact', () => {
    const existing: ClaudeSettings = {
      hooks: {
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: '/other/tool/hook.sh' }] }]
      }
    };
    const installed = mergeSettings(existing, HOOKS_DIR_A);
    const uninstalled = unmergeSettings(installed);

    expect(hooksInstalled(uninstalled).installed).toBe(false);
    expect(uninstalled.hooks!.PreToolUse).toEqual([
      { matcher: 'Bash', hooks: [{ type: 'command', command: '/other/tool/hook.sh' }] }
    ]);
    // no ccidle-owned entries left anywhere
    for (const groups of Object.values(uninstalled.hooks ?? {})) {
      for (const group of groups) {
        for (const hook of group.hooks) {
          expect(isOwnCommand(hook.command)).toBe(false);
        }
      }
    }
  });

  it('drops the hooks key entirely when nothing foreign remains', () => {
    const installed = mergeSettings({}, HOOKS_DIR_A);
    const uninstalled = unmergeSettings(installed);
    expect(uninstalled.hooks).toBeUndefined();
  });

  it('is a no-op on settings with no hooks key', () => {
    const settings: ClaudeSettings = { foo: 'bar' };
    expect(unmergeSettings(settings)).toEqual(settings);
  });

  it('install -> uninstall -> install round trip is stable', () => {
    let settings: ClaudeSettings = {};
    settings = mergeSettings(settings, HOOKS_DIR_A);
    settings = unmergeSettings(settings);
    settings = mergeSettings(settings, HOOKS_DIR_A);
    expect(hooksInstalled(settings).installed).toBe(true);
    for (const event of Object.keys(EVENT_SCRIPTS)) {
      const commands = settings.hooks![event]!.flatMap((g) => g.hooks.map((h) => h.command));
      expect(commands).toHaveLength(1);
    }
  });
});

describe('hooksInstalled (doctor settings-inspection logic)', () => {
  it('reports not installed on empty settings, listing all events missing', () => {
    const { installed, missing } = hooksInstalled({});
    expect(installed).toBe(false);
    expect(missing.sort()).toEqual(Object.keys(EVENT_SCRIPTS).sort());
  });

  it('reports installed once every event has an owned entry', () => {
    const settings = mergeSettings({}, HOOKS_DIR_A);
    expect(hooksInstalled(settings)).toEqual({ installed: true, missing: [] });
  });

  it('reports partial installation precisely', () => {
    const settings: ClaudeSettings = {
      hooks: {
        SessionStart: [{ hooks: [{ type: 'command', command: path.join(HOOKS_DIR_A, 'on-session-start.sh') }] }]
      }
    };
    const { installed, missing } = hooksInstalled(settings);
    expect(installed).toBe(false);
    expect(missing).not.toContain('SessionStart');
    expect(missing).toContain('Stop');
    expect(missing).toHaveLength(Object.keys(EVENT_SCRIPTS).length - 1);
  });

  it('ignores foreign hooks for the same event when deciding installed-ness', () => {
    const settings: ClaudeSettings = {
      hooks: {
        Stop: [{ hooks: [{ type: 'command', command: '/other/tool/stop.sh' }] }]
      }
    };
    expect(hooksInstalled(settings).installed).toBe(false);
    expect(hooksInstalled(settings).missing).toContain('Stop');
  });
});

describe('readSettings / writeSettings', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccidle-cli-test-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('returns {} for a missing file', () => {
    expect(readSettings(path.join(dir, 'nope.json'))).toEqual({});
  });

  it('round-trips through write/read', () => {
    const file = path.join(dir, 'nested', 'settings.json');
    const settings = mergeSettings({ existingKey: 1 }, HOOKS_DIR_A);
    writeSettings(file, settings);
    expect(readSettings(file)).toEqual(settings);
  });

  it('throws a clear error on malformed existing JSON rather than silently clobbering it', () => {
    const file = path.join(dir, 'settings.json');
    fs.writeFileSync(file, '{not valid json');
    expect(() => readSettings(file)).toThrow(/not valid JSON/);
  });
});

describe('buildRedactSed', () => {
  it('builds one s/// substitution per pattern, terminated with a trailing newline', () => {
    const sed = buildRedactSed(['sk-[A-Za-z0-9-]{10,}', 'ghp_[A-Za-z0-9]{20,}']);
    expect(sed).toBe('s/sk-[A-Za-z0-9-]{10,}/[REDACTED]/g\ns/ghp_[A-Za-z0-9]{20,}/[REDACTED]/g\n');
  });

  it('escapes literal slashes in a pattern so the sed delimiter is not broken', () => {
    const sed = buildRedactSed(['a/b']);
    expect(sed).toBe('s/a\\/b/[REDACTED]/g\n');
  });

  it('returns an empty string for no patterns', () => {
    expect(buildRedactSed([])).toBe('');
  });
});
