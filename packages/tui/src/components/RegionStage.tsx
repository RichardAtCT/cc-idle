import React from 'react';
import { Box, Text } from 'ink';
import type { GameState, Region } from '@ccidle/game';
import { BALANCE, INFRA_TIERS, formatAmount, regionMultiplier, tierCost } from '@ccidle/game';
import { progressBar, sparkline } from '../format.js';

export interface RegionStageProps {
  game: GameState;
  region: Region;
  /** Region count and 1-based position, for the "◂ 2/3 ▸" cycle hint. */
  position: number;
  count: number;
  /** Recent compute deltas for this region (store's flow ring). */
  flow: number[];
}

const STATUS_LABEL: Record<Region['status'], { text: string; color: string }> = {
  hot: { text: '● HOT', color: 'green' },
  idle: { text: '○ idle', color: 'gray' },
  dark: { text: '▓ DARK', color: 'red' }
};

const GPUS_PER_RACK_FRAME = 8;
const MAX_RACK_FRAMES = 6;

/** ASCII rack diagram: each frame holds 8 GPU cells, filling as GPUs come online. */
function rackDiagram(region: Region): string {
  const gpus = region.infrastructure['gpu'] ?? 0;
  const frames = Math.max(1, Math.ceil(gpus / GPUS_PER_RACK_FRAME));
  const shown = Math.min(frames, MAX_RACK_FRAMES);
  const parts: string[] = [];
  for (let i = 0; i < shown; i += 1) {
    const cells = Math.max(0, Math.min(GPUS_PER_RACK_FRAME, gpus - i * GPUS_PER_RACK_FRAME));
    parts.push(`[${'█'.repeat(cells)}${'·'.repeat(GPUS_PER_RACK_FRAME - cells)}]`);
  }
  if (frames > shown) parts.push(`+${frames - shown}`);
  return parts.join(' ');
}

/** Main stage: the focused region as a NOC dashboard (mechanics PRD §8). */
export function RegionStage({ game, region, position, count, flow }: RegionStageProps): React.ReactElement {
  const status = STATUS_LABEL[region.status];
  const multiplier = regionMultiplier(region);
  const windowUsed = region.window.outputTokens;
  const fullRate = BALANCE.compute.fullRateTokensPerWindow;
  const diminished = windowUsed > fullRate;

  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Box justifyContent="space-between">
        <Text>
          <Text bold color="cyan">
            {region.name}
          </Text>
          <Text dimColor>
            {'  '}◂ {position}/{count} ▸ [tab]
          </Text>
        </Text>
        <Text color={status.color} bold={region.status !== 'idle'}>
          {status.text}
        </Text>
        <Text>
          mult <Text bold>×{multiplier.toFixed(2)}</Text>
        </Text>
      </Box>

      <Box gap={2}>
        {INFRA_TIERS.map((tier) => (
          <Text key={tier.id}>
            <Text dimColor>{tier.glyph}</Text> {region.infrastructure[tier.id] ?? 0} {tier.name}
          </Text>
        ))}
      </Box>
      <Text>{rackDiagram(region)}</Text>

      <Box gap={1}>
        <Text dimColor>flow</Text>
        <Text color="cyan">{sparkline(flow)}</Text>
        <Text dimColor>Σ{formatAmount(region.totals.compute)}</Text>
      </Box>

      <Box gap={1}>
        <Text dimColor>rate</Text>
        <Text color={diminished ? 'yellow' : 'green'}>
          {progressBar(Math.min(1, windowUsed / fullRate), 14)}
        </Text>
        <Text dimColor>
          {diminished ? 'diminishing returns active' : `${formatAmount(fullRate - windowUsed)} full-rate tokens left this hour`}
        </Text>
      </Box>

      <Box gap={2}>
        {INFRA_TIERS.map((tier, index) => {
          const key = ['g', 'r', 'd'][index] ?? '?';
          const cost = tierCost(tier, region.infrastructure[tier.id] ?? 0);
          const affordable = game.resources.compute >= cost;
          return (
            <Text key={tier.id} color={affordable ? 'green' : undefined} dimColor={!affordable}>
              [{key}] {tier.name} {formatAmount(cost)}
            </Text>
          );
        })}
      </Box>

      {region.incidents.length > 0 && (
        <Box flexDirection="column">
          {region.incidents.map((incident) => (
            <Text key={incident.id} color="red">
              ⚡ {incident.title} <Text dimColor>[a] acknowledge</Text>
            </Text>
          ))}
        </Box>
      )}
    </Box>
  );
}
