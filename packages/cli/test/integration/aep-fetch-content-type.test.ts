import { createHash } from 'node:crypto';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import { AepStorage, Inflow, MemoryStorage } from '@inflowpayai/inflow-core';
import { describe, expect, it } from 'vitest';
import { createAepCli } from '../../src/commands/aep/index.js';

type TapMode = 'unavailable' | 'feature-disabled' | 'enabled';
type ResourceRequest = { body: string; headers: IncomingHttpHeaders; method: string | undefined };
const BODY = '{ "query": "café", "num_results": 1 }\n';

async function withFixture(
  mode: TapMode,
  protectedResource: boolean,
  test: (fixture: {
    client: Inflow;
    finalizations: Array<{ contentDigest: string; contentType: string }>;
    requests: ResourceRequest[];
    serviceDid: string;
    storage: MemoryStorage;
    url: string;
  }) => Promise<void>,
): Promise<void> {
  const requests: ResourceRequest[] = [];
  const finalizations: Array<{ contentDigest: string; contentType: string }> = [];
  const unexpected: string[] = [];
  let origin = '';
  let serviceDid = '';
  const json = (value: unknown) => JSON.stringify(value);
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });
    request.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const path = new URL(request.url ?? '/', origin).pathname;
      response.setHeader('Content-Type', 'application/json');
      if (path === '/v1/cli/capabilities') {
        response.end(json({ features: mode === 'enabled' ? ['visa_tap'] : [], minimumSupportedVersion: '0.13.0' }));
      } else if (path === '/v1/tap/signatures' || path === '/v1/tap/signatures/prepared/finalize') {
        // Deterministic signing boundary; request preparation, digest calculation and dispatch are real.
        const payload = JSON.parse(body) as Record<string, unknown>;
        if (path.endsWith('/finalize')) {
          finalizations.push({
            contentDigest: String(payload['contentDigest']),
            contentType: String(payload['contentType']),
          });
        }
        response.end(
          json({
            created: 1,
            expires: 2,
            keyid: 'fixture-key',
            nonce: 'fixture-nonce',
            ...(payload['prepare'] === true
              ? { signingRequestId: 'prepared' }
              : {
                  signature: 'sig=:dGVzdA==:',
                  signatureInput: 'sig=("@method" "@target-uri")',
                }),
          }),
        );
      } else if (path === '/v1/users/self') {
        response.end(json({ userId: 'local-user' }));
      } else if (path === '/.well-known/aep') {
        response.setHeader('Content-Type', 'application/aep+json');
        response.end(
          json({
            aep_version: '1.0',
            authentication: { methods: ['oauth-bearer'] },
            bindings: { supported: ['http'] },
            claims: { optional: [], preferred: [], required: [] },
            commands: { grant_types: ['oauth-bearer'], supported: ['inspect', 'enroll', 'grant', 'status', 'revoke'] },
            core: { signing_algorithms: ['EdDSA', 'ES256'] },
            http: { endpoint_base: '/aep' },
            identity: { methods: ['did:web'] },
            service: { did: serviceDid },
          }),
        );
      } else if (path === '/.well-known/aep-platform') {
        response.setHeader('Content-Type', 'application/aep+json');
        response.end(
          json({
            aep_version: '1.0',
            endpoints: {
              lifecycle: '/identities/lifecycle',
              list: '/identities',
              provision: '/identities/provision',
              sign: '/identities/sign',
            },
            http: { endpoint_base: '/identities' },
            identity: { did_methods: ['did:web'], did_url_template: 'https://platform.example/agents/{id}' },
            platform: { hosted_verification: false, name: 'Local fixture' },
            signing: { algorithms: ['ES256'], default_lifetime_seconds: '60' },
          }),
        );
      } else if (path === '/identities') {
        response.end(json({ count: '0', data: [], total: '0' }));
      } else if (path === '/actions/search') {
        requests.push({ body, headers: request.headers, method: request.method });
        if (protectedResource && request.headers.authorization !== 'Bearer local-service-credential') {
          response.statusCode = 401;
          response.setHeader(
            'WWW-Authenticate',
            `AEP service_did="${serviceDid}", inspect="${origin}/.well-known/aep"`,
          );
        }
        response.end(json({ ok: response.statusCode === 200 }));
      } else {
        unexpected.push(path);
        response.statusCode = 500;
        response.end(json({ error: 'Unexpected fixture request' }));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Fixture server has no port');
  origin = `http://127.0.0.1:${address.port}`;
  serviceDid = `did:web:127.0.0.1%3A${address.port}`;
  const storage = new MemoryStorage();
  const client = new Inflow({
    apiBaseUrl: origin,
    authStorage: storage,
    ...(mode === 'unavailable' ? { apiKey: 'local-fixture-key' } : { accessToken: 'local-fixture-token' }),
  });
  try {
    await test({ client, finalizations, requests, serviceDid, storage, url: `${origin}/actions/search` });
    expect(unexpected).toEqual([]);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error === undefined ? resolve() : reject(error))),
    );
  }
}

async function run(client: Inflow, storage: MemoryStorage, url: string, flags: string[] = []) {
  const output: string[] = [];
  const exits: number[] = [];
  await createAepCli(client, storage).serve(['fetch', url, '--method', 'POST', '--format', 'json', ...flags], {
    exit: (code) => {
      exits.push(code);
    },
    stdout: (chunk) => {
      output.push(chunk);
    },
  });
  return { exits, output: output.join('') };
}

describe('standalone AEP fetch content type', () => {
  it.each<TapMode>(['unavailable', 'feature-disabled', 'enabled'])('sends unchanged JSON with TAP %s', async (mode) => {
    await withFixture(mode, false, async ({ client, finalizations, requests, storage, url }) => {
      const result = await run(client, storage, url, ['--data', BODY]);
      expect(result.exits, result.output).toEqual([]);
      expect(result.output).toContain('not-required');
      expect(requests).toHaveLength(1);
      expect(requests[0]?.body).toBe(BODY);
      expect(requests[0]?.headers['content-type']).toBe('application/json');
      expect(requests[0]?.headers.authorization).toBeUndefined();
      if (mode === 'enabled') {
        const contentDigest = `sha-256=:${createHash('sha256').update(BODY).digest('base64')}:`;
        expect(finalizations).toEqual([{ contentDigest, contentType: 'application/json' }]);
        expect(requests[0]?.headers['content-digest']).toBe(contentDigest);
        expect(requests[0]?.headers['signature']).toBeDefined();
        expect(requests[0]?.headers['signature-input']).toBe('sig=("@method" "@target-uri")');
      } else {
        expect(finalizations).toEqual([]);
        expect(requests[0]?.headers['signature']).toBeUndefined();
      }
    });
  });

  it.each(['Content-Type', 'content-type', 'cOnTeNt-TyPe'])(
    'preserves explicit %s before signing and dispatch',
    async (header) => {
      await withFixture('enabled', false, async ({ client, finalizations, requests, storage, url }) => {
        const result = await run(client, storage, url, [
          '--data',
          BODY,
          '--header',
          `${header}: text/plain; charset=utf-8`,
        ]);
        expect(result.exits, result.output).toEqual([]);
        expect(requests).toHaveLength(1);
        expect(requests[0]?.body).toBe(BODY);
        expect(requests[0]?.headers['content-type']).toBe('text/plain; charset=utf-8');
        const contentDigest = `sha-256=:${createHash('sha256').update(BODY).digest('base64')}:`;
        expect(finalizations).toEqual([{ contentDigest, contentType: 'text/plain; charset=utf-8' }]);
        expect(requests[0]?.headers['content-digest']).toBe(contentDigest);
        expect(requests[0]?.headers['signature-input']).toBe('sig=("@method" "@target-uri")');
      });
    },
  );

  it.each([undefined, ''])('distinguishes an absent body from %j', async (body) => {
    await withFixture('enabled', false, async ({ client, finalizations, requests, storage, url }) => {
      const result = await run(client, storage, url, body === undefined ? [] : ['--data', body]);
      expect(result.exits, result.output).toEqual([]);
      expect(requests[0]?.body).toBe('');
      expect(requests[0]?.headers['content-type']).toBe(body === undefined ? undefined : 'application/json');
      expect(finalizations).toHaveLength(body === undefined ? 0 : 1);
    });
  });

  it.each<TapMode>(['unavailable', 'enabled'])(
    'reaches not-enrolled after a JSON challenge with TAP %s',
    async (mode) => {
      await withFixture(mode, true, async ({ client, requests, storage, url }) => {
        const result = await run(client, storage, url, ['--data', BODY]);
        expect(result.output).toContain('AEP_NOT_ENROLLED');
        expect(result.exits).toEqual([1]);
        expect(requests).toHaveLength(1);
        expect(requests[0]?.headers['content-type']).toBe('application/json');
        expect(requests[0]?.body).toBe(BODY);
      });
    },
  );

  it.each<TapMode>(['unavailable', 'enabled'])(
    'preserves JSON through anonymous and credential replay with TAP %s',
    async (mode) => {
      await withFixture(mode, true, async ({ client, finalizations, requests, serviceDid, storage, url }) => {
        await new AepStorage(storage, { platformOrigin: new URL(url).origin, userId: 'local-user' })
          .credentials()
          .saveCredential({
            credential: {
              access_token: 'local-service-credential',
              token_type: 'Bearer',
              credential_id: 'local-credential',
              expires_at: '2999-01-01T00:00:00Z',
              scopes: [],
            },
            credentialId: 'local-credential',
            expiresAt: '2999-01-01T00:00:00Z',
            grantType: 'oauth-bearer',
            issuedAt: '2026-01-01T00:00:00Z',
            serviceDid,
          });
        const result = await run(client, storage, url, ['--data', BODY]);
        expect(result.exits, result.output).toEqual([]);
        expect(result.output).toContain('authenticated');
        expect(requests).toHaveLength(2);
        expect(requests[0]?.headers.authorization).toBeUndefined();
        expect(requests[1]?.headers.authorization).toBe('Bearer local-service-credential');
        for (const request of requests) {
          expect(request.body).toBe(BODY);
          expect(request.headers['content-type']).toBe('application/json');
          if (mode === 'enabled') {
            expect(request.headers['content-digest']).toBe(
              `sha-256=:${createHash('sha256').update(BODY).digest('base64')}:`,
            );
            expect(request.headers['signature-input']).toBe('sig=("@method" "@target-uri")');
          }
        }
        expect(finalizations.map((value) => value.contentType)).toEqual(
          mode === 'enabled' ? ['application/json', 'application/json'] : [],
        );
      });
    },
  );
});
