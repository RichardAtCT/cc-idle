import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { ccidleHome, daemonLogPath, ensureDirs, pidFilePath, socketPath } from '@ccidle/shared';
import { daemonBinPath, moduleDir } from './repo-paths.js';

export interface DaemonStatus {
  running: boolean;
  pid?: number;
  detail: string;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function checkDaemonStatus(env: NodeJS.ProcessEnv = process.env): DaemonStatus {
  const pidPath = pidFilePath(env);
  try {
    const pid = Number(fs.readFileSync(pidPath, 'utf8').trim());
    if (Number.isInteger(pid) && pid > 0 && isProcessAlive(pid)) {
      return { running: true, pid, detail: `daemon running (pid ${pid})` };
    }
    return { running: false, detail: `stale pidfile at ${pidPath}` };
  } catch {
    return { running: false, detail: 'daemon not running (no pidfile)' };
  }
}

/** Polls for the daemon's unix socket to appear after a fresh spawn, up to timeoutMs. */
export async function waitForSocket(env: NodeJS.ProcessEnv = process.env, timeoutMs = 3000): Promise<boolean> {
  const sockPath = socketPath(env);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(sockPath)) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return fs.existsSync(sockPath);
}

export interface EnsureDaemonResult {
  started: boolean;
  alreadyRunning: boolean;
  ok: boolean;
  detail: string;
  pid?: number;
}

/** Ensures ccidled is running, spawning it detached if necessary. Never throws. */
export function ensureDaemonRunning(env: NodeJS.ProcessEnv = process.env): EnsureDaemonResult {
  const status = checkDaemonStatus(env);
  if (status.running) {
    return { started: false, alreadyRunning: true, ok: true, detail: status.detail, pid: status.pid };
  }

  const binPath = daemonBinPath(moduleDir(import.meta.url));
  if (!fs.existsSync(binPath)) {
    return {
      started: false,
      alreadyRunning: false,
      ok: false,
      detail: `ccidled not found at ${binPath} (daemon package not built yet)`
    };
  }

  try {
    ensureDirs(env);
    const logPath = daemonLogPath(env);
    const logFd = fs.openSync(logPath, 'a');
    const child = spawn(process.execPath, [binPath], {
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env: { ...env, CCIDLE_HOME: ccidleHome(env) }
    });
    child.unref();
    fs.closeSync(logFd);
    return {
      started: true,
      alreadyRunning: false,
      ok: true,
      detail: `spawned ccidled (pid ${child.pid}), logging to ${logPath}, socket at ${socketPath(env)}`,
      pid: child.pid
    };
  } catch (err) {
    return {
      started: false,
      alreadyRunning: false,
      ok: false,
      detail: `failed to spawn ccidled: ${(err as Error).message}`
    };
  }
}
