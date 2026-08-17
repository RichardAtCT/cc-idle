import net from 'node:net';
import { socketPath, serializeMessage, type ClientMessage } from '@ccidle/shared';

export interface RegisterOptions {
  role: 'cc' | 'game';
  pane?: string;
  cwd?: string;
  sessionId?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

export interface RegisterResult {
  connected: boolean;
  detail: string;
}

/** Connects to the daemon's unix socket and sends a `register` ClientMessage. */
export function sendRegister(opts: RegisterOptions): Promise<RegisterResult> {
  const sockPath = socketPath(opts.env);
  const timeoutMs = opts.timeoutMs ?? 500;

  const message: ClientMessage = {
    type: 'register',
    role: opts.role,
    ...(opts.pane ? { pane: opts.pane } : {}),
    ...(opts.cwd ? { cwd: opts.cwd } : {}),
    ...(opts.sessionId ? { sessionId: opts.sessionId } : {})
  };

  return new Promise((resolve) => {
    const socket = net.createConnection(sockPath);
    let settled = false;

    const finish = (result: RegisterResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };

    const timer = setTimeout(() => {
      finish({ connected: false, detail: 'daemon not running (timed out connecting to socket)' });
    }, timeoutMs);

    socket.once('connect', () => {
      socket.write(serializeMessage(message), (err) => {
        if (err) {
          finish({ connected: false, detail: `daemon not running (write failed: ${err.message})` });
          return;
        }
        finish({
          connected: true,
          detail: `registered role=${opts.role}${opts.pane ? ` pane=${opts.pane}` : ''}${
            opts.cwd ? ` cwd=${opts.cwd}` : ''
          }`
        });
      });
    });

    socket.once('error', (err) => {
      finish({ connected: false, detail: `daemon not running (${(err as Error).message})` });
    });
  });
}
