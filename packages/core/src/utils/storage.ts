import { Buffer } from 'node:buffer';
import { lstatSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { InflowConfigurationError } from '../errors.js';
import type { AuthTokens } from '../types/index.js';
import type {
  AepCredentialDeleteSelector,
  AepOwner,
  AepPersistedInspectResult,
  AepPersistedState,
  AepStateStorage,
  PublicDocumentStateStorage,
} from '../aep/storage.js';
import type { AepPublicDocumentCacheRecord, AgentServiceIdentity } from '@aep-foundation/agent';
import {
  createOpaqueSecretReference,
  type SecretReference,
  type SyncSecureSecretStore,
} from '../secure-storage/secret-store.js';
import { SyncSecureSecretLifecycleCoordinator } from '../secure-storage/lifecycle.js';
import { SecureSqliteRepository, type StoredPublicDocument } from '../secure-storage/sqlite.js';
import { NoopSyncSecretReferenceManifest, SyncVaultSecretStore } from '../secure-storage/vault-sync-secret-store.js';

export interface PendingDeviceAuth {
  device_code: string;
  interval: number;
  expires_at: number;
  verification_url: string;
  phrase: string;
}

export interface ConnectionSettings {
  environment?: 'production' | 'sandbox';
  apiBaseUrl?: string;
  authBaseUrl?: string;
}

export interface AuthStorage {
  getAuth(): AuthTokens | null;
  setAuth(auth: AuthTokens): void;
  clearAuth(): void;
  isAuthenticated(): boolean;
  getApiKey(): string | null;
  setApiKey(apiKey: string): void;
  clearApiKey(): void;
  getConnection(): ConnectionSettings | null;
  setConnection(settings: ConnectionSettings): void;
  clearConnection(): void;
  getPendingDeviceAuth(): PendingDeviceAuth | null;
  setPendingDeviceAuth(pending: PendingDeviceAuth): void;
  clearPendingDeviceAuth(): void;
  clearAll(): void;
  getPath(): string;
  deleteConfig(): Promise<void>;
}

interface StoredAuth {
  accessToken: SecretReference;
  expiresAt?: number;
  expiresIn: number;
  refreshToken: SecretReference;
  scope?: string;
  tokenType: string;
}

interface StoredSecret {
  secret: SecretReference;
}

interface StoredPendingDeviceAuth {
  deviceCode: SecretReference;
  expiresAt: number;
  interval: number;
  phrase: string;
  verificationUrl: string;
}

interface StoredAepCredentialRecord {
  credentialId: string;
  credentialSecret: SecretReference;
  expiresAt?: string;
  grantType: string;
  issuedAt: string;
  serviceDid: string;
  serviceUrl?: string;
}

interface StoredAepState {
  credentials: Record<string, Record<string, StoredAepCredentialRecord>>;
  identities: AepPersistedState['identities'];
  inspect?: Record<string, AepPersistedInspectResult>;
  owner: AepOwner;
  version: 1;
}

const AEP_STATE_SETTING = 'aep.state';
const API_KEY_SETTING = 'auth.api_key';
const AUTH_SETTING = 'auth.session';
const CONNECTION_SETTING = 'connection';
const PENDING_AUTH_SETTING = 'auth.pending_device';

function defaultLegacyConfigPath(): string {
  return path.join(homedir(), 'Library', 'Preferences', 'inflow', 'config.json');
}

function databasePathFromConfigPath(configPath: string): string {
  const resolved = path.resolve(configPath);
  if (path.extname(resolved) === '.json') {
    return path.join(path.dirname(resolved), `${path.basename(resolved, '.json')}.sqlite3`);
  }
  return resolved;
}

function legacyConfigPathFromConfigPath(configPath: string): string {
  const resolved = path.resolve(configPath);
  if (path.extname(resolved) === '.json') return resolved;
  return `${resolved}.json`;
}

function legacyConfigPathFromOptions(options: StorageOptions): string {
  if (options.configPath !== undefined) {
    return legacyConfigPathFromConfigPath(options.configPath);
  }
  if (options.cwd !== undefined) {
    return path.join(options.cwd, 'config.json');
  }
  return defaultLegacyConfigPath();
}

function deleteLegacyConfigFile(legacyPath: string): void {
  try {
    const stat = lstatSync(legacyPath);
    if (stat.isFile() || stat.isSymbolicLink()) {
      unlinkSync(legacyPath);
    }
  } catch {
    return;
  }
}

function withComputedExpiry(auth: AuthTokens): AuthTokens {
  return {
    ...auth,
    expires_at: auth.expires_at ?? Date.now() + auth.expires_in * 1000,
  };
}

export interface StorageOptions {
  configPath?: string;
  cwd?: string;
  secretStore?: SyncSecureSecretStore;
}

export class Storage implements AuthStorage, AepStateStorage, PublicDocumentStateStorage {
  private initialized = false;
  private readonly lifecycle: SyncSecureSecretLifecycleCoordinator;
  private readonly options: StorageOptions;
  private readonly repository: SecureSqliteRepository;
  private readonly secretStore: SyncSecureSecretStore;

  constructor(options: StorageOptions = {}) {
    this.options = options;
    const databasePath = this.databasePath();
    this.repository = new SecureSqliteRepository(databasePath === undefined ? {} : { databasePath });
    this.secretStore = options.secretStore ?? defaultSecretStore();
    this.lifecycle = new SyncSecureSecretLifecycleCoordinator(
      this.repository,
      this.secretStore,
      new NoopSyncSecretReferenceManifest(),
    );
  }

  getAuth(): AuthTokens | null {
    this.initialize();
    const stored = this.repository.getSetting(AUTH_SETTING)?.payload;
    if (!isStoredAuth(stored)) return null;
    return {
      access_token: readUtf8(this.secretStore, stored.accessToken),
      refresh_token: readUtf8(this.secretStore, stored.refreshToken),
      token_type: stored.tokenType,
      expires_in: stored.expiresIn,
      ...(stored.scope === undefined ? {} : { scope: stored.scope }),
      ...(stored.expiresAt === undefined ? {} : { expires_at: stored.expiresAt }),
    };
  }

  setAuth(auth: AuthTokens): void {
    this.initialize();
    const persisted = withComputedExpiry(auth);
    this.clearAuth();
    const accessToken = createOpaqueSecretReference('auth-access-token');
    const refreshToken = createOpaqueSecretReference('auth-refresh-token');
    this.lifecycle.create(accessToken, utf8(persisted.access_token), null, { setting: AUTH_SETTING });
    this.lifecycle.create(refreshToken, utf8(persisted.refresh_token), null, { setting: AUTH_SETTING });
    try {
      this.repository.upsertSetting(AUTH_SETTING, {
        accessToken,
        refreshToken,
        tokenType: persisted.token_type,
        expiresIn: persisted.expires_in,
        ...(persisted.scope === undefined ? {} : { scope: persisted.scope }),
        ...(persisted.expires_at === undefined ? {} : { expiresAt: persisted.expires_at }),
      } satisfies StoredAuth);
    } catch (cause) {
      this.lifecycle.delete(accessToken);
      this.lifecycle.delete(refreshToken);
      throw cause;
    }
  }

  clearAuth(): void {
    this.initialize();
    const stored = this.repository.getSetting(AUTH_SETTING)?.payload;
    if (isStoredAuth(stored)) {
      this.lifecycle.delete(stored.accessToken);
      this.lifecycle.delete(stored.refreshToken);
    }
    this.repository.deleteSetting(AUTH_SETTING);
  }

  isAuthenticated(): boolean {
    this.initialize();
    return (
      isStoredAuth(this.repository.getSetting(AUTH_SETTING)?.payload) ||
      isStoredSecret(this.repository.getSetting(API_KEY_SETTING)?.payload)
    );
  }

  getApiKey(): string | null {
    this.initialize();
    const stored = this.repository.getSetting(API_KEY_SETTING)?.payload;
    if (!isStoredSecret(stored)) return null;
    return readUtf8(this.secretStore, stored.secret);
  }

  setApiKey(apiKey: string): void {
    if (apiKey.length === 0) {
      throw new InflowConfigurationError('Storage.setApiKey: api key must be a non-empty string.');
    }
    this.initialize();
    this.clearApiKey();
    const secret = createOpaqueSecretReference('api-key');
    this.lifecycle.create(secret, utf8(apiKey), null, { setting: API_KEY_SETTING });
    try {
      this.repository.upsertSetting(API_KEY_SETTING, { secret } satisfies StoredSecret);
    } catch (cause) {
      this.lifecycle.delete(secret);
      throw cause;
    }
  }

  clearApiKey(): void {
    this.initialize();
    const stored = this.repository.getSetting(API_KEY_SETTING)?.payload;
    if (isStoredSecret(stored)) {
      this.lifecycle.delete(stored.secret);
    }
    this.repository.deleteSetting(API_KEY_SETTING);
  }

  getConnection(): ConnectionSettings | null {
    this.initialize();
    const stored = this.repository.getSetting(CONNECTION_SETTING)?.payload;
    return isConnectionSettings(stored) ? stored : null;
  }

  setConnection(settings: ConnectionSettings): void {
    this.initialize();
    this.repository.upsertSetting(CONNECTION_SETTING, settings);
  }

  clearConnection(): void {
    this.initialize();
    this.repository.deleteSetting(CONNECTION_SETTING);
  }

  getPendingDeviceAuth(): PendingDeviceAuth | null {
    this.initialize();
    const stored = this.repository.getSetting(PENDING_AUTH_SETTING)?.payload;
    if (!isStoredPendingDeviceAuth(stored)) return null;
    if (Date.now() >= stored.expiresAt) {
      this.clearPendingDeviceAuth();
      return null;
    }
    return {
      device_code: readUtf8(this.secretStore, stored.deviceCode),
      interval: stored.interval,
      expires_at: stored.expiresAt,
      verification_url: stored.verificationUrl,
      phrase: stored.phrase,
    };
  }

  setPendingDeviceAuth(pending: PendingDeviceAuth): void {
    this.initialize();
    this.clearPendingDeviceAuth();
    const deviceCode = createOpaqueSecretReference('pending-device-code');
    this.lifecycle.create(deviceCode, utf8(pending.device_code), null, { setting: PENDING_AUTH_SETTING });
    try {
      this.repository.upsertSetting(PENDING_AUTH_SETTING, {
        deviceCode,
        interval: pending.interval,
        expiresAt: pending.expires_at,
        verificationUrl: pending.verification_url,
        phrase: pending.phrase,
      } satisfies StoredPendingDeviceAuth);
    } catch (cause) {
      this.lifecycle.delete(deviceCode);
      throw cause;
    }
  }

  clearPendingDeviceAuth(): void {
    this.initialize();
    const stored = this.repository.getSetting(PENDING_AUTH_SETTING)?.payload;
    if (isStoredPendingDeviceAuth(stored)) {
      this.lifecycle.delete(stored.deviceCode);
    }
    this.repository.deleteSetting(PENDING_AUTH_SETTING);
  }

  clearAll(): void {
    this.clearAuth();
    this.clearApiKey();
    this.clearPendingDeviceAuth();
    this.clearConnection();
    this.clearAepState();
  }

  clearAepState(): void {
    this.initialize();
    const stored = this.repository.getSetting(AEP_STATE_SETTING)?.payload;
    if (isStoredAepState(stored)) {
      for (const serviceRecords of Object.values(stored.credentials)) {
        for (const record of Object.values(serviceRecords)) {
          this.lifecycle.delete(record.credentialSecret);
        }
      }
    }
    this.repository.deleteSetting(AEP_STATE_SETTING);
  }

  deleteAepCredentials(owner: AepOwner, serviceDid: string, selector: AepCredentialDeleteSelector): void {
    this.initialize();
    const stored = this.repository.getSetting(AEP_STATE_SETTING)?.payload;
    if (!isStoredAepState(stored)) return;
    if (!sameAepOwner(stored.owner, owner)) {
      this.clearAepState();
      return;
    }
    const records = stored.credentials[serviceDid];
    if (records === undefined) return;
    for (const [credentialId, record] of Object.entries(records)) {
      if (matchesStoredAepCredential(record, selector)) {
        this.lifecycle.delete(record.credentialSecret);
        delete records[credentialId];
      }
    }
    if (Object.keys(records).length === 0) {
      delete stored.credentials[serviceDid];
    }
    this.repository.upsertSetting(AEP_STATE_SETTING, stored);
  }

  findAepIdentity(owner: AepOwner, serviceDid: string): AgentServiceIdentity | undefined {
    this.initialize();
    const stored = this.repository.getSetting(AEP_STATE_SETTING)?.payload;
    if (!isStoredAepState(stored)) return undefined;
    if (!sameAepOwner(stored.owner, owner)) {
      this.clearAepState();
      return undefined;
    }
    const identity = stored.identities[serviceDid];
    return identity === undefined ? undefined : structuredClone(identity);
  }

  getAepState(): AepPersistedState | null {
    this.initialize();
    const stored = this.repository.getSetting(AEP_STATE_SETTING)?.payload;
    if (!isStoredAepState(stored)) return null;
    const credentials: AepPersistedState['credentials'] = {};
    for (const [serviceDid, serviceRecords] of Object.entries(stored.credentials)) {
      const byCredentialId: AepPersistedState['credentials'][string] = {};
      for (const [credentialId, record] of Object.entries(serviceRecords)) {
        byCredentialId[credentialId] = {
          credential: parseCredentialSecret(readUtf8(this.secretStore, record.credentialSecret)),
          credentialId: record.credentialId,
          grantType: record.grantType,
          issuedAt: record.issuedAt,
          serviceDid: record.serviceDid,
          ...(record.expiresAt === undefined ? {} : { expiresAt: record.expiresAt }),
          ...(record.serviceUrl === undefined ? {} : { serviceUrl: record.serviceUrl }),
        };
      }
      credentials[serviceDid] = byCredentialId;
    }
    return {
      credentials,
      identities: structuredClone(stored.identities),
      owner: structuredClone(stored.owner),
      version: 1,
      ...(stored.inspect === undefined ? {} : { inspect: structuredClone(stored.inspect) }),
    };
  }

  setAepState(state: AepPersistedState): void {
    this.initialize();
    this.clearAepState();
    const created: SecretReference[] = [];
    const credentials: StoredAepState['credentials'] = {};
    try {
      for (const [serviceDid, serviceRecords] of Object.entries(state.credentials)) {
        const byCredentialId: Record<string, StoredAepCredentialRecord> = {};
        for (const [credentialId, record] of Object.entries(serviceRecords)) {
          const credentialSecret = createOpaqueSecretReference('aep-credential');
          this.lifecycle.create(credentialSecret, utf8(JSON.stringify(record.credential)), null, {
            credentialId,
            serviceDid,
          });
          created.push(credentialSecret);
          byCredentialId[credentialId] = {
            credentialSecret,
            credentialId: record.credentialId,
            grantType: record.grantType,
            issuedAt: record.issuedAt,
            serviceDid: record.serviceDid,
            ...(record.expiresAt === undefined ? {} : { expiresAt: record.expiresAt }),
            ...(record.serviceUrl === undefined ? {} : { serviceUrl: record.serviceUrl }),
          };
        }
        credentials[serviceDid] = byCredentialId;
      }
      this.repository.upsertSetting(AEP_STATE_SETTING, {
        credentials,
        identities: structuredClone(state.identities),
        owner: structuredClone(state.owner),
        version: 1,
        ...(state.inspect === undefined ? {} : { inspect: structuredClone(state.inspect) }),
      } satisfies StoredAepState);
    } catch (cause) {
      for (const reference of created) {
        this.lifecycle.delete(reference);
      }
      throw cause;
    }
  }

  getDiscoveryDocuments(): AepPublicDocumentCacheRecord[] {
    this.initialize();
    return this.repository
      .listPublicDocuments('inspect')
      .concat(this.repository.listPublicDocuments('platform-discovery'))
      .map(publicDocumentToCacheRecord);
  }

  setDiscoveryDocuments(records: AepPublicDocumentCacheRecord[]): void {
    this.initialize();
    this.replacePublicDocuments(['inspect', 'platform-discovery'], records);
  }

  getOpenApiDocuments(): AepPublicDocumentCacheRecord[] {
    this.initialize();
    return this.repository.listPublicDocuments('openapi').map(publicDocumentToCacheRecord);
  }

  setOpenApiDocuments(records: AepPublicDocumentCacheRecord[]): void {
    this.initialize();
    this.replacePublicDocuments(['openapi'], records);
  }

  getPath(): string {
    return (
      this.databasePath() ??
      path.join(process.env['HOME'] ?? '', 'Library', 'Application Support', 'InFlow', 'inflow.sqlite3')
    );
  }

  deleteConfig(): Promise<void> {
    this.clearAll();
    deleteLegacyConfigFile(legacyConfigPathFromOptions(this.options));
    return Promise.resolve();
  }

  private databasePath(): string | undefined {
    if (this.options.configPath !== undefined) {
      return databasePathFromConfigPath(this.options.configPath);
    }
    if (this.options.cwd !== undefined) {
      return path.join(this.options.cwd, 'inflow.sqlite3');
    }
    return undefined;
  }

  private initialize(): void {
    if (this.initialized) return;
    this.repository.initialize();
    this.lifecycle.recoverInterruptedWork();
    deleteLegacyConfigFile(legacyConfigPathFromOptions(this.options));
    this.initialized = true;
  }

  private replacePublicDocuments(
    namespaces: StoredPublicDocument['namespace'][],
    records: AepPublicDocumentCacheRecord[],
  ): void {
    this.repository.writeTransactionSync(() => {
      for (const namespace of namespaces) {
        for (const record of this.repository.listPublicDocuments(namespace)) {
          this.repository.deletePublicDocument(namespace, record.url);
        }
      }
      for (const record of records) {
        if (namespaces.includes(record.namespace)) {
          this.repository.upsertPublicDocument(cacheRecordToPublicDocument(record));
        }
      }
    });
  }
}

export class MemoryStorage implements AuthStorage, AepStateStorage, PublicDocumentStateStorage {
  private aep: AepPersistedState | null = null;
  private discoveryDocuments: AepPublicDocumentCacheRecord[] = [];
  private openApiDocuments: AepPublicDocumentCacheRecord[] = [];
  private auth: AuthTokens | null;
  private apiKey: string | null = null;
  private pendingAuth: PendingDeviceAuth | null = null;
  private connection: ConnectionSettings | null = null;

  constructor(initialAuth: AuthTokens | null = null) {
    this.auth = initialAuth ? withComputedExpiry(initialAuth) : null;
  }

  getAuth(): AuthTokens | null {
    return this.auth;
  }

  setAuth(auth: AuthTokens): void {
    this.auth = withComputedExpiry(auth);
  }

  clearAuth(): void {
    this.auth = null;
  }

  isAuthenticated(): boolean {
    return this.auth !== null || this.apiKey !== null;
  }

  getApiKey(): string | null {
    return this.apiKey;
  }

  setApiKey(apiKey: string): void {
    if (apiKey.length === 0) {
      throw new InflowConfigurationError('MemoryStorage.setApiKey: api key must be a non-empty string.');
    }
    this.apiKey = apiKey;
  }

  clearApiKey(): void {
    this.apiKey = null;
  }

  getConnection(): ConnectionSettings | null {
    return this.connection;
  }

  setConnection(settings: ConnectionSettings): void {
    this.connection = settings;
  }

  clearConnection(): void {
    this.connection = null;
  }

  getPendingDeviceAuth(): PendingDeviceAuth | null {
    if (!this.pendingAuth) return null;
    if (Date.now() >= this.pendingAuth.expires_at) {
      this.pendingAuth = null;
      return null;
    }
    return this.pendingAuth;
  }

  setPendingDeviceAuth(pending: PendingDeviceAuth): void {
    this.pendingAuth = pending;
  }

  clearPendingDeviceAuth(): void {
    this.pendingAuth = null;
  }

  clearAll(): void {
    this.aep = null;
    this.discoveryDocuments = [];
    this.openApiDocuments = [];
    this.auth = null;
    this.apiKey = null;
    this.pendingAuth = null;
    this.connection = null;
  }

  clearAepState(): void {
    this.aep = null;
  }

  getAepState(): AepPersistedState | null {
    return this.aep === null ? null : structuredClone(this.aep);
  }

  setAepState(state: AepPersistedState): void {
    this.aep = structuredClone(state);
  }

  getDiscoveryDocuments(): AepPublicDocumentCacheRecord[] {
    return structuredClone(this.discoveryDocuments);
  }

  setDiscoveryDocuments(records: AepPublicDocumentCacheRecord[]): void {
    this.discoveryDocuments = structuredClone(records);
  }

  getOpenApiDocuments(): AepPublicDocumentCacheRecord[] {
    return structuredClone(this.openApiDocuments);
  }

  setOpenApiDocuments(records: AepPublicDocumentCacheRecord[]): void {
    this.openApiDocuments = structuredClone(records);
  }

  getPath(): string {
    return 'memory';
  }

  async deleteConfig(): Promise<void> {
    return Promise.resolve();
  }
}

function utf8(value: string): Uint8Array {
  return Buffer.from(value, 'utf8');
}

function readUtf8(store: SyncSecureSecretStore, reference: SecretReference): string {
  return Buffer.from(store.read(reference)).toString('utf8');
}

function defaultSecretStore(): SyncSecureSecretStore {
  return new SyncVaultSecretStore();
}

function publicDocumentToCacheRecord(record: StoredPublicDocument): AepPublicDocumentCacheRecord {
  return {
    cachedAt: record.cachedAt,
    namespace: record.namespace,
    url: record.url,
    value: structuredClone(record.payload),
    ...(record.cacheControl === undefined ? {} : { cacheControl: record.cacheControl }),
    ...(record.etag === undefined ? {} : { etag: record.etag }),
    ...(record.finalUrl === undefined ? {} : { finalUrl: record.finalUrl }),
    ...(record.lastModified === undefined ? {} : { lastModified: record.lastModified }),
  };
}

function cacheRecordToPublicDocument(record: AepPublicDocumentCacheRecord): StoredPublicDocument {
  return {
    cachedAt: record.cachedAt,
    namespace: record.namespace,
    payload: structuredClone(record.value),
    url: record.url,
    ...(record.cacheControl === undefined ? {} : { cacheControl: record.cacheControl }),
    ...(record.etag === undefined ? {} : { etag: record.etag }),
    ...(record.finalUrl === undefined ? {} : { finalUrl: record.finalUrl }),
    ...(record.lastModified === undefined ? {} : { lastModified: record.lastModified }),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseCredentialSecret(value: string): Record<string, unknown> {
  const parsed = JSON.parse(value) as unknown;
  if (!isRecord(parsed)) {
    throw new InflowConfigurationError('Stored AEP credential payload is malformed.');
  }
  return parsed;
}

function isSecretReference(value: unknown): value is SecretReference {
  return isRecord(value) && typeof value['purpose'] === 'string' && typeof value['reference'] === 'string';
}

function isStoredSecret(value: unknown): value is StoredSecret {
  return isRecord(value) && isSecretReference(value['secret']);
}

function isStoredAuth(value: unknown): value is StoredAuth {
  return (
    isRecord(value) &&
    isSecretReference(value['accessToken']) &&
    isSecretReference(value['refreshToken']) &&
    typeof value['tokenType'] === 'string' &&
    typeof value['expiresIn'] === 'number' &&
    (value['scope'] === undefined || typeof value['scope'] === 'string') &&
    (value['expiresAt'] === undefined || typeof value['expiresAt'] === 'number')
  );
}

function isConnectionSettings(value: unknown): value is ConnectionSettings {
  return (
    isRecord(value) &&
    (value['environment'] === undefined ||
      value['environment'] === 'production' ||
      value['environment'] === 'sandbox') &&
    (value['apiBaseUrl'] === undefined || typeof value['apiBaseUrl'] === 'string') &&
    (value['authBaseUrl'] === undefined || typeof value['authBaseUrl'] === 'string')
  );
}

function isStoredPendingDeviceAuth(value: unknown): value is StoredPendingDeviceAuth {
  return (
    isRecord(value) &&
    isSecretReference(value['deviceCode']) &&
    typeof value['interval'] === 'number' &&
    typeof value['expiresAt'] === 'number' &&
    typeof value['verificationUrl'] === 'string' &&
    typeof value['phrase'] === 'string'
  );
}

function isAepOwner(value: unknown): value is AepOwner {
  return isRecord(value) && typeof value['platformOrigin'] === 'string' && typeof value['userId'] === 'string';
}

function isStoredAepCredentialRecord(value: unknown): value is StoredAepCredentialRecord {
  return (
    isRecord(value) &&
    isSecretReference(value['credentialSecret']) &&
    typeof value['credentialId'] === 'string' &&
    typeof value['grantType'] === 'string' &&
    typeof value['issuedAt'] === 'string' &&
    typeof value['serviceDid'] === 'string' &&
    (value['expiresAt'] === undefined || typeof value['expiresAt'] === 'string') &&
    (value['serviceUrl'] === undefined || typeof value['serviceUrl'] === 'string')
  );
}

function isStoredAepState(value: unknown): value is StoredAepState {
  if (!isRecord(value) || value['version'] !== 1 || !isAepOwner(value['owner']) || !isRecord(value['credentials'])) {
    return false;
  }
  for (const serviceRecords of Object.values(value['credentials'])) {
    if (!isRecord(serviceRecords)) return false;
    for (const record of Object.values(serviceRecords)) {
      if (!isStoredAepCredentialRecord(record)) return false;
    }
  }
  return isRecord(value['identities']);
}

function sameAepOwner(left: AepOwner, right: AepOwner): boolean {
  return left.platformOrigin === right.platformOrigin && left.userId === right.userId;
}

function matchesStoredAepCredential(record: StoredAepCredentialRecord, selector: AepCredentialDeleteSelector): boolean {
  return (
    'allGrantTypes' in selector ||
    ('credentialId' in selector && record.credentialId === selector.credentialId) ||
    ('grantType' in selector && record.grantType === selector.grantType)
  );
}

export const storage = new Storage();
