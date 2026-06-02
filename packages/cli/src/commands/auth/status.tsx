import {
  type AuthenticatedFrame,
  type AuthSnapshotFrame,
  type AuthStatusProbeResult,
  type ConnectionSettings,
  describeUser,
  type IAuth,
  type User,
} from '@inflowpayai/inflow-core';
import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';
import type React from 'react';
import { useEffect, useReducer } from 'react';
import { useFlowExit } from '../../hooks/use-flow-exit.js';

type View =
  | { kind: 'loading' }
  | { kind: 'probing'; frame: AuthenticatedFrame }
  | { kind: 'snapshot'; frame: AuthSnapshotFrame }
  | { kind: 'probed'; frame: AuthenticatedFrame; user: User | null }
  | { kind: 'invalid'; frame: Record<string, unknown> }
  | { kind: 'failed'; message: string };

type Event =
  | { type: 'snapshot'; frame: AuthSnapshotFrame }
  | { type: 'probeStart'; frame: AuthenticatedFrame }
  | { type: 'probeResult'; result: AuthStatusProbeResult };

function reduce(_state: View, event: Event): View {
  switch (event.type) {
    case 'snapshot':
      return { kind: 'snapshot', frame: event.frame };
    case 'probeStart':
      return { kind: 'probing', frame: event.frame };
    case 'probeResult':
      switch (event.result.kind) {
        case 'pending':
        case 'unauthenticated':
          return { kind: 'snapshot', frame: event.result.frame };
        case 'authenticated':
          return { kind: 'probed', frame: event.result.frame, user: event.result.user };
        case 'invalid':
          return { kind: 'invalid', frame: event.result.frame };
        case 'error':
          return {
            kind: 'failed',
            message: event.result.error instanceof Error ? event.result.error.message : String(event.result.error),
          };
      }
  }
}

export interface AuthStatusProps {
  auth: IAuth;
  probe: boolean;
  apiKey?: string;
  displayConnection?: ConnectionSettings;
  verbose?: boolean;
  updateNotice?: { current: string; latest: string };
  onComplete: () => void;
}

function composeOptions(args: {
  apiKey: string | undefined;
  displayConnection: ConnectionSettings | undefined;
  verbose: boolean | undefined;
}) {
  return {
    ...(args.apiKey !== undefined && args.apiKey.length > 0 ? { effectiveApiKey: args.apiKey } : {}),
    ...(args.displayConnection !== undefined ? { connection: args.displayConnection } : {}),
    ...(args.verbose === true ? { verbose: true } : {}),
  };
}

export const AuthStatus: React.FC<AuthStatusProps> = ({
  auth,
  probe,
  apiKey,
  displayConnection,
  verbose,
  updateNotice,
  onComplete,
}) => {
  const initial: View = { kind: 'loading' };
  const [view, dispatch] = useReducer(reduce, initial);
  const { finish } = useFlowExit(onComplete);

  useEffect(() => {
    let cancelled = false;
    const options = composeOptions({ apiKey, displayConnection, verbose });
    const snapshot = auth.snapshot(options);

    if (!probe || !snapshot.authenticated) {
      dispatch({ type: 'snapshot', frame: snapshot });
      return undefined;
    }

    dispatch({ type: 'probeStart', frame: snapshot });
    void (async () => {
      const result = await auth.probeStatus({ composeOptions: options });
      if (!cancelled) dispatch({ type: 'probeResult', result });
    })();

    return () => {
      cancelled = true;
    };
  }, [auth, probe, apiKey, displayConnection, verbose]);

  useEffect(() => {
    if (view.kind === 'loading' || view.kind === 'probing') return;
    finish();
  }, [view, finish]);

  if (view.kind === 'loading') return null;

  if (view.kind === 'probing') {
    return (
      <Box>
        <Text color="cyan">
          <Spinner type="dots" /> Validating session...
        </Text>
      </Box>
    );
  }

  if (view.kind === 'failed') {
    return (
      <Box flexDirection="column">
        <Text color="red">✗ Probe failed</Text>
        <Text color="red">{view.message}</Text>
      </Box>
    );
  }

  const updateFooter = updateNotice ? (
    <Box flexDirection="column" marginTop={1}>
      <Text dimColor>{`Update available: ${updateNotice.current} -> ${updateNotice.latest}`}</Text>
      <Text dimColor>Run: npm install -g @inflowpayai/inflow</Text>
    </Box>
  ) : null;

  if (view.kind === 'snapshot' && view.frame.authenticated) {
    return renderAuthenticated(view.frame, null, verbose === true, updateFooter);
  }

  if (view.kind === 'probed') {
    return renderAuthenticated(view.frame, view.user, verbose === true, updateFooter);
  }

  // Unauthenticated paths: kind === 'snapshot' (no auth or pending) or kind === 'invalid' (probed 401).
  const isInvalid = view.kind === 'invalid';
  const credentialsPath =
    view.kind === 'snapshot' && 'credentials_path' in view.frame ? view.frame.credentials_path : undefined;
  return (
    <Box flexDirection="column">
      <Text color="yellow">✗ Not authenticated</Text>
      <Text dimColor>Run &quot;inflow auth login&quot; to authenticate.</Text>
      {verbose && credentialsPath !== undefined ? (
        <Box marginTop={1} paddingX={2}>
          <Text>
            {'Credentials: '}
            <Text bold>{credentialsPath}</Text>
          </Text>
          {isInvalid ? (
            <Text dimColor>{'\nNote: local credentials failed validation — clear with "inflow auth logout".'}</Text>
          ) : null}
        </Box>
      ) : isInvalid ? (
        <Box marginTop={1} paddingX={2}>
          <Text dimColor>Local credentials failed validation — clear with &quot;inflow auth logout&quot;.</Text>
        </Box>
      ) : null}
      {updateFooter}
    </Box>
  );
};

function renderAuthenticated(
  frame: AuthenticatedFrame,
  user: User | null,
  verbose: boolean,
  updateFooter: React.ReactNode,
): React.ReactElement {
  return (
    <Box flexDirection="column">
      <Text color="green">✓ Authenticated</Text>
      <Box flexDirection="column" marginTop={1} paddingX={2}>
        <Text>
          {'Method: '}
          <Text bold>{frame.auth_method === 'api_key' ? 'API key' : 'Device token'}</Text>
        </Text>
        {frame.auth_method === 'device_token' && frame.access_token !== undefined ? (
          <Text>
            {'Access token: '}
            <Text bold>{frame.access_token}</Text>
          </Text>
        ) : null}
        {frame.auth_method === 'device_token' && frame.token_type !== undefined ? (
          <Text>
            {'Token type: '}
            <Text bold>{frame.token_type}</Text>
          </Text>
        ) : null}
        {user !== null ? (
          <Text>
            {'Authenticated as: '}
            <Text bold>{describeUser(user)}</Text>
          </Text>
        ) : null}
        {frame.connection?.environment !== undefined ? (
          <Text>
            {'Environment: '}
            <Text bold>{frame.connection.environment}</Text>
          </Text>
        ) : null}
        {frame.connection?.apiBaseUrl !== undefined ? (
          <Text>
            {'API base URL: '}
            <Text bold>{frame.connection.apiBaseUrl}</Text>
          </Text>
        ) : null}
        {frame.connection?.authBaseUrl !== undefined ? (
          <Text>
            {'Auth base URL: '}
            <Text bold>{frame.connection.authBaseUrl}</Text>
          </Text>
        ) : null}
        {verbose && frame.credentials_path !== undefined ? (
          <Text>
            {'Credentials: '}
            <Text bold>{frame.credentials_path}</Text>
          </Text>
        ) : null}
      </Box>
      {updateFooter}
    </Box>
  );
}
