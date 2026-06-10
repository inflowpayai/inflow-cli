import {
  type AuthStorage,
  type ConnectionSettings,
  describeUser,
  type DeviceAuthRequest,
  type IAuth,
  InflowApiError,
  type IUserResource,
  probeSession,
  sanitizeDeep,
  type UpdateBlock,
  type User,
} from '@inflowpayai/inflow-core';
import { Cli } from 'incur';
import { Text } from 'ink';
import React, { useEffect, useState } from 'react';
import { useFlowExit } from '../../hooks/use-flow-exit.js';
import { renderInkUntilExit } from '../../utils/render-ink-until-exit.js';
import type { UpdateInfo, UpdateProbe } from '../../utils/update-probe.js';
import { NPM_INSTALL_COMMAND } from '../../utils/user-display.js';
import { Login } from './login.js';
import { LoginApiKey } from './login-api-key.js';
import { LoginPrompt } from './login-prompt.js';
import { Logout } from './logout.js';
import { loginOptions, statusOptions } from './schema.js';
import { AuthStatus } from './status.js';

export interface AuthCommandContext {
  apiKey: string | undefined;
  apiKeySource: 'flag' | 'env' | 'saved' | undefined;
  environment: 'production' | 'sandbox';
  apiBaseUrl?: string;
  authBaseUrl?: string;
  resolvedApiBaseUrl: string;
  verbose: boolean;
}

function connectionFromContext(ctx: AuthCommandContext): ConnectionSettings {
  const settings: ConnectionSettings = { environment: ctx.environment };
  if (ctx.apiBaseUrl !== undefined) settings.apiBaseUrl = ctx.apiBaseUrl;
  if (ctx.authBaseUrl !== undefined) settings.authBaseUrl = ctx.authBaseUrl;
  return settings;
}

function displayConnection(stored: ConnectionSettings | null, ctx: AuthCommandContext): ConnectionSettings {
  const out: ConnectionSettings = {
    environment: stored?.environment ?? ctx.environment,
    apiBaseUrl: stored?.apiBaseUrl ?? ctx.apiBaseUrl ?? ctx.resolvedApiBaseUrl,
  };
  const auth = stored?.authBaseUrl ?? ctx.authBaseUrl;
  if (auth !== undefined) out.authBaseUrl = auth;
  return out;
}

const INSTRUCTION_NO_INTERVAL =
  'Present the verification_url to the user and ask them to authorize. Then call `auth status --interval 5 --max-attempts 60` to poll until authenticated. Do not wait for the user to reply - start polling immediately.';

const INSTRUCTION_WITH_INTERVAL =
  'Present the verification_url to the user and ask them to authorize in their browser. Polling has started automatically — no further action needed.';

const POST_LOGIN_TIP = 'Signed in. Try: inflow balances list or inflow x402 pay <url>.';

const PROBE_TIMEOUT_MS = 30_000;

type ErrorOptions = {
  code: string;
  message: string;
  retryable?: boolean;
};

interface AuthLoginContext {
  agent: boolean;
  formatExplicit: boolean;
  options: {
    clientName: string;
    interval: number;
    maxAttempts: number;
    timeout: number;
  };
  error: (err: ErrorOptions) => never;
}

interface AuthLogoutContext {
  agent: boolean;
  formatExplicit: boolean;
}

interface AuthStatusContext {
  agent: boolean;
  formatExplicit: boolean;
  options: {
    interval: number;
    maxAttempts: number;
    timeout: number;
    probe: boolean;
  };
  error: (err: ErrorOptions) => never;
}

interface InitialLoginPayload {
  verification_url: string;
  phrase: string;
  instruction: string;
  tip: string;
  _next?: {
    command: string;
    poll_interval_seconds: number;
    until: string;
  };
}

export function buildInitialLoginPayload(req: DeviceAuthRequest, interval: number): InitialLoginPayload {
  const base: InitialLoginPayload = {
    verification_url: req.verification_url_complete,
    phrase: req.user_code,
    instruction: interval <= 0 ? INSTRUCTION_NO_INTERVAL : INSTRUCTION_WITH_INTERVAL,
    tip: POST_LOGIN_TIP,
  };
  if (interval <= 0) {
    base._next = {
      command: 'auth status --interval 5 --max-attempts 60',
      poll_interval_seconds: 5,
      until: 'authenticated is true',
    };
  }
  return base;
}

export function toUpdateBlock(info: UpdateInfo | undefined): UpdateBlock | undefined {
  if (!info) return undefined;
  return {
    current_version: info.current,
    latest_version: info.latest,
    update_command: NPM_INSTALL_COMMAND,
  };
}

interface InteractiveLoginShellProps {
  authResource: IAuth;
  authStorage: AuthStorage;
  userResource: IUserResource;
  clientName: string;
  connection: ConnectionSettings;
  onComplete: () => void;
}

type Stage =
  | { kind: 'probing' }
  | { kind: 'prompt'; userDisplay: string; priorRefreshToken: string }
  | { kind: 'declined' }
  | { kind: 'flow'; priorRefreshToken?: string };

export const InteractiveLoginShell: React.FC<InteractiveLoginShellProps> = ({
  authResource,
  authStorage,
  userResource,
  clientName,
  connection,
  onComplete,
}) => {
  const initial: Stage = { kind: 'probing' };
  const [stage, setStage] = useState<Stage>(initial);
  const { finish } = useFlowExit(onComplete);

  useEffect(() => {
    let cancelled = false;
    const auth = authStorage.getAuth();
    if (!auth) {
      setStage({ kind: 'flow' });
      return undefined;
    }
    void (async () => {
      const result = await probeSession(userResource, {
        timeoutMs: PROBE_TIMEOUT_MS,
      });
      if (cancelled) return;
      if (result.ok) {
        setStage({
          kind: 'prompt',
          userDisplay: describeUser(result.user),
          priorRefreshToken: auth.refresh_token,
        });
        return;
      }
      setStage({ kind: 'flow' });
    })();
    return () => {
      cancelled = true;
    };
  }, [authStorage, userResource]);

  useEffect(() => {
    if (stage.kind !== 'declined') return;
    finish();
  }, [stage, finish]);

  if (stage.kind === 'probing') return null;

  if (stage.kind === 'prompt') {
    return (
      <LoginPrompt
        userDisplay={stage.userDisplay}
        onAccept={() => setStage({ kind: 'flow', priorRefreshToken: stage.priorRefreshToken })}
        onReject={() => setStage({ kind: 'declined' })}
      />
    );
  }

  if (stage.kind === 'declined') {
    return <Text dimColor>No change. Use &quot;inflow auth logout&quot; to sign out first.</Text>;
  }

  const loginProps = stage.priorRefreshToken !== undefined ? { priorRefreshToken: stage.priorRefreshToken } : {};
  return (
    <Login
      auth={authResource}
      clientName={clientName}
      connection={connection}
      {...loginProps}
      onComplete={onComplete}
    />
  );
};

interface ApiKeyLoginFrame {
  authenticated: true;
  method: 'api_key';
  user: User;
  connection: ConnectionSettings;
}

async function runApiKeyLogin(
  c: AuthLoginContext,
  deps: {
    userResource: IUserResource;
    authStorage: AuthStorage;
  },
  apiKey: string,
  connection: ConnectionSettings,
): Promise<ApiKeyLoginFrame | undefined> {
  let user: User;
  try {
    user = await deps.userResource.retrieve();
  } catch (error) {
    if (error instanceof InflowApiError && error.status === 401) {
      return c.error({
        code: 'API_KEY_REJECTED',
        message: 'API key was rejected by the server (HTTP 401). Check the key value and try again.',
      });
    }
    return c.error({
      code: 'API_KEY_VALIDATION_FAILED',
      message: error instanceof Error ? error.message : String(error),
    });
  }
  deps.authStorage.clearAuth();
  deps.authStorage.clearPendingDeviceAuth();
  deps.authStorage.setApiKey(apiKey);
  deps.authStorage.setConnection(connection);
  return {
    authenticated: true,
    method: 'api_key',
    user,
    connection,
  };
}

async function* runAuthLogin(
  c: AuthLoginContext,
  deps: {
    authResource: IAuth;
    userResource: IUserResource;
    authStorage: AuthStorage;
  },
  ctx: AuthCommandContext,
): AsyncGenerator<unknown, unknown> {
  const clientName = c.options.clientName.trim();
  if (clientName.length === 0) {
    return c.error({
      code: 'INVALID_INPUT',
      message: 'client-name must be a non-empty string',
    });
  }

  const connection = connectionFromContext(ctx);

  if (ctx.apiKey !== undefined && ctx.apiKey.length > 0) {
    if (!c.agent && !c.formatExplicit) {
      await renderInkUntilExit(
        <LoginApiKey
          apiKey={ctx.apiKey}
          auth={deps.authResource}
          connection={connection}
          onComplete={() => undefined}
        />,
      );
      return;
    }
    const frame = await runApiKeyLogin(c, deps, ctx.apiKey, connection);
    if (frame !== undefined) {
      yield sanitizeDeep(frame);
    }
    return;
  }

  if (!c.agent && !c.formatExplicit) {
    await renderInkUntilExit(
      <InteractiveLoginShell
        authResource={deps.authResource}
        authStorage={deps.authStorage}
        userResource={deps.userResource}
        clientName={clientName}
        connection={connection}
        onComplete={() => undefined}
      />,
    );
    return;
  }

  const loginRun = deps.authResource.login({
    clientName,
    connection,
    ...(c.options.interval > 0 ? { pollIntervalMs: c.options.interval * 1000 } : {}),
    ...(c.options.maxAttempts > 0 ? { pollMaxAttempts: c.options.maxAttempts } : {}),
    ...(c.options.timeout > 0 ? { pollTimeoutSeconds: c.options.timeout } : {}),
  });

  try {
    for await (const event of loginRun.events) {
      if (event.type === 'initiated') {
        deps.authStorage.setPendingDeviceAuth({
          device_code: event.req.device_code,
          interval: event.req.interval,
          expires_at: Date.now() + event.req.expires_in * 1000,
          verification_url: event.req.verification_url_complete,
          phrase: event.req.user_code,
        });
        yield sanitizeDeep(buildInitialLoginPayload(event.req, c.options.interval));
        if (c.options.interval <= 0) {
          loginRun.cancel();
          return;
        }
        continue;
      }
      if (event.type === 'tokensReceived') {
        // auth.login() has already written tokens, cleared the API key, and pinned the connection block.
        yield sanitizeDeep({ authenticated: true });
        return;
      }
      if (event.type === 'pollExpired') {
        yield sanitizeDeep({ authenticated: false, expired: true });
        return c.error({
          code: 'EXPIRED_TOKEN',
          message: 'Device code expired. Please restart the login flow.',
        });
      }
      if (event.type === 'pollTimedOut') {
        yield sanitizeDeep({ authenticated: false });
        return c.error({
          code: 'POLLING_TIMEOUT',
          message:
            event.reason === 'timeout'
              ? 'Polling timed out before authentication completed.'
              : 'Reached the configured maximum poll attempts before authentication completed.',
          retryable: true,
        });
      }
      if (event.type === 'pollDenied') {
        yield sanitizeDeep({ authenticated: false, denied: true });
        return c.error({
          code: 'ACCESS_DENIED',
          message: 'Authorization denied by user.',
        });
      }
      if (event.type === 'initiateFailed') {
        return c.error({
          code: 'DEVICE_AUTH_INITIATE_FAILED',
          message: event.message,
        });
      }
      // event.type === 'pollFailed'
      yield sanitizeDeep({ authenticated: false });
      return c.error({
        code: 'DEVICE_AUTH_POLL_FAILED',
        message: event.message,
      });
    }
  } finally {
    loginRun.cancel();
  }
}

async function runAuthLogout(
  c: AuthLogoutContext,
  deps: { authResource: IAuth; authStorage: AuthStorage },
): Promise<{ authenticated: false }> {
  if (!c.agent && !c.formatExplicit) {
    await renderInkUntilExit(<Logout auth={deps.authResource} onComplete={() => undefined} />);
    return { authenticated: false };
  }

  await deps.authResource.logout();
  return { authenticated: false };
}

async function* runAuthStatus(
  c: AuthStatusContext,
  deps: {
    authResource: IAuth;
    userResource: IUserResource;
    authStorage: AuthStorage;
    updateProbe: UpdateProbe | undefined;
  },
  ctx: AuthCommandContext,
): AsyncGenerator<unknown, unknown> {
  const updateInfo = await deps.updateProbe?.({
    polling: c.options.interval > 0,
  });
  const update = toUpdateBlock(updateInfo);
  const storedConnection = deps.authStorage.getConnection();
  const effectiveConnection = displayConnection(storedConnection, ctx);
  const composeOptions = {
    ...(update !== undefined ? { update } : {}),
    ...(ctx.apiKey !== undefined && ctx.apiKey.length > 0 ? { effectiveApiKey: ctx.apiKey } : {}),
    connection: effectiveConnection,
    verbose: ctx.verbose,
  };

  if (!c.agent && !c.formatExplicit) {
    const updateNotice = updateInfo ? { current: updateInfo.current, latest: updateInfo.latest } : undefined;
    await renderInkUntilExit(
      <AuthStatus
        auth={deps.authResource}
        probe={c.options.probe}
        {...(ctx.apiKey !== undefined && ctx.apiKey.length > 0 ? { apiKey: ctx.apiKey } : {})}
        displayConnection={effectiveConnection}
        verbose={ctx.verbose}
        {...(updateNotice !== undefined ? { updateNotice } : {})}
        onComplete={() => undefined}
      />,
    );
    return;
  }

  if (c.options.probe) {
    const result = await deps.authResource.probeStatus({ composeOptions });
    if (result.kind === 'pending' || result.kind === 'unauthenticated') {
      yield sanitizeDeep(result.frame);
      return;
    }
    if (result.kind === 'authenticated') {
      const augmented = { ...result.frame, user: result.user };
      yield sanitizeDeep(augmented);
      return;
    }
    if (result.kind === 'invalid') {
      const rejected: Record<string, unknown> = { ...result.frame };
      if (ctx.verbose) rejected.credentials_path = deps.authStorage.getPath();
      if (update !== undefined) rejected.update = update;
      yield sanitizeDeep(rejected);
      return;
    }
    return c.error({
      code: 'PROBE_FAILED',
      message: result.error instanceof Error ? result.error.message : String(result.error),
    });
  }

  for await (const frame of deps.authResource.pollStatus({
    interval: c.options.interval,
    maxAttempts: c.options.maxAttempts,
    timeout: c.options.timeout,
    composeOptions,
  })) {
    yield sanitizeDeep(frame);
  }
}

export function createAuthCli(
  authResource: IAuth,
  userResource: IUserResource,
  updateProbe: UpdateProbe | undefined,
  authStorage: AuthStorage,
  ctx: AuthCommandContext,
) {
  const cli = Cli.create('auth', { description: 'Authentication commands' });

  cli.command('login', {
    description: 'Authenticate with InFlow',
    options: loginOptions,
    outputPolicy: 'agent-only' as const,
    async *run(c) {
      return yield* runAuthLogin(c, { authResource, userResource, authStorage }, ctx);
    },
  });

  cli.command('logout', {
    description: 'Log out from InFlow',
    outputPolicy: 'agent-only' as const,
    async run(c) {
      return runAuthLogout(c, { authResource, authStorage });
    },
  });

  cli.command('status', {
    description: 'Check authentication status',
    options: statusOptions,
    outputPolicy: 'agent-only' as const,
    async *run(c) {
      return yield* runAuthStatus(c, { authResource, userResource, authStorage, updateProbe }, ctx);
    },
  });

  return cli;
}

export const __testing = {
  runAuthLogin,
  runAuthLogout,
  runAuthStatus,
};
