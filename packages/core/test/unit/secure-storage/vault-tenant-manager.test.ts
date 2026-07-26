import { Buffer } from 'node:buffer';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MultiTenantVaultBackendManager } from '../../../src/secure-storage/vault-tenant-manager.js';
import type { VaultSocketPeer } from '../../../src/secure-storage/vault-peer-verifier.js';
import { parseVaultSecretReference } from '../../../src/secure-storage/vault-types.js';

const REFERENCE = parseVaultSecretReference('vlt_22222222222222222222222222222222');

describe('multi-tenant vault backend manager', () => {
  let manager: MultiTenantVaultBackendManager | undefined;
  let tmpDir: string | undefined;

  afterEach(async () => {
    await manager?.close();
    manager = undefined;
    if (tmpDir !== undefined) rmSync(tmpDir, { force: true, recursive: true });
    tmpDir = undefined;
  });

  it('isolates vault state selected from verified operating-system user identities', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'inflow-vault-tenants-'));
    manager = new MultiTenantVaultBackendManager({ rootDirectory: tmpDir });
    const tenantA = manager.backendForPeer(peer(1001));
    const tenantB = manager.backendForPeer(peer(1002));

    await tenantA.unlock(Buffer.from('tenant-a-factor'));
    await tenantB.unlock(Buffer.from('tenant-b-factor'));
    await tenantA.putSecret({
      expectedKind: 'inflow_api_key',
      payload: Buffer.from('tenant-a-secret'),
      reference: REFERENCE,
    });
    await tenantB.putSecret({
      expectedKind: 'inflow_api_key',
      payload: Buffer.from('tenant-b-secret'),
      reference: REFERENCE,
    });

    await expect(tenantA.getSecret({ expectedKind: 'inflow_api_key', reference: REFERENCE })).resolves.toMatchObject({
      payload: Buffer.from('tenant-a-secret'),
    });
    await expect(tenantB.getSecret({ expectedKind: 'inflow_api_key', reference: REFERENCE })).resolves.toMatchObject({
      payload: Buffer.from('tenant-b-secret'),
    });

    await tenantA.reset();

    await expect(manager.backendForPeer(peer(1001)).status()).resolves.toMatchObject({
      lockState: 'not_initialized',
    });
    await expect(manager.backendForPeer(peer(1001)).unlock(Buffer.from('tenant-a-replacement'))).resolves.toMatchObject(
      {
        lockState: 'unlocked',
      },
    );
    await expect(
      manager.backendForPeer(peer(1002)).getSecret({ expectedKind: 'inflow_api_key', reference: REFERENCE }),
    ).resolves.toMatchObject({ payload: Buffer.from('tenant-b-secret') });
  });

  it('expires and locks only an idle tenant context', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'inflow-vault-tenants-'));
    manager = new MultiTenantVaultBackendManager({ rootDirectory: tmpDir });
    const tenantA = manager.backendForPeer(peer(1001));
    const tenantB = manager.backendForPeer(peer(1002));
    await tenantA.unlock(Buffer.from('tenant-a-factor'));
    await tenantB.unlock(Buffer.from('tenant-b-factor'));
    await tenantA.setPolicy({ idleTimeoutSeconds: 0, lockOnSleep: false });

    await new Promise((resolve) => setTimeout(resolve, 25));

    await expect(manager.backendForPeer(peer(1001)).status()).resolves.toMatchObject({ lockState: 'locked' });
    await expect(manager.backendForPeer(peer(1002)).status()).resolves.toMatchObject({ lockState: 'unlocked' });
  });

  it('locks only tenants whose policy enables locking on sleep', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'inflow-vault-tenants-'));
    manager = new MultiTenantVaultBackendManager({ rootDirectory: tmpDir });
    const tenantA = manager.backendForPeer(peer(1001));
    const tenantB = manager.backendForPeer(peer(1002));
    await tenantA.unlock(Buffer.from('tenant-a-factor'));
    await tenantB.unlock(Buffer.from('tenant-b-factor'));
    await tenantA.setPolicy({ idleTimeoutSeconds: null, lockOnSleep: false });

    await manager.lockForSleep();

    await expect(tenantA.status()).resolves.toMatchObject({ lockState: 'unlocked' });
    await expect(tenantB.status()).resolves.toMatchObject({ lockState: 'locked' });
  });

  it('rejects invalid peer user identities before selecting a filesystem path', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'inflow-vault-tenants-'));
    manager = new MultiTenantVaultBackendManager({ rootDirectory: tmpDir });

    expect(peerError(manager, peer(-1))).toMatchObject({
      secureStorageCode: 'secure_storage_peer_verification_failed',
    });
    expect(peerError(manager, windowsPeer('not-a-sid'))).toMatchObject({
      secureStorageCode: 'secure_storage_peer_verification_failed',
    });
  });

  it('selects Windows tenants from complete token security identifiers', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'inflow-vault-tenants-'));
    manager = new MultiTenantVaultBackendManager({ rootDirectory: tmpDir });

    const tenantA = manager.backendForPeer(windowsPeer('S-1-5-21-100-200-300-1001'));
    const sameTenantA = manager.backendForPeer(windowsPeer('S-1-5-21-100-200-300-1001'));
    const tenantB = manager.backendForPeer(windowsPeer('S-1-5-21-100-200-300-1002'));

    expect(sameTenantA).toBe(tenantA);
    expect(tenantB).not.toBe(tenantA);
  });
});

function peer(uid: number): VaultSocketPeer {
  return { path: '/usr/bin/inflow', pid: uid, uid };
}

function windowsPeer(principal: string): VaultSocketPeer {
  return { path: 'C:\\Program Files\\InFlow\\inflow.exe', pid: 100, principal, uid: 0 };
}

function peerError(manager: MultiTenantVaultBackendManager, invalidPeer: VaultSocketPeer): unknown {
  try {
    manager.backendForPeer(invalidPeer);
    return undefined;
  } catch (cause) {
    return cause;
  }
}
