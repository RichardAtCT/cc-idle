import React, { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { Box, Text, useApp, useInput, useStdin } from 'ink';
import type { Config, ServerMessage, SessionSnapshot } from '@ccidle/shared';
import type { DaemonClient } from './client.js';
import { initialState, reduce, orderedSessions } from './store.js';
import { Header } from './components/Header.js';
import { SessionStrip } from './components/SessionStrip.js';
import { GamePanel } from './components/GamePanel.js';
import { AlertBanner } from './components/AlertBanner.js';

export interface AppProps {
  client: DaemonClient;
  config: Config;
}

export function App({ client, config }: AppProps): React.ReactElement {
  const { exit } = useApp();
  const { isRawModeSupported } = useStdin();
  const [state, dispatch] = useReducer(reduce, initialState);
  const [now, setNow] = useState(() => Date.now());
  const [highlightIndex, setHighlightIndex] = useState(0);
  const lastBellSessionId = useRef<string | null>(null);

  useEffect(() => {
    const onConnected = () => dispatch({ kind: 'connection-status', status: 'connected' });
    const onDisconnected = () => dispatch({ kind: 'connection-status', status: 'disconnected' });
    const onMessage = (message: ServerMessage) => dispatch({ kind: 'server-message', message });

    client.on('connected', onConnected);
    client.on('disconnected', onDisconnected);
    client.on('message', onMessage);
    client.connect();

    return () => {
      client.off('connected', onConnected);
      client.off('disconnected', onDisconnected);
      client.off('message', onMessage);
    };
  }, [client]);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  // Ring the bell exactly once per newly-raised alert (not on every re-render).
  useEffect(() => {
    if (
      state.activeAlertSessionId &&
      state.activeAlertSessionId !== lastBellSessionId.current &&
      config.alerts.bell
    ) {
      process.stdout.write('');
    }
    lastBellSessionId.current = state.activeAlertSessionId;
  }, [state.activeAlertSessionId, config.alerts.bell]);

  const sessions = orderedSessions(state).slice(0, 9);

  const handleInput = useCallback(
    (input: string) => {
      if (input === 'q') {
        client.disconnect();
        exit();
        return;
      }
      if (input === 'f') {
        client.sendMessage({
          type: 'command',
          command: state.autofocusPaused ? 'resume-autofocus' : 'pause-autofocus'
        });
        return;
      }
      if (input === 's') {
        if (sessions.length > 0) {
          setHighlightIndex((i) => (i + 1) % sessions.length);
        }
        return;
      }
      if (/^[1-9]$/.test(input)) {
        const session: SessionSnapshot | undefined = sessions[Number(input) - 1];
        if (session) {
          client.sendMessage({ type: 'focus-session', sessionId: session.sessionId });
        }
      }
    },
    [client, exit, sessions, state.autofocusPaused]
  );

  useInput(handleInput, { isActive: isRawModeSupported });

  const offline = state.connection !== 'connected';

  return (
    <Box flexDirection="column">
      {state.activeAlertSessionId && <AlertBanner sessionId={state.activeAlertSessionId} />}
      <Header connection={state.connection} autofocusPaused={state.autofocusPaused} />
      {offline ? (
        <Box borderStyle="round" paddingX={1} marginTop={1}>
          <Text color="yellow">daemon offline — reconnecting…</Text>
        </Box>
      ) : (
        <>
          <SessionStrip sessions={sessions} now={now} highlightIndex={highlightIndex} />
          <GamePanel ticks={state.ticks} lastTool={state.lastTool} />
        </>
      )}
    </Box>
  );
}
