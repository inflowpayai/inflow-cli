import { spawn } from 'node:child_process';
import { constants, closeSync, fstatSync, lstatSync, mkdirSync, openSync, realpathSync, statSync } from 'node:fs';
import { LocalVaultClient, SecureStorageError, usesLinuxVaultService } from '@inflowpayai/inflow-core';
import { Cli } from 'incur';
import { serviceStartOutput } from './schema.js';

const LAUNCHER = '/opt/inflow/lib/inflow/vault-launcher';
export const SERVICE_START_INSTRUCTION =
  'The InFlow vault service is not running. Start it with `sudo inflow vault service start`, then retry your command.';

export function hasSystemdManager(): boolean {
  try {
    statSync('/run/systemd/system/');
    return true;
  } catch (cause) {
    if (cause instanceof Error && 'code' in cause && cause.code === 'ENOENT') return false;
    throw cause;
  }
}

function trustedDirectory(directory: string): void {
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.uid !== 0 || (stat.mode & 0o022) !== 0 || realpathSync(directory) !== directory) {
    throw new Error(`Unsafe service directory: ${directory}.`);
  }
}

function launchConfinedService(): Promise<void> {
  trustedDirectory('/run');
  try {
    mkdirSync('/run/inflow', { mode: 0o755 });
  } catch (cause) {
    if (!(cause instanceof Error && 'code' in cause && cause.code === 'EEXIST')) throw cause;
  }
  trustedDirectory('/run/inflow');
  const log = openSync(
    '/run/inflow/service.log',
    constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    const stat = fstatSync(log);
    if (!stat.isFile() || stat.uid !== 0 || (stat.mode & 0o077) !== 0 || stat.nlink !== 1) {
      throw new Error('Unsafe service log.');
    }
  } catch (cause) {
    closeSync(log);
    throw cause;
  }
  const args = [
    '--ro-bind',
    '/',
    '/',
    '--proc',
    '/proc',
    '--remount-ro',
    '/proc',
    '--dev',
    '/dev',
    '--tmpfs',
    '/tmp',
    '--tmpfs',
    '/var/tmp',
    '--tmpfs',
    '/home',
    '--chmod',
    '0000',
    '/home',
    '--tmpfs',
    '/root',
    '--chmod',
    '0000',
    '/root',
    '--tmpfs',
    '/run',
    '--bind',
    '/run/inflow',
    '/run/inflow',
    '--bind',
    '/var/lib/inflow',
    '/var/lib/inflow',
    '--bind',
    '/var/lib/inflow-broker',
    '/var/lib/inflow-broker',
    '--clearenv',
    '--setenv',
    'PATH',
    '/usr/bin:/bin',
    '--setenv',
    'HOME',
    '/',
    '--cap-drop',
    'ALL',
    '--cap-add',
    'CAP_SYS_PTRACE',
    '--cap-add',
    'CAP_SETUID',
    '--cap-add',
    'CAP_SETGID',
    '--cap-add',
    'CAP_SETPCAP',
    '--',
    LAUNCHER,
    '--activate',
  ];
  return new Promise<void>((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn('/usr/bin/bwrap', args, {
        detached: true,
        env: { PATH: '/usr/bin:/bin' },
        stdio: ['ignore', 'pipe', log],
      });
    } finally {
      closeSync(log);
    }
    const readiness = child.stdout;
    let settled = false;
    let received = '';
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      readiness?.destroy();
      if (error !== undefined) {
        if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) {
          try {
            process.kill(-child.pid, 'SIGTERM');
          } catch {
            /* The startup process may have already exited. */
          }
        }
        reject(error);
      } else {
        child.unref();
        resolve();
      }
    };
    const timeout = setTimeout(
      () => finish(new Error('Vault service startup timed out. Inspect /run/inflow/service.log.')),
      15_000,
    );
    child.once('error', (error) => finish(error));
    child.once('exit', () => finish(new Error('Vault service startup failed. Inspect /run/inflow/service.log.')));
    if (readiness === null) {
      finish(new Error('The service readiness channel is unavailable.'));
      return;
    }
    readiness.on('data', (chunk: Buffer) => {
      received += chunk.toString('utf8');
      if (received === 'READY\n') finish();
      else if (received.length > 64) finish(new Error('Invalid service readiness response.'));
    });
    readiness.once('error', (error: Error) => finish(error));
  });
}

async function startService(): Promise<{ service_state: 'running' }> {
  if (!usesLinuxVaultService()) {
    throw new SecureStorageError(
      'secure_storage_unavailable',
      'Service startup requires the installed Linux InFlow package.',
    );
  }
  if (process.getuid?.() !== 0) {
    throw new SecureStorageError(
      'secure_storage_unavailable',
      'Run `sudo inflow vault service start` to start the system service.',
    );
  }
  if (hasSystemdManager()) {
    await new Promise<void>((resolve, reject) => {
      const child = spawn('/usr/bin/systemctl', ['start', 'inflow-vault.socket'], {
        env: { PATH: '/usr/bin:/bin' },
        stdio: 'ignore',
      });
      child.once('error', reject);
      child.once('exit', (code) =>
        code === 0 ? resolve() : reject(new Error('systemd could not start the InFlow vault socket.')),
      );
    });
  } else {
    await launchConfinedService();
  }
  const client = new LocalVaultClient();
  try {
    await client.info();
  } finally {
    client.dispose();
  }
  return { service_state: 'running' };
}

export function createVaultServiceCli() {
  const cli = Cli.create('service', { description: 'System vault service management' });
  cli.command('start', {
    description: 'Start the vault service with administrator privileges.',
    mcp: false,
    output: serviceStartOutput,
    outputPolicy: 'all' as const,
    async run(c) {
      try {
        return await startService();
      } catch (cause) {
        return c.error({
          code: 'VAULT_SERVICE_START_FAILED',
          message: cause instanceof Error ? cause.message : 'Vault service startup failed.',
        });
      }
    },
  });
  return cli;
}

export const __testing = { launchConfinedService, startService, trustedDirectory };
