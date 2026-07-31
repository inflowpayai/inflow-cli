import { chmodSync, closeSync, constants, existsSync, lstatSync, mkdirSync, openSync, realpathSync } from 'node:fs';
import { access, chmod, copyFile, mkdir, stat } from 'node:fs/promises';
import { userInfo } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { SecureStorageError } from './errors.js';
import { runtimeRequire } from './runtime-require.js';
import type { SecretReference } from './secret-store.js';
import { defaultVaultRoot } from './vault-files.js';
import {
  vaultRecordStatusCode,
  vaultRecordStatusName,
  vaultSecretKindCode,
  vaultSecretKindName,
  type VaultRecordStatus,
  type VaultSecretKind,
} from './vault-types.js';

const require = runtimeRequire();

type SQLiteValue = Uint8Array | bigint | number | string | null;
type SQLiteRow = Record<string, SQLiteValue>;

interface SQLiteStatement {
  all(...values: SQLiteValue[]): SQLiteRow[];
  get(...values: SQLiteValue[]): SQLiteRow | undefined;
  run(...values: SQLiteValue[]): unknown;
}

interface SQLiteDatabase {
  close(): void;
  exec(sql: string): void;
  prepare(sql: string): SQLiteStatement;
}

interface SQLiteModule {
  DatabaseSync: new (filename: string) => SQLiteDatabase;
}

export type SecretLifecycleState = 'active' | 'deleting' | 'pending';

export interface SecureSqliteRepositoryOptions {
  databasePath?: string;
  loadSqlite?: () => SQLiteModule;
  rootDir?: string;
}

export interface JsonPayloadRecord<T> {
  payload: T;
  payloadVersion: number;
}

export interface StoredPrincipal {
  id: number;
  platformOrigin: string;
  userId: string;
}

export interface StoredPublicDocument {
  cacheControl?: string;
  cachedAt: string;
  etag?: string;
  finalUrl?: string;
  lastModified?: string;
  namespace: 'inspect' | 'openapi' | 'platform-discovery';
  payload: unknown;
  url: string;
}

export interface StoredVaultRecord {
  ciphertext: Uint8Array;
  encryptionVersion: number;
  expiresAt?: string;
  kind: VaultSecretKind;
  nonce: Uint8Array;
  reference: string;
  status: VaultRecordStatus;
  tag: Uint8Array;
  updatedAt: string;
}

const APPLICATION_DIRECTORY_MODE = 0o700;
const DATABASE_FILE_MODE = 0o600;
const SCHEMA_VERSION = 1;
const STICKY_BIT_MODE = 0o1000;

function defaultDatabasePath(): string {
  return path.join(defaultVaultRoot(), 'inflow.sqlite3');
}

function loadDefaultSqlite(): SQLiteModule {
  return require('node:sqlite') as SQLiteModule;
}

function jsonBytes(value: unknown): Uint8Array {
  return Buffer.from(JSON.stringify(value), 'utf8');
}

function parsePayload(value: SQLiteValue): unknown {
  if (!(value instanceof Uint8Array)) {
    throw new SecureStorageError('secure_storage_corrupt', 'SQLite payload is not a byte array.');
  }
  return JSON.parse(Buffer.from(value).toString('utf8')) as unknown;
}

function valueColumn(row: SQLiteRow, name: string): SQLiteValue {
  const value = row[name];
  if (value === undefined) {
    throw new SecureStorageError('secure_storage_corrupt', `SQLite column ${name} is missing.`);
  }
  return value;
}

function stringColumn(row: SQLiteRow, name: string): string {
  const value = row[name];
  if (typeof value !== 'string') {
    throw new SecureStorageError('secure_storage_corrupt', `SQLite column ${name} is malformed.`);
  }
  return value;
}

function optionalStringColumn(row: SQLiteRow, name: string): string | undefined {
  const value = row[name];
  if (value === null || value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw new SecureStorageError('secure_storage_corrupt', `SQLite column ${name} is malformed.`);
  }
  return value;
}

function numberColumn(row: SQLiteRow, name: string): number {
  const value = row[name];
  if (typeof value !== 'number') {
    throw new SecureStorageError('secure_storage_corrupt', `SQLite column ${name} is malformed.`);
  }
  return value;
}

function bytesColumn(row: SQLiteRow, name: string): Uint8Array {
  const value = row[name];
  if (!(value instanceof Uint8Array)) {
    throw new SecureStorageError('secure_storage_corrupt', `SQLite column ${name} is malformed.`);
  }
  return value;
}

function ensureDatabasePath(databasePath: string): void {
  const parent = path.dirname(databasePath);
  mkdirSync(parent, { mode: APPLICATION_DIRECTORY_MODE, recursive: true });
  const realParent = realpathSync(parent);
  const parentStat = lstatSync(realParent);
  if (!parentStat.isDirectory()) {
    throw new SecureStorageError('secure_storage_invalid_path', 'The InFlow application data directory is invalid.');
  }
  if (process.platform === 'win32') {
    assertCanonicalWindowsPath(parent, realParent);
  } else {
    const currentUid = userInfo().uid;
    if (parentStat.uid !== currentUid && (parentStat.mode & STICKY_BIT_MODE) !== STICKY_BIT_MODE) {
      throw new SecureStorageError(
        'secure_storage_invalid_path',
        'The InFlow application data directory is not owned by this user.',
      );
    }
    if (parentStat.uid === currentUid) {
      chmodSync(realParent, APPLICATION_DIRECTORY_MODE);
    }
  }

  if (!existsSync(databasePath)) {
    closeSync(openSync(databasePath, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR, DATABASE_FILE_MODE));
  }
  const dbStat = lstatSync(databasePath);
  if (dbStat.isSymbolicLink() || !dbStat.isFile()) {
    throw new SecureStorageError('secure_storage_invalid_path', 'The InFlow SQLite database path is invalid.');
  }
  if (process.platform === 'win32') {
    assertCanonicalWindowsPath(databasePath, realpathSync(databasePath));
    return;
  }
  const currentUid = userInfo().uid;
  if (dbStat.uid !== currentUid) {
    throw new SecureStorageError(
      'secure_storage_invalid_path',
      'The InFlow SQLite database is not owned by this user.',
    );
  }
  chmodSync(databasePath, DATABASE_FILE_MODE);
}

function assertCanonicalWindowsPath(requestedPath: string, realPath: string): void {
  if (path.resolve(requestedPath).toLowerCase() !== path.resolve(realPath).toLowerCase()) {
    throw new SecureStorageError('secure_storage_invalid_path', 'The InFlow SQLite path is invalid.');
  }
}

export class SecureSqliteRepository {
  private database: SQLiteDatabase | undefined;
  private inTransaction = false;
  private readonly databasePath: string;
  private readonly loadSqlite: () => SQLiteModule;

  constructor(options: SecureSqliteRepositoryOptions = {}) {
    this.databasePath =
      options.databasePath ?? path.join(options.rootDir ?? path.dirname(defaultDatabasePath()), 'inflow.sqlite3');
    this.loadSqlite = options.loadSqlite ?? loadDefaultSqlite;
  }

  close(): void {
    this.database?.close();
    this.database = undefined;
  }

  initialize(): void {
    ensureDatabasePath(this.databasePath);
    try {
      const db = this.db();
      db.exec(`
        PRAGMA foreign_keys = ON;
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = FULL;
        PRAGMA trusted_schema = OFF;
        PRAGMA secure_delete = ON;
        PRAGMA busy_timeout = 5000;
      `);
      db.exec(`
        CREATE TABLE IF NOT EXISTS schema_metadata (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS principals (
          id INTEGER PRIMARY KEY,
          platform_origin TEXT NOT NULL,
          user_id TEXT NOT NULL,
          payload_version INTEGER NOT NULL,
          payload BLOB NOT NULL,
          UNIQUE(platform_origin, user_id)
        );
        CREATE TABLE IF NOT EXISTS connection_profiles (
          id INTEGER PRIMARY KEY,
          environment TEXT NOT NULL UNIQUE,
          payload_version INTEGER NOT NULL,
          payload BLOB NOT NULL
        );
        CREATE TABLE IF NOT EXISTS auth_sessions (
          id INTEGER PRIMARY KEY,
          profile_id INTEGER NOT NULL REFERENCES connection_profiles(id) ON DELETE CASCADE,
          principal_id INTEGER NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
          auth_method TEXT NOT NULL,
          expires_at TEXT,
          access_secret_purpose TEXT,
          access_secret_reference TEXT,
          refresh_secret_purpose TEXT,
          refresh_secret_reference TEXT,
          payload_version INTEGER NOT NULL,
          payload BLOB NOT NULL
        );
        CREATE TABLE IF NOT EXISTS pending_auth (
          id INTEGER PRIMARY KEY,
          profile_id INTEGER NOT NULL REFERENCES connection_profiles(id) ON DELETE CASCADE,
          expires_at TEXT NOT NULL,
          device_secret_purpose TEXT NOT NULL,
          device_secret_reference TEXT NOT NULL,
          payload_version INTEGER NOT NULL,
          payload BLOB NOT NULL
        );
        CREATE TABLE IF NOT EXISTS aep_identities (
          id INTEGER PRIMARY KEY,
          principal_id INTEGER NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
          service_did TEXT NOT NULL,
          agent_did TEXT NOT NULL,
          identity_kind TEXT NOT NULL,
          payload_version INTEGER NOT NULL,
          payload BLOB NOT NULL,
          UNIQUE(principal_id, service_did)
        );
        CREATE TABLE IF NOT EXISTS aep_credentials (
          id INTEGER PRIMARY KEY,
          principal_id INTEGER NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
          service_did TEXT NOT NULL,
          credential_id TEXT NOT NULL,
          grant_type TEXT NOT NULL,
          issued_at TEXT NOT NULL,
          expires_at TEXT,
          secret_purpose TEXT NOT NULL,
          secret_reference TEXT NOT NULL,
          payload_version INTEGER NOT NULL,
          payload BLOB NOT NULL,
          UNIQUE(principal_id, service_did, credential_id)
        );
        CREATE TABLE IF NOT EXISTS public_documents (
          namespace TEXT NOT NULL,
          canonical_url TEXT NOT NULL,
          final_url TEXT,
          cached_at TEXT NOT NULL,
          cache_control TEXT,
          etag TEXT,
          last_modified TEXT,
          payload_version INTEGER NOT NULL,
          payload BLOB NOT NULL,
          PRIMARY KEY(namespace, canonical_url)
        );
        CREATE TABLE IF NOT EXISTS settings (
          name TEXT PRIMARY KEY,
          payload_version INTEGER NOT NULL,
          payload BLOB NOT NULL
        );
        CREATE TABLE IF NOT EXISTS secret_lifecycle (
          secret_purpose TEXT NOT NULL,
          secret_reference TEXT NOT NULL,
          principal_id INTEGER REFERENCES principals(id) ON DELETE CASCADE,
          state TEXT NOT NULL CHECK(state IN ('pending', 'active', 'deleting')),
          payload_version INTEGER NOT NULL,
          payload BLOB NOT NULL,
          PRIMARY KEY(secret_purpose, secret_reference)
        );
        CREATE TABLE IF NOT EXISTS vault_records (
          reference TEXT PRIMARY KEY,
          kind INTEGER NOT NULL,
          status INTEGER NOT NULL,
          expires_at TEXT,
          encryption_version INTEGER NOT NULL,
          nonce BLOB NOT NULL,
          tag BLOB NOT NULL,
          ciphertext BLOB NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS auth_sessions_principal_idx ON auth_sessions(principal_id);
        CREATE INDEX IF NOT EXISTS aep_credentials_lookup_idx ON aep_credentials(principal_id, service_did, grant_type, expires_at);
        CREATE INDEX IF NOT EXISTS aep_identities_lookup_idx ON aep_identities(principal_id, service_did);
        CREATE INDEX IF NOT EXISTS public_documents_namespace_idx ON public_documents(namespace, cached_at);
        CREATE INDEX IF NOT EXISTS secret_lifecycle_state_idx ON secret_lifecycle(state);
        CREATE INDEX IF NOT EXISTS vault_records_status_idx ON vault_records(status);
        CREATE INDEX IF NOT EXISTS vault_records_expiry_idx ON vault_records(expires_at);
      `);
      this.setSchemaMetadata('schema_version', String(SCHEMA_VERSION));
      const check = db.prepare('PRAGMA quick_check').get();
      if (check === undefined || Object.values(check)[0] !== 'ok') {
        throw new SecureStorageError('secure_storage_corrupt', 'SQLite quick_check failed.');
      }
    } catch (cause) {
      this.close();
      if (cause instanceof SecureStorageError) throw cause;
      throw new SecureStorageError('secure_storage_corrupt', 'SQLite database is corrupt or unreadable.', { cause });
    }
  }

  async ensureBackup(backupPath = `${this.databasePath}.backup`): Promise<void> {
    const check = this.db().prepare('PRAGMA integrity_check').get();
    if (check === undefined || Object.values(check)[0] !== 'ok') {
      throw new SecureStorageError('secure_storage_corrupt', 'SQLite integrity_check failed.');
    }
    await mkdir(path.dirname(backupPath), { mode: APPLICATION_DIRECTORY_MODE, recursive: true });
    await copyFile(this.databasePath, backupPath);
    await chmod(backupPath, DATABASE_FILE_MODE);
  }

  getPrincipal(platformOrigin: string, userId: string): StoredPrincipal | undefined {
    const row = this.db()
      .prepare('SELECT id, platform_origin, user_id FROM principals WHERE platform_origin = ? AND user_id = ?')
      .get(platformOrigin, userId);
    if (row === undefined) return undefined;
    return {
      id: numberColumn(row, 'id'),
      platformOrigin: stringColumn(row, 'platform_origin'),
      userId: stringColumn(row, 'user_id'),
    };
  }

  upsertPrincipal(platformOrigin: string, userId: string, payload: unknown = {}): StoredPrincipal {
    this.transaction(() => {
      this.db()
        .prepare(
          `INSERT INTO principals (platform_origin, user_id, payload_version, payload)
           VALUES (?, ?, 1, ?)
           ON CONFLICT(platform_origin, user_id) DO UPDATE SET payload = excluded.payload, payload_version = excluded.payload_version`,
        )
        .run(platformOrigin, userId, jsonBytes(payload));
    });
    const principal = this.getPrincipal(platformOrigin, userId);
    if (principal === undefined) {
      throw new SecureStorageError('secure_storage_io_error', 'Failed to create the principal record.');
    }
    return principal;
  }

  getPublicDocument(namespace: StoredPublicDocument['namespace'], url: string): StoredPublicDocument | undefined {
    const row = this.db()
      .prepare(
        `SELECT namespace, canonical_url, final_url, cached_at, cache_control, etag, last_modified, payload
         FROM public_documents WHERE namespace = ? AND canonical_url = ?`,
      )
      .get(namespace, url);
    if (row === undefined) return undefined;
    const record: StoredPublicDocument = {
      namespace,
      url: stringColumn(row, 'canonical_url'),
      cachedAt: stringColumn(row, 'cached_at'),
      payload: parsePayload(valueColumn(row, 'payload')),
    };
    const cacheControl = optionalStringColumn(row, 'cache_control');
    const etag = optionalStringColumn(row, 'etag');
    const finalUrl = optionalStringColumn(row, 'final_url');
    const lastModified = optionalStringColumn(row, 'last_modified');
    if (cacheControl !== undefined) record.cacheControl = cacheControl;
    if (etag !== undefined) record.etag = etag;
    if (finalUrl !== undefined) record.finalUrl = finalUrl;
    if (lastModified !== undefined) record.lastModified = lastModified;
    return record;
  }

  upsertPublicDocument(record: StoredPublicDocument): void {
    this.transaction(() => {
      this.db()
        .prepare(
          `INSERT INTO public_documents (
             namespace, canonical_url, final_url, cached_at, cache_control, etag, last_modified, payload_version, payload
           ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)
           ON CONFLICT(namespace, canonical_url) DO UPDATE SET
             final_url = excluded.final_url,
             cached_at = excluded.cached_at,
             cache_control = excluded.cache_control,
             etag = excluded.etag,
             last_modified = excluded.last_modified,
             payload_version = excluded.payload_version,
             payload = excluded.payload`,
        )
        .run(
          record.namespace,
          record.url,
          record.finalUrl ?? null,
          record.cachedAt,
          record.cacheControl ?? null,
          record.etag ?? null,
          record.lastModified ?? null,
          jsonBytes(record.payload),
        );
    });
  }

  deletePublicDocument(namespace: StoredPublicDocument['namespace'], url: string): void {
    this.transaction(() => {
      this.db().prepare('DELETE FROM public_documents WHERE namespace = ? AND canonical_url = ?').run(namespace, url);
    });
  }

  listPublicDocuments(namespace: StoredPublicDocument['namespace']): StoredPublicDocument[] {
    return this.db()
      .prepare(
        `SELECT namespace, canonical_url, final_url, cached_at, cache_control, etag, last_modified, payload
         FROM public_documents WHERE namespace = ? ORDER BY canonical_url`,
      )
      .all(namespace)
      .map((row) => this.publicDocumentFromRow(namespace, row));
  }

  async writeTransaction<T>(work: () => Promise<T> | T): Promise<T> {
    if (this.inTransaction) return work();
    const db = this.db();
    db.exec('BEGIN IMMEDIATE');
    this.inTransaction = true;
    try {
      const result = await work();
      db.exec('COMMIT');
      return result;
    } catch (cause) {
      db.exec('ROLLBACK');
      throw cause;
    } finally {
      this.inTransaction = false;
    }
  }

  writeTransactionSync<T>(work: () => T): T {
    return this.transaction(work);
  }

  upsertSetting(name: string, payload: unknown): void {
    this.transaction(() => {
      this.db()
        .prepare(
          `INSERT INTO settings (name, payload_version, payload) VALUES (?, 1, ?)
           ON CONFLICT(name) DO UPDATE SET payload_version = excluded.payload_version, payload = excluded.payload`,
        )
        .run(name, jsonBytes(payload));
    });
  }

  getSetting(name: string): JsonPayloadRecord<unknown> | undefined {
    const row = this.db().prepare('SELECT payload_version, payload FROM settings WHERE name = ?').get(name);
    if (row === undefined) return undefined;
    return { payload: parsePayload(valueColumn(row, 'payload')), payloadVersion: numberColumn(row, 'payload_version') };
  }

  deleteSetting(name: string): void {
    this.transaction(() => {
      this.db().prepare('DELETE FROM settings WHERE name = ?').run(name);
    });
  }

  beginSecretLifecycle(reference: SecretReference, principalId: number | null, payload: unknown = {}): void {
    this.transaction(() => {
      this.db()
        .prepare(
          `INSERT INTO secret_lifecycle (
             secret_purpose, secret_reference, principal_id, state, payload_version, payload
           ) VALUES (?, ?, ?, 'pending', 1, ?)
           ON CONFLICT(secret_purpose, secret_reference) DO UPDATE SET
             principal_id = excluded.principal_id,
             state = 'pending',
             payload_version = excluded.payload_version,
             payload = excluded.payload`,
        )
        .run(reference.purpose, reference.reference, principalId, jsonBytes(payload));
    });
  }

  markSecretActive(reference: SecretReference): void {
    this.updateSecretState(reference, 'active');
  }

  markSecretDeleting(reference: SecretReference): void {
    this.updateSecretState(reference, 'deleting');
  }

  deleteSecretLifecycle(reference: SecretReference): void {
    this.transaction(() => {
      this.db()
        .prepare('DELETE FROM secret_lifecycle WHERE secret_purpose = ? AND secret_reference = ?')
        .run(reference.purpose, reference.reference);
    });
  }

  listSecretLifecycle(state: SecretLifecycleState): SecretReference[] {
    return this.db()
      .prepare(
        'SELECT secret_purpose, secret_reference FROM secret_lifecycle WHERE state = ? ORDER BY secret_purpose, secret_reference',
      )
      .all(state)
      .map((row) => ({
        purpose: stringColumn(row, 'secret_purpose'),
        reference: stringColumn(row, 'secret_reference'),
      }));
  }

  putVaultRecord(record: StoredVaultRecord): void {
    this.transaction(() => {
      this.db()
        .prepare(
          `INSERT INTO vault_records (
             reference, kind, status, expires_at, encryption_version, nonce, tag, ciphertext, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
        )
        .run(
          record.reference,
          vaultSecretKindCode(record.kind),
          vaultRecordStatusCode(record.status),
          record.expiresAt ?? null,
          record.encryptionVersion,
          record.nonce,
          record.tag,
          record.ciphertext,
          record.updatedAt,
        );
    });
  }

  hasVaultRecord(reference: string): boolean {
    return this.db().prepare('SELECT 1 FROM vault_records WHERE reference = ?').get(reference) !== undefined;
  }

  getVaultRecordByReference(reference: string): StoredVaultRecord | undefined {
    const row = this.db().prepare('SELECT * FROM vault_records WHERE reference = ?').get(reference);
    return row === undefined ? undefined : this.vaultRecordFromRow(row);
  }

  getVaultRecord(reference: string, expectedKind: VaultSecretKind): StoredVaultRecord | undefined {
    const record = this.getVaultRecordByReference(reference);
    if (record === undefined) return undefined;
    if (record.kind !== expectedKind || record.status !== 'active') return undefined;
    if (record.expiresAt !== undefined && Date.parse(record.expiresAt) <= Date.now()) return undefined;
    return record;
  }

  listVaultRecords(status: VaultRecordStatus): StoredVaultRecord[] {
    return this.db()
      .prepare('SELECT * FROM vault_records WHERE status = ? ORDER BY reference')
      .all(vaultRecordStatusCode(status))
      .map((row) => this.vaultRecordFromRow(row));
  }

  markVaultRecordStatus(reference: string, status: VaultRecordStatus, updatedAt: string): void {
    this.transaction(() => {
      this.db()
        .prepare('UPDATE vault_records SET status = ?, updated_at = ? WHERE reference = ?')
        .run(vaultRecordStatusCode(status), updatedAt, reference);
    });
  }

  deleteVaultRecord(reference: string): void {
    this.transaction(() => {
      this.db().prepare('DELETE FROM vault_records WHERE reference = ?').run(reference);
    });
  }

  deleteExpiredVaultRecords(now: string): void {
    this.transaction(() => {
      this.db().prepare('DELETE FROM vault_records WHERE expires_at IS NOT NULL AND expires_at <= ?').run(now);
    });
  }

  touchVaultRecord(reference: string, updatedAt: string): void {
    this.transaction(() => {
      this.db().prepare('UPDATE vault_records SET updated_at = ? WHERE reference = ?').run(updatedAt, reference);
    });
  }

  async verifyDatabaseFiles(): Promise<void> {
    await access(this.databasePath, constants.R_OK | constants.W_OK);
    const dbStat = await stat(this.databasePath);
    if (!dbStat.isFile() || dbStat.mode % 0o1000 !== DATABASE_FILE_MODE) {
      throw new SecureStorageError('secure_storage_invalid_path', 'The InFlow SQLite database has unsafe permissions.');
    }
  }

  private db(): SQLiteDatabase {
    if (this.database === undefined) {
      this.database = new (this.loadSqlite().DatabaseSync)(this.databasePath);
    }
    return this.database;
  }

  private publicDocumentFromRow(namespace: StoredPublicDocument['namespace'], row: SQLiteRow): StoredPublicDocument {
    const record: StoredPublicDocument = {
      namespace,
      url: stringColumn(row, 'canonical_url'),
      cachedAt: stringColumn(row, 'cached_at'),
      payload: parsePayload(valueColumn(row, 'payload')),
    };
    const cacheControl = optionalStringColumn(row, 'cache_control');
    const etag = optionalStringColumn(row, 'etag');
    const finalUrl = optionalStringColumn(row, 'final_url');
    const lastModified = optionalStringColumn(row, 'last_modified');
    if (cacheControl !== undefined) record.cacheControl = cacheControl;
    if (etag !== undefined) record.etag = etag;
    if (finalUrl !== undefined) record.finalUrl = finalUrl;
    if (lastModified !== undefined) record.lastModified = lastModified;
    return record;
  }

  private setSchemaMetadata(key: string, value: string): void {
    this.db()
      .prepare(
        `INSERT INTO schema_metadata (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(key, value);
  }

  private transaction<T>(work: () => T): T {
    if (this.inTransaction) return work();
    const db = this.db();
    db.exec('BEGIN IMMEDIATE');
    this.inTransaction = true;
    try {
      const result = work();
      db.exec('COMMIT');
      return result;
    } catch (cause) {
      db.exec('ROLLBACK');
      throw cause;
    } finally {
      this.inTransaction = false;
    }
  }

  private updateSecretState(reference: SecretReference, state: SecretLifecycleState): void {
    this.transaction(() => {
      this.db()
        .prepare('UPDATE secret_lifecycle SET state = ? WHERE secret_purpose = ? AND secret_reference = ?')
        .run(state, reference.purpose, reference.reference);
    });
  }

  private vaultRecordFromRow(row: SQLiteRow): StoredVaultRecord {
    const record: StoredVaultRecord = {
      ciphertext: bytesColumn(row, 'ciphertext'),
      encryptionVersion: numberColumn(row, 'encryption_version'),
      kind: vaultSecretKindName(numberColumn(row, 'kind')),
      nonce: bytesColumn(row, 'nonce'),
      reference: stringColumn(row, 'reference'),
      status: vaultRecordStatusName(numberColumn(row, 'status')),
      tag: bytesColumn(row, 'tag'),
      updatedAt: stringColumn(row, 'updated_at'),
    };
    const expiresAt = optionalStringColumn(row, 'expires_at');
    if (expiresAt !== undefined) record.expiresAt = expiresAt;
    return record;
  }
}
