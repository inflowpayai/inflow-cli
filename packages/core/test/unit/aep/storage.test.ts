import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { discoverPlatform, fetchAepPublicDocument, type CachedInspectServiceResult } from '@aep-foundation/agent';
import {
  AepStorage,
  createAepPublicDocumentCache,
  MemoryStorage,
  runAuthLogout,
  Storage,
  type AepPersistedState,
  type AepStateStorage,
} from '../../../src/index.js';
import { SyncMemorySecretStore } from '../../../src/secure-storage/secret-store.js';

const OWNER = { platformOrigin: 'https://api.example.test', userId: 'user-1' };
const IDENTITY = {
  agentDid: 'did:web:platform.example:agents:one',
  identityKind: 'platform-hosted' as const,
  serviceDid: 'did:web:service.example',
  signingAlgorithms: ['ES256'],
};

const PLATFORM_DISCOVERY = {
  aep_version: '1.0',
  endpoints: {
    hosted_verification: '/v1/aep/verifications',
    lifecycle: '/v1/aep/agent-identities/{agent_identity_id}',
    list: '/v1/aep/agent-identities',
    provision: '/v1/aep/agent-identities',
    sign: '/v1/aep/agent-identities/{agent_identity_id}/sign',
  },
  http: { endpoint_base: '/v1/aep' },
  identity: {
    did_methods: ['did:web'],
    did_url_template: 'https://platform.example.test/agents/{agent_did_id}/did.json',
  },
  platform: { did: 'did:web:platform.example.test', hosted_verification: true, name: 'Example Platform' },
  signing: { algorithms: ['ES256'], default_lifetime_seconds: '300' },
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('AepStorage', () => {
  it('persists Inspect cache entries across storage instances and isolates them by owner', async () => {
    const backing = new MemoryStorage();
    const first = new AepStorage(backing, OWNER);
    const document = {
      aep_version: '1.0',
      authentication: { methods: ['api-key'] },
      bindings: { supported: ['http'] },
      commands: { grant_types: ['api-key'], supported: ['inspect', 'grant'] },
      core: { signing_algorithms: ['ES256'] },
      http: { endpoint_base: '/aep/' },
      identity: { methods: ['did:web'] },
      service: { did: IDENTITY.serviceDid },
    } satisfies CachedInspectServiceResult['document'];
    await first.inspectCache().set('https://service.example/', {
      cacheControl: 'max-age=300',
      cachedAt: '2026-01-01T00:00:00.000Z',
      commandUrl: (command) => new URL(`/aep/${command}`, 'https://service.example/'),
      document,
      inspectUrl: new URL('https://service.example/.well-known/aep'),
    });

    const second = new AepStorage(backing, OWNER);
    const cached = await second.inspectCache().get('https://service.example/');
    expect(cached?.document).toEqual(document);
    expect(String(cached?.commandUrl('grant'))).toBe('https://service.example/aep/grant');

    const otherOwner = new AepStorage(backing, { platformOrigin: OWNER.platformOrigin, userId: 'user-2' });
    expect(await otherOwner.inspectCache().get('https://service.example/')).toBeUndefined();
  });

  it('persists identities and removes expired credentials before every read and write', async () => {
    const storage = new AepStorage(new MemoryStorage(), OWNER);
    const identities = storage.identities();
    const credentials = storage.credentials();
    const expired = {
      credential: { credential_id: 'expired', expires_at: '2000-01-01T00:00:00.000Z' },
      credentialId: 'expired',
      expiresAt: '2000-01-01T00:00:00.000Z',
      grantType: 'oauth-bearer',
      issuedAt: '2000-01-01T00:00:00.000Z',
      serviceDid: IDENTITY.serviceDid,
    };
    const active = {
      credential: { credential_id: 'active', expires_at: '2999-01-01T00:00:00.000Z', scopes: ['read'] },
      credentialId: 'active',
      expiresAt: '2999-01-01T00:00:00.000Z',
      grantType: 'oauth-bearer',
      issuedAt: '2026-01-01T00:00:00.000Z',
      serviceDid: IDENTITY.serviceDid,
    };

    await identities.saveIdentity(IDENTITY);
    expect(await identities.findByServiceDid(IDENTITY.serviceDid)).toEqual(IDENTITY);
    await credentials.saveCredential(expired);
    await credentials.saveCredential(active);
    expect(await credentials.findCredential(IDENTITY.serviceDid, 'expired')).toBeUndefined();
    expect(await credentials.findUsableCredential(IDENTITY.serviceDid)).toMatchObject({ credentialId: 'active' });
    expect(await credentials.listCredentials(IDENTITY.serviceDid)).toHaveLength(1);
    await credentials.deleteCredential(IDENTITY.serviceDid, 'active');
    expect(await credentials.listCredentials(IDENTITY.serviceDid)).toEqual([]);
  });

  it('selects the newest usable credential for a Service', async () => {
    const credentials = new AepStorage(new MemoryStorage(), OWNER).credentials();
    await credentials.saveCredential({
      credential: { credential_id: 'older', expires_at: '2999-01-01T00:00:00.000Z' },
      credentialId: 'older',
      expiresAt: '2999-01-01T00:00:00.000Z',
      grantType: 'api-key',
      issuedAt: '2026-01-01T00:00:00.000Z',
      serviceDid: IDENTITY.serviceDid,
    });
    await credentials.saveCredential({
      credential: { credential_id: 'newer', expires_at: '2999-01-01T00:00:00.000Z' },
      credentialId: 'newer',
      expiresAt: '2999-01-01T00:00:00.000Z',
      grantType: 'api-key',
      issuedAt: '2026-02-01T00:00:00.000Z',
      serviceDid: IDENTITY.serviceDid,
    });

    expect(await credentials.findUsableCredential(IDENTITY.serviceDid)).toMatchObject({ credentialId: 'newer' });
  });

  it('clears records when the authenticated Platform owner changes', async () => {
    const backing = new MemoryStorage();
    const first = new AepStorage(backing, OWNER);
    await first.identities().saveIdentity(IDENTITY);

    const second = new AepStorage(backing, { platformOrigin: OWNER.platformOrigin, userId: 'user-2' });
    expect(await second.identities().findByServiceDid(IDENTITY.serviceDid)).toBeUndefined();
    expect(backing.getAepState()?.owner.userId).toBe('user-2');
  });

  it('delegates identity lookup and credential deletion to secure storage capabilities', async () => {
    const deleteAepCredentials = vi.fn();
    const findAepIdentity = vi.fn(() => IDENTITY);
    const storage: AepStateStorage = {
      clearAepState: vi.fn(),
      deleteAepCredentials,
      findAepIdentity,
      getAepState: vi.fn(() => null),
      setAepState: vi.fn(),
    };
    const aep = new AepStorage(storage, OWNER);

    expect(await aep.identities().findByServiceDid(IDENTITY.serviceDid)).toEqual(IDENTITY);
    await aep.credentials().deleteCredential(IDENTITY.serviceDid, 'credential-1');
    aep.deleteCredentials(IDENTITY.serviceDid, { grantType: 'api-key' });

    expect(findAepIdentity).toHaveBeenCalledWith(OWNER, IDENTITY.serviceDid);
    expect(deleteAepCredentials).toHaveBeenNthCalledWith(1, OWNER, IDENTITY.serviceDid, {
      credentialId: 'credential-1',
    });
    expect(deleteAepCredentials).toHaveBeenNthCalledWith(2, OWNER, IDENTITY.serviceDid, { grantType: 'api-key' });
  });

  it('deletes fallback credentials by identifier, grant type, and all grant types', () => {
    const state: AepPersistedState = {
      credentials: {
        [IDENTITY.serviceDid]: {
          first: credential('first', 'api-key'),
          second: credential('second', 'oauth-bearer'),
          third: credential('third', 'api-key'),
        },
      },
      identities: {},
      owner: OWNER,
      version: 1,
    };
    const backing = new MemoryStorage();
    backing.setAepState(state);
    const aep = new AepStorage(backing, OWNER);

    aep.deleteCredentials(IDENTITY.serviceDid, { credentialId: 'first' });
    expect(Object.keys(backing.getAepState()?.credentials[IDENTITY.serviceDid] ?? {})).toEqual(['second', 'third']);

    aep.deleteCredentials(IDENTITY.serviceDid, { grantType: 'api-key' });
    expect(Object.keys(backing.getAepState()?.credentials[IDENTITY.serviceDid] ?? {})).toEqual(['second']);

    aep.deleteCredentials(IDENTITY.serviceDid, { allGrantTypes: true });
    expect(backing.getAepState()?.credentials[IDENTITY.serviceDid]).toBeUndefined();
    aep.deleteCredentials('did:web:missing.example', { allGrantTypes: true });
  });
});

function credential(credentialId: string, grantType: string) {
  return {
    credential: { credential_id: credentialId },
    credentialId,
    grantType,
    issuedAt: '2026-01-01T00:00:00.000Z',
    serviceDid: IDENTITY.serviceDid,
  };
}

describe('AEP public document cache', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'inflow-aep-public-cache-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('persists serializable public documents across file-backed storage instances without authentication', async () => {
    const configPath = join(tmpDir, 'config.json');
    const secretStore = new SyncMemorySecretStore();
    const firstStorage = new Storage({ configPath, secretStore });
    const firstCache = createAepPublicDocumentCache(firstStorage);

    await firstCache.set({
      cachedAt: '2026-01-01T00:00:00.000Z',
      namespace: 'openapi',
      url: 'https://service.example/openapi.json',
      value: { openapi: '3.1.0' },
    });

    const secondStorage = new Storage({ configPath, secretStore });
    expect(secondStorage.isAuthenticated()).toBe(false);
    expect(
      createAepPublicDocumentCache(secondStorage).get('openapi', 'https://service.example/openapi.json'),
    ).toMatchObject({
      value: { openapi: '3.1.0' },
    });
  });

  it('separates discovery and OpenAPI records in SQLite public-document storage', () => {
    const storage = new Storage({
      configPath: join(tmpDir, 'inflow.sqlite3'),
      secretStore: new SyncMemorySecretStore(),
    });
    storage.setDiscoveryDocuments([
      {
        cachedAt: '2026-01-01T00:00:00.000Z',
        namespace: 'inspect',
        url: 'https://service.example/.well-known/aep',
        value: { service: true },
      },
    ]);
    storage.setOpenApiDocuments([
      {
        cachedAt: '2026-01-01T00:00:00.000Z',
        namespace: 'openapi',
        url: 'https://service.example/openapi.json',
        value: { openapi: '3.1.0' },
      },
    ]);

    expect(storage.getDiscoveryDocuments()).toHaveLength(1);
    expect(storage.getOpenApiDocuments()).toHaveLength(1);
  });

  it('cleans malformed public records when the cache is read', () => {
    const storage = new MemoryStorage();
    storage.setOpenApiDocuments([
      { cachedAt: 'bad-date', namespace: 'openapi', url: 'https://bad.example/openapi.json', value: {} },
    ]);
    storage.setDiscoveryDocuments([
      {
        cachedAt: '2026-01-01T00:00:00.000Z',
        namespace: 'inspect',
        url: 'https://service.example/.well-known/aep',
        value: { ok: true },
      },
    ]);

    const cache = createAepPublicDocumentCache(storage);
    expect(cache.get('openapi', 'https://bad.example/openapi.json')).toBeUndefined();
    expect(cache.get('inspect', 'https://service.example/.well-known/aep')).toMatchObject({
      value: { ok: true },
    });
    expect(storage.getOpenApiDocuments()).toHaveLength(0);
    expect(storage.getDiscoveryDocuments()).toHaveLength(1);
  });

  it('uses cached Platform Discovery documents through the SDK public API', async () => {
    const cache = createAepPublicDocumentCache(new MemoryStorage());
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(PLATFORM_DISCOVERY), {
        headers: { 'cache-control': 'max-age=300', 'content-type': 'application/aep+json' },
      }),
    );

    const first = await discoverPlatform({ platformUrl: 'https://platform.example.test/', publicDocumentCache: cache });
    const second = await discoverPlatform({
      platformUrl: 'https://platform.example.test/',
      publicDocumentCache: cache,
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(first.freshness).toBe('fetched');
    expect(second.freshness).toBe('fresh');
    expect(String(second.endpointUrl('sign'))).toBe(
      'https://platform.example.test/v1/aep/agent-identities/%7Bagent_identity_id%7D/sign',
    );
  });

  it('preserves stale public documents for SDK conditional revalidation', async () => {
    const cache = createAepPublicDocumentCache(new MemoryStorage());
    const calls: RequestInit[] = [];
    vi.spyOn(globalThis, 'fetch')
      .mockImplementationOnce((_, init) => {
        calls.push(init ?? {});
        return Promise.resolve(
          new Response(JSON.stringify({ value: 1 }), {
            headers: {
              'cache-control': 'max-age=0',
              'content-type': 'application/json',
              etag: '"v1"',
              'last-modified': 'Wed, 01 Jan 2025 00:00:00 GMT',
            },
          }),
        );
      })
      .mockImplementationOnce((_, init) => {
        calls.push(init ?? {});
        return Promise.resolve(
          new Response(null, {
            headers: { 'cache-control': 'max-age=300', etag: '"v1"' },
            status: 304,
          }),
        );
      });
    const fetchDocument = () =>
      fetchAepPublicDocument({
        accept: 'application/json',
        acceptedMediaTypes: ['application/json'],
        cache,
        namespace: 'openapi',
        parse: (value) => value,
        url: 'https://service.example/openapi.json',
      });

    expect((await fetchDocument()).freshness).toBe('fetched');
    expect((await fetchDocument()).freshness).toBe('revalidated');
    expect(new Headers(calls[1]?.headers).get('if-none-match')).toBe('"v1"');
    expect(new Headers(calls[1]?.headers).get('if-modified-since')).toBe('Wed, 01 Jan 2025 00:00:00 GMT');
  });

  it('keeps public documents across logout while clearing authenticated AEP state', async () => {
    const storage = new MemoryStorage({
      access_token: 'a',
      expires_in: 3600,
      refresh_token: 'r',
      token_type: 'Bearer',
    });
    storage.setApiKey('inflow_api_key');
    await createAepPublicDocumentCache(storage).set({
      cachedAt: '2026-01-01T00:00:00.000Z',
      namespace: 'openapi',
      url: 'https://service.example/openapi.json',
      value: { openapi: '3.1.0' },
    });
    const aepStorage = new AepStorage(storage, OWNER);
    await aepStorage.identities().saveIdentity(IDENTITY);

    await runAuthLogout({
      authResource: {
        initiateDeviceAuth: vi.fn(),
        pollDeviceAuth: vi.fn(),
        refreshToken: vi.fn(),
        revokeToken: vi.fn().mockResolvedValue(undefined),
      },
      authStorage: storage,
    });

    expect(storage.getAuth()).toBeNull();
    expect(storage.getApiKey()).toBeNull();
    expect(storage.getAepState()).toBeNull();
    expect(createAepPublicDocumentCache(storage).get('openapi', 'https://service.example/openapi.json')).toMatchObject({
      value: { openapi: '3.1.0' },
    });
  });
});
