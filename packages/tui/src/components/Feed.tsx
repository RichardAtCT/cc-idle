import React from 'react';
import { Box, Text } from 'ink';
import type { Narration } from '@ccidle/game';

export interface FeedProps {
  log: Narration[];
  limit?: number;
}

const KIND_COLOR: Record<Narration['kind'], string | undefined> = {
  info: undefined,
  good: 'green',
  bad: 'red',
  ceremony: 'magentaBright'
};

/** Narration feed: the telemetry→economy mapping, narrated as it happens (PRD §7). */
export function Feed({ log, limit = 6 }: FeedProps): React.ReactElement {
  const entries = log.slice(-limit);
  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      {entries.length === 0 ? (
        <Text dimColor>waiting for telemetry — delegate work to Claude Code and the economy starts</Text>
      ) : (
        entries.map((entry, index) => (
          <Text key={`${entry.ts}-${index}`} color={KIND_COLOR[entry.kind]} dimColor={entry.kind === 'info'}>
            {entry.text}
          </Text>
        ))
      )}
    </Box>
  );
}
