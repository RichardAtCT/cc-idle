import React from 'react';
import { Box, Text } from 'ink';
import type { GameState } from '@ccidle/game';
import {
  BALANCE,
  canShipGeneration,
  formatAmount,
  generationThreshold,
  hireCap,
  hireCost,
  labMultiplier
} from '@ccidle/game';
import { progressBar } from '../format.js';

export interface LabPanelProps {
  game: GameState;
}

/** Frontier-lab track (mechanics PRD §2): hires, experiments, the generation ladder. */
export function LabPanel({ game }: LabPanelProps): React.ReactElement {
  const threshold = generationThreshold(game.generation);
  const progress = game.lab.modelProgress;
  const cap = hireCap(game.resources.reputation);
  const nextHire = hireCost(game.lab.researchers);
  const canHire = game.lab.researchers < cap && game.resources.engineering >= nextHire;
  const canExperiment =
    game.resources.research >= BALANCE.lab.experimentDataCost &&
    game.resources.engineering >= BALANCE.lab.experimentEngineeringCost;
  const shippable = canShipGeneration(game);

  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Box justifyContent="space-between">
        <Text bold>FRONTIER LAB</Text>
        <Text>
          ☺ {game.lab.researchers}/{cap} researchers <Text dimColor>(×{labMultiplier(game).toFixed(2)})</Text>
        </Text>
      </Box>
      <Box gap={1}>
        <Text dimColor>Gen-{game.generation}</Text>
        <Text color={shippable ? 'green' : 'cyan'}>{progressBar(progress / threshold, 18)}</Text>
        <Text>
          {formatAmount(progress)}/{formatAmount(threshold)}
        </Text>
      </Box>
      <Box gap={2}>
        <Text color={canHire ? 'green' : undefined} dimColor={!canHire}>
          [h] hire {formatAmount(nextHire)} eng
        </Text>
        <Text color={canExperiment ? 'green' : undefined} dimColor={!canExperiment}>
          [e] experiment {BALANCE.lab.experimentDataCost} data + {BALANCE.lab.experimentEngineeringCost} eng
        </Text>
        <Text color={shippable ? 'greenBright' : undefined} bold={shippable} dimColor={!shippable}>
          [P] ship Gen-{game.generation}
        </Text>
        <Text dimColor>[v] breakthroughs</Text>
      </Box>
    </Box>
  );
}
