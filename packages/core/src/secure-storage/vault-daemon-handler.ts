import { Buffer } from 'node:buffer';
import { SecureStorageError } from './errors.js';
import type { VaultBackend, VaultPolicy, VaultSecretPayload } from './vault-backend.js';
import type { VaultIpcRequest, VaultIpcResponse } from './vault-ipc.js';
import { isVaultSecretKind, parseVaultSecretReference, type VaultSecretKind } from './vault-types.js';

export async function handleVaultIpcRequest(
  backend: VaultBackend,
  request: VaultIpcRequest,
  daemonInfo?: VaultDaemonInfo,
): Promise<VaultIpcResponse> {
  try {
    const result = await dispatchVaultIpcRequest(backend, request, daemonInfo);
    return { id: request.id, ok: true, result, version: 1 };
  } catch (cause) {
    return {
      error: errorResponse(cause),
      id: request.id,
      ok: false,
      version: 1,
    };
  }
}

export interface VaultDaemonInfo {
  buildId: string | null;
  cliVersion: string | null;
  executablePath: string;
  pid: number;
}

async function dispatchVaultIpcRequest(
  backend: VaultBackend,
  request: VaultIpcRequest,
  daemonInfo: VaultDaemonInfo | undefined,
): Promise<Record<string, unknown>> {
  switch (request.method) {
    case 'daemon.info':
      return daemonInfoResult(daemonInfo);
    case 'daemon.shutdown':
      await backend.lock();
      return {};
    case 'secret.delete':
      await backend.deleteSecret(parseSecretReferenceParams(request.params));
      return {};
    case 'secret.deleteExpired':
      await backend.deleteExpired({ now: parseStringParam(request.params, 'now') });
      return {};
    case 'secret.exists':
      return { exists: await backend.exists(parseSecretReferenceParams(request.params)) };
    case 'secret.get':
      return secretPayloadResult(await backend.getSecret(parseSecretReferenceParams(request.params)));
    case 'secret.put':
      return { reference: (await backend.putSecret(parsePutSecretParams(request.params))).reference };
    case 'secret.touch':
      await backend.touch(parseSecretReferenceParams(request.params));
      return {};
    case 'vault.changePassphrase':
      await backend.changePassphrase(
        parseBase64Param(request.params, 'currentUnlockFactor'),
        parseBase64Param(request.params, 'nextUnlockFactor'),
      );
      return {};
    case 'vault.getPolicy':
      return policyResult(await backend.getPolicy());
    case 'vault.lock':
      await backend.lock();
      return {};
    case 'vault.reset':
      await backend.reset();
      return {};
    case 'vault.setPolicy':
      return policyResult(await backend.setPolicy(parsePolicyParam(request.params)));
    case 'vault.status':
      return statusResult(await backend.status());
    case 'vault.unlock':
      return statusResult(await backend.unlock(parseBase64Param(request.params, 'unlockFactor')));
  }
}

function daemonInfoResult(info: VaultDaemonInfo | undefined): Record<string, unknown> {
  if (info === undefined) {
    throw new SecureStorageError('secure_storage_unavailable', 'Vault daemon identity is unavailable.');
  }
  return {
    buildId: info.buildId,
    cliVersion: info.cliVersion,
    executablePath: info.executablePath,
    pid: info.pid,
  };
}

function parsePutSecretParams(params: Record<string, unknown>) {
  const input = {
    expectedKind: parseKindParam(params),
    payload: parseBase64Param(params, 'payload'),
  };
  const reference = parseOptionalStringParam(params, 'reference');
  const withReference = reference === undefined ? input : { ...input, reference: parseVaultSecretReference(reference) };
  const expiresAt = parseOptionalStringParam(params, 'expiresAt');
  if (expiresAt !== undefined) return { ...withReference, expiresAt };
  return withReference;
}

function parseSecretReferenceParams(params: Record<string, unknown>) {
  return {
    expectedKind: parseKindParam(params),
    reference: parseVaultSecretReference(parseStringParam(params, 'reference')),
  };
}

function parsePolicyParam(params: Record<string, unknown>): VaultPolicy {
  const policy = params['policy'];
  if (!isRecord(policy)) {
    throw new SecureStorageError('secure_storage_invalid_path', 'Vault IPC request parameters are malformed.');
  }
  const idleTimeoutSeconds = policy['idleTimeoutSeconds'];
  const lockOnSleep = policy['lockOnSleep'];
  if (!(idleTimeoutSeconds === null || isNonNegativeInteger(idleTimeoutSeconds)) || typeof lockOnSleep !== 'boolean') {
    throw new SecureStorageError('secure_storage_invalid_path', 'Vault IPC request parameters are malformed.');
  }
  return { idleTimeoutSeconds, lockOnSleep };
}

function parseKindParam(params: Record<string, unknown>): VaultSecretKind {
  const kind = params['expectedKind'];
  if (!isVaultSecretKind(kind)) {
    throw new SecureStorageError('secure_storage_invalid_path', 'Vault IPC request parameters are malformed.');
  }
  return kind;
}

function parseBase64Param(params: Record<string, unknown>, name: string): Buffer {
  const value = parseStringParam(params, name);
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 !== 0) {
    throw new SecureStorageError('secure_storage_invalid_path', 'Vault IPC request parameters are malformed.');
  }
  return Buffer.from(value, 'base64');
}

function parseStringParam(params: Record<string, unknown>, name: string): string {
  const value = params[name];
  if (typeof value !== 'string' || value.length === 0) {
    throw new SecureStorageError('secure_storage_invalid_path', 'Vault IPC request parameters are malformed.');
  }
  return value;
}

function parseOptionalStringParam(params: Record<string, unknown>, name: string): string | undefined {
  const value = params[name];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length === 0) {
    throw new SecureStorageError('secure_storage_invalid_path', 'Vault IPC request parameters are malformed.');
  }
  return value;
}

function secretPayloadResult(secret: VaultSecretPayload): Record<string, unknown> {
  return {
    payload: Buffer.from(secret.payload).toString('base64'),
    reference: secret.reference.reference,
  };
}

function policyResult(policy: VaultPolicy): Record<string, unknown> {
  return {
    idleTimeoutSeconds: policy.idleTimeoutSeconds,
    lockOnSleep: policy.lockOnSleep,
  };
}

function statusResult(status: { daemonRunning: boolean; lockState: string }): Record<string, unknown> {
  return {
    daemonRunning: status.daemonRunning,
    lockState: status.lockState,
  };
}

function errorResponse(cause: unknown): { code: string; message: string } {
  if (cause instanceof SecureStorageError) {
    return { code: cause.secureStorageCode, message: cause.message };
  }
  return { code: 'secure_storage_io_error', message: 'The InFlow vault operation failed.' };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
