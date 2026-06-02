import { type AuthLoginPhase, type ConnectionSettings, type IAuth, reduceAuthLogin } from '@inflowpayai/inflow-core';
import { Box, Text, useInput } from 'ink';
import Spinner from 'ink-spinner';
import type React from 'react';
import { useEffect, useReducer } from 'react';
import { useFlowExit } from '../../hooks/use-flow-exit.js';
import { openUrl } from '../../utils/open-url.js';

export interface LoginProps {
  auth: IAuth;
  clientName: string;
  connection: ConnectionSettings;
  priorRefreshToken?: string;
  onComplete: () => void;
}

export const Login: React.FC<LoginProps> = ({ auth, clientName, connection, priorRefreshToken, onComplete }) => {
  const initialPhase: AuthLoginPhase = { kind: 'init' };
  const [phase, dispatch] = useReducer(reduceAuthLogin, initialPhase);
  const { finish } = useFlowExit(onComplete);

  useInput(
    (_input, key) => {
      if (key.return && phase.kind === 'awaiting') {
        openUrl(phase.req.verification_url_complete);
      }
    },
    { isActive: phase.kind === 'awaiting' },
  );

  useEffect(() => {
    const run = auth.login({
      clientName,
      connection,
      ...(priorRefreshToken !== undefined ? { priorRefreshToken } : {}),
    });

    let cancelled = false;
    void (async () => {
      for await (const event of run.events) {
        if (cancelled) return;
        dispatch(event);
      }
    })();

    return () => {
      cancelled = true;
      run.cancel();
    };
  }, [auth, clientName, connection, priorRefreshToken]);

  useEffect(() => {
    if (phase.kind === 'success' || phase.kind === 'expired' || phase.kind === 'denied' || phase.kind === 'failed') {
      finish();
    }
  }, [phase, finish]);

  if (phase.kind === 'init') {
    return (
      <Box>
        <Text color="cyan">
          <Spinner type="dots" /> Initiating authentication...
        </Text>
      </Box>
    );
  }

  if (phase.kind === 'success') {
    return (
      <Box flexDirection="column">
        <Text color="green">✓ Successfully authenticated!</Text>
        <Text dimColor>Credentials saved locally.</Text>
      </Box>
    );
  }

  if (phase.kind === 'expired') {
    return (
      <Box flexDirection="column">
        <Text color="red">✗ Authentication failed</Text>
        <Text color="red">Device code expired. Run &quot;inflow auth login&quot; to try again.</Text>
      </Box>
    );
  }

  if (phase.kind === 'denied') {
    return (
      <Box flexDirection="column">
        <Text color="red">✗ Authentication failed</Text>
        <Text color="red">Authorization denied.</Text>
      </Box>
    );
  }

  if (phase.kind === 'failed') {
    return (
      <Box flexDirection="column">
        <Text color="red">✗ Authentication failed</Text>
        <Text color="red">{phase.message}</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" paddingY={1}>
      <Box marginBottom={1}>
        <Text bold>Authentication</Text>
      </Box>
      <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={2} paddingY={1}>
        <Text>
          {'Open: '}
          <Text bold color="cyan">
            {phase.req.verification_url_complete}
          </Text>
        </Text>
        <Text dimColor>Press Enter to open in browser.</Text>
        <Text>
          {'Enter phrase: '}
          <Text bold color="yellow">
            {phase.req.user_code}
          </Text>
        </Text>
      </Box>
      <Box marginTop={1}>
        <Text color="cyan">
          <Spinner type="dots" /> Waiting for authorization...
        </Text>
      </Box>
    </Box>
  );
};
