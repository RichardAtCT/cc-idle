import React from 'react';
import { Box, Text } from 'ink';
import type { SessionSnapshot, SessionState } from '@ccidle/shared';
import { shortSessionId, totalTokens, cwdBasename, elapsedSince } from '../format.js';

const STATE_COLORS: Record<SessionState, string> = {
  HUMAN_ACTIVE: 'red',
  CC_WORKING: 'green',
  STALE: 'yellow',
  DEAD: 'gray'
};

export interface SessionStripProps {
  sessions: SessionSnapshot[];
  now: number;
  highlightIndex: number;
}

export function SessionStrip({ sessions, now, highlightIndex }: SessionStripProps): React.ReactElement {
  if (sessions.length === 0) {
    return (
      <Box borderStyle="round" paddingX={1}>
        <Text dimColor>no sessions tracked yet</Text>
      </Box>
    );
  }
  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      {sessions.map((session, index) => (
        <SessionRow
          key={session.sessionId}
          session={session}
          index={index}
          now={now}
          highlighted={index === highlightIndex}
        />
      ))}
    </Box>
  );
}

interface SessionRowProps {
  session: SessionSnapshot;
  index: number;
  now: number;
  highlighted: boolean;
}

function SessionRow({ session, index, now, highlighted }: SessionRowProps): React.ReactElement {
  const isHumanActive = session.state === 'HUMAN_ACTIVE';
  const isDead = session.state === 'DEAD';
  return (
    <Box gap={1}>
      <Text color={highlighted ? 'cyan' : undefined}>
        {highlighted ? '▶' : ' '}
        {index + 1}
      </Text>
      <Text>{shortSessionId(session.sessionId)}</Text>
      <Text color={STATE_COLORS[session.state]} bold={isHumanActive} inverse={isHumanActive} dimColor={isDead}>
        {session.state.padEnd(12, ' ')}
      </Text>
      <Text>{elapsedSince(session.stateSince, now)}</Text>
      <Text>tools:{session.toolCallsThisTurn}</Text>
      <Text>tok:{totalTokens(session)}</Text>
      <Text dimColor>{cwdBasename(session.cwd)}</Text>
    </Box>
  );
}
