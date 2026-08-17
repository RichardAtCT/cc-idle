import React from 'react';
import { Box, Text } from 'ink';
import type { ConnectionStatus } from '../store.js';

export interface HeaderProps {
  connection: ConnectionStatus;
  autofocusPaused: boolean;
}

export function Header({ connection, autofocusPaused }: HeaderProps): React.ReactElement {
  const connected = connection === 'connected';
  return (
    <Box justifyContent="space-between" paddingX={1}>
      <Text bold>CC IDLE</Text>
      <Text color={connected ? 'green' : 'red'}>
        {connected ? '● connected' : '○ daemon offline — reconnecting…'}
      </Text>
      <Text color={autofocusPaused ? 'yellow' : 'green'}>
        autofocus: {autofocusPaused ? 'off' : 'on'}
      </Text>
    </Box>
  );
}
