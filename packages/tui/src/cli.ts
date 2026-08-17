#!/usr/bin/env node
import React from 'react';
import { render } from 'ink';
import { loadConfig } from '@ccidle/shared';
import { App } from './App.js';
import { DaemonClient } from './client.js';

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
  .catch(() => {
    // rendering ended abnormally; still fall through to a clean shutdown below
  })
  .finally(() => {
    client.disconnect();
  });
