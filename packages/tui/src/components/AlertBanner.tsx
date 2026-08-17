import React from 'react';
import { Box, Text, useStdout } from 'ink';
import { shortSessionId } from '../format.js';

export interface AlertBannerProps {
  sessionId: string;
}

/** Full-width inverse-video "needs you" banner (PRD §3.4). */
export function AlertBanner({ sessionId }: AlertBannerProps): React.ReactElement {
  const { stdout } = useStdout();
  const width = stdout?.columns ?? 80;
  const label = ` ⚠ SESSION ${shortSessionId(sessionId)} NEEDS YOU — [1..9] to jump `;
  const padded = label.length < width ? label + ' '.repeat(width - label.length) : label;
  return (
    <Box>
      <Text inverse bold color="red">
        {padded}
      </Text>
    </Box>
  );
}
