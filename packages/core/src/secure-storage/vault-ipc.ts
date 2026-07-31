import { Buffer } from 'node:buffer';
import { randomFillSync } from 'node:crypto';
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
  | 'daemon.info'
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
  | 'vault.unlock'
  | 'vault.unlockSalt';

export const VAULT_IPC_MAX_MESSAGE_BYTES = 1024 * 1024;
export const VAULT_IPC_METHODS = [
  'daemon.info',
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
  'vault.unlockSalt',
] as const satisfies readonly VaultIpcMethod[];

const LENGTH_BYTES = 4;
const ATTACHMENT_HEADER_BYTES = 8;
const ATTACHMENT_MARKER = '$inflowVaultAttachment';

export function encodeVaultIpcMessage(message: VaultIpcMessage): Buffer {
  const attachments: Uint8Array[] = [];
  const json = Buffer.from(JSON.stringify(encodeAttachments(message, attachments)), 'utf8');
  const attachmentBytes = attachments.reduce(
    (total, attachment) => total + LENGTH_BYTES + attachment.byteLength * 2,
    0,
  );
  const bodyLength = ATTACHMENT_HEADER_BYTES + json.byteLength + attachmentBytes;
  if (bodyLength > VAULT_IPC_MAX_MESSAGE_BYTES) {
    throw new SecureStorageError('secure_storage_invalid_path', 'Vault IPC message is too large.');
  }
  const frame = Buffer.alloc(LENGTH_BYTES + bodyLength);
  frame.writeUInt32BE(bodyLength, 0);
  frame.writeUInt32BE(json.byteLength, LENGTH_BYTES);
  frame.writeUInt32BE(attachments.length, LENGTH_BYTES * 2);
  json.copy(frame, LENGTH_BYTES + ATTACHMENT_HEADER_BYTES);
  let offset = LENGTH_BYTES + ATTACHMENT_HEADER_BYTES + json.byteLength;
  for (const attachment of attachments) {
    frame.writeUInt32BE(attachment.byteLength * 2, offset);
    offset += LENGTH_BYTES;
    const mask = frame.subarray(offset, offset + attachment.byteLength);
    randomFillSync(mask);
    offset += attachment.byteLength;
    for (let index = 0; index < attachment.byteLength; index += 1) {
      frame[offset + index] = (attachment[index] ?? 0) ^ (mask[index] ?? 0);
    }
    offset += attachment.byteLength;
  }
  json.fill(0);
  return frame;
}

export function decodeVaultIpcFrame(frame: Uint8Array): VaultIpcMessage {
  if (frame.byteLength < LENGTH_BYTES + ATTACHMENT_HEADER_BYTES) {
    throw new SecureStorageError('secure_storage_corrupt', 'Vault IPC frame is truncated.');
  }
  const bytes = Buffer.from(frame);
  try {
    const length = bytes.readUInt32BE(0);
    if (length > VAULT_IPC_MAX_MESSAGE_BYTES) {
      throw new SecureStorageError('secure_storage_invalid_path', 'Vault IPC message is too large.');
    }
    if (bytes.byteLength !== LENGTH_BYTES + length) {
      throw new SecureStorageError('secure_storage_corrupt', 'Vault IPC frame length is invalid.');
    }
    const jsonLength = bytes.readUInt32BE(LENGTH_BYTES);
    const attachmentCount = bytes.readUInt32BE(LENGTH_BYTES * 2);
    const jsonStart = LENGTH_BYTES + ATTACHMENT_HEADER_BYTES;
    const jsonEnd = jsonStart + jsonLength;
    if (jsonEnd > bytes.byteLength) {
      throw new SecureStorageError('secure_storage_corrupt', 'Vault IPC frame attachments are malformed.');
    }
    const attachments: Buffer[] = [];
    let offset = jsonEnd;
    for (let index = 0; index < attachmentCount; index += 1) {
      if (offset + LENGTH_BYTES > bytes.byteLength) {
        throw new SecureStorageError('secure_storage_corrupt', 'Vault IPC frame attachments are malformed.');
      }
      const attachmentLength = bytes.readUInt32BE(offset);
      offset += LENGTH_BYTES;
      if (offset + attachmentLength > bytes.byteLength) {
        throw new SecureStorageError('secure_storage_corrupt', 'Vault IPC frame attachments are malformed.');
      }
      if (attachmentLength % 2 !== 0) {
        throw new SecureStorageError('secure_storage_corrupt', 'Vault IPC attachment masking is malformed.');
      }
      const valueLength = attachmentLength / 2;
      const attachment = Buffer.alloc(valueLength);
      for (let index = 0; index < valueLength; index += 1) {
        attachment[index] = (bytes[offset + index] ?? 0) ^ (bytes[offset + valueLength + index] ?? 0);
      }
      attachments.push(attachment);
      offset += attachmentLength;
    }
    if (offset !== bytes.byteLength) {
      throw new SecureStorageError('secure_storage_corrupt', 'Vault IPC frame attachments are malformed.');
    }
    const parsed = JSON.parse(bytes.subarray(jsonStart, jsonEnd).toString('utf8')) as unknown;
    return parseVaultIpcMessage(decodeAttachments(parsed, attachments));
  } finally {
    bytes.fill(0);
  }
}

export function clearVaultIpcBytes(value: unknown): void {
  if (value instanceof Uint8Array) {
    value.fill(0);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) clearVaultIpcBytes(item);
    return;
  }
  if (!isRecord(value)) return;
  for (const item of Object.values(value)) clearVaultIpcBytes(item);
}

function encodeAttachments(value: unknown, attachments: Uint8Array[]): unknown {
  if (value instanceof Uint8Array) {
    const index = attachments.push(value) - 1;
    return { [ATTACHMENT_MARKER]: index };
  }
  if (Array.isArray(value)) return value.map((item) => encodeAttachments(item, attachments));
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, encodeAttachments(item, attachments)]));
}

function decodeAttachments(value: unknown, attachments: Buffer[]): unknown {
  if (isRecord(value) && Object.keys(value).length === 1 && ATTACHMENT_MARKER in value) {
    const index = value[ATTACHMENT_MARKER];
    if (!Number.isSafeInteger(index) || (index as number) < 0 || (index as number) >= attachments.length) {
      throw new SecureStorageError('secure_storage_corrupt', 'Vault IPC attachment reference is malformed.');
    }
    return attachments[index as number];
  }
  if (Array.isArray(value)) return value.map((item) => decodeAttachments(item, attachments));
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, decodeAttachments(item, attachments)]));
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
