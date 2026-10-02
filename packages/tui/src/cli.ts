#!/usr/bin/env node
import React from 'react';
import { render } from 'ink';
import { loadConfig } from '@ccidle/shared';
import { App } from './App.js';
import { DaemonClient } from './client.js';
import { captureConsole, log } from './log.js';

// Ink owns stdout from here on; stray writes break its repaint (see log.ts).
const restoreConsole = captureConsole();

const config = loadConfig();
const client = new DaemonClient();

client.on('connected', () => {
  client.sendMessage({
    type: 'register',
    role: 'game',
    pane: process.env.TMUX_PANE
  });
});

const { waitUntilExit } = render(React.createElement(App, { client, config }));

waitUntilExit()
  .catch((error: unknown) => {
    // rendering ended abnormally; still fall through to a clean shutdown below
    log('[error] render exited abnormally', error);
  })
  .finally(() => {
    client.disconnect();
    restoreConsole();
  });
