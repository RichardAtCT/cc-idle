import fs from 'node:fs';
import type { Config } from '@ccidle/shared';

const LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LEVELS)[number];

export interface Logger {
  debug: (msg: string) => void;
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
}

/** Minimal leveled logger: stderr + daemonLogPath(), honouring config.log.level. */
export function createLogger(logFilePath: string, level: Config['log']['level']): Logger {
  const threshold = LEVELS.indexOf(level);

  const write = (msgLevel: LogLevel, msg: string): void => {
    if (LEVELS.indexOf(msgLevel) < threshold) return;
    const line = `${new Date().toISOString()} [${msgLevel}] ${msg}`;
    process.stderr.write(line + '\n');
    try {
      fs.appendFileSync(logFilePath, line + '\n');
    } catch {
      // logging must never crash the daemon
    }
  };

  return {
    debug: (msg) => write('debug', msg),
    info: (msg) => write('info', msg),
    warn: (msg) => write('warn', msg),
    error: (msg) => write('error', msg)
  };
}
