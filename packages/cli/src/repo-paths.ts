import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Locate the monorepo root by walking up from `startDir` looking for the
 * pnpm workspace marker file. Works whether this module is running from
 * packages/cli/src (ts-node/vitest) or packages/cli/dist (built) — both are
 * a fixed number of levels under the repo root, but we search rather than
 * hardcode a depth so the CLI stays robust if it's ever relocated.
 */
export function findRepoRoot(startDir: string): string {
  let dir = path.resolve(startDir);
  for (;;) {
    if (fs.existsSync(path.join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return path.resolve(startDir); // not found; caller handles missing hooks
    dir = parent;
  }
}

/** Directory this module is executing from (src in dev, dist after build). */
export function moduleDir(importMetaUrl: string): string {
  return path.dirname(fileURLToPath(importMetaUrl));
}

/** Absolute path to the repo's hooks/ directory. */
export function hooksDir(startDir: string): string {
  return path.join(findRepoRoot(startDir), 'hooks');
}

/** Absolute path to the (not-yet-built-until-daemon-package-lands) ccidled entry point. */
export function daemonBinPath(startDir: string): string {
  return path.join(findRepoRoot(startDir), 'packages', 'daemon', 'dist', 'cli.js');
}

/** Absolute path to the ccidle-tui entry point. */
export function tuiBinPath(startDir: string): string {
  return path.join(findRepoRoot(startDir), 'packages', 'tui', 'dist', 'cli.js');
}

export const EVENT_SCRIPTS: Record<string, string> = {
  SessionStart: 'on-session-start.sh',
  SessionEnd: 'on-session-end.sh',
  UserPromptSubmit: 'on-user-prompt-submit.sh',
  PreToolUse: 'on-pre-tool-use.sh',
  PostToolUse: 'on-post-tool-use.sh',
  Stop: 'on-stop.sh',
  SubagentStop: 'on-subagent-stop.sh',
  Notification: 'on-notification.sh'
};

export const MATCHER_EVENTS = new Set(['PreToolUse', 'PostToolUse']);
