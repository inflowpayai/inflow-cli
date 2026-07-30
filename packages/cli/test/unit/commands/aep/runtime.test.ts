import {
  AepStorage,
  Inflow,
  MemoryStorage,
  PaymentInspectionBlockedError,
  type SellerAuthenticationError,
} from '@inflowpayai/inflow-core';
import {
  AepCommandError,
  type AepAgentOptions,
  type AgentCredentialRecord,
  type AgentServiceIdentity,
} from '@aep-foundation/agent';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createAepAwareInspectProbe,
  createAepAwareSellerTransport,
  createCliAepAgentOptions,
  mapAepRuntimeError,
  storedAepCredentialAuthenticationHeaders,
} from '../../../../src/commands/aep/runtime.js';

const INSPECT_DOCUMENT = {
  aep_version: '1.0',
  authentication: { methods: ['aep-jwt'] },
  bindings: { supported: ['http'] },
  claims: { optional: [], preferred: [], required: [] },
  commands: { grant_types: ['oauth-bearer'], supported: ['inspect', 'enroll', 'grant', 'revoke', 'status'] },
  core: { signing_algorithms: ['ES256'] },
  http: { endpoint_base: '/aep', openapi: { path_matching: { trailing_slash: 'strict' }, url: '/openapi.json' } },
  identity: { methods: ['did:web'] },
  service: { did: 'did:web:seller.test' },
};

const OPENAPI_DOCUMENT = {
  openapi: '3.1.0',
  components: {
    securitySchemes: {
      session: { type: 'http', scheme: 'bearer', 'x-aep-authentication-method': 'aep-jwt' },
    },
  },
  security: [{ session: [] }],
  paths: { '/resource': { get: {} } },
};

const API_KEY_INSPECT_DOCUMENT = {
  ...INSPECT_DOCUMENT,
  authentication: { methods: ['api-key'] },
  commands: { ...INSPECT_DOCUMENT.commands, grant_types: ['api-key'] },
};

const API_KEY_OPENAPI_DOCUMENT = {
  openapi: '3.1.0',
  components: {
    securitySchemes: {
      session: { type: 'apiKey', in: 'header', name: 'x-aep-api-key', 'x-aep-authentication-method': 'api-key' },
    },
  },
  security: [{ session: [] }],
  paths: { '/resource': { get: {} } },
};

const OAUTH_INSPECT_DOCUMENT = {
  ...INSPECT_DOCUMENT,
  authentication: { methods: ['oauth-bearer'] },
};

const OAUTH_OPENAPI_DOCUMENT = {
  ...OPENAPI_DOCUMENT,
  components: {
    securitySchemes: {
      session: { type: 'http', scheme: 'bearer', 'x-aep-authentication-method': 'oauth-bearer' },
    },
  },
};

function requestUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return String(input);
  return input.url;
}

function inflow(): Inflow {
  const client = new Inflow({ apiBaseUrl: 'https://platform.example', apiKey: 'key' });
  vi.spyOn(client, 'platformAuthenticationHeaders').mockResolvedValue({ 'X-Test-Platform': 'yes' });
  vi.spyOn(client.user, 'retrieve').mockResolvedValue({
    created: '2026-01-01T00:00:00.000Z',
    email: null,
    firstName: null,
    lastName: null,
    locale: 'en-US',
    mobile: null,
    timezone: 'UTC',
    updated: '2026-01-01T00:00:00.000Z',
    userId: 'user-1',
    username: null,
  });
  return client;
}

function context() {
  return {
    agent: true,
    error: (error: { code: string }): never => {
      throw new Error(error.code);
    },
    formatExplicit: true,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('AEP-aware seller transport', () => {
  it('preserves ordinary non-AEP seller responses without attaching payment headers', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('free', { headers: { 'content-type': 'text/plain' }, status: 200 }));
    const transport = createAepAwareSellerTransport({
      authStorage: new MemoryStorage(),
      context: context(),
      inflow: inflow(),
      timeout: 30,
    });

    const result = await transport.request({
      headers: { Authorization: 'Bearer caller' },
      method: 'GET',
      url: 'https://seller.test/resource',
    });

    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(new Headers(fetchSpy.mock.calls[0]?.[1]?.headers).get('Authorization')).toBe('Bearer caller');
    expect(result.status).toBe(200);
    expect(result.contentType).toBe('text/plain');
    expect(Buffer.from(result.bytes).toString('utf8')).toBe('free');
  });

  it('sends payment headers only after a non-AEP payment challenge is observed', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('payment required', { status: 402 }))
      .mockResolvedValueOnce(new Response('paid', { status: 200 }));
    const transport = createAepAwareSellerTransport({
      authStorage: new MemoryStorage(),
      context: context(),
      inflow: inflow(),
      timeout: 30,
    });

    const result = await transport.request({
      additionalAuthenticationHeaders: { Authorization: 'Payment CRED' },
      headers: { 'X-Request': 'one' },
      method: 'POST',
      data: '{}',
      url: 'https://seller.test/resource',
    });

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(new Headers(fetchSpy.mock.calls[0]?.[1]?.headers).get('Authorization')).toBeNull();
    expect(new Headers(fetchSpy.mock.calls[1]?.[1]?.headers).get('Authorization')).toBe('Payment CRED');
    expect(new Headers(fetchSpy.mock.calls[1]?.[1]?.headers).get('X-Request')).toBe('one');
    expect(result.status).toBe(200);
    expect(Buffer.from(result.bytes).toString('utf8')).toBe('paid');
  });

  it('rejects caller-controlled AEP authentication header collisions before contacting the seller', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const transport = createAepAwareSellerTransport({
      authStorage: new MemoryStorage(),
      context: context(),
      inflow: inflow(),
      timeout: 30,
    });

    await expect(
      transport.request({
        headers: { 'aep-authorization': 'caller' },
        method: 'GET',
        url: 'https://seller.test/resource',
      }),
    ).rejects.toMatchObject({
      code: 'AEP_AUTHENTICATION_HEADER_COLLISION',
      message: 'AEP-Authorization is reserved for AEP credentials. Remove that header from the request.',
    } satisfies Partial<SellerAuthenticationError>);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects payment-layer attempts to occupy the AEP authentication header', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const transport = createAepAwareSellerTransport({
      authStorage: new MemoryStorage(),
      context: context(),
      inflow: inflow(),
      timeout: 30,
    });

    await expect(
      transport.request({
        additionalAuthenticationHeaders: { 'AEP-Authorization': 'service' },
        headers: {},
        method: 'GET',
        url: 'https://seller.test/resource',
      }),
    ).rejects.toMatchObject({ code: 'AEP_AUTHENTICATION_HEADER_COLLISION' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('does not attach payment when AEP authentication cannot complete', async () => {
    const inspectDocument = {
      aep_version: '1.0',
      authentication: { methods: ['aep-jwt'] },
      bindings: { supported: ['http'] },
      claims: { optional: [], preferred: [], required: [] },
      commands: { grant_types: ['oauth-bearer'], supported: ['inspect', 'enroll', 'grant', 'revoke', 'status'] },
      core: { signing_algorithms: ['ES256'] },
      http: { endpoint_base: '/aep' },
      identity: { methods: ['did:web'] },
      service: { did: 'did:web:seller.test' },
    };
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? String(input) : input.url;
      if (url === 'https://seller.test/.well-known/aep') {
        return Promise.resolve(Response.json(inspectDocument, { headers: { 'content-type': 'application/aep+json' } }));
      }
      expect(new Headers(init?.headers).get('Authorization')).not.toBe('Payment CRED');
      return Promise.resolve(
        new Response('aep required', {
          headers: {
            'WWW-Authenticate': 'AEP service_did="did:web:seller.test", inspect="https://seller.test/.well-known/aep"',
          },
          status: 401,
        }),
      );
    });
    const transport = createAepAwareSellerTransport({
      authStorage: new MemoryStorage(),
      context: context(),
      inflow: inflow(),
      timeout: 30,
    });

    await expect(
      transport.request({
        additionalAuthenticationHeaders: { Authorization: 'Payment CRED' },
        headers: {},
        method: 'GET',
        url: 'https://seller.test/resource',
      }),
    ).rejects.toThrow();
    expect(fetchSpy.mock.calls.length).toBeGreaterThan(1);
  });
});

describe('AEP-aware read-only inspection probe', () => {
  it('passes through ordinary seller responses without AEP state', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = requestUrl(input);
      if (url === 'https://seller.test/.well-known/aep')
        return Promise.resolve(new Response('missing', { status: 404 }));
      return Promise.resolve(new Response('free', { headers: { 'content-type': 'text/plain' }, status: 200 }));
    });
    const probe = createAepAwareInspectProbe({
      authStorage: new MemoryStorage(),
      context: context(),
      inflow: inflow(),
      timeout: 30,
    });

    const result = await probe('https://seller.test/resource', { method: 'GET', headers: {} });

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(result.status).toBe(200);
    expect(result.contentType).toBe('text/plain');
    expect(Buffer.from(result.bytes).toString('utf8')).toBe('free');
  });

  it('returns a blocked inspection error when an AEP challenge has no reusable stored credential', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = requestUrl(input);
      if (url === 'https://seller.test/.well-known/aep') {
        return Promise.resolve(
          Response.json(INSPECT_DOCUMENT, { headers: { 'content-type': 'application/aep+json' } }),
        );
      }
      if (url === 'https://seller.test/openapi.json') {
        return Promise.resolve(Response.json({ openapi: '3.1.0', paths: {} }));
      }
      return Promise.resolve(
        new Response('aep required', {
          headers: {
            'WWW-Authenticate':
              'AEP service_did="did:web:seller.test", inspect="https://seller.test/.well-known/aep", reason="auth"',
          },
          status: 401,
        }),
      );
    });
    const probe = createAepAwareInspectProbe({
      authStorage: new MemoryStorage(),
      context: context(),
      inflow: inflow(),
      timeout: 30,
    });

    await expect(probe('https://seller.test/resource', { method: 'GET', headers: {} })).rejects.toMatchObject({
      blocked: {
        method: 'GET',
        url: 'https://seller.test/resource',
        source: 'challenge',
        serviceDid: 'did:web:seller.test',
        serviceUrl: 'https://seller.test',
      },
    });
  });

  it('uses a stored AEP credential to reveal payment terms when OpenAPI requires AEP', async () => {
    const authStorage = new MemoryStorage();
    const aepStorage = new AepStorage(authStorage, {
      platformOrigin: 'https://platform.example',
      userId: 'user-1',
    });
    await aepStorage.credentials().saveCredential({
      credential: {
        access_token: 'stored-token',
        credential_id: 'cred-1',
        expires_at: '2999-01-01T00:00:00.000Z',
        scopes: [],
        token_type: 'Bearer',
      },
      credentialId: 'cred-1',
      expiresAt: '2999-01-01T00:00:00.000Z',
      grantType: 'oauth-bearer',
      issuedAt: '2026-01-01T00:00:00.000Z',
      serviceDid: 'did:web:seller.test',
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const url = requestUrl(input);
      if (url === 'https://seller.test/.well-known/aep') {
        return Promise.resolve(
          Response.json(OAUTH_INSPECT_DOCUMENT, { headers: { 'content-type': 'application/aep+json' } }),
        );
      }
      if (url === 'https://seller.test/openapi.json') {
        return Promise.resolve(
          Response.json(OAUTH_OPENAPI_DOCUMENT, { headers: { 'content-type': 'application/json' } }),
        );
      }
      expect(new Headers(init?.headers).get('AEP-Authorization')).toBe('Bearer stored-token');
      return Promise.resolve(new Response('payment required', { status: 402 }));
    });
    const probe = createAepAwareInspectProbe({
      authStorage,
      context: context(),
      inflow: inflow(),
      timeout: 30,
    });

    const result = await probe('https://seller.test/resource', { method: 'GET', headers: { 'X-Test': 'yes' } });

    expect(result.status).toBe(402);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it('uses a stored API-key credential to reveal payment terms when OpenAPI requires AEP', async () => {
    const authStorage = new MemoryStorage();
    const aepStorage = new AepStorage(authStorage, {
      platformOrigin: 'https://platform.example',
      userId: 'user-1',
    });
    await aepStorage.credentials().saveCredential({
      credential: {
        api_key: 'stored-api-key',
        credential_id: 'cred-api-key',
        expires_at: '2999-01-01T00:00:00.000Z',
        header: 'x-aep-api-key',
        scopes: [],
      },
      credentialId: 'cred-api-key',
      expiresAt: '2999-01-01T00:00:00.000Z',
      grantType: 'api-key',
      issuedAt: '2026-01-01T00:00:00.000Z',
      serviceDid: 'did:web:seller.test',
    });
    await aepStorage.credentials().saveCredential({
      credential: {
        access_token: 'newer-but-incompatible',
        credential_id: 'cred-oauth',
        expires_at: '2999-01-01T00:00:00.000Z',
        scopes: [],
        token_type: 'Bearer',
      },
      credentialId: 'cred-oauth',
      expiresAt: '2999-01-01T00:00:00.000Z',
      grantType: 'oauth-bearer',
      issuedAt: '2026-02-01T00:00:00.000Z',
      serviceDid: 'did:web:seller.test',
    });
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const url = requestUrl(input);
      if (url === 'https://seller.test/.well-known/aep') {
        return Promise.resolve(
          Response.json(API_KEY_INSPECT_DOCUMENT, { headers: { 'content-type': 'application/aep+json' } }),
        );
      }
      if (url === 'https://seller.test/openapi.json') {
        return Promise.resolve(
          Response.json(API_KEY_OPENAPI_DOCUMENT, { headers: { 'content-type': 'application/json' } }),
        );
      }
      expect(new Headers(init?.headers).get('x-aep-api-key')).toBe('stored-api-key');
      return Promise.resolve(new Response('payment required', { status: 402 }));
    });
    const probe = createAepAwareInspectProbe({
      authStorage,
      context: context(),
      inflow: inflow(),
      timeout: 30,
    });

    expect((await probe('https://seller.test/resource', { method: 'GET', headers: {} })).status).toBe(402);
  });

  it('reports a rejected stored credential as blocked AEP inspection', async () => {
    const authStorage = new MemoryStorage();
    const aepStorage = new AepStorage(authStorage, {
      platformOrigin: 'https://platform.example',
      userId: 'user-1',
    });
    await aepStorage.credentials().saveCredential({
      credential: {
        api_key: 'rejected-api-key',
        credential_id: 'cred-rejected',
        expires_at: '2999-01-01T00:00:00.000Z',
        header: 'x-aep-api-key',
        scopes: [],
      },
      credentialId: 'cred-rejected',
      expiresAt: '2999-01-01T00:00:00.000Z',
      grantType: 'api-key',
      issuedAt: '2026-01-01T00:00:00.000Z',
      serviceDid: 'did:web:seller.test',
    });
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = requestUrl(input);
      if (url === 'https://seller.test/.well-known/aep') {
        return Promise.resolve(
          Response.json(API_KEY_INSPECT_DOCUMENT, { headers: { 'content-type': 'application/aep+json' } }),
        );
      }
      if (url === 'https://seller.test/openapi.json') {
        return Promise.resolve(
          Response.json(API_KEY_OPENAPI_DOCUMENT, { headers: { 'content-type': 'application/json' } }),
        );
      }
      return Promise.resolve(new Response('rejected', { status: 401 }));
    });
    const probe = createAepAwareInspectProbe({
      authStorage,
      context: context(),
      inflow: inflow(),
      timeout: 30,
    });

    try {
      await probe('https://seller.test/resource', { method: 'GET', headers: {} });
      expect.unreachable('Expected the rejected credential to block inspection.');
    } catch (error) {
      expect(error).toBeInstanceOf(PaymentInspectionBlockedError);
      if (!(error instanceof PaymentInspectionBlockedError)) throw error;
      expect(error.blocked.message).toContain('stored AEP credential was rejected');
      expect(error.blocked.source).toBe('openapi');
    }
  });

  it('rejects caller-supplied AEP carrier collisions before inspection', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const probe = createAepAwareInspectProbe({
      authStorage: new MemoryStorage(),
      context: context(),
      inflow: inflow(),
      timeout: 30,
    });

    await expect(
      probe('https://seller.test/resource', { method: 'GET', headers: { 'AEP-Authorization': 'caller' } }),
    ).rejects.toMatchObject({ message: 'Header AEP-Authorization is controlled by AEP authentication.' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('CLI AEP approval resolver', () => {
  const identity: AgentServiceIdentity = {
    agentDid: 'did:web:agent.test:agents:one',
    identityKind: 'platform-hosted',
    serviceDid: 'did:web:service.test',
    signingAlgorithms: ['ES256'],
  };

  function resolverInput(
    continueSign: () => Promise<{ clientAssertion: string; status: 'completed' }>,
  ): Parameters<NonNullable<AepAgentOptions['pendingSignResolver']>>[0] {
    return {
      claims: {
        aud: 'did:web:service.test',
        exp: 1,
        iat: 1,
        iss: identity.agentDid,
        jti: 'jti-1',
        op: 'authenticate',
        sub: identity.agentDid,
      },
      continueSign,
      context: { command: 'authenticate', serviceDid: identity.serviceDid, signingAlgorithms: ['ES256'] },
      pending: { platformContext: { approval_id: 'approval-1' }, retryAfterSeconds: 0.001, status: 'pending' },
    };
  }

  it('continues signing once Platform approval is approved', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(Response.json({ status: 'APPROVED' }));
    const options = createCliAepAgentOptions({
      authStorage: new MemoryStorage(),
      context: context(),
      inflow: inflow(),
      interval: 0.001,
      timeout: 1,
    });

    const result = await options.pendingSignResolver?.(
      resolverInput(() => Promise.resolve({ clientAssertion: 'jwt', status: 'completed' })),
    );

    expect(result).toEqual({ clientAssertion: 'jwt', status: 'completed' });
    expect(globalThis.fetch).toHaveBeenCalledWith(new URL('/v1/approvals/approval-1', 'https://platform.example'), {
      headers: { 'X-Test-Platform': 'yes' },
    });
  });

  it('maps declined approval to the stable AEP denial error', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(Response.json({ status: 'DECLINED' }));
    const options = createCliAepAgentOptions({
      authStorage: new MemoryStorage(),
      context: context(),
      inflow: inflow(),
      interval: 0.001,
      timeout: 1,
    });

    let caught: unknown;
    try {
      await options.pendingSignResolver?.(
        resolverInput(() => Promise.resolve({ clientAssertion: 'jwt', status: 'completed' })),
      );
    } catch (error) {
      caught = error;
    }

    expect(mapAepRuntimeError(caught)).toEqual({
      code: 'AEP_APPROVAL_DENIED',
      message: 'The InFlow approval was declined.',
    });
  });

  it('maps cancelled approval to the stable cancellation error', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(Response.json({ status: 'CANCELLED' }));
    const options = createCliAepAgentOptions({
      authStorage: new MemoryStorage(),
      context: context(),
      inflow: inflow(),
      interval: 0.001,
      timeout: 1,
    });

    let caught: unknown;
    try {
      await options.pendingSignResolver?.(
        resolverInput(() => Promise.resolve({ clientAssertion: 'jwt', status: 'completed' })),
      );
    } catch (error) {
      caught = error;
    }

    expect(mapAepRuntimeError(caught)).toEqual({
      code: 'APPROVAL_CANCELLED',
      message: 'The AEP approval was cancelled.',
    });
  });

  it('maps approval polling exhaustion to the stable timeout error', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => Promise.resolve(Response.json({ status: 'PENDING' })));
    const options = createCliAepAgentOptions({
      authStorage: new MemoryStorage(),
      context: context(),
      inflow: inflow(),
      interval: 0.001,
      timeout: 0.001,
    });

    let caught: unknown;
    try {
      await options.pendingSignResolver?.(
        resolverInput(() => Promise.resolve({ clientAssertion: 'jwt', status: 'completed' })),
      );
    } catch (error) {
      caught = error;
    }

    expect(mapAepRuntimeError(caught)).toEqual({
      code: 'AEP_APPROVAL_TIMEOUT',
      message: 'The InFlow approval timed out.',
    });
  });

  it('builds grant platform context with requested scopes', () => {
    const options = createCliAepAgentOptions({
      authStorage: new MemoryStorage(),
      context: context(),
      inflow: inflow(),
      timeout: 1,
    });

    expect(
      options.platformContextProvider?.({
        command: 'grant',
        grantType: 'oauth-bearer',
        identity,
        requestedScopes: ['read', 'write'],
        serviceDid: 'did:web:service.test',
      }),
    ).toEqual({ grant_type: 'oauth-bearer', requested_scopes: ['read', 'write'] });
    expect(
      options.platformContextProvider?.({
        command: 'authenticate',
        identity,
        serviceDid: 'did:web:service.test',
      }),
    ).toBeUndefined();
  });

  it('maps approval status request failures to the stable server error', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('nope', { status: 500 }));
    const options = createCliAepAgentOptions({
      authStorage: new MemoryStorage(),
      context: context(),
      inflow: inflow(),
      interval: 0.001,
      timeout: 1,
    });

    let caught: unknown;
    try {
      await options.pendingSignResolver?.(
        resolverInput(() => Promise.resolve({ clientAssertion: 'jwt', status: 'completed' })),
      );
    } catch (error) {
      caught = error;
    }

    expect(mapAepRuntimeError(caught)).toEqual({
      code: 'AEP_APPROVAL_SERVER_ERROR',
      message: 'The InFlow approval status request failed.',
      retryable: true,
    });
  });

  it('maps malformed approval status responses to the stable server error', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(Response.json({ state: 'APPROVED' }));
    const options = createCliAepAgentOptions({
      authStorage: new MemoryStorage(),
      context: context(),
      inflow: inflow(),
      interval: 0.001,
      timeout: 1,
    });

    let caught: unknown;
    try {
      await options.pendingSignResolver?.(
        resolverInput(() => Promise.resolve({ clientAssertion: 'jwt', status: 'completed' })),
      );
    } catch (error) {
      caught = error;
    }

    expect(mapAepRuntimeError(caught)).toMatchObject({ code: 'AEP_APPROVAL_SERVER_ERROR' });
  });

  it('rejects missing approval identifiers and invalid approval intervals', async () => {
    const options = createCliAepAgentOptions({
      authStorage: new MemoryStorage(),
      context: context(),
      inflow: inflow(),
      interval: 0,
      timeout: 1,
    });

    await expect(
      options.pendingSignResolver?.({
        claims: {
          aud: 'did:web:service.test',
          exp: 1,
          iat: 1,
          iss: identity.agentDid,
          jti: 'jti-1',
          op: 'authenticate',
          sub: identity.agentDid,
        },
        continueSign: () => Promise.resolve({ clientAssertion: 'jwt', status: 'completed' }),
        context: { command: 'authenticate', serviceDid: identity.serviceDid, signingAlgorithms: ['ES256'] },
        pending: { platformContext: {}, retryAfterSeconds: 1, status: 'pending' },
      }),
    ).rejects.toThrow('Platform Sign omitted the approval identifier.');
    await expect(
      options.pendingSignResolver?.(
        resolverInput(() => Promise.resolve({ clientAssertion: 'jwt', status: 'completed' })),
      ),
    ).rejects.toThrow('Approval interval must be positive.');
  });

  it('maps an aborted approval wait to cancellation', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ status: 'PENDING' }));
    const controller = new AbortController();
    controller.abort();
    const options = createCliAepAgentOptions({
      authStorage: new MemoryStorage(),
      context: context(),
      inflow: inflow(),
      interval: 0.001,
      timeout: 1,
    });

    let caught: unknown;
    try {
      await options.pendingSignResolver?.({
        ...resolverInput(() => Promise.resolve({ clientAssertion: 'jwt', status: 'completed' })),
        signal: controller.signal,
      });
    } catch (error) {
      caught = error;
    }

    expect(mapAepRuntimeError(caught)).toMatchObject({ code: 'APPROVAL_CANCELLED' });
  });

  it('maps an abort while sleeping between approval polls to cancellation', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ status: 'PENDING' }));
    const controller = new AbortController();
    const options = createCliAepAgentOptions({
      authStorage: new MemoryStorage(),
      context: context(),
      inflow: inflow(),
      interval: 0.1,
      timeout: 1,
    });
    setTimeout(() => controller.abort(), 0);

    let caught: unknown;
    try {
      await options.pendingSignResolver?.({
        ...resolverInput(() => Promise.resolve({ clientAssertion: 'jwt', status: 'completed' })),
        signal: controller.signal,
      });
    } catch (error) {
      caught = error;
    }

    expect(mapAepRuntimeError(caught)).toMatchObject({ code: 'APPROVAL_CANCELLED' });
  });

  it('maps AEP not-recognized command errors to the enrollment guidance error', () => {
    expect(
      mapAepRuntimeError(
        new AepCommandError('not recognized', 401, {
          code: 'not_recognized',
          status: 401,
          title: 'Not recognized',
          type: 'urn:aep:error:not_recognized',
        }),
      ),
    ).toEqual({
      code: 'AEP_NOT_ENROLLED',
      message: 'Not enrolled with this Service. Use `inflow aep enroll <service>` first.',
    });
  });
});

describe('CLI AEP persisted stores', () => {
  const credential: AgentCredentialRecord = {
    credential: {
      access_token: 'token',
      credential_id: 'cred-1',
      expires_at: '2999-01-01T00:00:00.000Z',
      scopes: [],
      token_type: 'Bearer',
    },
    credentialId: 'cred-1',
    expiresAt: '2999-01-01T00:00:00.000Z',
    grantType: 'oauth-bearer',
    issuedAt: '2026-01-01T00:00:00.000Z',
    serviceDid: 'did:web:service.test',
  };
  const identity: AgentServiceIdentity = {
    agentDid: 'did:web:agent.test',
    identityKind: 'platform-hosted',
    serviceDid: 'did:web:service.test',
    signingAlgorithms: ['ES256'],
  };

  it('persists credentials and identities through the shared runtime stores', async () => {
    const authStorage = new MemoryStorage();
    const trace = { count: 0, markAuthenticated: vi.fn(() => (trace.count += 1)) };
    const options = createCliAepAgentOptions({
      authStorage,
      context: context(),
      inflow: inflow(),
      timeout: 30,
      trace,
    });

    await options.credentialStore?.saveCredential(credential);
    expect(await options.credentialStore?.findCredential('did:web:service.test', 'cred-1')).toMatchObject({
      credentialId: 'cred-1',
    });
    expect(await options.credentialStore?.findUsableCredential('did:web:service.test')).toMatchObject({
      credentialId: 'cred-1',
    });
    expect(await options.credentialStore?.listCredentials('did:web:service.test')).toHaveLength(1);
    await options.credentialStore?.deleteCredential('did:web:service.test', 'cred-1');
    expect(await options.credentialStore?.listCredentials('did:web:service.test')).toHaveLength(0);

    await options.identityStore?.saveIdentity(identity);
    expect(await options.identityStore?.findByServiceDid('did:web:service.test')).toMatchObject({
      agentDid: 'did:web:agent.test',
    });
    expect(trace.markAuthenticated).toHaveBeenCalled();
  });

  it('reports unavailable AEP storage through the shared runtime stores', async () => {
    const options = createCliAepAgentOptions({
      authStorage: {} as never,
      context: context(),
      inflow: inflow(),
      timeout: 30,
    });

    await expect(options.credentialStore?.listCredentials('did:web:service.test')).rejects.toThrow(
      'AEP storage is unavailable.',
    );
  });

  it('returns undefined for credential-only inspect headers when no stored credential exists', async () => {
    await expect(
      storedAepCredentialAuthenticationHeaders(
        {
          authStorage: new MemoryStorage(),
          context: context(),
          inflow: inflow(),
          timeout: 30,
        },
        {
          commandUrl: (command: string) => new URL(`https://service.test/aep/${command}`),
          document: {
            aep_version: '1.0',
            bindings: { supported: ['http'] },
            commands: { supported: ['inspect'] },
            core: { signing_algorithms: ['ES256'] },
            http: { endpoint_base: '/aep' },
            identity: { methods: ['did:web'] },
            service: { did: 'did:web:service.test' },
          },
          finalUrl: new URL('https://service.test/.well-known/aep'),
          inspectUrl: new URL('https://service.test/.well-known/aep'),
        },
      ),
    ).resolves.toBeUndefined();
  });
});
