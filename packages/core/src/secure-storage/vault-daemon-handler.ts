import { Buffer } from 'node:buffer';
import { SecureStorageError } from './errors.js';
import type { VaultBackend, VaultPolicy, VaultSecretPayload } from './vault-backend.js';
import type { VaultIpcRequest, VaultIpcResponse } from './vault-ipc.js';
import { isVaultSecretKind, parseVaultSecretReference, type VaultSecretKind } from './vault-types.js';

export async function handleVaultIpcRequest(
  backend: VaultBackend,
  request: VaultIpcRequest,
  daemonInfo?: VaultDaemonInfo,
  options: VaultDaemonHandlerOptions = {},
): Promise<VaultIpcResponse> {
  try {
    const result = await dispatchVaultIpcRequest(backend, request, daemonInfo, options);
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

export interface VaultDaemonHandlerOptions {
  allowDaemonShutdown?: boolean;
}

async function dispatchVaultIpcRequest(
  backend: VaultBackend,
  request: VaultIpcRequest,
  daemonInfo: VaultDaemonInfo | undefined,
  options: VaultDaemonHandlerOptions,
): Promise<Record<string, unknown>> {
  switch (request.method) {
    case 'daemon.info':
      return daemonInfoResult(daemonInfo);
    case 'daemon.shutdown':
      if (options.allowDaemonShutdown === false) {
        throw new SecureStorageError(
          'secure_storage_unavailable',
          'The vault service lifecycle is managed by the operating system.',
        );
      }
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
    case 'secret.put': {
      const input = parsePutSecretParams(request.params);
      try {
        return { reference: (await backend.putSecret(input)).reference };
      } finally {
        input.payload.fill(0);
      }
    }
    case 'secret.touch':
      await backend.touch(parseSecretReferenceParams(request.params));
      return {};
    case 'vault.changePassphrase': {
      const currentWrappingKey = parseBytesParam(request.params, 'currentWrappingKey');
      const nextWrappingKey = parseBytesParam(request.params, 'nextWrappingKey');
      const nextSalt = parseBytesParam(request.params, 'nextSalt');
      try {
        await backend.changeWrappingKey(currentWrappingKey, nextWrappingKey, nextSalt);
        return {};
      } finally {
        currentWrappingKey.fill(0);
        nextWrappingKey.fill(0);
        nextSalt.fill(0);
      }
    }
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
    case 'vault.unlock': {
      const wrappingKey = parseBytesParam(request.params, 'wrappingKey');
      const salt = parseBytesParam(request.params, 'salt');
      try {
        return statusResult(await backend.unlockWithWrappingKey(wrappingKey, salt));
      } finally {
        wrappingKey.fill(0);
        salt.fill(0);
      }
    }
    case 'vault.unlockSalt':
      return { salt: await backend.unlockSalt() };
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
    payload: parseBytesParam(params, 'payload'),
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

function parseBytesParam(params: Record<string, unknown>, name: string): Buffer {
  const value = params[name];
  if (!(value instanceof Uint8Array) || value.byteLength === 0) {
    throw new SecureStorageError('secure_storage_invalid_path', 'Vault IPC request parameters are malformed.');
  }
  return Buffer.from(value);
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
    payload: secret.payload,
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
