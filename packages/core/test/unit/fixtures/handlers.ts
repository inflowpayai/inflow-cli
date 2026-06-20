import { http, HttpResponse } from 'msw';

const BASE = 'https://api.test.example';

interface FormPayload {
  [key: string]: string;
}

async function readForm(request: Request): Promise<FormPayload> {
  const body = await request.text();
  const params = new URLSearchParams(body);
  const out: FormPayload = {};
  for (const [k, v] of params.entries()) {
    out[k] = v;
  }
  return out;
}

export const BASE_URL = BASE;

export const deviceCodeHappy = http.post(`${BASE}/v1/oauth2/device/code`, () =>
  HttpResponse.json({
    device_code: 'dev-code-1',
    user_code: 'BCDF-GHJK',
    verification_uri: `${BASE}/device/`,
    verification_uri_complete: `${BASE}/device/?code=BCDF-GHJK`,
    expires_in: 600,
    interval: 5,
  }),
);

export const deviceCode400 = http.post(`${BASE}/v1/oauth2/device/code`, () =>
  HttpResponse.json({ error: 'invalid_client', error_description: 'bad client_id' }, { status: 400 }),
);

export const deviceTokenSuccess = http.post(`${BASE}/v1/oauth2/device/token`, () =>
  HttpResponse.json({
    access_token: 'access-1',
    refresh_token: 'refresh-1',
    token_type: 'Bearer',
    expires_in: 3600,
    scope: 'balances:read',
  }),
);

export const deviceTokenPending = http.post(`${BASE}/v1/oauth2/device/token`, () =>
  HttpResponse.json({ error: 'authorization_pending' }, { status: 400 }),
);

export const deviceTokenSlowDown = http.post(`${BASE}/v1/oauth2/device/token`, () =>
  HttpResponse.json({ error: 'slow_down' }, { status: 400 }),
);

export const deviceTokenExpired = http.post(`${BASE}/v1/oauth2/device/token`, () =>
  HttpResponse.json({ error: 'expired_token' }, { status: 400 }),
);

export const deviceTokenDenied = http.post(`${BASE}/v1/oauth2/device/token`, () =>
  HttpResponse.json({ error: 'access_denied' }, { status: 400 }),
);

export const deviceTokenUnsupported = http.post(`${BASE}/v1/oauth2/device/token`, () =>
  HttpResponse.json({ error: 'unsupported_grant_type' }, { status: 400 }),
);

export const deviceTokenServerError = http.post(
  `${BASE}/v1/oauth2/device/token`,
  () => new HttpResponse(null, { status: 500 }),
);

export const refreshSuccess = http.post(`${BASE}/v1/oauth2/token`, () =>
  HttpResponse.json({
    access_token: 'access-2',
    refresh_token: 'refresh-2',
    token_type: 'Bearer',
    expires_in: 3600,
  }),
);

export const refreshFail = http.post(`${BASE}/v1/oauth2/token`, () =>
  HttpResponse.json({ error: 'invalid_grant' }, { status: 400 }),
);

export const revokeSuccess = http.post(`${BASE}/v1/oauth2/revoke`, () => HttpResponse.json({}));

export const revokeServerError = http.post(`${BASE}/v1/oauth2/revoke`, () =>
  HttpResponse.json({ error: 'server_error' }, { status: 500 }),
);

export const balancesHappy = http.get(`${BASE}/v1/balances`, () =>
  HttpResponse.json({
    balances: [
      { available: '100.5', currency: 'USDC' },
      { available: '0', currency: 'USD' },
    ],
  }),
);

export const balancesEmpty = http.get(`${BASE}/v1/balances`, () => HttpResponse.json({ balances: [] }));

export const balances401 = http.get(`${BASE}/v1/balances`, () =>
  HttpResponse.json({ error: 'unauthorized' }, { status: 401 }),
);

export const balances500 = http.get(`${BASE}/v1/balances`, () => new HttpResponse(null, { status: 500 }));

export const depositAddressesHappy = http.get(`${BASE}/v1/deposit-addresses`, () =>
  HttpResponse.json({
    configured: [
      {
        address: '0xabc',
        blockchain: 'BASE',
        currencies: ['USDC'],
      },
      {
        address: '0x0000000000000000000000000000000000004217',
        blockchain: 'TEMPO',
        currencies: ['USDC'],
      },
    ],
    unconfigured: [{ blockchain: 'SOLANA', currencies: ['USDC'] }],
  }),
);

export const userHappy = http.get(`${BASE}/v1/users/self`, () =>
  HttpResponse.json({
    userId: 'u-1',
    email: 'a@example.com',
    firstName: null,
    lastName: null,
    username: null,
    mobile: null,
    locale: 'EN_US',
    timezone: 'US/Pacific',
    created: '2026-01-01T00:00:00Z',
    updated: '2026-01-02T00:00:00Z',
  }),
);

export { readForm };
