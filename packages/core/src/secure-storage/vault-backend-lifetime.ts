import type {
  DeleteExpiredVaultSecretsInput,
  DeleteVaultSecretInput,
  GetVaultSecretInput,
  PutVaultSecretInput,
  TouchVaultSecretInput,
  VaultBackend,
  VaultPolicy,
  VaultSecretPayload,
  VaultStatus,
} from './vault-backend.js';
import type { VaultSecretReference } from './vault-types.js';

const DEFAULT_SLEEP_CHECK_INTERVAL_MILLISECONDS = 30_000;
const DEFAULT_SLEEP_DRIFT_THRESHOLD_MILLISECONDS = 120_000;

export interface VaultBackendLifetimeOptions {
  sleepCheckIntervalMilliseconds?: number;
  sleepDriftThresholdMilliseconds?: number;
}

export class VaultBackendLifetime {
  private expire: (() => Promise<void>) | undefined;
  private idleTimer: NodeJS.Timeout | undefined;
  private sleepTimer: NodeJS.Timeout | undefined;

  constructor(private readonly options: VaultBackendLifetimeOptions = {}) {}

  clear(): void {
    if (this.idleTimer !== undefined) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
    if (this.sleepTimer !== undefined) {
      clearInterval(this.sleepTimer);
      this.sleepTimer = undefined;
    }
  }

  expireWith(expire: () => Promise<void>): void {
    this.expire = expire;
  }

  refresh(policy: VaultPolicy): void {
    this.clear();
    if (policy.idleTimeoutSeconds !== null) {
      this.idleTimer = setTimeout(() => {
        void this.expire?.();
      }, policy.idleTimeoutSeconds * 1_000);
      this.idleTimer.unref();
    }
    if (policy.lockOnSleep) this.watchForSleep();
  }

  private watchForSleep(): void {
    const interval = this.options.sleepCheckIntervalMilliseconds ?? DEFAULT_SLEEP_CHECK_INTERVAL_MILLISECONDS;
    const threshold = this.options.sleepDriftThresholdMilliseconds ?? DEFAULT_SLEEP_DRIFT_THRESHOLD_MILLISECONDS;
    let lastTick = Date.now();
    this.sleepTimer = setInterval(() => {
      const now = Date.now();
      const drift = now - lastTick - interval;
      lastTick = now;
      if (drift >= threshold) void this.expire?.();
    }, interval);
    this.sleepTimer.unref();
  }
}

export class LifetimeVaultBackend implements VaultBackend {
  constructor(
    private readonly backend: VaultBackend,
    private readonly lifetime: VaultBackendLifetime,
    private readonly onReset?: () => Promise<void>,
  ) {}

  async changePassphrase(currentUnlockFactor: Uint8Array, nextUnlockFactor: Uint8Array): Promise<void> {
    await this.backend.changePassphrase(currentUnlockFactor, nextUnlockFactor);
    await this.refresh();
  }

  async changeWrappingKey(
    currentWrappingKey: Uint8Array,
    nextWrappingKey: Uint8Array,
    nextSalt: Uint8Array,
  ): Promise<void> {
    await this.backend.changeWrappingKey(currentWrappingKey, nextWrappingKey, nextSalt);
    await this.refresh();
  }

  async deleteExpired(input: DeleteExpiredVaultSecretsInput): Promise<void> {
    await this.backend.deleteExpired(input);
    await this.refresh();
  }

  async deleteSecret(input: DeleteVaultSecretInput): Promise<void> {
    await this.backend.deleteSecret(input);
    await this.refresh();
  }

  async exists(input: GetVaultSecretInput): Promise<boolean> {
    const result = await this.backend.exists(input);
    await this.refresh();
    return result;
  }

  async getPolicy(): Promise<VaultPolicy> {
    const policy = await this.backend.getPolicy();
    this.lifetime.refresh(policy);
    return policy;
  }

  async getSecret(input: GetVaultSecretInput): Promise<VaultSecretPayload> {
    const result = await this.backend.getSecret(input);
    await this.refresh();
    return result;
  }

  async lock(): Promise<void> {
    await this.backend.lock();
    this.lifetime.clear();
  }

  async putSecret(input: PutVaultSecretInput): Promise<VaultSecretReference> {
    const result = await this.backend.putSecret(input);
    await this.refresh();
    return result;
  }

  async reset(): Promise<void> {
    this.lifetime.clear();
    await this.onReset?.();
    await this.backend.reset();
  }

  async setPolicy(policy: VaultPolicy): Promise<VaultPolicy> {
    const result = await this.backend.setPolicy(policy);
    this.lifetime.refresh(result);
    return result;
  }

  async status(): Promise<VaultStatus> {
    const result = await this.backend.status();
    if (result.lockState !== 'not_initialized') await this.refresh();
    return { ...result, daemonRunning: true };
  }

  async touch(input: TouchVaultSecretInput): Promise<void> {
    await this.backend.touch(input);
    await this.refresh();
  }

  async unlock(unlockFactor: Uint8Array): Promise<VaultStatus> {
    const result = await this.backend.unlock(unlockFactor);
    await this.refresh();
    return { ...result, daemonRunning: true };
  }

  async unlockSalt(): Promise<Uint8Array> {
    return this.backend.unlockSalt();
  }

  async unlockWithWrappingKey(wrappingKey: Uint8Array, salt: Uint8Array): Promise<VaultStatus> {
    const result = await this.backend.unlockWithWrappingKey(wrappingKey, salt);
    await this.refresh();
    return { ...result, daemonRunning: true };
  }

  private async refresh(): Promise<void> {
    this.lifetime.refresh(await this.backend.getPolicy());
  }
}
