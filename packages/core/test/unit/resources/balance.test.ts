import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { InflowApiError } from '../../../src/errors.js';
import { BalanceResource } from '../../../src/resources/balance.js';
import { BASE_URL, balancesHappy, balancesEmpty, balances500 } from '../fixtures/handlers.js';
import { makeServer } from '../fixtures/server.js';

const server = makeServer();

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe('BalanceResource', () => {
  it('unwraps the balances array', async () => {
    server.use(balancesHappy);
    const r = new BalanceResource({
      apiBaseUrl: BASE_URL,
      accessToken: 'tk',
    });
    const list = await r.list();
    expect(list).toEqual([
      { available: '100.5', currency: 'USDC' },
      { available: '0', currency: 'USD' },
    ]);
  });

  it('normalizes server decimal strings without scientific notation', async () => {
    server.use(
      http.get(`${BASE_URL}/v1/balances`, () =>
        HttpResponse.json({
          balances: [
            { available: '100.500000000000000000', currency: 'USDC' },
            { available: '0.000000000000000000', currency: 'USD' },
            { available: '0.000001000000000000', currency: 'PYUSD' },
          ],
        }),
      ),
    );
    const r = new BalanceResource({
      apiBaseUrl: BASE_URL,
      accessToken: 'tk',
    });
    expect(await r.list()).toEqual([
      { available: '100.5', currency: 'USDC' },
      { available: '0', currency: 'USD' },
      { available: '0.000001', currency: 'PYUSD' },
    ]);
  });

  it('passes an AbortSignal through request options', async () => {
    let signalSeen = false;
    server.use(
      http.get(`${BASE_URL}/v1/balances`, ({ request }) => {
        signalSeen = request.signal instanceof AbortSignal;
        return HttpResponse.json({
          balances: [{ available: '1.000000000000000000', currency: 'USDC' }],
        });
      }),
    );
    const r = new BalanceResource({
      apiBaseUrl: BASE_URL,
      accessToken: 'tk',
    });
    const controller = new AbortController();
    await expect(r.list({ signal: controller.signal })).resolves.toEqual([{ available: '1', currency: 'USDC' }]);
    expect(signalSeen).toBe(true);
  });

  it('returns [] for an empty server response', async () => {
    server.use(balancesEmpty);
    const r = new BalanceResource({
      apiBaseUrl: BASE_URL,
      accessToken: 'tk',
    });
    expect(await r.list()).toEqual([]);
  });

  it('returns [] when the server response body is null', async () => {
    server.use(http.get(`${BASE_URL}/v1/balances`, () => HttpResponse.json(null)));
    const r = new BalanceResource({
      apiBaseUrl: BASE_URL,
      accessToken: 'tk',
    });
    expect(await r.list()).toEqual([]);
  });

  it('throws InflowApiError on 5xx after retries', async () => {
    server.use(balances500);
    const r = new BalanceResource({
      apiBaseUrl: BASE_URL,
      accessToken: 'tk',
    });
    await expect(r.list()).rejects.toBeInstanceOf(InflowApiError);
  });
});
