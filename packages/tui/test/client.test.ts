import { describe, it, expect, afterEach } from 'vitest';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ServerMessage } from '@ccidle/shared';
import { DaemonClient } from '../src/client.js';

function tmpSocketPath(): string {
  return path.join(os.tmpdir(), `ccidle-tui-test-${process.pid}-${Math.random().toString(36).slice(2)}.sock`);
}

function waitForEvent(emitter: DaemonClient, event: string): Promise<unknown> {
  return new Promise((resolve) => emitter.once(event, resolve));
}

const clients: DaemonClient[] = [];
const servers: net.Server[] = [];

afterEach(() => {
  for (const client of clients.splice(0)) client.disconnect();
  for (const server of servers.splice(0)) server.close();
});

describe('DaemonClient', () => {
  it('connects, receives an ndjson message, and parses it via the shared schema', async () => {
    const sockPath = tmpSocketPath();
    const server = net.createServer((socket) => {
      const hello: ServerMessage = {
        type: 'hello',
        protocol: 1,
        daemonVersion: '0.1.0',
        autofocusPaused: false,
        tmuxAvailable: true,
        sessions: []
      };
      socket.write(JSON.stringify(hello) + '\n');
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(sockPath, resolve));

    const client = new DaemonClient({ socketPath: sockPath });
    clients.push(client);

    const connected = waitForEvent(client, 'connected');
    const messagePromise = waitForEvent(client, 'message');
    client.connect();

    await connected;
    const message = await messagePromise;
    expect(message).toEqual({
      type: 'hello',
      protocol: 1,
      daemonVersion: '0.1.0',
      autofocusPaused: false,
      tmuxAvailable: true,
      sessions: []
    });
  });

  it('buffers a message split across multiple writes', async () => {
    const sockPath = tmpSocketPath();
    const server = net.createServer((socket) => {
      const status: ServerMessage = {
        type: 'status',
        autofocusPaused: true,
        tmuxAvailable: false,
        sessions: []
      };
      const line = JSON.stringify(status) + '\n';
      const mid = Math.floor(line.length / 2);
      socket.write(line.slice(0, mid));
      setTimeout(() => socket.write(line.slice(mid)), 10);
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(sockPath, resolve));

    const client = new DaemonClient({ socketPath: sockPath });
    clients.push(client);
    const messagePromise = waitForEvent(client, 'message');
    client.connect();

    const message = await messagePromise;
    expect(message).toMatchObject({ type: 'status', autofocusPaused: true, tmuxAvailable: false });
  });

  it('reconnects with backoff after the daemon goes away and comes back', async () => {
    const sockPath = tmpSocketPath();
    if (fs.existsSync(sockPath)) fs.unlinkSync(sockPath);

    const liveSockets = new Set<net.Socket>();
    let server = net.createServer((socket) => {
      liveSockets.add(socket);
      socket.on('close', () => liveSockets.delete(socket));
      socket.write(JSON.stringify({ type: 'command', command: 'status' } as never) + '\n');
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(sockPath, resolve));

    const client = new DaemonClient({ socketPath: sockPath, minBackoffMs: 20, maxBackoffMs: 40 });
    clients.push(client);

    await new Promise<void>((resolve) => {
      client.once('connected', () => resolve());
      client.connect();
    });
    expect(client.connected).toBe(true);

    // Simulate the daemon dying: drop the live connection and stop accepting new ones.
    // (server.close()'s callback only fires once all existing sockets end, so don't await it —
    // destroying the sockets ourselves is what stands in for the daemon process disappearing.)
    const disconnected = waitForEvent(client, 'disconnected');
    for (const socket of liveSockets) socket.destroy();
    server.close();
    await disconnected;
    expect(client.connected).toBe(false);

    // Bring the daemon back on the same path; client should reconnect on its own.
    // (net does not unlink the socket file on close, so clear it ourselves first.)
    if (fs.existsSync(sockPath)) fs.unlinkSync(sockPath);
    server = net.createServer();
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(sockPath, resolve));

    await waitForEvent(client, 'connected');
    expect(client.connected).toBe(true);
  });

  it('sendMessage returns false when not connected and true once connected', async () => {
    const sockPath = tmpSocketPath();
    const received: string[] = [];
    const server = net.createServer((socket) => {
      socket.on('data', (chunk) => received.push(chunk.toString('utf8')));
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(sockPath, resolve));

    const client = new DaemonClient({ socketPath: sockPath });
    clients.push(client);

    expect(client.sendMessage({ type: 'command', command: 'status' })).toBe(false);

    await new Promise<void>((resolve) => {
      client.once('connected', () => resolve());
      client.connect();
    });

    expect(client.sendMessage({ type: 'focus-session', sessionId: 'abc' })).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(received.join('')).toContain('"focus-session"');
  });
});
