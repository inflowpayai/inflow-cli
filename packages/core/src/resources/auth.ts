import { hostname } from 'node:os';
import { type InflowOptions, type ResolvedInflowSdkConfig, resolveInflowSdkConfig } from '../config.js';
import { InflowApiError, InflowConfigurationError } from '../errors.js';
import type { AuthTokens, DeviceAuthRequest } from '../types/index.js';
import { InflowApiClient } from '../utils/api-client.js';
import { redactRawBody } from '../utils/redact.js';
import { createApiError, isVersionUnsupportedResponse } from './api-error.js';
import type { IAuthResource } from './interfaces.js';

const DEFAULT_SCOPE = 'balances:read deposit-addresses:read transactions:read transactions:write';

interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number;
  scope?: string;
}

interface OAuthError {
  error?: string;
  error_description?: string;
}

function formatOAuthError(prefix: string, status: number, data: unknown, rawBody: string): string {
  const err = (data as OAuthError | null) ?? null;
  const description = err?.error_description ?? err?.error ?? (redactRawBody(rawBody) || 'unknown error');
  return `${prefix} (${String(status)}): ${description}`;
}

function requireCliClientId(config: ResolvedInflowSdkConfig): string {
  if (config.cliClientId === undefined || config.cliClientId.length === 0) {
    throw new InflowConfigurationError('cliClientId is required for auth flows.');
  }
  return config.cliClientId;
}

export class AuthResource implements IAuthResource {
  private readonly config: ResolvedInflowSdkConfig;
  private readonly api: InflowApiClient;

  constructor(options: InflowOptions = {}, resolvedConfig?: ResolvedInflowSdkConfig) {
    this.config = resolvedConfig ?? resolveInflowSdkConfig(options);
    this.api = new InflowApiClient(this.config, this.config.authBaseUrl);
  }

  async initiateDeviceAuth(clientName?: string): Promise<DeviceAuthRequest> {
    const clientId = requireCliClientId(this.config);
    const effectiveName = clientName ?? this.config.clientName;
    const { status, data, rawBody } = await this.api.postForm(
      '/v1/oauth2/device/code',
      {
        client_id: clientId,
        scope: DEFAULT_SCOPE,
        connection_label: `${effectiveName} on ${hostname()}`,
        client_name: effectiveName,
      },
      { skipAuth: true },
    );

    if (status < 200 || status >= 300) {
      if (isVersionUnsupportedResponse(data)) {
        throw createApiError({ status, data, rawBody }, 'Device auth initiation failed');
      }
      throw new InflowApiError(formatOAuthError('Device auth initiation failed', status, data, rawBody), {
        status,
        rawBody,
        details: data,
        ...((data as OAuthError | null)?.error !== undefined ? { code: (data as OAuthError).error as string } : {}),
      });
    }

    const resp = data as DeviceCodeResponse;
    return {
      device_code: resp.device_code,
      user_code: resp.user_code,
      verification_url: resp.verification_uri,
      verification_url_complete: resp.verification_uri_complete,
      expires_in: resp.expires_in,
      interval: resp.interval,
    };
  }

  async pollDeviceAuth(deviceCode: string): Promise<AuthTokens | null> {
    const clientId = requireCliClientId(this.config);
    const { status, data, rawBody } = await this.api.postForm(
      '/v1/oauth2/device/token',
      {
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: deviceCode,
        client_id: clientId,
      },
      { skipAuth: true },
    );

    if (status >= 200 && status < 300) {
      const resp = data as TokenResponse;
      const tokens: AuthTokens = {
        access_token: resp.access_token,
        refresh_token: resp.refresh_token,
        token_type: resp.token_type,
        expires_in: resp.expires_in,
      };
      if (resp.scope !== undefined) {
        tokens.scope = resp.scope;
      }
      return tokens;
    }

    if (status === 400) {
      const err = (data as OAuthError | null) ?? {};
      switch (err.error) {
        case 'authorization_pending':
        case 'slow_down':
          return null;
        case 'expired_token':
          throw new InflowApiError('Device code expired. Please restart the login flow.', {
            status,
            code: 'expired_token',
            rawBody,
            details: data,
          });
        case 'access_denied':
          throw new InflowApiError('Authorization denied by user.', {
            status,
            code: 'access_denied',
            rawBody,
            details: data,
          });
        case undefined:
          // No OAuth error code present; fall through to the generic token-poll failure below.
          break;
      }
    }

    if (isVersionUnsupportedResponse(data)) {
      throw createApiError({ status, data, rawBody }, 'Token poll failed');
    }

    throw new InflowApiError(formatOAuthError('Token poll failed', status, data, rawBody), {
      status,
      rawBody,
      details: data,
      ...((data as OAuthError | null)?.error !== undefined ? { code: (data as OAuthError).error as string } : {}),
    });
  }

  async refreshToken(refreshToken: string): Promise<AuthTokens> {
    const clientId = requireCliClientId(this.config);
    const { status, data, rawBody } = await this.api.postForm(
      '/v1/oauth2/token',
      {
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: clientId,
      },
      { skipAuth: true },
    );

    if (status < 200 || status >= 300) {
      if (isVersionUnsupportedResponse(data)) {
        throw createApiError({ status, data, rawBody }, 'Token refresh failed');
      }
      throw new InflowApiError(formatOAuthError('Token refresh failed', status, data, rawBody), {
        status,
        rawBody,
        details: data,
        ...((data as OAuthError | null)?.error !== undefined ? { code: (data as OAuthError).error as string } : {}),
      });
    }

    const resp = data as TokenResponse;
    const tokens: AuthTokens = {
      access_token: resp.access_token,
      refresh_token: resp.refresh_token,
      token_type: resp.token_type,
      expires_in: resp.expires_in,
    };
    if (resp.scope !== undefined) {
      tokens.scope = resp.scope;
    }
    return tokens;
  }

  async revokeToken(token: string): Promise<void> {
    const clientId = requireCliClientId(this.config);
    try {
      await this.api.postForm(
        '/v1/oauth2/revoke',
        {
          client_id: clientId,
          token,
        },
        { skipAuth: true },
      );
    } catch (error) {
      this.config.logger.debug(`revoke swallowed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
