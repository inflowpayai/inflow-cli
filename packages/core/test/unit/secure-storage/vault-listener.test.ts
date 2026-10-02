import { once } from 'node:events';
import { chmodSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { createConnection, createServer, type Server } from 'node:net';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { inspectSameUserVaultListener } from '../../../src/secure-storage/vault-peer-verifier.js';

describe.runIf(process.platform === 'darwin')('macOS native vault listener inspection', () => {
  it('identifies an immediately rejecting listener without making another connection', async () => {
    const root = mkdtempSync('/tmp/inflow-listener-');
    const socketPath = join(root, 'vault.sock');
    let connections = 0;
    const server = createServer((socket) => {
      connections++;
      socket.on('error', () => undefined);
      socket.end('rejected', () => socket.destroy());
    });
    try {
      server.listen(socketPath);
      await once(server, 'listening');
      for (let iteration = 0; iteration < 25; iteration++) {
        const client = createConnection(socketPath);
        client.resume();
        await once(client, 'close');
        expect(inspectSameUserVaultListener(socketPath)).toMatchObject({ pid: process.pid, uid: process.getuid?.() });
        expect(connections).toBe(iteration + 1);
      }
    } finally {
      await close(server);
      rmSync(root, { force: true, recursive: true });
    }
  });

  it('refuses ambiguous listeners after the socket pathname has been replaced', async () => {
    const root = mkdtempSync('/tmp/inflow-listener-');
    const socketPath = join(root, 'vault.sock');
    const original = createServer();
    const replacement = createServer();
    try {
      original.listen(socketPath);
      await once(original, 'listening');
      unlinkSync(socketPath);
      replacement.listen(socketPath);
      await once(replacement, 'listening');
      expect(() => inspectSameUserVaultListener(socketPath)).toThrow('Vault listener ownership could not be verified.');
    } finally {
      await close(replacement);
      await close(original);
      rmSync(root, { force: true, recursive: true });
    }
  });

  it('refuses missing paths, regular files, symlinks, and writable socket directories', async () => {
    const root = mkdtempSync('/tmp/inflow-listener-');
    const socketPath = join(root, 'vault.sock');
    const server = createServer();
    try {
      expect(() => inspectSameUserVaultListener(socketPath)).toThrow();
      writeFileSync(socketPath, 'not a socket');
      expect(() => inspectSameUserVaultListener(socketPath)).toThrow();
      unlinkSync(socketPath);
      server.listen(socketPath);
      await once(server, 'listening');
      const link = join(root, 'link.sock');
      symlinkSync(socketPath, link);
      expect(() => inspectSameUserVaultListener(link)).toThrow();
      expect(() => inspectSameUserVaultListener(`${socketPath}\0extra`)).toThrow();
      expect(() => inspectSameUserVaultListener('/'.repeat(104))).toThrow();
      chmodSync(root, 0o777);
      expect(() => inspectSameUserVaultListener(socketPath)).toThrow();
    } finally {
      chmodSync(root, 0o700);
      await close(server);
      rmSync(root, { force: true, recursive: true });
    }
  });
});

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
