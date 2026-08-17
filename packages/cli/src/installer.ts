import fs from 'node:fs';
import path from 'node:path';
import { ccidleHome, ensureDirs, loadConfig } from '@ccidle/shared';
import { hooksDir, moduleDir } from './repo-paths.js';
import {
  buildHookFragment,
  buildRedactSed,
  defaultSettingsPath,
  mergeSettings,
  readSettings,
  unmergeSettings,
  writeSettings
} from './settings.js';

export interface InstallOptions {
  settingsPath?: string;
  dryRun?: boolean;
  hooksDirOverride?: string;
}

export function resolveHooksDir(override?: string): string {
  return override ?? hooksDir(moduleDir(import.meta.url));
}

export function runInstall(opts: InstallOptions = {}): void {
  const hooksDirAbs = resolveHooksDir(opts.hooksDirOverride);
  const settingsPath = opts.settingsPath ?? defaultSettingsPath();

  if (opts.dryRun) {
    const fragment = buildHookFragment(hooksDirAbs);
    process.stdout.write(JSON.stringify({ hooks: fragment }, null, 2) + '\n');
    return;
  }

  const existing = readSettings(settingsPath);
  const next = mergeSettings(existing, hooksDirAbs);
  writeSettings(settingsPath, next);

  const config = loadConfig();
  ensureDirs();
  const redactSedPath = path.join(ccidleHome(), 'redact.sed');
  fs.writeFileSync(redactSedPath, buildRedactSed(config.log.redactPatterns), 'utf8');

  const events = Object.keys(next.hooks ?? {});
  console.log(`ccidle: installed ${events.length} hook events into ${settingsPath}`);
  console.log(`ccidle: hooks dir  ${hooksDirAbs}`);
  console.log(`ccidle: redact.sed (${config.log.redactPatterns.length} patterns) written to ${redactSedPath}`);
}

export interface UninstallOptions {
  settingsPath?: string;
}

export function runUninstall(opts: UninstallOptions = {}): void {
  const settingsPath = opts.settingsPath ?? defaultSettingsPath();
  const existing = readSettings(settingsPath);
  const next = unmergeSettings(existing);
  writeSettings(settingsPath, next);
  console.log(`ccidle: removed ccidle hooks from ${settingsPath}`);
}
