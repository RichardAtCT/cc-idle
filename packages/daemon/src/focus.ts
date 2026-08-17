import type { Config } from '@ccidle/shared';
import type { SessionSnapshot, SessionState } from '@ccidle/shared';
import type { TmuxClient } from './tmux.js';

/** Injected clock so tests can control time deterministically. */
export interface Clock {
  now(): number;
  /** Schedule `fn` to run after `ms`; returns a handle for cancellation. */
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout)
};

export interface AlertEvent {
  kind: 'needs-you' | 'clear';
  sessionId: string;
  /** FIFO needs-you queue, in service order. */
  queue: string[];
}

/**
 * Resolves a session's tmux pane target; source of truth is the daemon's
 * registration/session state. Async because pane ids ("%3") are resolved to
 * live 'session:window.pane' targets via a tmux call, and tmux window/pane
 * indices can change between checks.
 */
export interface PaneResolver {
  /** 'session:window.pane' for the CC pane belonging to sessionId, or null if unknown. */
  ccPaneTarget(sessionId: string): Promise<string | null>;
  /** 'session:window.pane' for the one registered game pane, or null if unregistered / no tmux. */
  gamePaneTarget(): Promise<string | null>;
}

interface PendingGraceSwitch {
  sessionId: string;
  handle: unknown;
}

/**
 * Focus policy engine (PRD §3.3). Driven by an injected tmux client, clock,
 * and pane resolver so it's fully unit-testable without a real terminal.
 *
 * Core rule: the daemon only ever auto-moves focus when the user's cursor is
 * currently in the pane it's about to move *from* (the game pane, or the
 * session's own CC pane) — never steals focus from somewhere else.
 */
export class FocusEngine {
  private readonly tmux: TmuxClient;
  private readonly clock: Clock;
  private readonly panes: PaneResolver;
  private readonly onAlert: (event: AlertEvent) => void;
  private config: Config['focus'];

  private paused = false;
  private lastAutoSwitchAt = -Infinity;
  private lastSetTarget: string | null = null;
  private manualOverrideUntil = -Infinity;
  private pendingGrace = new Map<string, PendingGraceSwitch>();
  /** FIFO needs-you queue of session ids currently HUMAN_ACTIVE and unserviced. */
  private queue: string[] = [];

  constructor(opts: {
    tmux: TmuxClient;
    clock?: Clock;
    panes: PaneResolver;
    focusConfig: Config['focus'];
    onAlert?: (event: AlertEvent) => void;
  }) {
    this.tmux = opts.tmux;
    this.clock = opts.clock ?? systemClock;
    this.panes = opts.panes;
    this.config = opts.focusConfig;
    this.onAlert = opts.onAlert ?? (() => {});
  }

  updateConfig(focusConfig: Config['focus']): void {
    this.config = focusConfig;
  }

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
  }

  isPaused(): boolean {
    return this.paused;
  }

  /** Current needs-you queue snapshot, in service order. */
  getQueue(): string[] {
    return [...this.queue];
  }

  /**
   * Check whether the pane the user is currently in was last set by this
   * engine's own auto-switch; if not (and it isn't the very first check),
   * treat it as a manual override and start the cooldown. The user's new
   * location becomes the accepted baseline immediately, so staying put
   * doesn't keep re-triggering (and re-extending) the cooldown on every
   * subsequent check.
   */
  private async detectManualOverride(): Promise<void> {
    const current = await this.tmux.currentPaneTarget();
    if (current === null) return;
    if (this.lastSetTarget !== null && current !== this.lastSetTarget) {
      this.manualOverrideUntil = this.clock.now() + this.config.manualCooldownMs;
    }
    this.lastSetTarget = current;
  }

  private inManualCooldown(): boolean {
    return this.clock.now() < this.manualOverrideUntil;
  }

  private dwellOk(): boolean {
    return this.clock.now() - this.lastAutoSwitchAt >= this.config.dwellMs;
  }

  private async doFocus(target: string): Promise<boolean> {
    const ok = await this.tmux.focusPane(target);
    if (ok) {
      this.lastSetTarget = target;
      this.lastAutoSwitchAt = this.clock.now();
    }
    return ok;
  }

  /**
   * Call for every state transition observed by the daemon. Whether *another*
   * tracked session is currently HUMAN_ACTIVE is derived from the internal
   * needs-you queue (every HUMAN_ACTIVE session passes through it), so the
   * grace-switch gate is always evaluated against live state, both when
   * scheduled and again right before it fires.
   */
  async onTransition(sessionId: string, from: SessionState, to: SessionState): Promise<void> {
    await this.detectManualOverride();

    if (to === 'HUMAN_ACTIVE' && from !== 'HUMAN_ACTIVE') {
      this.cancelGrace(sessionId);
      this.enqueue(sessionId);
      await this.tryImmediateReturn(sessionId);
      return;
    }

    if (to === 'CC_WORKING' && from !== 'CC_WORKING') {
      this.dequeue(sessionId);
      if (this.queue.length === 0) {
        this.onAlert({ kind: 'clear', sessionId, queue: [...this.queue] });
      }
      this.scheduleGraceSwitch(sessionId);
      return;
    }

    if (to === 'DEAD') {
      this.cancelGrace(sessionId);
      this.dequeue(sessionId);
    }
  }

  /**
   * Seed the queue at daemon startup (after replaying JSONL) without firing
   * alert callbacks — the TUI isn't connected yet and will get the full
   * picture via the 'hello' message instead.
   */
  seedHumanActive(sessionId: string): void {
    if (!this.queue.includes(sessionId)) this.queue.push(sessionId);
  }

  private enqueue(sessionId: string): void {
    if (!this.queue.includes(sessionId)) this.queue.push(sessionId);
    this.onAlert({ kind: 'needs-you', sessionId, queue: [...this.queue] });
  }

  private dequeue(sessionId: string): void {
    this.queue = this.queue.filter((id) => id !== sessionId);
  }

  private cancelGrace(sessionId: string): void {
    const pending = this.pendingGrace.get(sessionId);
    if (pending) {
      this.clock.clearTimeout(pending.handle);
      this.pendingGrace.delete(sessionId);
    }
  }

  /**
   * → HUMAN_ACTIVE while user is in the game pane: focus that session's pane
   * immediately. Deliberately NOT gated by manual-override cooldown or
   * dwell — those exist to avoid fighting the user over the CC/game split,
   * but a needs-you signal is safety-critical and must always get through.
   */
  private async tryImmediateReturn(sessionId: string): Promise<void> {
    if (this.paused || !this.config.enabled) return;
    const current = await this.tmux.currentPaneTarget();
    const gamePane = await this.panes.gamePaneTarget();
    if (current === null || gamePane === null || current !== gamePane) return;
    const ccTarget = await this.panes.ccPaneTarget(sessionId);
    if (!ccTarget) return;
    await this.doFocus(ccTarget);
  }

  /** → CC_WORKING (the session whose pane you're in): after graceMs, switch to the game pane. */
  private scheduleGraceSwitch(sessionId: string): void {
    if (this.paused || !this.config.enabled) return;
    this.cancelGrace(sessionId);
    const handle = this.clock.setTimeout(() => {
      this.pendingGrace.delete(sessionId);
      void this.executeGraceSwitch(sessionId);
    }, this.config.graceMs);
    this.pendingGrace.set(sessionId, { sessionId, handle });
  }

  private async executeGraceSwitch(sessionId: string): Promise<void> {
    if (this.paused || !this.config.enabled) return;
    if (this.queue.length > 0) return;
    await this.detectManualOverride();
    if (this.inManualCooldown()) return;
    if (!this.dwellOk()) return;

    const current = await this.tmux.currentPaneTarget();
    const ccTarget = await this.panes.ccPaneTarget(sessionId);
    if (current === null || ccTarget === null || current !== ccTarget) return;

    const gamePane = await this.panes.gamePaneTarget();
    if (!gamePane) return;
    await this.doFocus(gamePane);
  }

  /** IPC 'focus-session': explicit user request to jump to a session's pane (queue keybinds). */
  async focusSession(sessionId: string): Promise<boolean> {
    const target = await this.panes.ccPaneTarget(sessionId);
    if (!target) return false;
    this.dequeue(sessionId);
    return this.doFocus(target);
  }

  dispose(): void {
    for (const pending of this.pendingGrace.values()) this.clock.clearTimeout(pending.handle);
    this.pendingGrace.clear();
  }
}

/** Convenience type export for callers that only need the snapshot fields FocusEngine cares about. */
export type FocusableSession = Pick<SessionSnapshot, 'sessionId' | 'state' | 'pane' | 'paneTarget'>;
