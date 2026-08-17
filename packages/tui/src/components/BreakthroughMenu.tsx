import React from 'react';
import { Box, Text } from 'ink';
import type { GameState } from '@ccidle/game';
import { BREAKTHROUGH_NODES, breakthroughLevel, formatAmount } from '@ccidle/game';

export interface BreakthroughMenuProps {
  game: GameState;
}

/** Modal Breakthrough tree (M2): digits buy, [v]/[esc] closes. */
export function BreakthroughMenu({ game }: BreakthroughMenuProps): React.ReactElement {
  return (
    <Box flexDirection="column" borderStyle="double" paddingX={1}>
      <Box justifyContent="space-between">
        <Text bold color="magentaBright">
          BREAKTHROUGHS
        </Text>
        <Text>
          {formatAmount(game.resources.breakthroughs)} banked <Text dimColor>[v]/[esc] close</Text>
        </Text>
      </Box>
      {BREAKTHROUGH_NODES.map((node, index) => {
        const level = breakthroughLevel(game, node.id);
        const maxed = level >= node.maxLevel;
        const cost = maxed ? null : node.cost(level);
        const affordable = cost !== null && game.resources.breakthroughs >= cost;
        return (
          <Text key={node.id} color={maxed ? 'gray' : affordable ? 'green' : undefined} dimColor={!maxed && !affordable}>
            [{index + 1}] {node.name} {level}/{node.maxLevel}
            {maxed ? ' — MAX' : ` — ${cost} BT`} <Text dimColor>· {node.description}</Text>
          </Text>
        );
      })}
    </Box>
  );
}
