import { execFile } from 'node:child_process';
import fs from 'node:fs';

/**
 * Thin injectable wrapper over the `tmux` CLI (PRD §3.3). Every method is
 * safe to call when tmux is absent or the call fails — they resolve to
 * null/false rather than throwing, so callers never need try/catch.
 */
export interface TmuxClient {
  isAvailable(): Promise<boolean>;
  /** '#{session_name}:#{window_index}.#{pane_index}' of the pane the user's cursor is currently in. */
  currentPaneTarget(): Promise<string | null>;
  /** '#{pane_id}' (e.g. "%3") of the pane the user's cursor is currently in. */
  currentPaneId(): Promise<string | null>;
  /** Resolve a stable pane id (e.g. "%3") to its current 'session:window.pane' target. */
  resolvePaneTarget(paneId: string): Promise<string | null>;
  /** Move the user's cursor to a 'session:window.pane' target, jumping tmux sessions if needed. */
  focusPane(target: string): Promise<boolean>;
  /** Ring the terminal bell in a pane (best-effort attention signal). */
  bell(target?: string): Promise<boolean>;
}

function run(args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('tmux', args, { timeout: 2000 }, (error, stdout) => {
      if (error) {
        resolve(null);
        return;
      }
      resolve(stdout.toString());
    });
  });
}

export class RealTmuxClient implements TmuxClient {
  private available: boolean | null = null;

  async isAvailable(): Promise<boolean> {
    if (this.available !== null) return this.available;
    const out = await run(['display-message', '-p', 'ok']);
    this.available = out !== null;
    return this.available;
  }

  async currentPaneTarget(): Promise<string | null> {
    const out = await run(['display-message', '-p', '#{session_name}:#{window_index}.#{pane_index}']);
    return out ? out.trim() : null;
  }

  async currentPaneId(): Promise<string | null> {
    const out = await run(['display-message', '-p', '#{pane_id}']);
    return out ? out.trim() : null;
  }

  async resolvePaneTarget(paneId: string): Promise<string | null> {
    const out = await run([
      'list-panes',
      '-a',
      '-F',
      '#{pane_id} #{session_name}:#{window_index}.#{pane_index}'
    ]);
    if (!out) return null;
    for (const line of out.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const spaceIdx = trimmed.indexOf(' ');
      if (spaceIdx === -1) continue;
      const id = trimmed.slice(0, spaceIdx);
      const target = trimmed.slice(spaceIdx + 1);
      if (id === paneId) return target;
    }
    return null;
  }

  async focusPane(target: string): Promise<boolean> {
    const sessionName = target.split(':')[0];
    if (!sessionName) return false;
    const switchOk = (await run(['switch-client', '-t', sessionName])) !== null;
    const selectWindowOk = (await run(['select-window', '-t', target])) !== null;
    const selectPaneOk = (await run(['select-pane', '-t', target])) !== null;
    // switch-client fails when the daemon isn't attached to a client itself
    // (e.g. run headless); select-window/select-pane are still meaningful.
    return switchOk || selectWindowOk || selectPaneOk;
  }

  async bell(target?: string): Promise<boolean> {
    // Write a literal BEL directly to the pane's tty rather than sending it
    // as "keys" — send-keys would land in whatever the user is mid-typing.
    const ttyArgs = target ? ['display-message', '-p', '-t', target, '#{pane_tty}'] : ['display-message', '-p', '#{pane_tty}'];
    const tty = await run(ttyArgs);
    if (!tty) return false;
    try {
      fs.writeFileSync(tty.trim(), '');
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * In-memory TmuxClient for tests: no real tmux process involved. `currentTarget`
 * is mutable so a test can simulate the user moving their cursor mid-scenario.
 */
export class FakeTmuxClient implements TmuxClient {
  available = true;
  currentTarget = 'work:0.0';
  /** paneId -> target mapping, as `tmux list-panes -a` would report. */
  panes = new Map<string, string>();
  focusCalls: string[] = [];
  bellCalls: (string | undefined)[] = [];

  async isAvailable(): Promise<boolean> {
    return this.available;
  }

  async currentPaneTarget(): Promise<string | null> {
    return this.available ? this.currentTarget : null;
  }

  async currentPaneId(): Promise<string | null> {
    for (const [id, target] of this.panes) {
      if (target === this.currentTarget) return id;
    }
    return null;
  }

  async resolvePaneTarget(paneId: string): Promise<string | null> {
    return this.panes.get(paneId) ?? null;
  }

  async focusPane(target: string): Promise<boolean> {
    if (!this.available) return false;
    this.focusCalls.push(target);
    this.currentTarget = target;
    return true;
  }

  async bell(target?: string): Promise<boolean> {
    this.bellCalls.push(target);
    return this.available;
  }
}
