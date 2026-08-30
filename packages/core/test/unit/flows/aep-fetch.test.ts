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
