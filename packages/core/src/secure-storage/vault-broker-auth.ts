import { Buffer } from 'node:buffer';
import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign,
  verify,
  type KeyObject,
} from 'node:crypto';
import { chmodSync, lstatSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import type { Socket } from 'node:net';
import path from 'node:path';
import { SecureStorageError } from './errors.js';
import {
  createVaultPeerVerificationConfig,
  socketFileDescriptor,
  verifyVaultPeerVerificationConfig,
  type VaultSocketPeer,
  type VaultSocketPeerVerifier,
} from './vault-peer-verifier.js';
import { runtimeRequire } from './runtime-require.js';

const CHALLENGE_MAGIC = Buffer.from('IFB1');
const RESPONSE_MAGIC = Buffer.from('IFR1');
const AUTHENTICATION_DOMAIN = Buffer.from('inflow-vault-broker-auth-v1\0');
const CHALLENGE_BYTES = 36;
const RESPONSE_BYTES = 68;
const BROKER_KEY_DIRECTORY = '/var/lib/inflow-broker';
const BROKER_PRIVATE_KEY = path.join(BROKER_KEY_DIRECTORY, 'private.der');
export const LINUX_VAULT_BROKER_PUBLIC_KEY = path.join(BROKER_KEY_DIRECTORY, 'public.der');

interface NativePeerCredentialsModule {
  peerCredentials(fd: number): Pick<VaultSocketPeer, 'pid' | 'uid'>;
}

export async function ensureLinuxVaultBrokerKey(): Promise<KeyObject> {
  await mkdir(BROKER_KEY_DIRECTORY, { mode: 0o755, recursive: true });
  try {
    const privateKey = readBrokerPrivateKey();
    ensureBrokerPublicKey(privateKey);
    return privateKey;
  } catch (cause) {
    if (!isMissingPath(cause)) throw cause;
  }
  const pair = generateKeyPairSync('ed25519');
  const privateBytes = pair.privateKey.export({ format: 'der', type: 'pkcs8' });
  const suffix = `${process.pid}.${Date.now()}`;
  const privateTemporary = `${BROKER_PRIVATE_KEY}.${suffix}`;
  try {
    writeFileSync(privateTemporary, privateBytes, { flag: 'wx', mode: 0o600 });
    renameSync(privateTemporary, BROKER_PRIVATE_KEY);
    chmodSync(BROKER_PRIVATE_KEY, 0o600);
  } finally {
    privateBytes.fill(0);
  }
  const privateKey = readBrokerPrivateKey();
  ensureBrokerPublicKey(privateKey);
  return privateKey;
}

export function createLinuxVaultBrokerPeerVerifier(expectedUserId: number): VaultSocketPeerVerifier {
  const config = createVaultPeerVerificationConfig({ expectedUserId, requireSameUser: false });
  verifyVaultPeerVerificationConfig(config);
  const native = runtimeRequire()(config.nativeModulePath) as NativePeerCredentialsModule;
  return async (socket) => {
    const peer = native.peerCredentials(socketFileDescriptor(socket));
    if (peer.uid !== expectedUserId) {
      throw new SecureStorageError('secure_storage_peer_verification_failed', 'Vault peer verification failed.');
    }
    const publicKey = await readBrokerPublicKeyWhenReady();
    const nonce = randomBytes(32);
    const challenge = Buffer.concat([CHALLENGE_MAGIC, nonce]);
    try {
      await writeBytes(socket, challenge);
      const response = await readExact(socket, RESPONSE_BYTES);
      try {
        if (
          !response.subarray(0, RESPONSE_MAGIC.byteLength).equals(RESPONSE_MAGIC) ||
          !verify(
            null,
            signedChallenge(nonce, process.pid, currentUserId()),
            publicKey,
            response.subarray(RESPONSE_MAGIC.byteLength),
          )
        ) {
          throw new SecureStorageError('secure_storage_peer_verification_failed', 'Vault peer verification failed.');
        }
      } finally {
        response.fill(0);
      }
    } finally {
      challenge.fill(0);
      nonce.fill(0);
    }
    return { path: config.expectedExecutablePath, pid: peer.pid, uid: peer.uid };
  };
}

async function readBrokerPublicKeyWhenReady(): Promise<KeyObject> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try {
      return readBrokerPublicKey();
    } catch (cause) {
      if (!isMissingPath(cause)) throw cause;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new SecureStorageError('secure_storage_unavailable', 'The InFlow vault broker identity is unavailable.');
}

export async function authenticateLinuxVaultBrokerClient(
  socket: Socket,
  peer: VaultSocketPeer,
  privateKey: KeyObject,
): Promise<void> {
  const challenge = await readExact(socket, CHALLENGE_BYTES);
  try {
    if (!challenge.subarray(0, CHALLENGE_MAGIC.byteLength).equals(CHALLENGE_MAGIC)) {
      throw new SecureStorageError('secure_storage_peer_verification_failed', 'Vault peer verification failed.');
    }
    const signature = sign(
      null,
      signedChallenge(challenge.subarray(CHALLENGE_MAGIC.byteLength), peer.pid, peer.uid),
      privateKey,
    );
    const response = Buffer.concat([RESPONSE_MAGIC, signature]);
    try {
      socket.pause();
      await writeBytes(socket, response);
    } finally {
      response.fill(0);
      signature.fill(0);
    }
  } finally {
    challenge.fill(0);
  }
}

function readBrokerPrivateKey(): KeyObject {
  validateBrokerKeyPath(BROKER_PRIVATE_KEY, 0o077);
  return createPrivateKey({
    format: 'der',
    key: readFileSync(BROKER_PRIVATE_KEY),
    type: 'pkcs8',
  });
}

function readBrokerPublicKey(): KeyObject {
  validateBrokerKeyPath(LINUX_VAULT_BROKER_PUBLIC_KEY, 0o022);
  return createPublicKey({
    format: 'der',
    key: readFileSync(LINUX_VAULT_BROKER_PUBLIC_KEY),
    type: 'spki',
  });
}

function ensureBrokerPublicKey(privateKey: KeyObject): void {
  try {
    readBrokerPublicKey();
    chmodSync(LINUX_VAULT_BROKER_PUBLIC_KEY, 0o644);
    const expected = createPublicKey(privateKey).export({ format: 'der', type: 'spki' });
    try {
      if (!expected.equals(readFileSync(LINUX_VAULT_BROKER_PUBLIC_KEY))) {
        throw new SecureStorageError('secure_storage_unavailable', 'The InFlow vault broker identity is invalid.');
      }
    } finally {
      expected.fill(0);
    }
    return;
  } catch (cause) {
    if (!isMissingPath(cause)) throw cause;
  }
  const publicBytes = createPublicKey(privateKey).export({ format: 'der', type: 'spki' });
  const temporary = `${LINUX_VAULT_BROKER_PUBLIC_KEY}.${process.pid}.${Date.now()}`;
  try {
    writeFileSync(temporary, publicBytes, { flag: 'wx', mode: 0o644 });
    renameSync(temporary, LINUX_VAULT_BROKER_PUBLIC_KEY);
    chmodSync(LINUX_VAULT_BROKER_PUBLIC_KEY, 0o644);
  } finally {
    publicBytes.fill(0);
  }
}

function validateBrokerKeyPath(filePath: string, forbiddenMode: number): void {
  const directory = lstatSync(BROKER_KEY_DIRECTORY);
  const file = lstatSync(filePath);
  if (
    directory.uid !== 0 ||
    !directory.isDirectory() ||
    directory.isSymbolicLink() ||
    (directory.mode & 0o022) !== 0 ||
    realpathSync(BROKER_KEY_DIRECTORY) !== BROKER_KEY_DIRECTORY ||
    file.uid !== 0 ||
    !file.isFile() ||
    file.isSymbolicLink() ||
    (file.mode & forbiddenMode) !== 0 ||
    realpathSync(filePath) !== filePath
  ) {
    throw new SecureStorageError('secure_storage_unavailable', 'The InFlow vault broker identity is invalid.');
  }
}

function signedChallenge(nonce: Uint8Array, processId: number, userId: number): Buffer {
  const identity = Buffer.alloc(8);
  identity.writeUInt32BE(processId, 0);
  identity.writeUInt32BE(userId, 4);
  return Buffer.concat([AUTHENTICATION_DOMAIN, nonce, identity]);
}

function currentUserId(): number {
  const userId = process.getuid?.();
  if (userId === undefined) {
    throw new SecureStorageError('secure_storage_peer_verification_failed', 'Vault peer verification failed.');
  }
  return userId;
}

function writeBytes(socket: Socket, bytes: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (cause: Error): void => {
      reject(cause);
    };
    socket.once('error', onError);
    socket.write(bytes, (cause) => {
      socket.off('error', onError);
      if (cause === undefined || cause === null) resolve();
      else reject(cause instanceof Error ? cause : new Error('Vault broker authentication write failed.'));
    });
  });
}

function readExact(socket: Socket, length: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    const cleanup = (): void => {
      socket.off('data', onData);
      socket.off('end', onEnd);
      socket.off('error', onError);
    };
    const onData = (chunk: Buffer): void => {
      chunks.push(chunk);
      total += chunk.byteLength;
      if (total < length) return;
      cleanup();
      const bytes = Buffer.concat(chunks);
      for (const item of chunks) item.fill(0);
      if (bytes.byteLength !== length) {
        bytes.fill(0);
        reject(new SecureStorageError('secure_storage_peer_verification_failed', 'Vault peer verification failed.'));
        return;
      }
      resolve(bytes);
    };
    const onEnd = (): void => {
      cleanup();
      reject(new SecureStorageError('secure_storage_peer_verification_failed', 'Vault peer verification failed.'));
    };
    const onError = (cause: Error): void => {
      cleanup();
      reject(cause);
    };
    socket.on('data', onData);
    socket.once('end', onEnd);
    socket.once('error', onError);
    socket.resume();
  });
}

function isMissingPath(cause: unknown): boolean {
  return typeof cause === 'object' && cause !== null && 'code' in cause && cause.code === 'ENOENT';
}
