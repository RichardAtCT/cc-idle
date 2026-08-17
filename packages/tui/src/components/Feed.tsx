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
  // slice(-0) would return the whole log, so an exhausted row budget has to
  // short-circuit; the caller counts on this panel being exactly `limit` rows.
  const entries = limit > 0 ? log.slice(-limit) : [];
  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      {entries.length === 0
        ? limit > 0 && (
            <Text dimColor>waiting for telemetry — delegate work to Claude Code and the economy starts</Text>
          )
        : entries.map((entry, index) => (
            // truncate: region names and incident titles are user-derived, so a
            // wrapped entry would silently cost the layout an extra row.
            <Text
              key={`${entry.ts}-${index}`}
              color={KIND_COLOR[entry.kind]}
              dimColor={entry.kind === 'info'}
              wrap="truncate-end"
            >
              {entry.text}
            </Text>
          ))}
    </Box>
  );
}
