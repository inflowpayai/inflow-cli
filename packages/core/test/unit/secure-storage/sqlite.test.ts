import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SecureSqliteRepository } from '../../../src/secure-storage/sqlite.js';

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
  });
});
