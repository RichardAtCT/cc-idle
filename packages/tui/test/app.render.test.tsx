import { describe, it, expect, afterEach } from 'vitest';
import React from 'react';
import { EventEmitter } from 'node:events';
import { render, cleanup } from 'ink-testing-library';
import { DEFAULT_CONFIG } from '@ccidle/shared';
import type { ServerMessage } from '@ccidle/shared';
import { applyInput, initialGameState } from '@ccidle/game';
import { App } from '../src/App.js';
import type { DaemonClient } from '../src/client.js';

/** Minimal stand-in for DaemonClient: App only needs on/off/connect/disconnect/sendMessage. */
class FakeClient extends EventEmitter {
  sent: unknown[] = [];
  connect(): void {
    // no real socket in tests
  }
  disconnect(): void {
    // no-op
  }
  sendMessage(message: unknown): boolean {
    this.sent.push(message);
    return true;
  }
}

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

afterEach(() => {
  cleanup();
});

describe('App (ink render smoke tests)', () => {
  it('renders the header and a degraded state before any data arrives', () => {
    const client = new FakeClient() as unknown as DaemonClient;
    const { lastFrame } = render(<App client={client} config={DEFAULT_CONFIG} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('CC IDLE');
    expect(frame).toContain('daemon offline');
  });

  it('shows a session in the strip after a hello message', async () => {
    const client = new FakeClient() as unknown as DaemonClient;
    const { lastFrame } = render(<App client={client} config={DEFAULT_CONFIG} />);
    const fake = client as unknown as FakeClient;
    await flush(); // let the App's effect register its client listeners first

    const hello: ServerMessage = {
      type: 'hello',
      protocol: 1,
      daemonVersion: '0.1.0',
      autofocusPaused: false,
      tmuxAvailable: true,
      sessions: [
        {
          sessionId: 'session-12345678',
          state: 'CC_WORKING',
          stateSince: new Date().toISOString(),
          cwd: '/home/user/project',
          toolCallsThisTurn: 2,
          toolCallsTotal: 5,
          turns: 1,
          tokensByModel: {}
        }
      ]
    };

    fake.emit('connected');
    fake.emit('message', hello);
    await flush();

    const frame = lastFrame() ?? '';
    expect(frame).toContain('session-');
    expect(frame).toContain('CC_WORKING');
    expect(frame).toContain('project');
  });

  it('renders the needs-you banner when an alert is active', async () => {
    const client = new FakeClient() as unknown as DaemonClient;
    const { lastFrame } = render(<App client={client} config={DEFAULT_CONFIG} />);
    const fake = client as unknown as FakeClient;
    await flush(); // let the App's effect register its client listeners first

    fake.emit('connected');
    fake.emit('message', {
      type: 'hello',
      protocol: 1,
      daemonVersion: '0.1.0',
      autofocusPaused: false,
      tmuxAvailable: true,
      sessions: []
    } satisfies ServerMessage);
    fake.emit('message', {
      type: 'alert',
      kind: 'needs-you',
      sessionId: 'session-abcdefgh',
      queue: []
    } satisfies ServerMessage);
    await flush();

    const frame = lastFrame() ?? '';
    expect(frame).toContain('NEEDS YOU');
    expect(frame).toContain('session-');
  });
});

describe('App game surface', () => {
  it('renders resources, the focused region stage, lab, and feed from a game-state push', async () => {
    const client = new FakeClient() as unknown as DaemonClient;
    const { lastFrame } = render(<App client={client} config={DEFAULT_CONFIG} />);
    const fake = client as unknown as FakeClient;
    await flush();

    // Build a real game state by running one envelope through the engine.
    const founded = applyInput(
      initialGameState('2026-08-17T10:00:00.000Z'),
      {
        kind: 'telemetry',
        envelope: {
          v: 1,
          ts: '2026-08-17T10:00:00.000Z',
          session_id: 'sess-1',
          event: 'SessionStart',
          cwd: '/home/user/webapp',
          payload: {}
        }
      },
      Date.parse('2026-08-17T10:00:00.000Z')
    ).state;

    fake.emit('connected');
    fake.emit('message', {
      type: 'hello',
      protocol: 1,
      daemonVersion: '0.1.0',
      autofocusPaused: false,
      tmuxAvailable: true,
      sessions: []
    } satisfies ServerMessage);
    fake.emit('message', { type: 'game-state', game: founded as never } satisfies ServerMessage);
    await flush();

    const frame = lastFrame() ?? '';
    expect(frame).toContain('FLOPS');
    expect(frame).toContain('GEN-1');
    expect(frame).toContain('webapp');
    expect(frame).toContain('FRONTIER LAB');
    expect(frame).toContain('region "webapp" founded');
  });
});
