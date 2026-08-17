import React from 'react';
import { Box, Text } from 'ink';
import type { GameState } from '@ccidle/game';
import { formatAmount } from '@ccidle/game';

export interface ResourceBarProps {
  game: GameState;
}

/** One-line resource readout (mechanics PRD §3): why did that number go up? Watch it here. */
export function ResourceBar({ game }: ResourceBarProps): React.ReactElement {
  const r = game.resources;
  return (
    <Box gap={2} paddingX={1}>
      <Text>
        <Text color="cyan" bold>
          {formatAmount(r.compute)}
        </Text>
        <Text dimColor> FLOPS</Text>
      </Text>
      <Text>
        <Text color="yellow" bold>
          {formatAmount(r.engineering)}
        </Text>
        <Text dimColor> ENG</Text>
      </Text>
      <Text>
        <Text color="magenta" bold>
          {formatAmount(r.research)}
        </Text>
        <Text dimColor> DATA</Text>
      </Text>
      <Text>
        <Text color="green" bold>
          {formatAmount(r.reputation)}
        </Text>
        <Text dimColor> REP</Text>
      </Text>
      <Text>
        <Text color="white" bold>
          {formatAmount(r.breakthroughs)}
        </Text>
        <Text dimColor> BT</Text>
      </Text>
      <Text>
        <Text bold>GEN-{game.generation}</Text>
      </Text>
    </Box>
  );
}
