import fs from 'node:fs';
import path from 'node:path';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import {
  ccidleHome,
  eventsDir,
  pidFilePath,
  socketPath,
  parseEventLine
} from '@ccidle/shared';
import { hooksDir, moduleDir } from './repo-paths.js';
import { defaultSettingsPath, hooksInstalled, readSettings } from './settings.js';
import { createTmuxRunner } from './tmux.js';

const execFileAsync = promisify(execFileCb);

export type CheckStatus = 'ok' | 'warn' | 'crit';

export interface DoctorCheck {
  name: string;
  status: CheckStatus;
  detail: string;
}

export interface DoctorReport {
  checks: DoctorCheck[];
  fireTestEvent?: {
    ranOk: boolean;
    latencyMs: number;
    detail: string;
  };
}

/** Scan $PATH for an executable without spawning it (cheap, side-effect-free existence check). */
export function findOnPath(bin: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const pathEnv = env.PATH ?? '';
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, bin);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // not here; keep scanning
    }
  }
  return null;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'; // exists, just not ours
  }
}

export function countSessionFiles(dir: string): number {
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return 0;
  }
  return entries.filter((f) => f.endsWith('.jsonl') && !f.endsWith('.archive.jsonl')).length;
}

export interface DoctorOptions {
  settingsPath?: string;
  fireTestEvent?: boolean;
  env?: NodeJS.ProcessEnv;
}

export async function runDoctor(opts: DoctorOptions = {}): Promise<DoctorReport> {
  const env = opts.env ?? process.env;
  const checks: DoctorCheck[] = [];

  // tmux
  const tmuxRunner = createTmuxRunner();
  const tmuxVersion = await tmuxRunner.version();
  const insideTmux = tmuxRunner.insideTmux(env);
  if (tmuxVersion) {
    checks.push({
      name: 'tmux',
      status: 'ok',
      detail: `${tmuxVersion}${insideTmux ? ' (inside tmux)' : ' (not inside tmux)'}`
    });
  } else {
    checks.push({
      name: 'tmux',
      status: 'warn',
      detail: 'not found — auto-focus and layout features disabled (PRD G5)'
    });
  }

  // jq
  const jqPath = findOnPath('jq', env);
  if (jqPath) {
    let version = '';
    try {
      const { stdout } = await execFileAsync('jq', ['--version']);
      version = stdout.trim();
    } catch {
      version = jqPath;
    }
    checks.push({ name: 'jq', status: 'ok', detail: version });
  } else {
    checks.push({
      name: 'jq',
      status: 'warn',
      detail: 'not found — hook shims fall back to shell-only mode (session_id only)'
    });
  }

  // claude CLI
  const claudePath = findOnPath('claude', env);
  checks.push(
    claudePath
      ? { name: 'claude', status: 'ok', detail: claudePath }
      : { name: 'claude', status: 'warn', detail: 'claude CLI not found on PATH' }
  );

  // node
  checks.push({ name: 'node', status: 'ok', detail: process.version });

  // CCIDLE_HOME / events dir
  const home = ccidleHome(env);
  const evDir = eventsDir(env);
  const evDirExists = fs.existsSync(evDir);
  const sessionCount = countSessionFiles(evDir);
  checks.push({
    name: 'CCIDLE_HOME',
    status: 'ok',
    detail: `${home} (events dir ${evDirExists ? 'exists' : 'missing'}, ${sessionCount} session file(s))`
  });

  // hooks installed in settings.json
  const settingsPath = opts.settingsPath ?? defaultSettingsPath();
  let hooksStatus: CheckStatus = 'crit';
  let hooksDetail: string;
  try {
    const settings = readSettings(settingsPath);
    const { installed, missing } = hooksInstalled(settings);
    hooksStatus = installed ? 'ok' : 'crit';
    hooksDetail = installed
      ? `all events registered in ${settingsPath}`
      : `missing events in ${settingsPath}: ${missing.join(', ')} — run 'ccidle install'`;
  } catch (err) {
    hooksDetail = (err as Error).message;
  }
  checks.push({ name: 'hooks-installed', status: hooksStatus, detail: hooksDetail });

  // daemon
  const pidPath = pidFilePath(env);
  const sockPath = socketPath(env);
  let daemonAlive = false;
  let daemonDetail = 'not running';
  try {
    const pidRaw = fs.readFileSync(pidPath, 'utf8').trim();
    const pid = Number(pidRaw);
    if (Number.isInteger(pid) && pid > 0 && isProcessAlive(pid)) {
      daemonAlive = true;
      daemonDetail = `running (pid ${pid})`;
    } else {
      daemonDetail = `not running (stale pidfile at ${pidPath})`;
    }
  } catch {
    daemonDetail = `not running (no pidfile at ${pidPath})`;
  }
  const socketExists = fs.existsSync(sockPath);
  checks.push({
    name: 'daemon',
    status: daemonAlive && socketExists ? 'ok' : 'warn',
    detail: `${daemonDetail}; socket ${socketExists ? 'present' : 'absent'} at ${sockPath}`
  });

  const report: DoctorReport = { checks };

  if (opts.fireTestEvent) {
    report.fireTestEvent = await fireTestEvent(env);
  }

  return report;
}

async function fireTestEvent(env: NodeJS.ProcessEnv): Promise<DoctorReport['fireTestEvent']> {
  const { spawnSync } = await import('node:child_process');
  const scriptDir = hooksDir(moduleDir(import.meta.url));
  const script = path.join(scriptDir, 'on-session-start.sh');
  const home = ccidleHome(env);
  const sessionId = 'doctor-test';
  const evFile = path.join(eventsDir(env), `${sessionId}.jsonl`);

  const fixture = JSON.stringify({
    session_id: sessionId,
    hook_event_name: 'SessionStart',
    cwd: process.cwd(),
    model: 'doctor-fixture'
  });

  if (!fs.existsSync(script)) {
    return { ranOk: false, latencyMs: 0, detail: `hook script not found at ${script}` };
  }

  const before = fs.existsSync(evFile) ? fs.readFileSync(evFile, 'utf8').split('\n').length : 0;
  const startedAt = process.hrtime.bigint();
  const result = spawnSync(script, [], {
    input: fixture,
    env: { ...env, CCIDLE_HOME: home },
    encoding: 'utf8'
  });
  const latencyMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;

  if (result.status !== 0) {
    return { ranOk: false, latencyMs, detail: `hook exited ${result.status}: ${result.stderr}` };
  }

  let lines: string[] = [];
  try {
    lines = fs
      .readFileSync(evFile, 'utf8')
      .split('\n')
      .filter((l) => l.trim() !== '');
  } catch {
    return { ranOk: false, latencyMs, detail: `event file not found: ${evFile}` };
  }

  const appeared = lines.length >= before && lines.some((l) => parseEventLine(l)?.session_id === sessionId);
  return {
    ranOk: appeared,
    latencyMs,
    detail: appeared
      ? `envelope landed in ${evFile}`
      : `no matching envelope found in ${evFile}`
  };
}

export function formatDoctorReport(report: DoctorReport): string {
  const lines: string[] = [];
  for (const check of report.checks) {
    const marker = check.status === 'ok' ? 'OK  ' : check.status === 'warn' ? 'WARN' : 'CRIT';
    lines.push(`[${marker}] ${check.name}: ${check.detail}`);
  }
  if (report.fireTestEvent) {
    const t = report.fireTestEvent;
    lines.push(
      `[${t.ranOk ? 'OK  ' : 'CRIT'}] fire-test-event: ${t.detail} (${t.latencyMs.toFixed(2)}ms, budget <10ms)`
    );
  }
  return lines.join('\n');
}

export function doctorExitCode(report: DoctorReport, strict: boolean): number {
  if (!strict) return 0;
  const hasCrit =
    report.checks.some((c) => c.status === 'crit') || report.fireTestEvent?.ranOk === false;
  return hasCrit ? 1 : 0;
}
