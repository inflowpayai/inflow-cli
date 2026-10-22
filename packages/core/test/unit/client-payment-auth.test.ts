import { describe, expect, it, vi } from 'vitest';
import { Inflow, MemoryStorage } from '../../src/index.js';

describe('payment SDK authentication through Inflow', () => {
  it.each(['mpp', 'x402'] as const)(
    'resolves the bearer provider again for subsequent %s requests',
    async (protocol) => {
      let token = 'first-token';
      const provider = vi.fn(() => Promise.resolve(token));
      const requests: Request[] = [];
      const fetch = vi.fn<typeof globalThis.fetch>((input, init) => {
        const request = new Request(input, init);
        requests.push(request);
        return Promise.resolve(
          request.url.endsWith('/x402-supported') ? Response.json({ kinds: [] }) : new Response(null, { status: 204 }),
        );
      });
      const client = new Inflow({ apiBaseUrl: 'https://platform.test', getAccessToken: provider, fetch });
      const buyer = protocol === 'mpp' ? client.mpp : await client.x402.client();
      await buyer.cancelApproval('approval-one');
      token = 'second-token';
      await buyer.cancelApproval('approval-two');
      const cancellations = requests.filter((request) => request.url.endsWith('/cancel'));
      expect(cancellations.map((request) => request.headers.get('authorization'))).toEqual([
        'Bearer first-token',
        'Bearer second-token',
      ]);
      expect(provider).toHaveBeenCalledTimes(requests.length);
      expect(requests.every((request) => new URL(request.url).origin === 'https://platform.test')).toBe(true);
    },
  );

  it.each(['mpp', 'x402'] as const)('forwards a static bearer token to the actual %s SDK', async (protocol) => {
    const requests: Request[] = [];
    const fetch = vi.fn<typeof globalThis.fetch>((input, init) => {
      requests.push(new Request(input, init));
      return Promise.resolve(protocol === 'x402' ? Response.json({ kinds: [] }) : new Response(null, { status: 204 }));
    });
    const client = new Inflow({ apiBaseUrl: 'https://platform.test', accessToken: 'static-token', fetch });
    if (protocol === 'mpp') await client.mpp.cancelApproval('approval-one');
    else await (await client.x402.client()).getSupported();
    expect(requests).toHaveLength(1);
    expect(requests[0]?.headers.get('authorization')).toBe('Bearer static-token');
    expect(requests[0]?.headers.has('x-api-key')).toBe(false);
  });

  it.each(['mpp', 'x402'] as const)(
    'resolves stored OAuth credentials when the actual %s SDK requests them',
    async (protocol) => {
      const storage = new MemoryStorage({
        access_token: 'stored-token',
        refresh_token: 'refresh-token',
        token_type: 'Bearer',
        expires_in: 3600,
      });
      const requests: Request[] = [];
      const fetch = vi.fn<typeof globalThis.fetch>((input, init) => {
        requests.push(new Request(input, init));
        return Promise.resolve(
          protocol === 'x402' ? Response.json({ kinds: [] }) : new Response(null, { status: 204 }),
        );
      });
      const client = new Inflow({
        apiBaseUrl: 'https://platform.test',
        authStorage: storage,
        cliClientId: 'test-client',
        fetch,
      });
      if (protocol === 'mpp') await client.mpp.cancelApproval('approval-one');
      else await (await client.x402.client()).getSupported();
      expect(requests).toHaveLength(1);
      expect(requests[0]?.headers.get('authorization')).toBe('Bearer stored-token');
      expect(requests[0]?.headers.has('x-api-key')).toBe(false);
    },
  );
});
