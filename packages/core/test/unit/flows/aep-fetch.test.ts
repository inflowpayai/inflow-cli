import {
  createInMemoryAgentIdentityStore,
  createInMemorySessionCredentialStore,
  type AepPublicDocumentCache,
  type AgentServiceIdentity,
  type AgentCredentialRecord,
} from '@aep-foundation/agent';
import { encode, type MppChallenge, renderChallengeHeader } from '@inflowpayai/mpp';
import { encodePaymentRequiredHeader } from '@x402/core/http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { createAepPublicDocumentCache, MemoryStorage, runAepFetch } from '../../../src/index.js';

const SERVICE_DID = 'did:web:api.example.com';
const RESOURCE_URL = 'https://api.example.com/items/1';

const IDENTITY: AgentServiceIdentity = {
  agentDid: 'did:web:agent.example.com:agents:one',
  identityKind: 'sovereign',
  serviceDid: SERVICE_DID,
  signingAlgorithms: ['ES256'],
};

function paymentChallenge(): MppChallenge {
  return {
    expires: '2999-01-01T00:00:00Z',
    id: 'chal-1',
    intent: 'charge',
    method: 'inflow',
    realm: 'mpp.test',
    request: encode({ amount: '1', currency: 'USD', methodDetails: { rail: 'balance' } }),
  };
}

function x402PaymentRequiredHeader(): string {
  return encodePaymentRequiredHeader({
    accepts: [
      {
        amount: '1000',
        asset: '0xasset',
        extra: {},
        maxTimeoutSeconds: 300,
        network: 'eip155:84532',
        payTo: '0xpay',
        scheme: 'exact',
      },
    ],
    resource: { url: RESOURCE_URL },
    x402Version: 2,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

function requestUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return String(input);
  return input.url;
}

async function seedPublicDocuments(publicDocumentCache: AepPublicDocumentCache, methods: string[]): Promise<void> {
  const cachedAt = new Date().toISOString();
  const grantTypes = methods.filter((method) => method !== 'aep-jwt');
  await publicDocumentCache.set({
    cacheControl: 'max-age=300',
    cachedAt,
    namespace: 'inspect',
    url: 'https://api.example.com/.well-known/aep',
    value: {
      aep_version: '1.0',
      authentication: { methods },
      bindings: { supported: ['http'] },
      claims: { optional: [], preferred: [], required: [] },
      commands: {
        grant_types: grantTypes,
        supported: grantTypes.length === 0 ? ['inspect', 'status'] : ['enroll', 'grant', 'inspect', 'revoke', 'status'],
      },
      core: { signing_algorithms: ['EdDSA', 'ES256'] },
      extensions: { supported: [] },
      http: {
        endpoint_base: '/aep',
        openapi: { path_matching: { trailing_slash: 'strict' }, url: '/openapi.json' },
      },
      identity: { methods: ['did:web'] },
      service: { did: SERVICE_DID },
    },
  });
  await publicDocumentCache.set({
    cacheControl: 'max-age=300',
    cachedAt,
    namespace: 'openapi',
    url: 'https://api.example.com/openapi.json',
    value: {
      openapi: '3.1.0',
      components: {
        securitySchemes: Object.fromEntries(
          methods.map((method) => [method, { type: 'http', scheme: 'bearer', 'x-aep-authentication-method': method }]),
        ),
      },
      security: methods.map((method) => ({ [method]: [] })),
      paths: { '/items/{id}': { get: {} } },
    },
  });
}

describe('runAepFetch OpenAPI path', () => {
  it('retains public HTTP response metadata without obtaining an identity', async () => {
    const publicDocumentCache = createAepPublicDocumentCache(new MemoryStorage());
    await seedPublicDocuments(publicDocumentCache, []);
    const provision = vi.fn(() => IDENTITY);
    const server = setupServer(http.get(RESOURCE_URL, () => HttpResponse.text('public content')));
    server.listen({ onUnhandledRequest: 'error' });
    try {
      const result = await runAepFetch({
        agentOptions: {
          publicDocumentCache,
          identityProvider: { getOrCreateIdentity: provision, signerFor: () => () => 'unused' },
        },
        signal: new AbortController().signal,
        url: RESOURCE_URL,
      });
      expect(result).toMatchObject({
        finalUrl: RESOURCE_URL,
        redirected: false,
        status: 200,
        body: 'public content',
        authentication: { outcome: 'not-required' },
      });
      expect(provision).not.toHaveBeenCalled();
    } finally {
      server.close();
    }
  });

  it.each(['local', 'platform'] as const)(
    'obtains and reuses a credential with a %s identity without enrollment',
    async (location) => {
      const publicDocumentCache = createAepPublicDocumentCache(new MemoryStorage());
      await seedPublicDocuments(publicDocumentCache, ['api-key']);
      const credentialStore = createInMemorySessionCredentialStore();
      const identityStore = createInMemoryAgentIdentityStore(location === 'local' ? [IDENTITY] : []);
      const lookup = vi.fn(() => IDENTITY);
      const provision = vi.fn(() => IDENTITY);
      const signer = vi.fn(() => 'test-assertion');
      const requests: Request[] = [];
      const fetch = vi.fn<typeof globalThis.fetch>((input, init) => {
        const request = new Request(input, init);
        requests.push(request);
        if (request.url === 'https://api.example.com/aep/status') {
          expect(request.headers.get('authorization')).toBe('AEP test-assertion');
          return Promise.resolve(
            Response.json({ status: 'active' }, { headers: { 'Content-Type': 'application/aep+json' } }),
          );
        }
        if (request.url === 'https://api.example.com/aep/grant') {
          expect(request.method).toBe('POST');
          expect(request.headers.get('authorization')).toBe('AEP test-assertion');
          expect(request.headers.get('idempotency-key')).toBeTruthy();
          return Promise.resolve(
            Response.json(
              {
                credential_id: 'issued-key',
                api_key: 'secret-key',
                header: 'X-Service-Key',
                expires_at: '2999-01-01T00:00:00Z',
              },
              { headers: { 'Content-Type': 'application/aep+json' } },
            ),
          );
        }
        expect(request.url).toBe(RESOURCE_URL);
        expect(request.headers.get('X-Service-Key')).toBe('secret-key');
        return Promise.resolve(new Response('accepted'));
      });
      const input = {
        agentOptions: {
          fetch,
          credentialStore,
          identityStore,
          publicDocumentCache,
          identityProvider: {
            getOrCreateIdentity: provision,
            signerFor: () => signer,
            ...(location === 'platform' ? { findIdentityByServiceDid: lookup } : {}),
          },
        },
        url: RESOURCE_URL,
        grantType: 'api-key',
      };
      const first = await runAepFetch(input);
      expect(first.authentication).toEqual({
        outcome: 'authenticated',
        method: 'credential',
        operation: 'grant',
        credentialId: 'issued-key',
        grantType: 'api-key',
      });
      expect(await credentialStore.findCredential(SERVICE_DID, 'issued-key')).toMatchObject({
        credentialId: 'issued-key',
      });
      const second = await runAepFetch(input);
      expect(second.authentication).toEqual({
        outcome: 'authenticated',
        method: 'credential',
        credentialId: 'issued-key',
        grantType: 'api-key',
      });
      expect(requests.map((request) => request.url)).toEqual([
        'https://api.example.com/aep/status',
        'https://api.example.com/aep/grant',
        RESOURCE_URL,
        RESOURCE_URL,
      ]);
      expect(await requests[1]?.json()).toEqual({ grant_type: 'api-key' });
      expect(provision).not.toHaveBeenCalled();
      expect(await identityStore.findByServiceDid(SERVICE_DID)).toEqual(IDENTITY);
      expect(lookup).toHaveBeenCalledTimes(location === 'platform' ? 1 : 0);
      if (location === 'platform') expect(lookup).toHaveBeenCalledWith(SERVICE_DID);
      expect(signer).toHaveBeenCalledTimes(2);
    },
  );

  it.each(['missing', 'failure'] as const)(
    'does not provision or transmit credentials when platform lookup is %s',
    async (outcome) => {
      const publicDocumentCache = createAepPublicDocumentCache(new MemoryStorage());
      await seedPublicDocuments(publicDocumentCache, ['api-key']);
      const provision = vi.fn(() => IDENTITY);
      const fetch = vi.fn<typeof globalThis.fetch>();
      const identityStore = createInMemoryAgentIdentityStore();
      class Provider {
        readonly failure = new Error('Platform lookup failed');
        getOrCreateIdentity = provision;
        signerFor = vi.fn(() => () => 'unused');
        findIdentityByServiceDid(serviceDid: string) {
          expect(serviceDid).toBe(SERVICE_DID);
          if (outcome === 'failure') throw this.failure;
          return undefined;
        }
      }
      const provider = new Provider();
      await expect(
        runAepFetch({
          agentOptions: { publicDocumentCache, fetch, identityStore, identityProvider: provider },
          url: RESOURCE_URL,
          grantType: 'api-key',
        }),
      ).rejects.toThrow(
        outcome === 'failure' ? 'Platform lookup failed' : 'Grant requires an existing enrolled identity.',
      );
      expect(provision).not.toHaveBeenCalled();
      expect(provider.signerFor).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
      expect(await identityStore.findByServiceDid(SERVICE_DID)).toBeUndefined();
    },
  );

  it('does not grant or enroll when a recovered identity is suspended at the Service', async () => {
    const publicDocumentCache = createAepPublicDocumentCache(new MemoryStorage());
    await seedPublicDocuments(publicDocumentCache, ['api-key']);
    const provision = vi.fn(() => IDENTITY);
    const lookup = vi.fn(() => IDENTITY);
    const identityProvider = {
      getOrCreateIdentity: provision,
      findIdentityByServiceDid: lookup,
      signerFor: () => () => 'assertion',
    };
    const fetch = vi.fn<typeof globalThis.fetch>((input) => {
      expect(requestUrl(input)).toBe('https://api.example.com/aep/status');
      return Promise.resolve(
        Response.json({ status: 'suspended' }, { headers: { 'content-type': 'application/aep+json' } }),
      );
    });
    await expect(
      runAepFetch({
        agentOptions: {
          fetch,
          publicDocumentCache,
          identityStore: createInMemoryAgentIdentityStore(),
          identityProvider,
        },
        url: RESOURCE_URL,
        grantType: 'api-key',
      }),
    ).rejects.toThrow('Grant requires active enrollment.');
    expect(lookup).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledOnce();
    expect(provision).not.toHaveBeenCalled();
  });

  it('answers a live AEP challenge with the selected stored API key while preserving the request', async () => {
    const publicDocumentCache = createAepPublicDocumentCache(new MemoryStorage());
    await seedPublicDocuments(publicDocumentCache, ['api-key']);
    const credentialStore = createInMemorySessionCredentialStore();
    await credentialStore.saveCredential({
      credential: {
        api_key: 'test-key',
        header: 'X-Service-Key',
        credential_id: 'key-1',
        expires_at: '2999-01-01T00:00:00Z',
      },
      credentialId: 'key-1',
      grantType: 'api-key',
      issuedAt: '2026-01-01T00:00:00Z',
      expiresAt: '2999-01-01T00:00:00Z',
      serviceDid: SERVICE_DID,
    });
    const requests: Request[] = [];
    const fetch = vi.fn<typeof globalThis.fetch>((input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      expect(request.url).toBe(RESOURCE_URL);
      if (request.headers.get('X-Service-Key') === null) {
        return Promise.resolve(
          new Response('authentication required', {
            status: 401,
            headers: {
              'WWW-Authenticate': `AEP service_did="${SERVICE_DID}", inspect="https://api.example.com/.well-known/aep", reason="authentication_required"`,
            },
          }),
        );
      }
      expect(request.headers.get('X-Service-Key')).toBe('test-key');
      return Promise.resolve(new Response('accepted', { status: 200 }));
    });
    const signerFor = vi.fn(() => () => 'unused');
    const result = await runAepFetch({
      agentOptions: {
        fetch,
        credentialStore,
        publicDocumentCache,
        identityProvider: { getOrCreateIdentity: () => IDENTITY, signerFor },
      },
      credentialId: 'key-1',
      method: 'POST',
      body: '{"quantity":2}',
      headers: { 'Content-Type': 'application/json', 'X-Request-ID': 'request-1' },
      url: RESOURCE_URL,
      timeoutMs: 1000,
      maxRedirects: 0,
    });
    expect(requests).toHaveLength(2);
    for (const request of requests) {
      expect(request.method).toBe('POST');
      expect(request.headers.get('content-type')).toBe('application/json');
      expect(request.headers.get('x-request-id')).toBe('request-1');
      expect(await request.text()).toBe('{"quantity":2}');
    }
    expect(signerFor).not.toHaveBeenCalled();
    expect(result.authentication).toEqual({
      outcome: 'authenticated',
      method: 'credential',
      credentialId: 'key-1',
      grantType: 'api-key',
    });
    expect(result.body).toBe('accepted');
  });

  it.each([
    { 'WWW-Authenticate': 'Payment malformed' },
    { 'PAYMENT-REQUIRED': 'not-base64-json' },
    { 'WWW-Authenticate': 'Bearer realm="other"' },
    {},
  ])('does not offer payment for undecodable or unrelated 402 headers: %j', async (headers) => {
    const publicDocumentCache = createAepPublicDocumentCache(new MemoryStorage());
    await seedPublicDocuments(publicDocumentCache, []);
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response('payment error', { status: 402, headers }));
    const signerFor = vi.fn(() => () => 'unused');
    const result = await runAepFetch({
      agentOptions: {
        fetch,
        publicDocumentCache,
        identityProvider: { getOrCreateIdentity: () => IDENTITY, signerFor },
      },
      url: RESOURCE_URL,
    });
    expect(result.status).toBe(402);
    expect(result.paymentRequired).toBeUndefined();
    expect(result.body).toBe('payment error');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(signerFor).not.toHaveBeenCalled();
  });

  it('rejects responses exceeding the caller limit and accepts an exact-size response', async () => {
    const publicDocumentCache = createAepPublicDocumentCache(new MemoryStorage());
    await seedPublicDocuments(publicDocumentCache, []);
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(() => Promise.resolve(new Response('hello')));
    const input = {
      agentOptions: {
        fetch,
        publicDocumentCache,
        identityProvider: { getOrCreateIdentity: () => IDENTITY, signerFor: () => () => 'unused' },
      },
      url: RESOURCE_URL,
    };
    await expect(runAepFetch({ ...input, maxResponseBytes: 4 })).rejects.toMatchObject({
      code: 'AEP_RESPONSE_TOO_LARGE',
    });
    const result = await runAepFetch({ ...input, maxResponseBytes: 5, showBody: false });
    expect(result).toMatchObject({
      status: 200,
      responseSizeBytes: 5,
    });
    expect(result).not.toHaveProperty('body');
    expect(result).not.toHaveProperty('bodyBase64');
  });

  it('sends exactly one protected-resource request when fresh OpenAPI policy is definitive', async () => {
    const publicDocumentCache = createAepPublicDocumentCache(new MemoryStorage());
    await seedPublicDocuments(publicDocumentCache, ['aep-jwt']);
    const targetCalls: Request[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const url = requestUrl(input);
      if (url !== RESOURCE_URL) {
        return Promise.reject(new Error(`Unexpected fetch: ${url}`));
      }
      targetCalls.push(new Request(input, init));
      return Promise.resolve(
        new Response(JSON.stringify({ ok: true }), {
          headers: { 'content-type': 'application/json' },
          status: 200,
        }),
      );
    });

    const result = await runAepFetch({
      agentOptions: {
        credentialStore: createInMemorySessionCredentialStore(),
        identityProvider: {
          getOrCreateIdentity: () => IDENTITY,
          signerFor: () => () => 'jwt',
        },
        identityStore: createInMemoryAgentIdentityStore([IDENTITY]),
        publicDocumentCache,
      },
      method: 'GET',
      showBody: true,
      url: RESOURCE_URL,
    });

    expect(targetCalls).toHaveLength(1);
    expect(result.authentication).toMatchObject({
      method: 'aep-jwt',
      operation: 'authenticate',
      outcome: 'authenticated',
    });
    expect(targetCalls[0]?.headers.get('authorization')).not.toBeNull();
    expect(result.body).toBe('{"ok":true}');
  });

  it('returns not-required when OpenAPI falls back and the anonymous resource succeeds', async () => {
    const publicDocumentCache = createAepPublicDocumentCache(new MemoryStorage());
    await seedPublicDocuments(publicDocumentCache, ['aep-jwt']);
    await publicDocumentCache.set({
      cacheControl: 'max-age=300',
      cachedAt: new Date().toISOString(),
      namespace: 'openapi',
      url: 'https://api.example.com/openapi.json',
      value: { openapi: '3.1.0', paths: { '/public': { get: { security: [] } } } },
    });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('public', { headers: { 'content-type': 'text/plain' }, status: 200 }),
    );

    const result = await runAepFetch({
      agentOptions: {
        identityProvider: {
          getOrCreateIdentity: () => IDENTITY,
          signerFor: () => () => 'jwt',
        },
        publicDocumentCache,
      },
      method: 'GET',
      url: RESOURCE_URL,
    });

    expect(result.authentication).toEqual({ method: null, outcome: 'not-required' });
    expect(result.body).toBe('public');
  });

  it('reports credential authentication when a stored credential is replayed from definitive OpenAPI policy', async () => {
    const publicDocumentCache = createAepPublicDocumentCache(new MemoryStorage());
    await seedPublicDocuments(publicDocumentCache, ['oauth-bearer']);
    const credentialStore = createInMemorySessionCredentialStore();
    const credential: AgentCredentialRecord = {
      credential: {
        access_token: 'access-token',
        credential_id: 'cred-1',
        expires_at: '2999-01-01T00:00:00.000Z',
        scopes: [],
        token_type: 'Bearer',
      },
      credentialId: 'cred-1',
      expiresAt: '2999-01-01T00:00:00.000Z',
      grantType: 'oauth-bearer',
      issuedAt: '2026-01-01T00:00:00.000Z',
      serviceDid: SERVICE_DID,
    };
    await credentialStore.saveCredential(credential);
    const targetCalls: Request[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      if (requestUrl(input) !== RESOURCE_URL) return Promise.reject(new Error('Unexpected fetch.'));
      targetCalls.push(new Request(input, init));
      return Promise.resolve(new Response(null, { status: 204 }));
    });

    const result = await runAepFetch({
      agentOptions: {
        credentialStore,
        identityProvider: {
          getOrCreateIdentity: () => IDENTITY,
          signerFor: () => () => 'jwt',
        },
        publicDocumentCache,
      },
      credentialId: 'cred-1',
      method: 'GET',
      url: RESOURCE_URL,
    });

    expect(result.authentication).toMatchObject({
      credentialId: 'cred-1',
      grantType: 'oauth-bearer',
      method: 'credential',
      outcome: 'authenticated',
    });
    expect(targetCalls[0]?.headers.get('authorization')).toBe('Bearer access-token');
  });

  it('reports payment protocols when AEP authentication reaches a payment 402', async () => {
    const publicDocumentCache = createAepPublicDocumentCache(new MemoryStorage());
    await seedPublicDocuments(publicDocumentCache, ['aep-jwt']);
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      if (requestUrl(input) !== RESOURCE_URL) return Promise.reject(new Error('Unexpected fetch.'));
      return Promise.resolve(
        new Response('payment required', {
          headers: {
            'PAYMENT-REQUIRED': x402PaymentRequiredHeader(),
            'WWW-Authenticate': renderChallengeHeader(paymentChallenge()),
          },
          status: 402,
        }),
      );
    });

    const result = await runAepFetch({
      agentOptions: {
        identityProvider: {
          getOrCreateIdentity: () => IDENTITY,
          signerFor: () => () => 'jwt',
        },
        identityStore: createInMemoryAgentIdentityStore([IDENTITY]),
        publicDocumentCache,
      },
      method: 'GET',
      url: RESOURCE_URL,
    });

    expect(result.status).toBe(402);
    expect(result.paymentRequired).toEqual({ protocols: ['mpp', 'x402'] });
  });
});
