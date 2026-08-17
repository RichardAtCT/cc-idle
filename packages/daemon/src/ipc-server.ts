import net from 'node:net';
import fs from 'node:fs';
import {
  parseClientMessage,
  serializeMessage,
  type ClientMessage,
  type EventEnvelope,
  type ServerMessage,
  type SessionSnapshot
} from '@ccidle/shared';

type RegisterMessage = Extract<ClientMessage, { type: 'register' }>;

export interface IpcServerDeps {
  daemonVersion: string;
  sessions: () => SessionSnapshot[];
  isAutofocusPaused: () => boolean;
  isTmuxAvailable: () => boolean;
  onPauseAutofocus: () => void;
  onResumeAutofocus: () => void;
  onRegister: (msg: RegisterMessage) => void;
  onFocusSession: (sessionId: string) => void | Promise<void>;
}

export interface IpcLogger {
  info: (msg: string) => void;
  warn: (msg: string) => void;
}

/**
 * Unix domain socket server at socketPath() speaking the ndjson protocol
 * from @ccidle/shared/ipc (PRD §3.3).
 */
export class IpcServer {
  private server: net.Server | null = null;
  private readonly clients = new Set<net.Socket>();
  private readonly buffers = new WeakMap<net.Socket, string>();

  constructor(
    private readonly socketPath: string,
    private readonly deps: IpcServerDeps,
    private readonly logger?: IpcLogger
  ) {}

  async start(): Promise<void> {
    // Unlink a stale socket left behind by a previous (crashed) daemon.
    try {
      fs.unlinkSync(this.socketPath);
    } catch {
      // absent is fine
    }

    await new Promise<void>((resolve, reject) => {
      this.server = net.createServer((socket) => this.handleConnection(socket));
      this.server.once('error', reject);
      this.server.listen(this.socketPath, () => {
        this.server?.removeListener('error', reject);
        resolve();
      });
    });
  }

  private handleConnection(socket: net.Socket): void {
    this.clients.add(socket);
    this.buffers.set(socket, '');

    this.send(socket, {
      type: 'hello',
      protocol: 1,
      daemonVersion: this.deps.daemonVersion,
      autofocusPaused: this.deps.isAutofocusPaused(),
      tmuxAvailable: this.deps.isTmuxAvailable(),
      sessions: this.deps.sessions()
    });

    socket.on('data', (chunk) => this.onData(socket, chunk));
    socket.on('close', () => {
      this.clients.delete(socket);
      this.buffers.delete(socket);
    });
    socket.on('error', () => {
      this.clients.delete(socket);
      this.buffers.delete(socket);
    });
  }

  private onData(socket: net.Socket, chunk: Buffer): void {
    const prev = this.buffers.get(socket) ?? '';
    let buffer = prev + chunk.toString('utf8');
    let idx: number;
    while ((idx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      this.handleLine(socket, line);
    }
    this.buffers.set(socket, buffer);
  }

  private handleLine(socket: net.Socket, line: string): void {
    let message: ClientMessage | null;
    try {
      message = parseClientMessage(line);
    } catch {
      message = null;
    }
    if (!message) return; // ignore unparseable lines, never crash

    switch (message.type) {
      case 'command':
        this.handleCommand(socket, message.command);
        break;
      case 'register':
        this.deps.onRegister(message);
        break;
      case 'focus-session':
        void this.deps.onFocusSession(message.sessionId);
        break;
    }
  }

  private handleCommand(socket: net.Socket, command: 'pause-autofocus' | 'resume-autofocus' | 'status'): void {
    if (command === 'pause-autofocus') this.deps.onPauseAutofocus();
    else if (command === 'resume-autofocus') this.deps.onResumeAutofocus();
    this.send(socket, {
      type: 'status',
      autofocusPaused: this.deps.isAutofocusPaused(),
      tmuxAvailable: this.deps.isTmuxAvailable(),
      sessions: this.deps.sessions()
    });
  }

  broadcastSessionState(session: SessionSnapshot, previousState?: string): void {
    this.broadcast({ type: 'session-state', session, previousState });
  }

  broadcastEvent(envelope: EventEnvelope): void {
    this.broadcast({ type: 'event', envelope });
  }

  broadcastAlert(kind: 'needs-you' | 'clear', sessionId: string, queue: SessionSnapshot[]): void {
    this.broadcast({ type: 'alert', kind, sessionId, queue });
  }

  private broadcast(message: ServerMessage): void {
    for (const client of this.clients) this.send(client, message);
  }

  private send(socket: net.Socket, message: ServerMessage): void {
    try {
      socket.write(serializeMessage(message));
    } catch (error) {
      this.logger?.warn(`ipc write failed: ${(error as Error).message}`);
    }
  }

  clientCount(): number {
    return this.clients.size;
  }

  async stop(): Promise<void> {
    for (const client of this.clients) client.destroy();
    this.clients.clear();
    await new Promise<void>((resolve) => {
      if (!this.server) {
        resolve();
        return;
      }
      this.server.close(() => resolve());
    });
    this.server = null;
  }
}
