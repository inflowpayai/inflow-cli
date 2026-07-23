import process from 'node:process';
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
import { SecureSqliteRepository } from './sqlite.js';
import { LocalVaultBackend } from './vault-local-backend.js';
import {
  createVaultSocketPeerVerifier,
  shouldRequireVaultPeerVerification,
  type VaultSocketPeerVerifier,
} from './vault-peer-verifier.js';
import { vaultFilePaths } from './vault-files.js';
import { startVaultSocketServer, type VaultSocketServer } from './vault-socket.js';
import type { VaultSecretReference } from './vault-types.js';

export interface LocalVaultDaemonOptions {
  buildId?: string;
  cliVersion?: string;
  rootDirectory?: string;
  sleepCheckIntervalMilliseconds?: number;
  sleepDriftThresholdMilliseconds?: number;
}

export interface LocalVaultDaemon {
  close(): Promise<void>;
  closed: Promise<void>;
  socketPath: string;
}

export interface LocalVaultDaemonRuntime {
  exit(code: number): void;
  once(signal: 'SIGINT' | 'SIGTERM', handler: () => Promise<void>): void;
}

export async function startLocalVaultDaemon(options: LocalVaultDaemonOptions = {}): Promise<LocalVaultDaemon> {
  const paths = vaultFilePaths(options.rootDirectory);
  const repository = new SecureSqliteRepository({ databasePath: paths.database });
  const backend = new LocalVaultBackend({ paths, repository });
  const lifetime = new VaultDaemonLifetime(lifetimeOptions(options));
  const shutdown = { close: undefined as (() => Promise<void>) | undefined };
  let resolveClosed: () => void;
  const closedPromise = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  const server = await startVaultSocketServer(
    socketServerOptions(
      new LifetimeVaultBackend(backend, lifetime),
      paths.socket,
      options.cliVersion ?? null,
      options.buildId ?? null,
      () => {
        void shutdown.close?.();
      },
    ),
  );
  let isClosed = false;
  const close = async (): Promise<void> => {
    if (isClosed) return;
    isClosed = true;
    lifetime.clear();
    try {
      await closeLocalVaultDaemon(repository, server);
    } finally {
      resolveClosed();
    }
  };
  shutdown.close = close;
  lifetime.closeWith(close);
  return {
    close,
    closed: closedPromise,
    socketPath: paths.socket,
  };
}

function socketServerOptions(
  backend: VaultBackend,
  socketPath: string,
  cliVersion: string | null,
  buildId: string | null,
  onShutdown: () => void,
) {
  const options: {
    backend: VaultBackend;
    daemonInfo: { buildId: string | null; cliVersion: string | null; executablePath: string; pid: number };
    onShutdown: () => void;
    peerVerifier?: VaultSocketPeerVerifier;
    socketPath: string;
  } = {
    backend,
    daemonInfo: {
      buildId,
      cliVersion,
      executablePath: process.execPath,
      pid: process.pid,
    },
    onShutdown,
    socketPath,
  };
  if (shouldRequireVaultPeerVerification()) options.peerVerifier = createVaultSocketPeerVerifier();
  return options;
}

export async function runLocalVaultDaemon(options: LocalVaultDaemonOptions = {}): Promise<void> {
  const daemon = await startLocalVaultDaemon(options);
  attachLocalVaultDaemonSignalHandlers(daemon, process);
  await daemon.closed;
}

export function attachLocalVaultDaemonSignalHandlers(daemon: LocalVaultDaemon, runtime: LocalVaultDaemonRuntime): void {
  const close = async (): Promise<void> => {
    await daemon.close();
    runtime.exit(0);
  };
  runtime.once('SIGINT', close);
  runtime.once('SIGTERM', close);
}

async function closeLocalVaultDaemon(repository: SecureSqliteRepository, server: VaultSocketServer): Promise<void> {
  await server.close();
  repository.close();
}

const DEFAULT_SLEEP_CHECK_INTERVAL_MILLISECONDS = 30_000;
const DEFAULT_SLEEP_DRIFT_THRESHOLD_MILLISECONDS = 120_000;

interface VaultDaemonLifetimeOptions {
  sleepCheckIntervalMilliseconds?: number;
  sleepDriftThresholdMilliseconds?: number;
}

function lifetimeOptions(options: LocalVaultDaemonOptions): VaultDaemonLifetimeOptions {
  const result: VaultDaemonLifetimeOptions = {};
  if (options.sleepCheckIntervalMilliseconds !== undefined) {
    result.sleepCheckIntervalMilliseconds = options.sleepCheckIntervalMilliseconds;
  }
  if (options.sleepDriftThresholdMilliseconds !== undefined) {
    result.sleepDriftThresholdMilliseconds = options.sleepDriftThresholdMilliseconds;
  }
  return result;
}

class VaultDaemonLifetime {
  private close: (() => Promise<void>) | undefined;
  private idleTimer: NodeJS.Timeout | undefined;
  private sleepTimer: NodeJS.Timeout | undefined;

  constructor(private readonly options: VaultDaemonLifetimeOptions = {}) {}

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

  closeWith(close: () => Promise<void>): void {
    this.close = close;
  }

  refresh(policy: VaultPolicy): void {
    this.clear();
    if (policy.idleTimeoutSeconds !== null) {
      this.idleTimer = setTimeout(() => {
        void this.close?.();
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
      if (drift >= threshold) void this.close?.();
    }, interval);
    this.sleepTimer.unref();
  }
}

class LifetimeVaultBackend implements VaultBackend {
  constructor(
    private readonly backend: VaultBackend,
    private readonly lifetime: VaultDaemonLifetime,
  ) {}

  async changePassphrase(currentUnlockFactor: Uint8Array, nextUnlockFactor: Uint8Array): Promise<void> {
    await this.backend.changePassphrase(currentUnlockFactor, nextUnlockFactor);
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
    await this.backend.reset();
    this.lifetime.clear();
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

  private async refresh(): Promise<void> {
    this.lifetime.refresh(await this.backend.getPolicy());
  }
}
