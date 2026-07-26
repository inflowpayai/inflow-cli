import { createHash } from 'node:crypto';
import path from 'node:path';
import type { VaultBackend } from './vault-backend.js';
import {
  LifetimeVaultBackend,
  VaultBackendLifetime,
  type VaultBackendLifetimeOptions,
} from './vault-backend-lifetime.js';
import { SecureStorageError } from './errors.js';
import { SecureSqliteRepository } from './sqlite.js';
import { vaultFilePaths } from './vault-files.js';
import { LocalVaultBackend } from './vault-local-backend.js';
import type { VaultSocketPeer } from './vault-peer-verifier.js';

interface VaultTenantContext {
  backend: LocalVaultBackend;
  facade: VaultBackend;
  lifetime: VaultBackendLifetime;
  repository: SecureSqliteRepository;
}

export interface MultiTenantVaultBackendManagerOptions extends VaultBackendLifetimeOptions {
  rootDirectory: string;
}

export class MultiTenantVaultBackendManager {
  private readonly contexts = new Map<string, VaultTenantContext>();
  private readonly lifetimeOptions: VaultBackendLifetimeOptions;
  private readonly rootDirectory: string;

  constructor(options: MultiTenantVaultBackendManagerOptions) {
    this.rootDirectory = path.resolve(options.rootDirectory);
    this.lifetimeOptions = {
      ...(options.sleepCheckIntervalMilliseconds === undefined
        ? {}
        : { sleepCheckIntervalMilliseconds: options.sleepCheckIntervalMilliseconds }),
      ...(options.sleepDriftThresholdMilliseconds === undefined
        ? {}
        : { sleepDriftThresholdMilliseconds: options.sleepDriftThresholdMilliseconds }),
    };
  }

  backendForPeer(peer: VaultSocketPeer): VaultBackend {
    const tenantId = tenantIdForPeer(peer);
    const existing = this.contexts.get(tenantId);
    if (existing !== undefined) return existing.facade;

    const paths = vaultFilePaths(path.join(this.rootDirectory, tenantId));
    const repository = new SecureSqliteRepository({ databasePath: paths.database });
    const backend = new LocalVaultBackend({ paths, repository });
    const lifetime = new VaultBackendLifetime(this.lifetimeOptions);
    const contextReference: { value?: VaultTenantContext } = {};
    const facade = new LifetimeVaultBackend(backend, lifetime, () =>
      contextReference.value === undefined ? Promise.resolve() : this.disposeTenant(tenantId, contextReference.value),
    );
    const context = { backend, facade, lifetime, repository };
    contextReference.value = context;
    this.contexts.set(tenantId, context);
    lifetime.expireWith(() => this.disposeTenant(tenantId, context));
    return facade;
  }

  async close(): Promise<void> {
    const contexts = [...this.contexts.entries()];
    this.contexts.clear();
    await Promise.all(contexts.map(([tenantId, context]) => this.disposeTenant(tenantId, context)));
  }

  lockForSleep(): Promise<void> {
    for (const context of this.contexts.values()) {
      if (context.backend.getPolicy().lockOnSleep) {
        context.backend.lock();
      }
    }
    return Promise.resolve();
  }

  private disposeTenant(tenantId: string, context: VaultTenantContext): Promise<void> {
    if (this.contexts.get(tenantId) === context) this.contexts.delete(tenantId);
    context.lifetime.clear();
    try {
      context.backend.lock();
    } finally {
      context.repository.close();
    }
    return Promise.resolve();
  }
}

function tenantIdForPeer(peer: VaultSocketPeer): string {
  if (peer.principal !== undefined) {
    if (!/^S-\d+(?:-\d+)+$/u.test(peer.principal)) {
      throw new SecureStorageError('secure_storage_peer_verification_failed', 'Vault peer verification failed.');
    }
    return createHash('sha256').update(`windows-sid:${peer.principal}`).digest('hex');
  }
  if (!Number.isSafeInteger(peer.uid) || peer.uid < 0) {
    throw new SecureStorageError('secure_storage_peer_verification_failed', 'Vault peer verification failed.');
  }
  return createHash('sha256').update(`unix-uid:${peer.uid}`).digest('hex');
}
