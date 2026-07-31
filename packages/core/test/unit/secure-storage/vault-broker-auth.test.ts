import { Buffer } from 'node:buffer';
import { createPublicKey, generateKeyPairSync } from 'node:crypto';
import type * as nodeFs from 'node:fs';
import type * as nodeFsPromises from 'node:fs/promises';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import process from 'node:process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SecureStorageError } from '../../../src/secure-storage/errors.js';

const state = vi.hoisted(() => ({
  nativePeer: { pid: 700, uid: 0 },
  privateExists: true,
  privateKeyBytes: new Uint8Array(),
  publicExists: true,
  publicKeyBytes: new Uint8Array(),
  temporaryFiles: new Map<string, Uint8Array>(),
}));

vi.mock('../../../src/secure-storage/runtime-require.js', () => ({
  runtimeRequire: () => () => ({
    peerCredentials: () => state.nativePeer,
  }),
}));

vi.mock('../../../src/secure-storage/vault-peer-verifier.js', () => ({
  createVaultPeerVerificationConfig: ({ expectedUserId }: { expectedUserId: number }) => ({
    expectedExecutablePath: '/opt/inflow/bin/inflow',
    expectedUserId,
    nativeModulePath: '/opt/inflow/lib/inflow/native/vault_peer_linux.node',
  }),
  socketFileDescriptor: () => 42,
  verifyVaultPeerVerificationConfig: () => undefined,
}));

vi.mock('node:fs', async (importOriginal) => {
  const original = await importOriginal<typeof nodeFs>();
  return {
    ...original,
    chmodSync: (filePath: string, mode: number) => {
      if (!filePath.startsWith('/var/lib/inflow-broker/')) original.chmodSync(filePath, mode);
    },
    lstatSync: (filePath: string) => {
      if (filePath === '/var/lib/inflow-broker') {
        return { isDirectory: () => true, isSymbolicLink: () => false, mode: 0o40755, uid: 0 };
      }
      if (filePath === '/var/lib/inflow-broker/private.der' || filePath === '/var/lib/inflow-broker/public.der') {
        const exists = filePath.endsWith('private.der') ? state.privateExists : state.publicExists;
        if (!exists) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
        return {
          isFile: () => true,
          isSymbolicLink: () => false,
          mode: filePath.endsWith('private.der') ? 0o100600 : 0o100644,
          uid: 0,
        };
      }
      return original.lstatSync(filePath);
    },
    readFileSync: (filePath: string) => {
      if (filePath === '/var/lib/inflow-broker/private.der') return state.privateKeyBytes;
      if (filePath === '/var/lib/inflow-broker/public.der') return state.publicKeyBytes;
      return original.readFileSync(filePath);
    },
    renameSync: (source: string, destination: string) => {
      const bytes = state.temporaryFiles.get(source);
      if (bytes === undefined) return original.renameSync(source, destination);
      if (destination.endsWith('private.der')) {
        state.privateKeyBytes = Uint8Array.from(bytes);
        state.privateExists = true;
      } else {
        state.publicKeyBytes = Uint8Array.from(bytes);
        state.publicExists = true;
      }
      state.temporaryFiles.delete(source);
    },
    realpathSync: (filePath: string) => filePath,
    writeFileSync: (filePath: string, bytes: Uint8Array) => {
      if (!filePath.startsWith('/var/lib/inflow-broker/')) return original.writeFileSync(filePath, bytes);
      state.temporaryFiles.set(filePath, Uint8Array.from(bytes));
    },
  };
});

vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof nodeFsPromises>()),
  mkdir: () => Promise.resolve(undefined),
}));

import {
  authenticateLinuxVaultBrokerClient,
  createLinuxVaultBrokerPeerVerifier,
  ensureLinuxVaultBrokerKey,
} from '../../../src/secure-storage/vault-broker-auth.js';

describe('Linux vault broker authentication', () => {
  let server: Server | undefined;

  beforeEach(() => {
    state.nativePeer = { pid: 700, uid: 0 };
    state.privateExists = true;
    state.publicExists = true;
    state.temporaryFiles.clear();
    const pair = generateKeyPairSync('ed25519');
    state.privateKeyBytes = pair.privateKey.export({ format: 'der', type: 'pkcs8' });
    state.publicKeyBytes = createPublicKey(pair.privateKey).export({ format: 'der', type: 'spki' });
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server?.close(() => resolve()) ?? resolve());
    server = undefined;
  });

  it('mutually authenticates the broker and binds its signature to the client identity', async () => {
    const pair = generateKeyPairSync('ed25519');
    state.publicKeyBytes = createPublicKey(pair.privateKey).export({ format: 'der', type: 'spki' });
    const verifier = createLinuxVaultBrokerPeerVerifier(0);
    const result = await withSocketPair(async (client, accepted) => {
      const broker = authenticateLinuxVaultBrokerClient(
        accepted,
        { path: '/opt/inflow/bin/inflow', pid: process.pid, uid: currentUserId() },
        pair.privateKey,
      );
      const peer = await verifier(client);
      await broker;
      return peer;
    });

    expect(result).toEqual({ path: '/opt/inflow/bin/inflow', pid: 700, uid: 0 });
  });

  it('pauses client input before completing broker authentication', async () => {
    const pair = generateKeyPairSync('ed25519');
    state.publicKeyBytes = createPublicKey(pair.privateKey).export({ format: 'der', type: 'spki' });
    const verifier = createLinuxVaultBrokerPeerVerifier(0);

    await withSocketPair(async (client, accepted) => {
      const broker = authenticateLinuxVaultBrokerClient(
        accepted,
        { path: '/opt/inflow/bin/inflow', pid: process.pid, uid: currentUserId() },
        pair.privateKey,
      );
      await verifier(client);
      await broker;

      expect(accepted.isPaused()).toBe(true);
    });
  });

  it('loads a matching root-owned machine identity', async () => {
    const privateKey = await ensureLinuxVaultBrokerKey();

    expect(createPublicKey(privateKey).export({ format: 'der', type: 'spki' })).toEqual(
      Buffer.from(state.publicKeyBytes),
    );
  });

  it('rejects a public machine identity that does not match its private key', async () => {
    const different = generateKeyPairSync('ed25519');
    state.publicKeyBytes = createPublicKey(different.privateKey).export({ format: 'der', type: 'spki' });

    await expect(ensureLinuxVaultBrokerKey()).rejects.toMatchObject({
      secureStorageCode: 'secure_storage_unavailable',
    });
  });

  it('creates a machine identity when no broker key exists', async () => {
    state.privateExists = false;
    state.publicExists = false;

    const privateKey = await ensureLinuxVaultBrokerKey();

    expect(state.privateExists).toBe(true);
    expect(state.publicExists).toBe(true);
    expect(createPublicKey(privateKey).export({ format: 'der', type: 'spki' })).toEqual(
      Buffer.from(state.publicKeyBytes),
    );
  });

  it('rejects a broker signature bound to a different client process', async () => {
    const pair = generateKeyPairSync('ed25519');
    state.publicKeyBytes = createPublicKey(pair.privateKey).export({ format: 'der', type: 'spki' });
    const verifier = createLinuxVaultBrokerPeerVerifier(0);

    await expect(
      withSocketPair(async (client, accepted) => {
        const broker = authenticateLinuxVaultBrokerClient(
          accepted,
          { path: '/opt/inflow/bin/inflow', pid: process.pid + 1, uid: currentUserId() },
          pair.privateKey,
        );
        const verification = verifier(client);
        await broker;
        return verification;
      }),
    ).rejects.toMatchObject({ secureStorageCode: 'secure_storage_peer_verification_failed' });
  });

  it('rejects clients whose kernel user identity does not match the broker service', async () => {
    const pair = generateKeyPairSync('ed25519');
    state.publicKeyBytes = createPublicKey(pair.privateKey).export({ format: 'der', type: 'spki' });
    state.nativePeer = { pid: 700, uid: 1 };

    await withSocketPair(async (client, accepted) => {
      accepted.destroy();
      await expect(createLinuxVaultBrokerPeerVerifier(0)(client)).rejects.toBeInstanceOf(SecureStorageError);
    });
  });

  it('rejects malformed and oversized broker challenges', async () => {
    const pair = generateKeyPairSync('ed25519');
    for (const challenge of [Buffer.alloc(36), Buffer.alloc(37, 1)]) {
      await withSocketPair(async (client, accepted) => {
        const authentication = authenticateLinuxVaultBrokerClient(
          accepted,
          { path: '/opt/inflow/bin/inflow', pid: 1, uid: 1 },
          pair.privateKey,
        );
        client.write(challenge);
        await expect(authentication).rejects.toMatchObject({
          secureStorageCode: 'secure_storage_peer_verification_failed',
        });
      });
    }
  });

  it('rejects a client that disconnects before sending a complete challenge', async () => {
    const pair = generateKeyPairSync('ed25519');
    await withSocketPair(async (client, accepted) => {
      const authentication = authenticateLinuxVaultBrokerClient(
        accepted,
        { path: '/opt/inflow/bin/inflow', pid: 1, uid: 1 },
        pair.privateKey,
      );
      client.end(Buffer.alloc(10));
      await expect(authentication).rejects.toMatchObject({
        secureStorageCode: 'secure_storage_peer_verification_failed',
      });
    });
  });

  it('propagates a socket failure while reading a challenge', async () => {
    const pair = generateKeyPairSync('ed25519');
    const failure = new Error('socket failed');
    await withSocketPair(async (_client, accepted) => {
      const authentication = authenticateLinuxVaultBrokerClient(
        accepted,
        { path: '/opt/inflow/bin/inflow', pid: 1, uid: 1 },
        pair.privateKey,
      );
      accepted.destroy(failure);
      await expect(authentication).rejects.toBe(failure);
    });
  });

  async function withSocketPair<T>(run: (client: Socket, accepted: Socket) => Promise<T>): Promise<T> {
    const accepted = new Promise<Socket>((resolve) => {
      server = createServer(resolve);
    });
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
    const address = server?.address();
    if (address === null || address === undefined || typeof address === 'string') throw new Error('missing address');
    const client = await new Promise<Socket>((resolve) => {
      const socket = createConnection(address.port, '127.0.0.1', () => resolve(socket));
    });
    const peer = await accepted;
    try {
      return await run(client, peer);
    } finally {
      client.destroy();
      peer.destroy();
    }
  }
});

function currentUserId(): number {
  return process.getuid?.() ?? 0;
}
