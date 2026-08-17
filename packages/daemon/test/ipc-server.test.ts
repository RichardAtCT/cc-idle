import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { serializeMessage, type ClientMessage, type ServerMessage, type SessionSnapshot } from '@ccidle/shared';
import { IpcServer, type IpcServerDeps } from '../src/ipc-server.js';

function mkTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ccidle-ipc-'));
}

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length > 0) {
    const fn = cleanups.pop()!;
    await fn();
  }
});

function sampleSession(sessionId: string): SessionSnapshot {
  return {
    sessionId,
    state: 'CC_WORKING',
    stateSince: '2026-08-17T10:00:00.000Z',
    toolCallsThisTurn: 0,
    toolCallsTotal: 0,
    turns: 0,
    tokensByModel: {}
  };
}

/** Small ndjson client for driving the socket in tests. */
class TestClient {
  private buffer = '';
  readonly received: ServerMessage[] = [];
  private waiters: Array<() => void> = [];

  constructor(private readonly socket: net.Socket) {
    socket.on('data', (chunk) => {
      this.buffer += chunk.toString('utf8');
      let idx: number;
      while ((idx = this.buffer.indexOf('\n')) !== -1) {
        const line = this.buffer.slice(0, idx);
        this.buffer = this.buffer.slice(idx + 1);
        if (line.trim()) this.received.push(JSON.parse(line));
      }
      const waiters = this.waiters;
      this.waiters = [];
      for (const w of waiters) w();
    });
  }

  send(message: ClientMessage): void {
    this.socket.write(serializeMessage(message));
  }

  async waitForCount(n: number, timeoutMs = 2000): Promise<void> {
    const start = Date.now();
    while (this.received.length < n) {
      if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${n} messages, got ${this.received.length}`);
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve);
        setTimeout(resolve, 20);
      });
    }
  }
}

function connect(socketPath: string): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    socket.once('connect', () => resolve(socket));
    socket.once('error', reject);
  });
}

describe('IpcServer', () => {
  it('sends hello on connect, replies to command, and handles register', async () => {
    const dir = mkTmpDir();
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const socketPath = path.join(dir, 'ccidled.sock');

    let paused = false;
    const registered: unknown[] = [];
    const sessions = new Map<string, SessionSnapshot>([['sess-1', sampleSession('sess-1')]]);

    const deps: IpcServerDeps = {
      daemonVersion: '0.1.0-test',
      sessions: () => Array.from(sessions.values()),
      isAutofocusPaused: () => paused,
      isTmuxAvailable: () => true,
      onPauseAutofocus: () => {
        paused = true;
      },
      onResumeAutofocus: () => {
        paused = false;
      },
      onRegister: (msg) => {
        registered.push(msg);
      },
      onFocusSession: () => {}
    };

    const server = new IpcServer(socketPath, deps);
    await server.start();
    cleanups.push(() => server.stop());

    const socket = await connect(socketPath);
    cleanups.push(() => socket.destroy());
    const client = new TestClient(socket);

    await client.waitForCount(1);
    expect(client.received[0]).toMatchObject({
      type: 'hello',
      protocol: 1,
      daemonVersion: '0.1.0-test',
      autofocusPaused: false,
      tmuxAvailable: true
    });
    expect((client.received[0] as { sessions: SessionSnapshot[] }).sessions).toHaveLength(1);

    client.send({ type: 'command', command: 'pause-autofocus' });
    await client.waitForCount(2);
    expect(client.received[1]).toMatchObject({ type: 'status', autofocusPaused: true });
    expect(paused).toBe(true);

    client.send({ type: 'command', command: 'status' });
    await client.waitForCount(3);
    expect(client.received[2]).toMatchObject({ type: 'status', autofocusPaused: true });

    client.send({ type: 'register', role: 'game', pane: '%5' });
    // give the event loop a beat to process (no reply expected for register)
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(registered).toEqual([{ type: 'register', role: 'game', pane: '%5' }]);

    // Unparseable lines must not crash the server.
    socket.write('not json at all\n');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(socket.destroyed).toBe(false);
  });

  it('broadcasts session-state, event, and alert messages to all connected clients', async () => {
    const dir = mkTmpDir();
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const socketPath = path.join(dir, 'ccidled.sock');

    const deps: IpcServerDeps = {
      daemonVersion: '0.1.0-test',
      sessions: () => [],
      isAutofocusPaused: () => false,
      isTmuxAvailable: () => false,
      onPauseAutofocus: () => {},
      onResumeAutofocus: () => {},
      onRegister: () => {},
      onFocusSession: () => {}
    };

    const server = new IpcServer(socketPath, deps);
    await server.start();
    cleanups.push(() => server.stop());

    const socketA = await connect(socketPath);
    const socketB = await connect(socketPath);
    cleanups.push(() => socketA.destroy(), () => socketB.destroy());
    const clientA = new TestClient(socketA);
    const clientB = new TestClient(socketB);
    await clientA.waitForCount(1);
    await clientB.waitForCount(1);

    const snapshot = sampleSession('sess-1');
    server.broadcastSessionState(snapshot, 'HUMAN_ACTIVE');
    server.broadcastEvent({
      v: 1,
      ts: '2026-08-17T10:00:01.000Z',
      session_id: 'sess-1',
      event: 'PostToolUse',
      payload: {}
    });
    server.broadcastAlert('needs-you', 'sess-1', [snapshot]);

    await clientA.waitForCount(4);
    await clientB.waitForCount(4);

    expect(clientA.received[1]).toMatchObject({ type: 'session-state', previousState: 'HUMAN_ACTIVE' });
    expect(clientA.received[2]).toMatchObject({ type: 'event' });
    expect(clientA.received[3]).toMatchObject({ type: 'alert', kind: 'needs-you' });
    expect(clientB.received.slice(1)).toEqual(clientA.received.slice(1));
  });

  it('unlinks a stale socket file left behind by a previous daemon on startup', async () => {
    const dir = mkTmpDir();
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const socketPath = path.join(dir, 'ccidled.sock');
    fs.writeFileSync(socketPath, ''); // stale, non-socket file

    const deps: IpcServerDeps = {
      daemonVersion: '0.1.0-test',
      sessions: () => [],
      isAutofocusPaused: () => false,
      isTmuxAvailable: () => false,
      onPauseAutofocus: () => {},
      onResumeAutofocus: () => {},
      onRegister: () => {},
      onFocusSession: () => {}
    };
    const server = new IpcServer(socketPath, deps);
    await expect(server.start()).resolves.toBeUndefined();
    cleanups.push(() => server.stop());
  });
});
