import React, { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { Box, Text, useApp, useInput, useStdin } from 'ink';
import type { Config, ServerMessage, SessionSnapshot } from '@ccidle/shared';
import { BREAKTHROUGH_NODES, canShipGeneration, regionsByFounded, type GameAction } from '@ccidle/game';
import type { DaemonClient } from './client.js';
import { initialState, reduce, orderedSessions } from './store.js';
import { Header } from './components/Header.js';
import { SessionStrip } from './components/SessionStrip.js';
import { AlertBanner } from './components/AlertBanner.js';
import { ResourceBar } from './components/ResourceBar.js';
import { RegionStage } from './components/RegionStage.js';
import { LabPanel } from './components/LabPanel.js';
import { Feed } from './components/Feed.js';
import { BreakthroughMenu } from './components/BreakthroughMenu.js';

export interface AppProps {
  client: DaemonClient;
  config: Config;
}

/** Modal input state: every interaction stays a single keypress or a y/n (PRD §1.4). */
type Mode = 'main' | 'breakthroughs' | 'confirm-ship';

const TIER_KEYS: Record<string, string> = { g: 'gpu', r: 'rack', d: 'datacenter' };

export function App({ client, config }: AppProps): React.ReactElement {
  const { exit } = useApp();
  const { isRawModeSupported } = useStdin();
  const [state, dispatch] = useReducer(reduce, initialState);
  const [now, setNow] = useState(() => Date.now());
  const [highlightIndex, setHighlightIndex] = useState(0);
  const [regionIndex, setRegionIndex] = useState(0);
  const [mode, setMode] = useState<Mode>('main');
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
  const game = state.game;
  const regions = game ? regionsByFounded(game) : [];
  const focusedRegion = regions.length > 0 ? regions[regionIndex % regions.length] : undefined;

  const sendAction = useCallback(
    (action: GameAction) => {
      client.sendMessage({ type: 'game-action', action });
    },
    [client]
  );

  const handleInput = useCallback(
    (input: string, key: { escape?: boolean; tab?: boolean }) => {
      if (mode === 'confirm-ship') {
        if (input === 'y') sendAction({ type: 'ship-generation' });
        if (input === 'y' || input === 'n' || key.escape) setMode('main');
        return;
      }

      if (mode === 'breakthroughs') {
        if (input === 'v' || key.escape || input === 'q') {
          setMode('main');
          return;
        }
        if (/^[1-9]$/.test(input)) {
          const node = BREAKTHROUGH_NODES[Number(input) - 1];
          if (node) sendAction({ type: 'buy-breakthrough', nodeId: node.id });
        }
        return;
      }

      // main mode
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
        if (sessions.length > 0) setHighlightIndex((i) => (i + 1) % sessions.length);
        return;
      }
      if (key.tab) {
        if (regions.length > 0) setRegionIndex((i) => (i + 1) % regions.length);
        return;
      }
      if (/^[1-9]$/.test(input)) {
        const session: SessionSnapshot | undefined = sessions[Number(input) - 1];
        if (session) client.sendMessage({ type: 'focus-session', sessionId: session.sessionId });
        return;
      }

      if (!game) return; // game keys need game state

      const tierId = TIER_KEYS[input];
      if (tierId && focusedRegion) {
        sendAction({ type: 'buy', regionId: focusedRegion.id, tierId });
        return;
      }
      if (input === 'a' && focusedRegion) {
        sendAction({ type: 'ack-incident', regionId: focusedRegion.id });
        return;
      }
      if (input === 'h') {
        sendAction({ type: 'hire' });
        return;
      }
      if (input === 'e') {
        sendAction({ type: 'experiment' });
        return;
      }
      if (input === 'v') {
        setMode('breakthroughs');
        return;
      }
      if (input === 'P') {
        if (canShipGeneration(game)) setMode('confirm-ship');
        else sendAction({ type: 'ship-generation' }); // engine narrates what's missing
      }
    },
    [mode, client, exit, sessions, regions.length, state.autofocusPaused, game, focusedRegion, sendAction]
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
          {!game ? (
            <Box borderStyle="round" paddingX={1}>
              <Text dimColor>waiting for game state from the daemon…</Text>
            </Box>
          ) : (
            <>
              <ResourceBar game={game} />
              {mode === 'confirm-ship' && (
                <Box borderStyle="double" paddingX={1}>
                  <Text color="magentaBright" bold>
                    Ship Gen-{game.generation}? This resets infrastructure and lab staff. [y]/[n]
                  </Text>
                </Box>
              )}
              {mode === 'breakthroughs' ? (
                <BreakthroughMenu game={game} />
              ) : focusedRegion ? (
                <RegionStage
                  game={game}
                  region={focusedRegion}
                  position={(regionIndex % regions.length) + 1}
                  count={regions.length}
                  flow={state.computeFlow[focusedRegion.id] ?? []}
                />
              ) : (
                <Box borderStyle="round" paddingX={1}>
                  <Text dimColor>no regions yet — the first Claude Code session founds one</Text>
                </Box>
              )}
              <LabPanel game={game} />
              <Feed log={game.log} />
            </>
          )}
          <Box paddingX={1} gap={2}>
            <Text dimColor>
              [q]uit [f]ocus [s]ession [tab]region [g/r/d]buy [h]ire [e]xperiment [a]ck [v]tree [P]ship
            </Text>
            <Text dimColor>
              ticks:{state.ticks}
              {state.lastTool ? ` last:${state.lastTool}` : ''}
            </Text>
          </Box>
        </>
      )}
    </Box>
  );
}
