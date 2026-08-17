import fs from 'node:fs';
import {
  ensureDirs,
  eventsDir,
  eventFilePath,
  gameSavePath,
  socketPath,
  pidFilePath,
  daemonLogPath,
  loadConfig,
  type SessionSnapshot,
  type SessionState
} from '@ccidle/shared';
import type { GameState } from '@ccidle/game';
import { Watcher } from './watcher.js';
import { GameHost } from './game-host.js';
import { applyEvent, checkStale, initSnapshot } from './state-machine.js';
import { FocusEngine, systemClock, type PaneResolver } from './focus.js';
import { RealTmuxClient, type TmuxClient } from './tmux.js';
import { TranscriptReader } from './transcripts.js';
import { Rotator } from './rotation.js';
import { IpcServer } from './ipc-server.js';
import { RegistrationStore } from './registrations.js';
import { createLogger, type Logger } from './logger.js';

export const DAEMON_VERSION = '0.1.0';
const STALE_CHECK_INTERVAL_MS = 5000;
const ROTATION_CHECK_INTERVAL_MS = 60000;

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Single-instance enforcement via pidfile: if a pidfile exists and the pid
 * it names is still alive, refuse to start a second daemon. Otherwise
 * (missing, unreadable, or stale) claim it with our own pid.
 */
export function claimPidfile(path: string): void {
  try {
    const raw = fs.readFileSync(path, 'utf8').trim();
    const existingPid = Number.parseInt(raw, 10);
    if (Number.isInteger(existingPid) && existingPid > 0 && isProcessAlive(existingPid)) {
      throw new DaemonAlreadyRunningError(existingPid);
    }
  } catch (error) {
    if (error instanceof DaemonAlreadyRunningError) throw error;
    // missing/unreadable pidfile — proceed to claim it
  }
  fs.writeFileSync(path, String(process.pid));
}

export class DaemonAlreadyRunningError extends Error {
  constructor(public readonly pid: number) {
    super(`ccidled is already running (pid ${pid})`);
  }
}

export interface DaemonHandle {
  logger: Logger;
  stop(): Promise<void>;
}

/** Wires watcher → state machines → focus engine → ipc server (PRD §3.3). */
export async function startDaemon(env: NodeJS.ProcessEnv = process.env): Promise<DaemonHandle> {
  ensureDirs(env);
  const config = loadConfig(undefined, env);
  const logger = createLogger(daemonLogPath(env), config.log.level);

  claimPidfile(pidFilePath(env));

  const sessions = new Map<string, SessionSnapshot>();
  const tmux: TmuxClient = new RealTmuxClient();
  const registrations = new RegistrationStore(env);
  const transcripts = new TranscriptReader();
  const tmuxAvailable = await tmux.isAvailable();

  // Game host: throttle state pushes so event bursts (startup replay, busy
  // turns) don't flood connected TUIs with full-state broadcasts.
  const GAME_BROADCAST_THROTTLE_MS = 150;
  let pendingGameState: GameState | null = null;
  let gameBroadcastTimer: NodeJS.Timeout | null = null;
  const broadcastGameState = (game: GameState): void => {
    if (gameBroadcastTimer) {
      pendingGameState = game;
      return;
    }
    ipc.broadcastGameState(game as unknown as Record<string, unknown>);
    gameBroadcastTimer = setTimeout(() => {
      gameBroadcastTimer = null;
      if (pendingGameState) {
        const next = pendingGameState;
        pendingGameState = null;
        broadcastGameState(next);
      }
    }, GAME_BROADCAST_THROTTLE_MS);
    gameBroadcastTimer.unref?.();
  };
  const gameHost = new GameHost({
    savePath: gameSavePath(env),
    broadcast: broadcastGameState,
    logger
  });

  const watcher = new Watcher(eventsDir(env));
  const rotator = new Rotator(eventsDir(env), watcher, logger, (filePath) => gameHost.handleFileReset(filePath));

  const paneResolver: PaneResolver = {
    async ccPaneTarget(sessionId) {
      const snapshot = sessions.get(sessionId);
      const paneId = snapshot?.pane ?? registrations.resolvePaneForSession(sessionId, snapshot?.cwd);
      if (!paneId) return null;
      return tmux.resolvePaneTarget(paneId);
    },
    async gamePaneTarget() {
      const paneId = registrations.getGamePane();
      if (!paneId) return null;
      return tmux.resolvePaneTarget(paneId);
    }
  };

  const focusEngine = new FocusEngine({
    tmux,
    clock: systemClock,
    panes: paneResolver,
    focusConfig: config.focus,
    onAlert: (alert) => {
      const queueSnapshots = alert.queue
        .map((id) => sessions.get(id))
        .filter((s): s is SessionSnapshot => s !== undefined);
      ipc.broadcastAlert(alert.kind, alert.sessionId, queueSnapshots);
      if (config.alerts.bell && alert.kind === 'needs-you') void tmux.bell();
    }
  });
  if (!config.focus.enabled) focusEngine.pause();

  const ipc = new IpcServer(
    socketPath(env),
    {
      daemonVersion: DAEMON_VERSION,
      sessions: () => Array.from(sessions.values()),
      isAutofocusPaused: () => focusEngine.isPaused(),
      isTmuxAvailable: () => tmuxAvailable,
      onPauseAutofocus: () => {
        focusEngine.pause();
        logger.info('autofocus paused via ipc command');
      },
      onResumeAutofocus: () => {
        focusEngine.resume();
        logger.info('autofocus resumed via ipc command');
      },
      onRegister: (msg) => {
        if (msg.role === 'game') {
          if (msg.pane) registrations.setGamePane(msg.pane);
          logger.info(`registered game pane ${msg.pane ?? '(none)'}`);
        } else {
          registrations.registerCc({ pane: msg.pane, cwd: msg.cwd, sessionId: msg.sessionId });
          logger.info(`registered cc pane ${msg.pane ?? '(none)'} cwd=${msg.cwd ?? '(none)'}`);
        }
      },
      onFocusSession: async (sessionId) => {
        await focusEngine.focusSession(sessionId);
      },
      gameState: () => gameHost.state() as unknown as Record<string, unknown>,
      onGameAction: (action) => gameHost.handleAction(action)
    },
    logger
  );

  async function transition(sessionId: string, from: SessionState, to: SessionState): Promise<void> {
    if (from === to) return;
    gameHost.handleStateChange(sessionId, to);
    await focusEngine.onTransition(sessionId, from, to);
  }

  watcher.on('event', (envelope, filePath) => {
    const sessionId = envelope.session_id;
    const nowIso = new Date().toISOString();
    const prev = sessions.get(sessionId) ?? initSnapshot(sessionId, nowIso);
    const prevState = prev.state;
    const next = applyEvent(prev, envelope, nowIso);
    sessions.set(sessionId, next);

    const transcriptPath = envelope.payload?.transcript_path;
    if (typeof transcriptPath === 'string' && transcriptPath) {
      transcripts.setTranscriptPath(sessionId, transcriptPath);
    }

    ipc.broadcastEvent(envelope);
    gameHost.handleEnvelope(envelope, filePath);

    if (next.state !== prevState) {
      if (next.state === 'HUMAN_ACTIVE') focusEngine.seedHumanActive(sessionId);
      ipc.broadcastSessionState(next, prevState);
      void transition(sessionId, prevState, next.state);
    }

    if (envelope.event === 'Stop' && transcripts.hasTranscript(sessionId)) {
      const tokenEnvelope = transcripts.poll(sessionId, eventFilePath(sessionId, env), nowIso);
      if (tokenEnvelope) watcher.poke(eventFilePath(sessionId, env));
    }
  });

  watcher.on('truncated', (filePath) => {
    gameHost.handleFileReset(filePath);
    logger.warn(`event file truncated externally: ${filePath}`);
  });

  watcher.on('error', (error) => {
    logger.error(`watcher error: ${error.message}`);
  });

  await watcher.start();

  // Seed the focus engine's queue and log a startup summary once replay is done.
  for (const snapshot of sessions.values()) {
    if (snapshot.state === 'HUMAN_ACTIVE') focusEngine.seedHumanActive(snapshot.sessionId);
  }
  logger.info(`replayed ${sessions.size} session(s) from ${eventsDir(env)}`);

  await ipc.start();
  logger.info(`ipc listening on ${socketPath(env)}`);
  logger.info(`tmux available: ${tmuxAvailable}`);

  const staleTimer = setInterval(() => {
    const nowMs = systemClock.now();
    for (const snapshot of sessions.values()) {
      const lastMs = snapshot.lastEventTs ? Date.parse(snapshot.lastEventTs) : Date.parse(snapshot.stateSince);
      const nextState = checkStale(snapshot.state, lastMs, nowMs, config.session.staleAfterMs);
      if (nextState !== snapshot.state) {
        const prevState = snapshot.state;
        const updated: SessionSnapshot = { ...snapshot, state: nextState, stateSince: new Date(nowMs).toISOString() };
        sessions.set(snapshot.sessionId, updated);
        ipc.broadcastSessionState(updated, prevState);
        void transition(snapshot.sessionId, prevState, nextState);
      }

      if (snapshot.state === 'CC_WORKING' && transcripts.hasTranscript(snapshot.sessionId)) {
        if (transcripts.shouldPoll(snapshot.sessionId, nowMs, config.session.tokenPollMs)) {
          transcripts.markPolled(snapshot.sessionId, nowMs);
          const filePath = eventFilePath(snapshot.sessionId, env);
          const tokenEnvelope = transcripts.poll(snapshot.sessionId, filePath, new Date(nowMs).toISOString());
          if (tokenEnvelope) watcher.poke(filePath);
        }
      }
    }
  }, STALE_CHECK_INTERVAL_MS);

  const rotationTimer = setInterval(() => {
    rotator.checkAndRotate(config.log.maxFileMB, config.log.retentionDays);
  }, ROTATION_CHECK_INTERVAL_MS);

  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    clearInterval(staleTimer);
    clearInterval(rotationTimer);
    if (gameBroadcastTimer) clearTimeout(gameBroadcastTimer);
    gameHost.stop();
    focusEngine.dispose();
    await ipc.stop();
    await watcher.stop();
    try {
      const raw = fs.readFileSync(pidFilePath(env), 'utf8').trim();
      if (Number.parseInt(raw, 10) === process.pid) fs.unlinkSync(pidFilePath(env));
    } catch {
      // already gone
    }
  };

  const handleSignal = (signal: NodeJS.Signals): void => {
    logger.info(`received ${signal}, shutting down`);
    void stop().then(() => process.exit(0));
  };
  process.once('SIGINT', handleSignal);
  process.once('SIGTERM', handleSignal);

  return { logger, stop };
}
