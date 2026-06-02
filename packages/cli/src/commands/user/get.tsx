import { buildProfileRows, type User } from '@inflowpayai/inflow-core';
import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';
import type React from 'react';
import { useCallback, useRef } from 'react';
import { useFlowExit } from '../../hooks/use-flow-exit.js';
import { useFlowState } from '../../hooks/use-flow-state.js';

export type UserGetOutcome = { kind: 'success'; user: User } | { kind: 'error'; message: string };

export interface UserGetProps {
  userResource: { retrieve: () => Promise<User> };
  onComplete: (outcome: UserGetOutcome) => void;
}

export const UserGet: React.FC<UserGetProps> = ({ userResource, onComplete }) => {
  const action = useCallback(() => userResource.retrieve(), [userResource]);
  const { finish } = useFlowExit(onComplete);

  const lastErrorRef = useRef<string>('');

  const handleLinger = useCallback(
    (result: User | null) => {
      if (result !== null) {
        finish({ kind: 'success', user: result });
      } else {
        finish({
          kind: 'error',
          message: lastErrorRef.current || 'No result produced.',
        });
      }
    },
    [finish],
  );

  const { status, data: user, error } = useFlowState(action, handleLinger);
  lastErrorRef.current = error;

  if (status === 'loading') {
    return (
      <Box>
        <Text color="cyan">
          <Spinner type="dots" /> Loading user...
        </Text>
      </Box>
    );
  }

  if (status === 'error') {
    return (
      <Box flexDirection="column">
        <Text color="red">✗ Failed to retrieve user</Text>
        <Text color="red">{error}</Text>
      </Box>
    );
  }

  if (user === null) return null;

  const rows = buildProfileRows(user);

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={2} paddingY={1}>
      {rows.map((row) => (
        <Text key={row.label}>
          {`${row.label}: `}
          {row.value !== null ? <Text bold>{row.value}</Text> : <Text dimColor>—</Text>}
        </Text>
      ))}
    </Box>
  );
};
