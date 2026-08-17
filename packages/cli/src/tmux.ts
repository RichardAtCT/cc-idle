import { execFile as execFileCb, spawn, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFileCb);

/** Minimal shape of the piece of `child_process` this module needs — lets tests inject a fake. */
export type ExecFile = (
  file: string,
  args: string[]
) => Promise<{ stdout: string; stderr: string }>;

export interface TmuxRunner {
  isAvailable(): Promise<boolean>;
  version(): Promise<string | null>;
  insideTmux(env?: NodeJS.ProcessEnv): boolean;
  /** `session:window.pane` (or just pane id) of wherever the tmux client's cursor currently is. */
  currentPane(): Promise<string | null>;
  /** Name of the tmux session the calling process is attached to (only meaningful when insideTmux()). */
  currentSessionName(): Promise<string | null>;
  newWindow(opts: { target: string; name: string }): Promise<string>;
  splitWindow(opts: { target: string; horizontal?: boolean }): Promise<string>;
  sendKeys(opts: { target: string; keys: string }): Promise<void>;
  /** Creates a detached session and returns the pane id of its initial pane. */
  newSessionDetached(opts: { name: string; windowName?: string }): Promise<string>;
  hasSession(name: string): Promise<boolean>;
  /** Replaces the current process with an interactive `tmux attach`; resolves on exit for testability. */
  attach(opts: { name: string }): Promise<number>;
}

export function createTmuxRunner(exec: ExecFile = execAsyncDefault): TmuxRunner {
  return {
    async isAvailable() {
      try {
        await exec('tmux', ['-V']);
        return true;
      } catch {
        return false;
      }
    },

    async version() {
      try {
        const { stdout } = await exec('tmux', ['-V']);
        return stdout.trim() || null;
      } catch {
        return null;
      }
    },

    insideTmux(env: NodeJS.ProcessEnv = process.env) {
      return Boolean(env.TMUX && env.TMUX !== '');
    },

    async currentPane() {
      try {
        const { stdout } = await exec('tmux', [
          'display-message',
          '-p',
          '#{session_name}:#{window_index}.#{pane_index}'
        ]);
        const value = stdout.trim();
        return value || null;
      } catch {
        return null;
      }
    },

    async currentSessionName() {
      try {
        const { stdout } = await exec('tmux', ['display-message', '-p', '#{session_name}']);
        const value = stdout.trim();
        return value || null;
      } catch {
        return null;
      }
    },

    async newWindow(opts) {
      const { stdout } = await exec('tmux', [
        'new-window',
        '-P',
        '-F',
        '#{pane_id}',
        '-t',
        opts.target,
        '-n',
        opts.name
      ]);
      return stdout.trim();
    },

    async splitWindow(opts) {
      const { stdout } = await exec('tmux', [
        'split-window',
        '-P',
        '-F',
        '#{pane_id}',
        opts.horizontal === false ? '-v' : '-h',
        '-t',
        opts.target
      ]);
      return stdout.trim();
    },

    async sendKeys(opts) {
      await exec('tmux', ['send-keys', '-t', opts.target, opts.keys, 'Enter']);
    },

    async newSessionDetached(opts) {
      const args = ['new-session', '-d', '-P', '-F', '#{pane_id}', '-s', opts.name];
      if (opts.windowName) args.push('-n', opts.windowName);
      const { stdout } = await exec('tmux', args);
      return stdout.trim();
    },

    async hasSession(name) {
      try {
        await exec('tmux', ['has-session', '-t', name]);
        return true;
      } catch {
        return false;
      }
    },

    attach(opts) {
      return new Promise((resolve) => {
        const child: ChildProcess = spawn('tmux', ['attach', '-t', opts.name], { stdio: 'inherit' });
        child.on('exit', (code) => resolve(code ?? 0));
        child.on('error', () => resolve(1));
      });
    }
  };
}

async function execAsyncDefault(file: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(file, args);
}
