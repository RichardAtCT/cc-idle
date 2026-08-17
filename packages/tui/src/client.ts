import net from 'node:net';
import { EventEmitter } from 'node:events';
import {
  socketPath,
  parseServerMessage,
  serializeMessage,
  type ServerMessage,
  type ClientMessage
} from '@ccidle/shared';

/**
 * Pure ndjson line splitter/buffer: feed it chunks of a socket stream and it
 * hands back complete lines, holding any trailing partial line until the
 * next chunk completes it. No I/O, fully unit-testable on its own.
 */
export class NdjsonLineBuffer {
  private pending = '';

  /** Feed a raw chunk; returns zero or more complete (still-terminated) lines. */
  push(chunk: string): string[] {
    this.pending += chunk;
    const parts = this.pending.split('\n');
    // The last element is either '' (chunk ended exactly on a newline) or an
    // incomplete trailing line — either way it belongs back in `pending`.
    this.pending = parts.pop() ?? '';
    return parts;
  }

  /** Whatever has been buffered but not yet terminated by a newline. */
  get buffered(): string {
    return this.pending;
  }
}

export interface DaemonClientOptions {
  /** Override the socket path (tests use this to point at a fixture socket). */
  socketPath?: string;
  /** Initial/minimum reconnect backoff in ms. Default 500. */
  minBackoffMs?: number;
  /** Maximum reconnect backoff in ms. Default 5000. */
  maxBackoffMs?: number;
}

export interface DaemonClientEvents {
  connected: [];
  disconnected: [];
  message: [ServerMessage];
}

/**
 * Connects to the daemon's ndjson unix socket (see @ccidle/shared `socketPath`),
 * decodes/parses incoming lines, and reconnects with exponential backoff when
 * the daemon is down or restarts.
 */
export class DaemonClient extends EventEmitter {
  private readonly path: string;
  private readonly minBackoffMs: number;
  private readonly maxBackoffMs: number;
  private backoffMs: number;
  private socket: net.Socket | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private stopped = true;
  private readonly lineBuffer = new NdjsonLineBuffer();

  constructor(options: DaemonClientOptions = {}) {
    super();
    this.path = options.socketPath ?? socketPath();
    this.minBackoffMs = options.minBackoffMs ?? 500;
    this.maxBackoffMs = options.maxBackoffMs ?? 5000;
    this.backoffMs = this.minBackoffMs;
  }

  /** Start connecting (and keep reconnecting until `disconnect()` is called). */
  connect(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.attemptConnect();
  }

  /** Stop for good: no further reconnect attempts, socket torn down. */
  disconnect(): void {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.destroy();
      this.socket = null;
    }
  }

  get connected(): boolean {
    return this.socket !== null && !this.socket.destroyed;
  }

  /** Serialize and write a client message; returns false if not currently connected. */
  sendMessage(message: ClientMessage): boolean {
    if (!this.socket || this.socket.destroyed || !this.socket.writable) return false;
    this.socket.write(serializeMessage(message));
    return true;
  }

  private attemptConnect(): void {
    if (this.stopped) return;
    const socket = net.createConnection(this.path);
    this.socket = socket;
    socket.setEncoding('utf8');

    socket.on('connect', () => {
      this.backoffMs = this.minBackoffMs;
      this.emit('connected');
    });

    socket.on('data', (chunk: string) => {
      const lines = this.lineBuffer.push(chunk);
      for (const line of lines) {
        const message = parseServerMessage(line);
        if (message) this.emit('message', message);
      }
    });

    const onDown = () => {
      if (this.socket !== socket) return; // stale listener from a superseded socket
      this.socket = null;
      socket.removeAllListeners();
      this.emit('disconnected');
      this.scheduleReconnect();
    };
    socket.on('close', onDown);
    socket.on('error', () => {
      socket.destroy();
    });
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.backoffMs = Math.min(this.backoffMs * 2, this.maxBackoffMs);
      this.attemptConnect();
    }, this.backoffMs);
  }
}
