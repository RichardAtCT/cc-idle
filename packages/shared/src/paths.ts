import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

/**
 * All on-disk state lives under ~/.ccidle (override with CCIDLE_HOME,
 * which tests and the hook shims both honour).
 */
export function ccidleHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.CCIDLE_HOME && env.CCIDLE_HOME !== ''
    ? env.CCIDLE_HOME
    : path.join(os.homedir(), '.ccidle');
}

export function eventsDir(env?: NodeJS.ProcessEnv): string {
  return path.join(ccidleHome(env), 'events');
}

export function eventFilePath(sessionId: string, env?: NodeJS.ProcessEnv): string {
  // session ids come from CC hook input; strip path separators defensively
  const safe = sessionId.replace(/[/\\]/g, '_');
  return path.join(eventsDir(env), `${safe}.jsonl`);
}

export function archiveFilePath(sessionId: string, env?: NodeJS.ProcessEnv): string {
  const safe = sessionId.replace(/[/\\]/g, '_');
  return path.join(eventsDir(env), `${safe}.archive.jsonl`);
}

export function socketPath(env?: NodeJS.ProcessEnv): string {
  return path.join(ccidleHome(env), 'ccidled.sock');
}

export function pidFilePath(env?: NodeJS.ProcessEnv): string {
  return path.join(ccidleHome(env), 'ccidled.pid');
}

export function configPath(env?: NodeJS.ProcessEnv): string {
  return path.join(ccidleHome(env), 'config.json');
}

export function daemonLogPath(env?: NodeJS.ProcessEnv): string {
  return path.join(ccidleHome(env), 'ccidled.log');
}

/** Registration records written by `ccidle register` (PRD §3.5). */
export function registrationsPath(env?: NodeJS.ProcessEnv): string {
  return path.join(ccidleHome(env), 'registrations.json');
}

/** Game save file (mechanics PRD; written via the save-file abstraction). */
export function gameSavePath(env?: NodeJS.ProcessEnv): string {
  return path.join(ccidleHome(env), 'game', 'save.json');
}

/** Imported historical sessions (backtesting corpus), one <session_id>.jsonl each. */
export function corpusDir(env?: NodeJS.ProcessEnv): string {
  return path.join(ccidleHome(env), 'corpus');
}

/** Import idempotency manifest (source hash → output mapping). */
export function corpusManifestPath(env?: NodeJS.ProcessEnv): string {
  return path.join(corpusDir(env), 'manifest.json');
}

/** Raw transcript snapshots, one dated tree per `ccidle corpus snapshot` run. */
export function corpusRawDir(env?: NodeJS.ProcessEnv): string {
  return path.join(ccidleHome(env), 'corpus-raw');
}

/** Claude Code's own data dir — read-only territory for ccidle. */
export function defaultClaudeDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.CLAUDE_CONFIG_DIR && env.CLAUDE_CONFIG_DIR !== ''
    ? env.CLAUDE_CONFIG_DIR
    : path.join(os.homedir(), '.claude');
}

export function ensureDirs(env?: NodeJS.ProcessEnv): void {
  fs.mkdirSync(eventsDir(env), { recursive: true });
}
