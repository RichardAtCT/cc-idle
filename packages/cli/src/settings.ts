import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EVENT_SCRIPTS, MATCHER_EVENTS } from './repo-paths.js';

/**
 * Pure functions for reading, merging, and writing Claude Code's
 * ~/.claude/settings.json hooks section (PRD §3.1, §7 "installer writes
 * absolute paths into settings.json").
 */

export interface HookCommand {
  type: 'command';
  command: string;
  [key: string]: unknown;
}

export interface HookGroup {
  matcher?: string;
  hooks: HookCommand[];
  [key: string]: unknown;
}

export type HooksSection = Record<string, HookGroup[]>;

export interface ClaudeSettings {
  hooks?: HooksSection;
  [key: string]: unknown;
}

/** Marker substring used to identify hook entries ccidle owns, for both install-dedup and uninstall. */
const OWN_HOOK_MARKER = '/hooks/on-';

export function isOwnCommand(command: string): boolean {
  return command.includes(OWN_HOOK_MARKER);
}

/** Build the hooks fragment ccidle registers, keyed by Claude Code event name. */
export function buildHookFragment(hooksDirAbs: string): HooksSection {
  const fragment: HooksSection = {};
  for (const [event, script] of Object.entries(EVENT_SCRIPTS)) {
    const command = path.join(hooksDirAbs, script);
    const group: HookGroup = MATCHER_EVENTS.has(event)
      ? { matcher: '*', hooks: [{ type: 'command', command }] }
      : { hooks: [{ type: 'command', command }] };
    fragment[event] = [group];
  }
  return fragment;
}

/** Remove ccidle-owned hook entries from a list of hook groups, dropping now-empty groups. */
function stripOwnHooks(groups: HookGroup[]): HookGroup[] {
  const result: HookGroup[] = [];
  for (const group of groups) {
    const keptHooks = group.hooks.filter((h) => !isOwnCommand(h.command));
    if (keptHooks.length > 0) {
      result.push({ ...group, hooks: keptHooks });
    }
  }
  return result;
}

/**
 * Deep-merge the ccidle hook fragment into existing settings, preserving
 * everything else untouched. Idempotent: any previously-installed ccidle
 * entries (even pointing at a different hooks/ path, e.g. a moved checkout)
 * are stripped first, then the canonical fragment is appended — so running
 * install twice (or after a repo move) never yields duplicates.
 */
export function mergeSettings(existing: ClaudeSettings, hooksDirAbs: string): ClaudeSettings {
  const fragment = buildHookFragment(hooksDirAbs);
  const nextHooks: HooksSection = { ...(existing.hooks ?? {}) };
  for (const [event, groups] of Object.entries(fragment)) {
    const currentGroups = nextHooks[event] ?? [];
    const others = stripOwnHooks(currentGroups);
    nextHooks[event] = [...others, ...groups];
  }
  return { ...existing, hooks: nextHooks };
}

/** Remove exactly the entries install added (matched by command path containing '/hooks/on-'). */
export function unmergeSettings(existing: ClaudeSettings): ClaudeSettings {
  if (!existing.hooks) return existing;
  const nextHooks: HooksSection = {};
  for (const [event, groups] of Object.entries(existing.hooks)) {
    const stripped = stripOwnHooks(groups);
    if (stripped.length > 0) nextHooks[event] = stripped;
  }
  const next: ClaudeSettings = { ...existing };
  if (Object.keys(nextHooks).length > 0) {
    next.hooks = nextHooks;
  } else {
    delete next.hooks;
  }
  return next;
}

/** True if every ccidle event has at least one owned hook command registered. */
export function hooksInstalled(settings: ClaudeSettings): { installed: boolean; missing: string[] } {
  const missing: string[] = [];
  for (const event of Object.keys(EVENT_SCRIPTS)) {
    const groups = settings.hooks?.[event] ?? [];
    const hasOwn = groups.some((g) => g.hooks.some((h) => isOwnCommand(h.command)));
    if (!hasOwn) missing.push(event);
  }
  return { installed: missing.length === 0, missing };
}

export function defaultSettingsPath(): string {
  return path.join(os.homedir(), '.claude', 'settings.json');
}

export function readSettings(settingsPath: string): ClaudeSettings {
  let raw: string;
  try {
    raw = fs.readFileSync(settingsPath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw err;
  }
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as ClaudeSettings;
    }
    throw new Error('settings.json root is not an object');
  } catch (err) {
    throw new Error(
      `Refusing to overwrite ${settingsPath}: it exists but is not valid JSON (${(err as Error).message}).`
    );
  }
}

export function writeSettings(settingsPath: string, settings: ClaudeSettings): void {
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf8');
}

/** Build the sed script content for $CCIDLE_HOME/redact.sed from config.log.redactPatterns. */
export function buildRedactSed(patterns: string[]): string {
  const lines = patterns.map((p) => `s/${escapeForSedDelimiter(p)}/[REDACTED]/g`);
  return lines.join('\n') + (lines.length > 0 ? '\n' : '');
}

function escapeForSedDelimiter(pattern: string): string {
  return pattern.replace(/\//g, '\\/');
}
