import {
  type AuthLoginApiKeyPhase,
  type ConnectionSettings,
  describeUser,
  type IAuth,
  reduceAuthLoginApiKey,
} from '@inflowpayai/inflow-core';
import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';
import type React from 'react';
import { useEffect, useReducer } from 'react';
import { useFlowExit } from '../../hooks/use-flow-exit.js';

export interface LoginApiKeyProps {
  apiKey: string;
  auth: IAuth;
  connection: ConnectionSettings;
  onComplete: () => void;
}

export const LoginApiKey: React.FC<LoginApiKeyProps> = ({ apiKey, auth, connection, onComplete }) => {
  const initial: AuthLoginApiKeyPhase = { kind: 'validating' };
  const [phase, dispatch] = useReducer(reduceAuthLoginApiKey, initial);
  const { finish } = useFlowExit(onComplete);

  useEffect(() => {
    const run = auth.loginApiKey({ apiKey, connection });
    let cancelled = false;
    void (async () => {
      for await (const event of run.events) {
        if (cancelled) return;
        dispatch(event);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [apiKey, auth, connection]);

  useEffect(() => {
    if (phase.kind === 'validating') return;
    finish();
  }, [phase, finish]);

  if (phase.kind === 'validating') {
    return (
      <Box>
        <Text color="cyan">
          <Spinner type="dots" /> Validating API key...
        </Text>
      </Box>
    );
  }

  if (phase.kind === 'failed') {
    return (
      <Box flexDirection="column">
        <Text color="red">✗ API key not accepted</Text>
        <Text color="red">{phase.message}</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Text color="green">✓ Saved API key</Text>
      <Box flexDirection="column" marginTop={1} paddingX={2}>
        <Text>
          {'Authenticated as: '}
          <Text bold>{describeUser(phase.user)}</Text>
        </Text>
      </Box>
    </Box>
  );
};
