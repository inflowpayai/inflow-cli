import type { VaultRecordStatus, VaultSecretKind, VaultSecretReference } from './vault-types.js';

export type VaultLockState = 'locked' | 'not_initialized' | 'unlocked';
export type Awaitable<T> = Promise<T> | T;

export const VAULT_BACKEND_METHODS = [
  'changePassphrase',
  'changeWrappingKey',
  'deleteExpired',
  'deleteSecret',
  'exists',
  'getPolicy',
  'getSecret',
  'lock',
  'putSecret',
  'reset',
  'setPolicy',
  'status',
  'touch',
  'unlock',
  'unlockSalt',
  'unlockWithWrappingKey',
] as const;

export const DEFAULT_VAULT_POLICY = {
  idleTimeoutSeconds: 28_800,
  lockOnSleep: true,
} as const satisfies VaultPolicy;

export interface VaultStatus {
  lockState: VaultLockState;
  daemonRunning: boolean;
}

export interface VaultPolicy {
  idleTimeoutSeconds: number | null;
  lockOnSleep: boolean;
}

export interface VaultSecretPayload {
  payload: Uint8Array;
  reference: VaultSecretReference;
}

export interface PutVaultSecretInput {
  expectedKind: VaultSecretKind;
  expiresAt?: string;
  payload: Uint8Array;
  reference?: VaultSecretReference;
}

export interface GetVaultSecretInput {
  expectedKind: VaultSecretKind;
  reference: VaultSecretReference;
}

export interface DeleteVaultSecretInput {
  expectedKind: VaultSecretKind;
  reference: VaultSecretReference;
}

export interface TouchVaultSecretInput {
  expectedKind: VaultSecretKind;
  reference: VaultSecretReference;
}

export interface DeleteExpiredVaultSecretsInput {
  now: string;
}

export interface VaultBackend {
  changePassphrase(currentUnlockFactor: Uint8Array, nextUnlockFactor: Uint8Array): Awaitable<void>;
  changeWrappingKey(currentWrappingKey: Uint8Array, nextWrappingKey: Uint8Array, nextSalt: Uint8Array): Awaitable<void>;
  deleteExpired(input: DeleteExpiredVaultSecretsInput): Awaitable<void>;
  deleteSecret(input: DeleteVaultSecretInput): Awaitable<void>;
  exists(input: GetVaultSecretInput): Awaitable<boolean>;
  getPolicy(): Awaitable<VaultPolicy>;
  getSecret(input: GetVaultSecretInput): Awaitable<VaultSecretPayload>;
  lock(): Awaitable<void>;
  putSecret(input: PutVaultSecretInput): Awaitable<VaultSecretReference>;
  reset(): Awaitable<void>;
  setPolicy(policy: VaultPolicy): Awaitable<VaultPolicy>;
  status(): Awaitable<VaultStatus>;
  touch(input: TouchVaultSecretInput): Awaitable<void>;
  unlock(unlockFactor: Uint8Array): Awaitable<VaultStatus>;
  unlockSalt(): Awaitable<Uint8Array>;
  unlockWithWrappingKey(wrappingKey: Uint8Array, salt: Uint8Array): Awaitable<VaultStatus>;
}

export interface StoredVaultSecretEnvelope {
  expiresAt?: string;
  kind: VaultSecretKind;
  reference: VaultSecretReference;
  status: VaultRecordStatus;
}
