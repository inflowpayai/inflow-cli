import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SecureSqliteRepository } from '../../../src/secure-storage/sqlite.js';

type SqliteTestValue = Uint8Array | bigint | number | string | null;

class EmptySqliteStatement {
  all(): Record<string, SqliteTestValue>[] {
    return [];
  }

  get(): Record<string, SqliteTestValue> | undefined {
    return undefined;
  }

  run(): undefined {
    return undefined;
  }
}

class QuickCheckStatement extends EmptySqliteStatement {
  constructor(private readonly result: Record<string, SqliteTestValue> | undefined) {
    super();
  }

  override get(): Record<string, SqliteTestValue> | undefined {
    return this.result;
  }
}

function quickCheckSqlite(result: Record<string, SqliteTestValue> | undefined): {
  DatabaseSync: new (filename: string) => {
    close(): void;
    exec(sql: string): void;
    prepare(sql: string): EmptySqliteStatement;
  };
} {
  return {
    DatabaseSync: class {
      constructor(_filename: string) {}

      close(): void {}

      exec(_sql: string): void {}

      prepare(sql: string): EmptySqliteStatement {
        return sql === 'PRAGMA quick_check' ? new QuickCheckStatement(result) : new EmptySqliteStatement();
      }
    },
  };
}

describe('SecureSqliteRepository', () => {
  let tmpDir: string;
  let repository: SecureSqliteRepository;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'inflow-secure-sqlite-'));
    repository = new SecureSqliteRepository({ rootDir: tmpDir });
    repository.initialize();
  });

  afterEach(() => {
    repository.close();
    rmSync(tmpDir, { force: true, recursive: true });
  });

  it('initializes the durable schema and validates database permissions', async () => {
    await expect(repository.verifyDatabaseFiles()).resolves.toBeUndefined();
    await expect(repository.ensureBackup()).resolves.toBeUndefined();
  });

  it('stores principal rows with stable owner lookup columns', () => {
    const created = repository.upsertPrincipal('https://platform.example.test', 'user-1', { displayName: 'User One' });
    const loaded = repository.getPrincipal('https://platform.example.test', 'user-1');

    expect(loaded).toEqual(created);
    expect(repository.getPrincipal('https://platform.example.test', 'user-2')).toBeUndefined();
  });

  it('allows independent repository handles to share one durable database', () => {
    const second = new SecureSqliteRepository({ rootDir: tmpDir });
    second.initialize();
    try {
      repository.upsertSetting('cli-process', { source: 'cli' });
      second.upsertSetting('mcp-process', { source: 'mcp' });

      expect(repository.getSetting('mcp-process')?.payload).toEqual({ source: 'mcp' });
      expect(second.getSetting('cli-process')?.payload).toEqual({ source: 'cli' });
    } finally {
      second.close();
    }
  });

  it('stores public documents separately from authenticated records', () => {
    repository.upsertPublicDocument({
      cachedAt: '2026-01-01T00:00:00.000Z',
      cacheControl: 'max-age=300',
      etag: '"v1"',
      namespace: 'openapi',
      payload: { openapi: '3.1.0' },
      url: 'https://service.example/openapi.json',
    });

    expect(repository.getPublicDocument('openapi', 'https://service.example/openapi.json')).toMatchObject({
      cacheControl: 'max-age=300',
      etag: '"v1"',
      payload: { openapi: '3.1.0' },
    });

    repository.deletePublicDocument('openapi', 'https://service.example/openapi.json');
    expect(repository.getPublicDocument('openapi', 'https://service.example/openapi.json')).toBeUndefined();
  });

  it('round-trips and orders complete public-document metadata', () => {
    repository.upsertPublicDocument({
      cachedAt: '2026-01-02T00:00:00.000Z',
      finalUrl: 'https://service.example/openapi-final.json',
      lastModified: 'Wed, 01 Jan 2026 00:00:00 GMT',
      namespace: 'openapi',
      payload: { openapi: '3.1.0', version: 2 },
      url: 'https://service.example/z-openapi.json',
    });
    repository.upsertPublicDocument({
      cachedAt: '2026-01-01T00:00:00.000Z',
      namespace: 'openapi',
      payload: { openapi: '3.1.0', version: 1 },
      url: 'https://service.example/a-openapi.json',
    });

    expect(repository.listPublicDocuments('openapi')).toEqual([
      {
        cachedAt: '2026-01-01T00:00:00.000Z',
        namespace: 'openapi',
        payload: { openapi: '3.1.0', version: 1 },
        url: 'https://service.example/a-openapi.json',
      },
      {
        cachedAt: '2026-01-02T00:00:00.000Z',
        finalUrl: 'https://service.example/openapi-final.json',
        lastModified: 'Wed, 01 Jan 2026 00:00:00 GMT',
        namespace: 'openapi',
        payload: { openapi: '3.1.0', version: 2 },
        url: 'https://service.example/z-openapi.json',
      },
    ]);
  });

  it('tracks secret lifecycle rows without storing secret material', () => {
    const principal = repository.upsertPrincipal('https://platform.example.test', 'user-1');
    const reference = { purpose: 'api-key', reference: 'opaque-reference' };

    repository.beginSecretLifecycle(reference, principal.id, { owner: 'auth' });
    expect(repository.listSecretLifecycle('pending')).toEqual([reference]);

    repository.markSecretActive(reference);
    expect(repository.listSecretLifecycle('active')).toEqual([reference]);

    repository.markSecretDeleting(reference);
    expect(repository.listSecretLifecycle('deleting')).toEqual([reference]);

    repository.deleteSecretLifecycle(reference);
    expect(repository.listSecretLifecycle('deleting')).toEqual([]);
  });

  it('stores versioned non-secret settings payloads as JSON bytes', () => {
    repository.upsertSetting('connection', { apiBaseUrl: 'https://sandbox.inflowpay.ai' });

    expect(repository.getSetting('connection')).toEqual({
      payload: { apiBaseUrl: 'https://sandbox.inflowpay.ai' },
      payloadVersion: 1,
    });

    repository.deleteSetting('connection');
    expect(repository.getSetting('connection')).toBeUndefined();
  });

  it('commits nested transactions and rolls back failed synchronous and asynchronous work', async () => {
    repository.writeTransactionSync(() => {
      repository.upsertSetting('nested-sync', { committed: true });
    });
    await repository.writeTransaction(() => {
      repository.upsertSetting('nested-async', { committed: true });
      return Promise.resolve();
    });

    expect(repository.getSetting('nested-sync')?.payload).toEqual({ committed: true });
    expect(repository.getSetting('nested-async')?.payload).toEqual({ committed: true });

    expect(() =>
      repository.writeTransactionSync(() => {
        repository.upsertSetting('rolled-back-sync', { committed: false });
        throw new Error('sync failure');
      }),
    ).toThrow('sync failure');
    await expect(
      repository.writeTransaction(() => {
        repository.upsertSetting('rolled-back-async', { committed: false });
        return Promise.reject(new Error('async failure'));
      }),
    ).rejects.toThrow('async failure');

    expect(repository.getSetting('rolled-back-sync')).toBeUndefined();
    expect(repository.getSetting('rolled-back-async')).toBeUndefined();
  });

  it('rejects database files whose permissions become unsafe', async () => {
    chmodSync(join(tmpDir, 'inflow.sqlite3'), 0o644);

    await expect(repository.verifyDatabaseFiles()).rejects.toMatchObject({
      secureStorageCode: 'secure_storage_invalid_path',
    });
  });

  it('reports corrupted database files with the stable secure-storage code', () => {
    repository.close();
    writeFileSync(join(tmpDir, 'inflow.sqlite3'), 'not a sqlite database');
    const corrupted = new SecureSqliteRepository({ rootDir: tmpDir });

    let error: unknown;
    try {
      corrupted.initialize();
    } catch (cause) {
      error = cause;
    }
    expect(error).toMatchObject({ secureStorageCode: 'secure_storage_corrupt' });
    corrupted.close();
  });

  it('reports failed SQLite quick_check results with the stable secure-storage code', () => {
    for (const [name, result] of [
      ['missing', undefined],
      ['failed', { quick_check: 'database disk image is malformed' }],
    ] as const) {
      const failing = new SecureSqliteRepository({
        databasePath: join(tmpDir, `${name}.sqlite3`),
        loadSqlite: () => quickCheckSqlite(result),
      });
      let error: unknown;
      try {
        failing.initialize();
      } catch (cause) {
        error = cause;
      }
      expect(error).toMatchObject({ secureStorageCode: 'secure_storage_corrupt' });
      failing.close();
    }
  });

  it('allows close to be repeated safely', () => {
    repository.close();
    repository.close();
  });
});
