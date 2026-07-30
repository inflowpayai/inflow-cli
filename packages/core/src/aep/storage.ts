import type {
  AgentCredentialRecord,
  AgentCredentialStore,
  AgentIdentityStore,
  AgentInspectCache,
  AgentServiceIdentity,
  CachedInspectServiceResult,
  AepPublicDocumentCache,
  AepPublicDocumentCacheRecord,
} from '@aep-foundation/agent';

export interface AepPersistedInspectResult {
  cacheControl?: string;
  cachedAt: string;
  document: CachedInspectServiceResult['document'];
  etag?: string;
  finalUrl?: string;
  inspectUrl: string;
  lastModified?: string;
}

export interface AepOwner {
  platformOrigin: string;
  userId: string;
}

export interface AepPersistedState {
  credentials: Record<string, Record<string, AgentCredentialRecord>>;
  identities: Record<string, AgentServiceIdentity>;
  inspect?: Record<string, AepPersistedInspectResult>;
  owner: AepOwner;
  version: 1;
}

export interface AepStateStorage {
  clearAepState(): void;
  getAepState(): AepPersistedState | null;
  setAepState(state: AepPersistedState): void;
}

export interface PublicDocumentStateStorage {
  getDiscoveryDocuments(): AepPublicDocumentCacheRecord[];
  setDiscoveryDocuments(records: AepPublicDocumentCacheRecord[]): void;
  getOpenApiDocuments(): AepPublicDocumentCacheRecord[];
  setOpenApiDocuments(records: AepPublicDocumentCacheRecord[]): void;
}

export function createAepPublicDocumentCache(storage: PublicDocumentStateStorage): AepPublicDocumentCache {
  const records = (namespace: AepPublicDocumentCacheRecord['namespace']): AepPublicDocumentCacheRecord[] => {
    const persisted = namespace === 'openapi' ? storage.getOpenApiDocuments() : storage.getDiscoveryDocuments();
    const valid = persisted.filter(validPublicDocumentRecord);
    if (valid.length !== persisted.length) replace(namespace, valid);
    return valid;
  };
  const replace = (
    namespace: AepPublicDocumentCacheRecord['namespace'],
    next: AepPublicDocumentCacheRecord[],
  ): void => {
    if (namespace === 'openapi') storage.setOpenApiDocuments(next);
    else storage.setDiscoveryDocuments(next);
  };
  return {
    delete: (namespace, url) =>
      replace(
        namespace,
        records(namespace).filter((record) => record.url !== url),
      ),
    get: (namespace, url) => {
      const record = records(namespace).find((candidate) => candidate.namespace === namespace && candidate.url === url);
      return record === undefined ? undefined : structuredClone(record);
    },
    set: (record) => {
      if (!validPublicDocumentRecord(record)) return;
      const prior = records(record.namespace).filter((candidate) => candidate.url !== record.url);
      replace(record.namespace, [...prior, structuredClone(record)]);
    },
  };
}

function validPublicDocumentRecord(record: unknown): record is AepPublicDocumentCacheRecord {
  if (typeof record !== 'object' || record === null) return false;
  const candidate = record as Partial<AepPublicDocumentCacheRecord>;
  return (
    (candidate.namespace === 'inspect' ||
      candidate.namespace === 'platform-discovery' ||
      candidate.namespace === 'openapi') &&
    typeof candidate.url === 'string' &&
    candidate.url.length > 0 &&
    typeof candidate.cachedAt === 'string' &&
    !Number.isNaN(Date.parse(candidate.cachedAt)) &&
    (candidate.finalUrl === undefined || typeof candidate.finalUrl === 'string') &&
    (candidate.cacheControl === undefined || typeof candidate.cacheControl === 'string') &&
    (candidate.etag === undefined || typeof candidate.etag === 'string') &&
    (candidate.lastModified === undefined || typeof candidate.lastModified === 'string')
  );
}

export class AepStorage {
  constructor(
    private readonly storage: AepStateStorage,
    private readonly owner: AepOwner,
  ) {}

  credentials(): AgentCredentialStore {
    return {
      deleteCredential: (serviceDid, credentialId) => {
        const state = this.state();
        this.purge(state);
        delete state.credentials[serviceDid]?.[credentialId];
        this.save(state);
      },
      findCredential: (serviceDid, credentialId) => {
        const state = this.state();
        this.purge(state);
        this.save(state);
        const record = state.credentials[serviceDid]?.[credentialId];
        return record === undefined ? undefined : structuredClone(record);
      },
      findUsableCredential: (serviceDid, now = new Date()) => {
        const state = this.state();
        this.purge(state, now);
        this.save(state);
        const records = Object.values(state.credentials[serviceDid] ?? {}).sort(
          (left, right) =>
            right.issuedAt.localeCompare(left.issuedAt) || right.credentialId.localeCompare(left.credentialId),
        );
        const record = records.find((candidate) => !expired(candidate, now));
        return record === undefined ? undefined : structuredClone(record);
      },
      listCredentials: (serviceDid) => {
        const state = this.state();
        this.purge(state);
        this.save(state);
        return Object.values(state.credentials[serviceDid] ?? {}).map((record) => structuredClone(record));
      },
      saveCredential: (record) => {
        const state = this.state();
        this.purge(state);
        const byId = (state.credentials[record.serviceDid] ??= {});
        byId[record.credentialId] = structuredClone(record);
        this.save(state);
        return structuredClone(record);
      },
    };
  }

  identities(): AgentIdentityStore {
    return {
      findByServiceDid: (serviceDid) => {
        const identity = this.state().identities[serviceDid];
        return identity === undefined ? undefined : structuredClone(identity);
      },
      saveIdentity: (identity) => {
        if (identity.serviceDid.length === 0) {
          throw new TypeError('AEP identities require a Service DID.');
        }
        const state = this.state();
        state.identities[identity.serviceDid] = structuredClone(identity);
        this.save(state);
        return structuredClone(identity);
      },
    };
  }

  inspectCache(): AgentInspectCache {
    return {
      delete: (serviceUrl) => {
        const state = this.state();
        delete state.inspect?.[serviceUrl];
        this.save(state);
      },
      get: (serviceUrl) => {
        const persisted = this.state().inspect?.[serviceUrl];
        if (persisted === undefined) return undefined;
        try {
          const document = structuredClone(persisted.document);
          const inspectUrl = new URL(persisted.inspectUrl);
          return {
            cachedAt: persisted.cachedAt,
            document,
            inspectUrl,
            commandUrl: (command) => {
              const base = document.http.endpoint_base.endsWith('/')
                ? document.http.endpoint_base
                : `${document.http.endpoint_base}/`;
              return new URL(`${base}${command}`, serviceUrl);
            },
            ...(persisted.cacheControl === undefined ? {} : { cacheControl: persisted.cacheControl }),
            ...(persisted.etag === undefined ? {} : { etag: persisted.etag }),
            ...(persisted.finalUrl === undefined ? {} : { finalUrl: new URL(persisted.finalUrl) }),
            ...(persisted.lastModified === undefined ? {} : { lastModified: persisted.lastModified }),
          };
        } catch {
          const state = this.state();
          delete state.inspect?.[serviceUrl];
          this.save(state);
          return undefined;
        }
      },
      set: (serviceUrl, result) => {
        const state = this.state();
        const inspect = (state.inspect ??= {});
        inspect[serviceUrl] = {
          cachedAt: result.cachedAt,
          document: structuredClone(result.document),
          inspectUrl: String(result.inspectUrl),
          ...(result.cacheControl === undefined ? {} : { cacheControl: result.cacheControl }),
          ...(result.etag === undefined ? {} : { etag: result.etag }),
          ...(result.finalUrl === undefined ? {} : { finalUrl: String(result.finalUrl) }),
          ...(result.lastModified === undefined ? {} : { lastModified: result.lastModified }),
        };
        this.save(state);
      },
    };
  }

  private purge(state: AepPersistedState, now = new Date()): void {
    for (const [serviceDid, records] of Object.entries(state.credentials)) {
      for (const [credentialId, record] of Object.entries(records)) {
        if (expired(record, now)) {
          delete records[credentialId];
        }
      }
      if (Object.keys(records).length === 0) {
        delete state.credentials[serviceDid];
      }
    }
  }

  private save(state: AepPersistedState): void {
    this.storage.setAepState(state);
  }

  private state(): AepPersistedState {
    const state = this.storage.getAepState();
    if (state === null) {
      const created: AepPersistedState = {
        credentials: {},
        identities: {},
        inspect: {},
        owner: structuredClone(this.owner),
        version: 1,
      };
      this.save(created);
      return created;
    }
    if (state.owner.platformOrigin !== this.owner.platformOrigin || state.owner.userId !== this.owner.userId) {
      this.storage.clearAepState();
      const created: AepPersistedState = {
        credentials: {},
        identities: {},
        inspect: {},
        owner: structuredClone(this.owner),
        version: 1,
      };
      this.save(created);
      return created;
    }
    return structuredClone(state);
  }
}

function expired(record: AgentCredentialRecord, now: Date): boolean {
  if (record.expiresAt === undefined) {
    return false;
  }
  const expiry = Date.parse(record.expiresAt);
  return Number.isNaN(expiry) || expiry <= now.getTime();
}
