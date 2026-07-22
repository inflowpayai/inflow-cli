import { Buffer } from 'node:buffer';
import { SecureStorageError } from './errors.js';

export interface VaultIpcError {
  code: string;
  message: string;
}

export interface VaultIpcRequest {
  id: string;
  method: VaultIpcMethod;
  params: Record<string, unknown>;
  version: 1;
}

export type VaultIpcResponse =
  | {
      id: string;
      ok: false;
      error: VaultIpcError;
      version: 1;
    }
  | {
      id: string;
      ok: true;
      result: Record<string, unknown>;
      version: 1;
    };

export type VaultIpcMessage = VaultIpcRequest | VaultIpcResponse;

export type VaultIpcMethod =
  | 'daemon.shutdown'
  | 'secret.delete'
  | 'secret.deleteExpired'
  | 'secret.exists'
  | 'secret.get'
  | 'secret.put'
  | 'secret.touch'
  | 'vault.changePassphrase'
  | 'vault.getPolicy'
  | 'vault.lock'
  | 'vault.reset'
  | 'vault.setPolicy'
  | 'vault.status'
  | 'vault.unlock';

export const VAULT_IPC_MAX_MESSAGE_BYTES = 1024 * 1024;
export const VAULT_IPC_METHODS = [
  'daemon.shutdown',
  'secret.delete',
  'secret.deleteExpired',
  'secret.exists',
  'secret.get',
  'secret.put',
  'secret.touch',
  'vault.changePassphrase',
  'vault.getPolicy',
  'vault.lock',
  'vault.reset',
  'vault.setPolicy',
  'vault.status',
  'vault.unlock',
] as const satisfies readonly VaultIpcMethod[];

const LENGTH_BYTES = 4;

export function encodeVaultIpcMessage(message: VaultIpcMessage): Buffer {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  if (body.byteLength > VAULT_IPC_MAX_MESSAGE_BYTES) {
    throw new SecureStorageError('secure_storage_invalid_path', 'Vault IPC message is too large.');
  }
  const frame = Buffer.alloc(LENGTH_BYTES + body.byteLength);
  frame.writeUInt32BE(body.byteLength, 0);
  body.copy(frame, LENGTH_BYTES);
  return frame;
}

export function decodeVaultIpcFrame(frame: Uint8Array): VaultIpcMessage {
  if (frame.byteLength < LENGTH_BYTES) {
    throw new SecureStorageError('secure_storage_corrupt', 'Vault IPC frame is truncated.');
  }
  const bytes = Buffer.from(frame);
  const length = bytes.readUInt32BE(0);
  if (length > VAULT_IPC_MAX_MESSAGE_BYTES) {
    throw new SecureStorageError('secure_storage_invalid_path', 'Vault IPC message is too large.');
  }
  if (bytes.byteLength !== LENGTH_BYTES + length) {
    throw new SecureStorageError('secure_storage_corrupt', 'Vault IPC frame length is invalid.');
  }
  const parsed = JSON.parse(bytes.subarray(LENGTH_BYTES).toString('utf8')) as unknown;
  return parseVaultIpcMessage(parsed);
}

function parseVaultIpcMessage(value: unknown): VaultIpcMessage {
  if (!isRecord(value) || value['version'] !== 1 || typeof value['id'] !== 'string') {
    throw new SecureStorageError('secure_storage_corrupt', 'Vault IPC message is malformed.');
  }
  if ('method' in value) return parseVaultIpcRequest(value);
  return parseVaultIpcResponse(value);
}

function parseVaultIpcRequest(value: Record<string, unknown>): VaultIpcRequest {
  if (!isVaultIpcMethod(value['method']) || !isRecord(value['params'])) {
    throw new SecureStorageError('secure_storage_corrupt', 'Vault IPC request is malformed.');
  }
  return {
    id: value['id'] as string,
    method: value['method'],
    params: value['params'],
    version: 1,
  };
}

function parseVaultIpcResponse(value: Record<string, unknown>): VaultIpcResponse {
  if (value['ok'] === true && isRecord(value['result'])) {
    return {
      id: value['id'] as string,
      ok: true,
      result: value['result'],
      version: 1,
    };
  }
  if (value['ok'] === false && isRecord(value['error'])) {
    const code = value['error']['code'];
    const message = value['error']['message'];
    if (typeof code === 'string' && typeof message === 'string') {
      return {
        error: { code, message },
        id: value['id'] as string,
        ok: false,
        version: 1,
      };
    }
  }
  throw new SecureStorageError('secure_storage_corrupt', 'Vault IPC response is malformed.');
}

function isVaultIpcMethod(value: unknown): value is VaultIpcMethod {
  return typeof value === 'string' && VAULT_IPC_METHODS.includes(value as VaultIpcMethod);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
