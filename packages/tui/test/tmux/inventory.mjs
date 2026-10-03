/** Lists every distinct non-ASCII glyph the App actually renders. */
import React from 'react';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { render, cleanup } from 'ink-testing-library';
import { DEFAULT_CONFIG } from '@ccidle/shared';
import { parseEventFile, replayEnvelopes } from '@ccidle/game';

const here = path.dirname(fileURLToPath(import.meta.url));
const { App } = await import(path.join(here, '../../dist/App.js'));

const args = process.argv.slice(2);
const files = args[0]?.endsWith('.txt')
  ? fs.readFileSync(args[0], 'utf8').split('\n').filter(Boolean)
  : args;

const seen = new Set();
for (const file of files) {
  const { state } = replayEnvelopes(parseEventFile(fs.readFileSync(file, 'utf8')));
  class FakeClient extends EventEmitter {
    connect() {}
    disconnect() {}
    sendMessage() {
      return true;
    }
  }
  const client = new FakeClient();
  const { lastFrame } = render(React.createElement(App, { client, config: DEFAULT_CONFIG }));
  await new Promise((r) => setImmediate(r));
  client.emit('connected');
  client.emit('message', {
    type: 'hello',
    protocol: 1,
    daemonVersion: '0.1.0',
    autofocusPaused: false,
    tmuxAvailable: true,
    sessions: []
  });
  client.emit('message', { type: 'game-state', game: state });
  await new Promise((r) => setImmediate(r));
  for (const ch of lastFrame() ?? '') {
    if (ch.codePointAt(0) > 127) seen.add(ch);
  }
  cleanup();
}
const glyphs = [...seen].sort();
console.log(glyphs.join(''));
console.log(glyphs.map((g) => `U+${g.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`).join(' '));
