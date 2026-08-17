import fs from 'node:fs';
import path from 'node:path';
import { logsDir, tuiLogPath } from '@ccidle/shared';

/**
 * While Ink owns the terminal, stdout and stderr belong to the renderer alone.
 * Anything else written there lands between frames, shifts the cursor, and
 * breaks Ink's repaint arithmetic — the frame scrolls instead of updating.
 * So the TUI logs to a file, and `console.*` is redirected to it for the
 * lifetime of the render.
 */

let stream: fs.WriteStream | undefined;

function open(): fs.WriteStream {
  if (!stream) {
    const file = tuiLogPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    stream = fs.createWriteStream(file, { flags: 'a' });
  }
  return stream;
}

export function log(...parts: unknown[]): void {
  const text = parts
    .map((p) => (typeof p === 'string' ? p : inspect(p)))
    .join(' ');
  open().write(`${new Date().toISOString()} ${text}\n`);
}

function inspect(value: unknown): string {
  if (value instanceof Error) return value.stack ?? value.message;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Redirects console output to the log file and returns a restore function.
 * Call before `render()`; call the result after the app exits.
 */
export function captureConsole(): () => void {
  const original = {
    log: console.log,
    info: console.info,
    warn: console.warn,
    error: console.error,
    debug: console.debug
  };
  console.log = (...args: unknown[]) => log('[log]', ...args);
  console.info = (...args: unknown[]) => log('[info]', ...args);
  console.warn = (...args: unknown[]) => log('[warn]', ...args);
  console.error = (...args: unknown[]) => log('[error]', ...args);
  console.debug = (...args: unknown[]) => log('[debug]', ...args);

  return () => {
    Object.assign(console, original);
  };
}

/** Where the log lives, for `ccidle doctor` and error messages. */
export { tuiLogPath, logsDir };
