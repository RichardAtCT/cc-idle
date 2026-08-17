import React from 'react';
import { Box, Text } from 'ink';

export interface GamePanelProps {
  ticks: number;
  lastTool?: string;
}

/** Placeholder game surface — proves the telemetry loop end-to-end (PRD §3.4). */
export function GamePanel({ ticks, lastTool }: GamePanelProps): React.ReactElement {
  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1} marginTop={1}>
      <Text bold color="cyan">
        TICKS: {ticks}
      </Text>
      <Text dimColor>last tool: {lastTool ?? '—'}</Text>
    </Box>
  );
}
