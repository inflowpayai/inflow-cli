import { http, HttpResponse } from 'msw';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { InflowApiError } from '../../../src/errors.js';
import { DepositAddressResource } from '../../../src/resources/deposit-address.js';
import { BASE_URL, depositAddressesHappy } from '../fixtures/handlers.js';
import { makeServer } from '../fixtures/server.js';

const server = makeServer();

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe('DepositAddressResource', () => {
  it('preserves configured + unconfigured wrapper', async () => {
    server.use(depositAddressesHappy);
    const r = new DepositAddressResource({
      apiBaseUrl: BASE_URL,
      accessToken: 'tk',
    });
    const out = await r.list();
    expect(out.configured).toHaveLength(2);
    expect(out.configured[0]?.blockchain).toBe('BASE');
    expect(out.configured[1]?.blockchain).toBe('TEMPO');
    expect(out.unconfigured[0]?.currencies).toEqual(['USDC']);
  });

  it('returns empty arrays when wire arrays are missing', async () => {
    server.use(http.get(`${BASE_URL}/v1/deposit-addresses`, () => HttpResponse.json({})));
    const r = new DepositAddressResource({
      apiBaseUrl: BASE_URL,
      accessToken: 'tk',
    });
    const out = await r.list();
    expect(out.configured).toEqual([]);
    expect(out.unconfigured).toEqual([]);
  });

  it('throws InflowApiError on non-2xx', async () => {
    server.use(http.get(`${BASE_URL}/v1/deposit-addresses`, () => new HttpResponse(null, { status: 403 })));
    const r = new DepositAddressResource({
      apiBaseUrl: BASE_URL,
      accessToken: 'tk',
    });
    await expect(r.list()).rejects.toBeInstanceOf(InflowApiError);
  });
});
