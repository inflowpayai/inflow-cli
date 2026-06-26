import { InflowConfigurationError } from './errors.js';
import type { AccessTokenProvider } from './session.js';
import { type AuthStorage, storage } from './utils/storage.js';

export interface InflowSdkLogger {
  debug(message: string): void;
}

export type InflowEnvironment = 'production' | 'sandbox';

export interface InflowOptions {
  verbose?: boolean;
  clientName?: string;
  cliClientId?: string;
  defaultHeaders?: Record<string, string>;
  apiKey?: string;
  accessToken?: string;
  getAccessToken?: AccessTokenProvider;
  authStorage?: AuthStorage;
  fetch?: typeof globalThis.fetch;
  environment?: InflowEnvironment;
  apiBaseUrl?: string;
  authBaseUrl?: string;
  logger?: InflowSdkLogger;
}

export interface ResolvedInflowSdkConfig {
  verbose: boolean;
  clientName: string;
  cliClientId: string | undefined;
  defaultHeaders: Record<string, string> | undefined;
  authMode:
    | { type: 'apiKey'; apiKey: string }
    | { type: 'dynamicBearer'; getAccessToken: AccessTokenProvider }
    | { type: 'staticBearer'; accessToken: string }
    | { type: 'anonymous' };
  authStorage: AuthStorage;
  fetch: typeof globalThis.fetch;
  environment: InflowEnvironment;
  apiBaseUrl: string;
  authBaseUrl: string;
  logger: InflowSdkLogger;
}

type AuthMode = ResolvedInflowSdkConfig['authMode'];

/** @internal */
export const ENVIRONMENT_API_BASE_URLS: Record<InflowEnvironment, string> = {
  production: 'https://api.inflowpay.ai',
  sandbox: 'https://sandbox.inflowpay.ai',
};

/** @internal */
export const ENVIRONMENT_AUTH_BASE_URLS: Record<InflowEnvironment, string> = {
  production: 'https://app.inflowpay.ai',
  sandbox: 'https://sandbox.inflowpay.ai',
};

/**
 * Mirrors the resolution `resolveInflowSdkConfig` uses internally so the {@link Inflow} class can expose the same value
 * publicly without instantiating the full config.
 *
 * @internal
 */
export function resolveApiBaseUrl(options: Pick<InflowOptions, 'apiBaseUrl' | 'environment'>): string {
  return (
    options.apiBaseUrl ?? process.env.INFLOW_BASE_URL ?? ENVIRONMENT_API_BASE_URLS[options.environment ?? 'production']
  );
}

function createProxyFetch(baseFetch: typeof globalThis.fetch, proxyUrl: string): typeof globalThis.fetch {
  let dispatcherPromise: Promise<unknown> | null = null;

  return (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
    if (!dispatcherPromise) {
      const mod = 'undici';
      dispatcherPromise = (
        import(mod) as Promise<{
          ProxyAgent: new (url: string) => unknown;
        }>
      )
        .then((m) => new m.ProxyAgent(proxyUrl))
        .catch(() => {
          throw new InflowConfigurationError(
            'INFLOW_HTTP_PROXY requires the "undici" package. Install it with: npm install undici',
          );
        });
    }

    return dispatcherPromise.then((dispatcher) => baseFetch(input, { ...init, dispatcher } as RequestInit));
  };
}

function createDefaultHeadersFetch(
  baseFetch: typeof globalThis.fetch,
  defaultHeaders: Record<string, string>,
): typeof globalThis.fetch {
  return (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    for (const [key, value] of Object.entries(defaultHeaders)) {
      if (!headers.has(key)) {
        headers.set(key, value);
      }
    }
    return baseFetch(input, { ...init, headers });
  };
}

function createDefaultLogger(verbose: boolean): InflowSdkLogger {
  return {
    debug(message: string) {
      if (!verbose) {
        return;
      }
      process.stderr.write(message.endsWith('\n') ? message : `${message}\n`);
    },
  };
}

function resolveAuthMode(options: InflowOptions): AuthMode {
  const modes: string[] = [];
  if (options.apiKey !== undefined) modes.push('apiKey');
  if (options.accessToken !== undefined) modes.push('accessToken');
  if (options.getAccessToken !== undefined) modes.push('getAccessToken');

  if (modes.length > 1) {
    throw new InflowConfigurationError('apiKey, accessToken, and getAccessToken are mutually exclusive.');
  }

  if (options.apiKey !== undefined) {
    return { type: 'apiKey', apiKey: options.apiKey };
  }
  if (options.getAccessToken !== undefined) {
    return { type: 'dynamicBearer', getAccessToken: options.getAccessToken };
  }
  if (options.accessToken !== undefined) {
    return { type: 'staticBearer', accessToken: options.accessToken };
  }
  return { type: 'anonymous' };
}

/** @internal */
export function resolveInflowSdkConfig(options: InflowOptions = {}): ResolvedInflowSdkConfig {
  const verbose = options.verbose ?? false;
  const logger = options.logger ?? createDefaultLogger(verbose);
  const environment: InflowEnvironment = options.environment ?? 'production';

  const explicitApiBaseUrl = options.apiBaseUrl ?? process.env.INFLOW_BASE_URL;
  const apiBaseUrl = explicitApiBaseUrl ?? ENVIRONMENT_API_BASE_URLS[environment];

  const authBaseUrl = options.authBaseUrl ?? process.env.INFLOW_AUTH_BASE_URL ?? explicitApiBaseUrl ?? ENVIRONMENT_AUTH_BASE_URLS[environment];

  const cliClientId = options.cliClientId ?? process.env.INFLOW_CLI_CLIENT_ID;

  const authMode = resolveAuthMode(options);

  const baseFetch = options.fetch ?? globalThis.fetch;
  if (typeof baseFetch !== 'function') {
    throw new InflowConfigurationError('No fetch implementation available. Pass `fetch` in InFlow SDK options.');
  }

  const proxyUrl = process.env.INFLOW_HTTP_PROXY;
  const proxyFetch = proxyUrl && options.fetch === undefined ? createProxyFetch(baseFetch, proxyUrl) : baseFetch;
  const effectiveFetch =
    options.defaultHeaders && Object.keys(options.defaultHeaders).length > 0
      ? createDefaultHeadersFetch(proxyFetch, options.defaultHeaders)
      : proxyFetch;

  return {
    verbose,
    clientName: options.clientName ?? 'InFlow',
    cliClientId,
    defaultHeaders: options.defaultHeaders,
    authMode,
    authStorage: options.authStorage ?? storage,
    fetch: effectiveFetch,
    environment,
    apiBaseUrl,
    authBaseUrl,
    logger,
  };
}

/** @internal */
export function requireFetchImplementation(config: { fetch?: typeof globalThis.fetch }): typeof globalThis.fetch {
  if (typeof config.fetch !== 'function') {
    throw new InflowConfigurationError('No fetch implementation available. Pass `fetch` in InFlow SDK options.');
  }
  return config.fetch;
}
