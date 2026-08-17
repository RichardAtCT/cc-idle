import { describe, it, expect } from 'vitest';
import { parseServerMessage, parseClientMessage, serializeMessage } from '../src/ipc.js';
import type { ServerMessage, ClientMessage } from '../src/ipc.js';

describe('ipc protocol', () => {
  it('round-trips a hello message', () => {
    const message: ServerMessage = {
      type: 'hello',
      protocol: 1,
      daemonVersion: '0.1.0',
      autofocusPaused: false,
      tmuxAvailable: true,
      sessions: []
    };
    expect(parseServerMessage(serializeMessage(message))).toEqual(message);
  });

  it('round-trips client commands and registration', () => {
    const command: ClientMessage = { type: 'command', command: 'pause-autofocus' };
    expect(parseClientMessage(serializeMessage(command))).toEqual(command);

    const register: ClientMessage = { type: 'register', role: 'cc', pane: '%3', cwd: '/repo' };
    expect(parseClientMessage(serializeMessage(register))).toEqual(register);
  });

  it('rejects unknown message types without throwing', () => {
    expect(parseServerMessage('{"type":"from-the-future"}')).toBeNull();
    expect(parseClientMessage('{"type":"from-the-future"}')).toBeNull();
    expect(parseServerMessage('garbage')).toBeNull();
  });
});
