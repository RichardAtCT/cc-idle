/**
 * Renders the real App into a real TTY, driven by a fake DaemonClient and a
 * game state replayed from a corpus event file. Used by the tmux scrollback
 * test: run this inside a tmux pane, then `capture-pane -S -` and assert the
 * pane history did not grow.
 *
 * Usage: node render-harness.mjs <events.jsonl>   (RUN_MS caps the lifetime)
 */
import React from 'react';
import { render } from 'ink';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_CONFIG } from '@ccidle/shared';
import { parseEventFile, replayEnvelopes } from '@ccidle/game';

const here = path.dirname(fileURLToPath(import.meta.url));
const { App } = await import(path.join(here, '../../dist/App.js'));

const file = process.argv[2];
const { state } = replayEnvelopes(parseEventFile(fs.readFileSync(file, 'utf8')));

class FakeClient extends EventEmitter {
  connect() {}
  disconnect() {}
  sendMessage() {
    return true;
  }
}
const client = new FakeClient();

render(React.createElement(App, { client, config: DEFAULT_CONFIG }));

setTimeout(() => {
  client.emit('connected');
  client.emit('message', {
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
  });
  client.emit('message', { type: 'game-state', game: state });
}, 200);

setTimeout(() => process.exit(0), Number(process.env.RUN_MS ?? 12000));
