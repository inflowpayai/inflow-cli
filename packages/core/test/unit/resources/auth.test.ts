import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { InflowApiError, InflowConfigurationError } from '../../../src/errors.js';
import { AuthResource } from '../../../src/resources/auth.js';
import {
  BASE_URL,
  deviceCodeHappy,
  deviceCode400,
  deviceTokenSuccess,
  deviceTokenPending,
  deviceTokenSlowDown,
  deviceTokenExpired,
  deviceTokenDenied,
  deviceTokenUnsupported,
  refreshSuccess,
  refreshFail,
  revokeSuccess,
  revokeServerError,
} from '../fixtures/handlers.js';
import { makeServer } from '../fixtures/server.js';

const server = makeServer();

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function makeResource(): AuthResource {
  return new AuthResource({
    apiBaseUrl: BASE_URL,
    authBaseUrl: BASE_URL,
    cliClientId: 'test-client',
  });
}

describe('AuthResource failure contracts', () => {
  it.each(['initiate', 'poll', 'refresh'] as const)(
    'preserves the version-upgrade error during %s',
    async (operation) => {
      server.use(
        http.post(`${BASE_URL}/v1/oauth2/*`, () =>
          HttpResponse.json(
            {
              errors: [{ code: 'VERSION_UNSUPPORTED', message: 'Unsupported client version' }],
              install_url: 'https://inflowcli.ai/',
              access_token: 'private-token',
            },
            { status: 426 },
          ),
        ),
      );
      const resource = makeResource();
      const promise =
        operation === 'initiate'
          ? resource.initiateDeviceAuth()
          : operation === 'poll'
            ? resource.pollDeviceAuth('private-device')
            : resource.refreshToken('private-refresh');
      await expect(promise).rejects.toMatchObject({
        code: 'VERSION_UNSUPPORTED',
        status: 426,
        message: 'This InFlow CLI version is no longer supported.\nInstall the latest version: https://inflowcli.ai/',
      });
      await promise.catch((error: unknown) => {
        expect(JSON.stringify(error)).not.toContain('private-token');
      });
    },
  );

  it.each(['initiate', 'poll', 'refresh'] as const)(
    'reports a bodyless %s failure without assuming an OAuth error body',
    async (operation) => {
      server.use(http.post(`${BASE_URL}/v1/oauth2/*`, () => new HttpResponse(null, { status: 400 })));
      const resource = makeResource();
      const promise =
        operation === 'initiate'
          ? resource.initiateDeviceAuth()
          : operation === 'poll'
            ? resource.pollDeviceAuth('device')
            : resource.refreshToken('refresh');
      const prefix =
        operation === 'initiate'
          ? 'Device auth initiation failed'
          : operation === 'poll'
            ? 'Token poll failed'
            : 'Token refresh failed';
      await expect(promise).rejects.toMatchObject({ status: 400, message: `${prefix} (400): unknown error` });
    },
  );

  it.each(['poll', 'refresh'] as const)('accepts a %s token response with no optional scope', async (operation) => {
    const tokens = { access_token: 'access', refresh_token: 'refresh', token_type: 'Bearer', expires_in: 3600 };
    server.use(http.post(`${BASE_URL}/v1/oauth2/*`, () => HttpResponse.json(tokens)));
    const resource = makeResource();
    const result = await (operation === 'poll' ? resource.pollDeviceAuth('device') : resource.refreshToken('refresh'));
    expect(result).toEqual(tokens);
    expect(result).not.toHaveProperty('scope');
  });
});

describe('AuthResource — initiateDeviceAuth', () => {
  it('normalizes wire to verification_url + verification_url_complete', async () => {
    server.use(deviceCodeHappy);
    const r = makeResource();
    const result = await r.initiateDeviceAuth();
    expect(result).toEqual({
      device_code: 'dev-code-1',
      user_code: 'BCDF-GHJK',
      verification_url: `${BASE_URL}/device/`,
      verification_url_complete: `${BASE_URL}/device/?code=BCDF-GHJK`,
      expires_in: 600,
      interval: 5,
    });
  });

  it('throws InflowApiError on 400', async () => {
    server.use(deviceCode400);
    const r = makeResource();
    await expect(r.initiateDeviceAuth()).rejects.toBeInstanceOf(InflowApiError);
  });

  it('throws InflowConfigurationError when cliClientId missing', async () => {
    const r = new AuthResource({
      apiBaseUrl: BASE_URL,
      authBaseUrl: BASE_URL,
    });
    await expect(r.initiateDeviceAuth()).rejects.toBeInstanceOf(InflowConfigurationError);
  });
});

describe('AuthResource — pollDeviceAuth', () => {
  it('returns tokens on success', async () => {
    server.use(deviceTokenSuccess);
    const r = makeResource();
    const tokens = await r.pollDeviceAuth('d');
    expect(tokens?.access_token).toBe('access-1');
    expect(tokens?.refresh_token).toBe('refresh-1');
    expect(tokens?.scope).toBe('balances:read');
  });

  it('returns null on authorization_pending', async () => {
    server.use(deviceTokenPending);
    const r = makeResource();
    expect(await r.pollDeviceAuth('d')).toBeNull();
  });

  it('returns null on slow_down', async () => {
    server.use(deviceTokenSlowDown);
    const r = makeResource();
    expect(await r.pollDeviceAuth('d')).toBeNull();
  });

  it('throws InflowApiError with code expired_token', async () => {
    server.use(deviceTokenExpired);
    const r = makeResource();
    await expect(r.pollDeviceAuth('d')).rejects.toMatchObject({
      code: 'expired_token',
    });
  });

  it('throws InflowApiError with code access_denied', async () => {
    server.use(deviceTokenDenied);
    const r = makeResource();
    await expect(r.pollDeviceAuth('d')).rejects.toMatchObject({
      code: 'access_denied',
    });
  });

  it('throws on unknown 400 error code', async () => {
    server.use(deviceTokenUnsupported);
    const r = makeResource();
    await expect(r.pollDeviceAuth('d')).rejects.toBeInstanceOf(InflowApiError);
  });
});

describe('AuthResource — refreshToken', () => {
  it('retains the scopes returned with a refreshed token', async () => {
    server.use(
      http.post(`${BASE_URL}/v1/oauth2/token`, () =>
        HttpResponse.json({
          access_token: 'replacement-access',
          refresh_token: 'replacement-refresh',
          token_type: 'Bearer',
          expires_in: 3600,
          scope: 'balances:read transactions:read',
        }),
      ),
    );
    expect(await makeResource().refreshToken('old-refresh')).toEqual({
      access_token: 'replacement-access',
      refresh_token: 'replacement-refresh',
      token_type: 'Bearer',
      expires_in: 3600,
      scope: 'balances:read transactions:read',
    });
  });

  it('returns the new token pair', async () => {
    server.use(refreshSuccess);
    const r = makeResource();
    const tokens = await r.refreshToken('refresh-1');
    expect(tokens.access_token).toBe('access-2');
    expect(tokens.refresh_token).toBe('refresh-2');
  });

  it('throws InflowApiError on invalid_grant', async () => {
    server.use(refreshFail);
    const r = makeResource();
    await expect(r.refreshToken('bad')).rejects.toBeInstanceOf(InflowApiError);
  });
});

describe('AuthResource — revokeToken', () => {
  it.each([new Error('connection unavailable'), 'connection unavailable'])(
    'allows local logout to continue after a transport rejection: %s',
    async (failure) => {
      const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(failure);
      const debug = vi.fn();
      const resource = new AuthResource({
        authBaseUrl: BASE_URL,
        cliClientId: 'test-client',
        fetch,
        logger: { debug },
      });
      await expect(resource.revokeToken('refresh-secret')).resolves.toBeUndefined();
      expect(debug).toHaveBeenCalledWith(`revoke swallowed: Request failed: POST ${BASE_URL}/v1/oauth2/revoke`);
      expect(JSON.stringify(debug.mock.calls)).not.toContain('refresh-secret');
    },
  );

  it('does not throw on success', async () => {
    server.use(revokeSuccess);
    const r = makeResource();
    await expect(r.revokeToken('tk')).resolves.toBeUndefined();
  });

  it('swallows non-2xx server response (best-effort)', async () => {
    server.use(revokeServerError);
    const r = makeResource();
    await expect(r.revokeToken('tk')).resolves.toBeUndefined();
  });
});
