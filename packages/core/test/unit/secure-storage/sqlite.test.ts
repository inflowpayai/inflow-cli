import { spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __testing, SecureSqliteRepository } from '../../../src/secure-storage/sqlite.js';

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

function quickCheckSqlite(
  result: Record<string, SqliteTestValue> | undefined,
  integrity?: Record<string, SqliteTestValue>,
): {
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
        return sql === 'PRAGMA quick_check'
          ? new QuickCheckStatement(result)
          : sql === 'PRAGMA integrity_check'
            ? new QuickCheckStatement(integrity)
            : new EmptySqliteStatement();
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
    vi.restoreAllMocks();
    repository.close();
    rmSync(tmpDir, { force: true, recursive: true });
  });

  it.each(['pending', 'deleting'] as const)('recovers %s work only after its writer process exits', async (state) => {
    const source = `
      import { registerHooks } from 'node:module';
      registerHooks({ resolve(specifier, context, nextResolve) {
        try { return nextResolve(specifier, context); }
        catch (error) {
          if (error.code !== 'ERR_MODULE_NOT_FOUND' || !specifier.endsWith('.js')) throw error;
          return nextResolve(specifier.slice(0, -3) + '.ts', context);
        }
      }});
      const { SecureSqliteRepository } = await import(${JSON.stringify(new URL('../../../src/secure-storage/sqlite.ts', import.meta.url).href)});
      const repository = new SecureSqliteRepository({ rootDir: process.argv[1] });
      repository.initialize();
      const reference = { purpose: 'api-key', reference: 'child-write' };
      repository.beginSecretLifecycle(reference, null);
      if (process.argv[2] === 'deleting') {
        repository.markSecretActive(reference);
        repository.markSecretDeleting(reference);
      }
      process.send('ready');
      setInterval(() => {}, 1000);
    `;
    const child = spawn(
      process.execPath,
      ['--experimental-transform-types', '--input-type=module', '-e', source, tmpDir, state],
      {
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      },
    );
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const exit = once(child, 'exit');
    try {
      const ready = await Promise.race([
        once(child, 'message'),
        exit.then(() => {
          throw new Error(stderr);
        }),
      ]);
      expect(ready[0]).toBe('ready');
      expect(repository.listSecretLifecycle(state)).toEqual([{ purpose: 'api-key', reference: 'child-write' }]);
      expect(repository.claimInterruptedSecretLifecycle()).toBeUndefined();
      child.kill('SIGKILL');
      await exit;
      expect(repository.claimInterruptedSecretLifecycle()).toEqual({ purpose: 'api-key', reference: 'child-write' });
      expect(repository.claimInterruptedSecretLifecycle()).toBeUndefined();
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await exit;
    }
  });

  it('preserves live owners on permission errors and releases failed work for another connection', () => {
    const reference = { purpose: 'api-key', reference: 'owner' };
    repository.beginSecretLifecycle(reference, null);
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('access denied'), { code: 'EPERM' });
    });
    expect(repository.claimInterruptedSecretLifecycle()).toBeUndefined();
    expect(() => repository.markSecretDeleting(reference)).toThrow('operation is in progress');
    expect(() => repository.beginSecretLifecycle(reference, null)).toThrow('reference already exists');
    kill.mockRestore();
    repository.releaseSecretLifecycle(reference);
    const other = new SecureSqliteRepository({ rootDir: tmpDir });
    other.initialize();
    try {
      expect(other.claimInterruptedSecretLifecycle()).toEqual(reference);
      expect(repository.claimInterruptedSecretLifecycle()).toBeUndefined();
      other.deleteSecretLifecycle(reference);
      other.releaseSecretLifecycle(reference);
      expect(() => repository.markSecretActive(reference)).toThrow('lost ownership');
    } finally {
      other.close();
    }
  });

  it('recovers version-one lifecycle records without altering their application metadata', () => {
    const raw = new (process.getBuiltinModule('node:sqlite').DatabaseSync)(join(tmpDir, 'inflow.sqlite3'));
    try {
      raw
        .prepare("INSERT INTO secret_lifecycle VALUES (?, ?, NULL, 'pending', 1, ?)")
        .run('api-key', 'legacy', Buffer.from(JSON.stringify({ setting: 'auth.api_key' })));
      expect(repository.claimInterruptedSecretLifecycle()).toEqual({ purpose: 'api-key', reference: 'legacy' });
      const row = raw.prepare('SELECT payload FROM secret_lifecycle').get();
      const payload = row?.['payload'];
      if (!(payload instanceof Uint8Array)) throw new Error('Missing lifecycle payload');
      expect(JSON.parse(Buffer.from(payload).toString())).toEqual({
        ownerPid: process.pid,
        value: { setting: 'auth.api_key' },
      });
    } finally {
      raw.close();
    }
  });

  it.each([
    [2, null],
    [2, {}],
    [2, { ownerPid: 0, value: {} }],
    [2, { ownerPid: '123', value: {} }],
    [2, { ownerPid: -1, value: {} }],
    [2, { ownerPid: 1.5, value: {} }],
    [2, { ownerPid: null }],
    [3, { ownerPid: null, value: {} }],
  ])('refuses recovery with malformed ownership metadata (%s, %j)', (version, payload) => {
    const raw = new (process.getBuiltinModule('node:sqlite').DatabaseSync)(join(tmpDir, 'inflow.sqlite3'));
    try {
      raw
        .prepare("INSERT INTO secret_lifecycle VALUES (?, ?, NULL, 'pending', ?, ?)")
        .run('api-key', 'malformed', Number(version), Buffer.from(JSON.stringify(payload)));
      expect(() => repository.claimInterruptedSecretLifecycle()).toThrow('ownership is malformed');
      expect(repository.listSecretLifecycle('pending')).toHaveLength(1);
    } finally {
      raw.close();
    }
  });

  it('does not activate or release work owned by another process', () => {
    const raw = new (process.getBuiltinModule('node:sqlite').DatabaseSync)(join(tmpDir, 'inflow.sqlite3'));
    const reference = { purpose: 'api-key', reference: 'foreign-owner' };
    try {
      raw
        .prepare("INSERT INTO secret_lifecycle VALUES (?, ?, NULL, 'pending', 2, ?)")
        .run(
          reference.purpose,
          reference.reference,
          Buffer.from(JSON.stringify({ ownerPid: process.ppid, value: {} })),
        );
      repository.releaseSecretLifecycle(reference);
      expect(() => repository.markSecretActive(reference)).toThrow('lost ownership');
      expect(repository.claimInterruptedSecretLifecycle()).toBeUndefined();
    } finally {
      raw.close();
    }
  });

  it('initializes the durable schema and validates database permissions', async () => {
    await expect(repository.verifyDatabaseFiles()).resolves.toBeUndefined();
    await expect(repository.ensureBackup()).resolves.toBeUndefined();
  });

  it('rejects a directory used as the database file', () => {
    const databasePath = join(tmpDir, 'directory-not-database');
    mkdirSync(databasePath);
    const invalid = new SecureSqliteRepository({ databasePath });
    try {
      expect(() => invalid.initialize()).toThrow('The InFlow SQLite database path is invalid.');
      expect(statSync(databasePath).isDirectory()).toBe(true);
    } finally {
      invalid.close();
    }
  });

  it('applies the Windows canonical-path policy before opening a database through a directory alias', () => {
    const originalPlatform = process.platform;
    const root = realpathSync(tmpDir);
    const target = join(root, 'canonical');
    const alias = join(root, 'alias');
    mkdirSync(target);
    symlinkSync(target, alias, 'junction');
    const canonical = new SecureSqliteRepository({ databasePath: join(target, 'accepted.sqlite3') });
    const redirected = new SecureSqliteRepository({ databasePath: join(alias, 'rejected.sqlite3') });
    try {
      Object.defineProperty(process, 'platform', { value: 'win32' });
      canonical.initialize();
      expect(canonical.upsertPrincipal('https://platform.test', 'user').userId).toBe('user');
      expect(() => redirected.initialize()).toThrow('The InFlow SQLite path is invalid.');
      expect(existsSync(join(target, 'rejected.sqlite3'))).toBe(false);
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform });
      canonical.close();
      redirected.close();
    }
  });

  it.runIf(process.platform !== 'win32')('rejects a database symlink without modifying its target', () => {
    const target = join(tmpDir, 'unrelated-file');
    const databasePath = join(tmpDir, 'symlink.sqlite3');
    writeFileSync(target, 'unrelated contents', { mode: 0o644 });
    const originalMode = statSync(target).mode;
    symlinkSync(target, databasePath);
    const invalid = new SecureSqliteRepository({ databasePath });
    try {
      expect(() => invalid.initialize()).toThrow('The InFlow SQLite database path is invalid.');
      expect(readFileSync(target, 'utf8')).toBe('unrelated contents');
      expect(statSync(target).mode).toBe(originalMode);
    } finally {
      invalid.close();
    }
  });

  it.runIf(process.platform === 'linux')('uses the Linux vault root for the default database', () => {
    const originalDataHome = process.env['XDG_DATA_HOME'];
    const dataHome = join(tmpDir, 'xdg-data');
    process.env['XDG_DATA_HOME'] = dataHome;
    let databasePath: string | undefined;
    const defaultRepository = new SecureSqliteRepository({
      loadSqlite: () => ({
        DatabaseSync: class {
          constructor(filename: string) {
            databasePath = filename;
          }

          close(): void {}

          exec(_sql: string): void {}

          prepare(sql: string): EmptySqliteStatement {
            return sql === 'PRAGMA quick_check'
              ? new QuickCheckStatement({ quick_check: 'ok' })
              : new EmptySqliteStatement();
          }
        },
      }),
    });
    try {
      defaultRepository.initialize();
      expect(databasePath).toBe(join(dataHome, 'inflow', 'inflow.sqlite3'));
    } finally {
      defaultRepository.close();
      if (originalDataHome === undefined) delete process.env['XDG_DATA_HOME'];
      else process.env['XDG_DATA_HOME'] = originalDataHome;
    }
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
      finalUrl: 'https://service.example/specification.json',
      lastModified: 'Thu, 01 Jan 2026 00:00:00 GMT',
      namespace: 'openapi',
      payload: { openapi: '3.1.0' },
      url: 'https://service.example/openapi.json',
    });

    expect(repository.getPublicDocument('openapi', 'https://service.example/openapi.json')).toMatchObject({
      cacheControl: 'max-age=300',
      etag: '"v1"',
      finalUrl: 'https://service.example/specification.json',
      lastModified: 'Thu, 01 Jan 2026 00:00:00 GMT',
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

  it('stores encrypted vault rows with exact-reference kind and active-status retrieval', () => {
    const active = {
      ciphertext: Uint8Array.from([1, 2, 3]),
      encryptionVersion: 1,
      kind: 'aep_credential' as const,
      nonce: Uint8Array.from([4, 5, 6]),
      reference: 'vlt_11111111111111111111111111111111',
      status: 'active' as const,
      tag: Uint8Array.from([7, 8, 9]),
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    const pending = {
      ...active,
      reference: 'vlt_22222222222222222222222222222222',
      status: 'pending' as const,
    };
    repository.putVaultRecord(active);
    repository.putVaultRecord(pending);

    expect(repository.getVaultRecord(active.reference, 'aep_credential')).toMatchObject({
      kind: 'aep_credential',
      reference: active.reference,
      status: 'active',
      updatedAt: active.updatedAt,
    });
    expect(repository.getVaultRecord(active.reference, 'inflow_api_key')).toBeUndefined();
    expect(repository.getVaultRecord(pending.reference, 'aep_credential')).toBeUndefined();
    expect(repository.listVaultRecords('pending')).toEqual([expect.objectContaining({ reference: pending.reference })]);
  });

  it('hides expired vault rows and hard-deletes completed records', () => {
    const record = {
      ciphertext: Uint8Array.from([1]),
      encryptionVersion: 1,
      expiresAt: '2000-01-01T00:00:00.000Z',
      kind: 'auth_access_token' as const,
      nonce: Uint8Array.from([2]),
      reference: 'vlt_33333333333333333333333333333333',
      status: 'active' as const,
      tag: Uint8Array.from([3]),
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    repository.putVaultRecord(record);

    expect(repository.getVaultRecord(record.reference, 'auth_access_token')).toBeUndefined();

    repository.markVaultRecordStatus(record.reference, 'deleting', '2026-01-02T00:00:00.000Z');
    expect(repository.listVaultRecords('deleting')).toEqual([
      expect.objectContaining({ reference: record.reference, status: 'deleting' }),
    ]);

    repository.deleteVaultRecord(record.reference);
    expect(repository.listVaultRecords('deleting')).toEqual([]);
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
    await repository.writeTransaction(() =>
      repository.writeTransaction(() => {
        repository.upsertSetting('nested-async', { committed: true });
      }),
    );

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

  it.each([undefined, { integrity_check: 'database disk image is malformed' }])(
    'refuses a backup after a failed integrity check: %j',
    async (result) => {
      const backupPath = join(tmpDir, 'rejected.backup');
      const failing = new SecureSqliteRepository({
        databasePath: join(tmpDir, 'backup-source.sqlite3'),
        loadSqlite: () => quickCheckSqlite({ quick_check: 'ok' }, result),
      });
      try {
        failing.initialize();
        await expect(failing.ensureBackup(backupPath)).rejects.toMatchObject({
          secureStorageCode: 'secure_storage_corrupt',
          message: 'SQLite integrity_check failed.',
        });
        expect(existsSync(backupPath)).toBe(false);
      } finally {
        failing.close();
      }
    },
  );

  it('allows close to be repeated safely', () => {
    repository.close();
    repository.close();
  });

  it('rejects malformed SQLite row values before mapping them into records', () => {
    expect(() => __testing.parsePayload('json')).toThrow('payload is not a byte array');
    expect(() => __testing.valueColumn({}, 'missing')).toThrow('column missing is missing');
    expect(() => __testing.stringColumn({ value: 1 }, 'value')).toThrow('column value is malformed');
    expect(() => __testing.optionalStringColumn({ value: 1 }, 'value')).toThrow('column value is malformed');
    expect(() => __testing.numberColumn({ value: '1' }, 'value')).toThrow('column value is malformed');
    expect(() => __testing.bytesColumn({ value: 'bytes' }, 'value')).toThrow('column value is malformed');
  });
});
