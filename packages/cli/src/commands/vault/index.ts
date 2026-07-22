import { Buffer } from 'node:buffer';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import process from 'node:process';
import {
  LocalVaultClient,
  SecureStorageError,
  type VaultLockState,
  type VaultPolicy,
  type VaultStatus,
} from '@inflowpayai/inflow-core';
import { Cli } from 'incur';
import { emptyOptions, policySetOptions, resetOptions } from './schema.js';

interface VaultCommandContext {
  agent: boolean;
  formatExplicit: boolean;
  options: Record<string, unknown>;
  error: (err: { code: string; message: string }) => never;
}

interface VaultDeps {
  ensureDaemon: () => Promise<VaultClientLike>;
  readPassphrase: (prompt: string, context: VaultCommandContext) => Promise<Buffer>;
  write: (text: string) => void;
}

type VaultClientLike = Pick<
  LocalVaultClient,
  'changePassphrase' | 'getPolicy' | 'lock' | 'reset' | 'setPolicy' | 'status' | 'unlock'
>;

type VaultStatusFrame = {
  daemon_running: boolean;
  lock_state: VaultLockState;
};

type VaultPolicyFrame = {
  idle_timeout_seconds: number | null;
  lock_on_daemon_exit: boolean;
  lock_on_explicit_logout: boolean;
  lock_on_sleep: boolean;
};

const MIN_PASSPHRASE_LENGTH = 6;

/* v8 ignore start */
function defaultDeps(): VaultDeps {
  return {
    ensureDaemon: () => ensureLocalVaultDaemon(rootOption()),
    readPassphrase,
    write: (text) => {
      process.stdout.write(text);
    },
  };
}
/* v8 ignore stop */

async function runVaultStatus(c: VaultCommandContext, deps: VaultDeps = defaultDeps()): Promise<VaultStatusFrame> {
  const client = await deps.ensureDaemon();
  const status = await mapSecureStorageError(c, () => client.status());
  const frame = statusFrame(status);
  if (!c.agent && !c.formatExplicit) deps.write(renderStatus(frame));
  return frame;
}

async function runVaultUnlock(c: VaultCommandContext, deps: VaultDeps = defaultDeps()): Promise<VaultStatusFrame> {
  const client = await deps.ensureDaemon();
  const before = await mapSecureStorageError(c, () => client.status());
  const passphrase = await deps.readPassphrase(
    before.lockState === 'not_initialized'
      ? 'Create an InFlow vault PIN or passphrase: '
      : 'Enter the InFlow vault PIN or passphrase: ',
    c,
  );
  validatePassphrase(c, passphrase);
  const status = await mapSecureStorageError(c, () => client.unlock(passphrase));
  passphrase.fill(0);
  const frame = statusFrame(status);
  if (!c.agent && !c.formatExplicit) {
    deps.write(before.lockState === 'not_initialized' ? 'Vault initialized and unlocked.\n' : 'Vault unlocked.\n');
  }
  return frame;
}

async function runVaultLock(c: VaultCommandContext, deps: VaultDeps = defaultDeps()): Promise<{ locked: true }> {
  const client = await deps.ensureDaemon();
  await mapSecureStorageError(c, () => client.lock());
  if (!c.agent && !c.formatExplicit) deps.write('Vault locked.\n');
  return { locked: true };
}

async function runVaultPolicy(c: VaultCommandContext, deps: VaultDeps = defaultDeps()): Promise<VaultPolicyFrame> {
  const client = await deps.ensureDaemon();
  const policy = await mapSecureStorageError(c, () => client.getPolicy());
  const frame = policyFrame(policy);
  if (!c.agent && !c.formatExplicit) deps.write(renderPolicy(frame));
  return frame;
}

async function runVaultPolicySet(c: VaultCommandContext, deps: VaultDeps = defaultDeps()): Promise<VaultPolicyFrame> {
  const client = await deps.ensureDaemon();
  const current = await mapSecureStorageError(c, () => client.getPolicy());
  const options = parsePolicySetOptions(c.options);
  const next = {
    idleTimeoutSeconds:
      options.idleTimeoutSeconds === undefined
        ? current.idleTimeoutSeconds
        : options.idleTimeoutSeconds === 0
          ? null
          : options.idleTimeoutSeconds,
    lockOnDaemonExit: options.lockOnDaemonExit ?? current.lockOnDaemonExit,
    lockOnExplicitLogout: options.lockOnExplicitLogout ?? current.lockOnExplicitLogout,
    lockOnSleep: options.lockOnSleep ?? current.lockOnSleep,
  };
  const frame = policyFrame(await mapSecureStorageError(c, () => client.setPolicy(next)));
  if (!c.agent && !c.formatExplicit) deps.write(renderPolicy(frame));
  return frame;
}

async function runVaultChangePassphrase(
  c: VaultCommandContext,
  deps: VaultDeps = defaultDeps(),
): Promise<{ changed: true }> {
  const client = await deps.ensureDaemon();
  const current = await deps.readPassphrase('Enter the current InFlow vault PIN or passphrase: ', c);
  const next = await deps.readPassphrase('Enter the new InFlow vault PIN or passphrase: ', c);
  validatePassphrase(c, next);
  if (!c.agent && !c.formatExplicit) {
    const confirmation = await deps.readPassphrase('Confirm the new InFlow vault PIN or passphrase: ', c);
    const confirmed = confirmation.equals(next);
    confirmation.fill(0);
    if (!confirmed) {
      current.fill(0);
      next.fill(0);
      return c.error({ code: 'VAULT_PASSPHRASE_MISMATCH', message: 'The passphrases did not match.' });
    }
  }
  await mapSecureStorageError(c, () => client.changePassphrase(current, next));
  current.fill(0);
  next.fill(0);
  if (!c.agent && !c.formatExplicit) deps.write('Vault passphrase changed.\n');
  return { changed: true };
}

async function runVaultReset(c: VaultCommandContext, deps: VaultDeps = defaultDeps()): Promise<{ reset: true }> {
  const force = c.options['force'];
  if (force !== true) {
    return c.error({
      code: 'VAULT_RESET_REQUIRES_FORCE',
      message: 'Run `inflow vault reset --force` to remove the local vault.',
    });
  }
  const client = await deps.ensureDaemon();
  await mapSecureStorageError(c, () => client.reset());
  if (!c.agent && !c.formatExplicit) deps.write('Vault reset complete.\n');
  return { reset: true };
}

export function createVaultCli() {
  const cli = Cli.create('vault', { description: 'Local credential vault commands' });

  cli.command('status', {
    description: 'Show local vault status.',
    options: emptyOptions,
    outputPolicy: 'agent-only' as const,
    async run(c) {
      return runVaultStatus(c);
    },
  });

  cli.command('unlock', {
    description: 'Unlock or initialize the local vault.',
    options: emptyOptions,
    outputPolicy: 'agent-only' as const,
    async run(c) {
      return runVaultUnlock(c);
    },
  });

  cli.command('lock', {
    description: 'Lock the local vault.',
    options: emptyOptions,
    outputPolicy: 'agent-only' as const,
    async run(c) {
      return runVaultLock(c);
    },
  });

  cli.command('policy', {
    description: 'Show the local vault lock policy.',
    options: emptyOptions,
    outputPolicy: 'agent-only' as const,
    async run(c) {
      return runVaultPolicy(c);
    },
  });

  cli.command('set-policy', {
    description: 'Update the local vault lock policy.',
    options: policySetOptions,
    outputPolicy: 'agent-only' as const,
    async run(c) {
      return runVaultPolicySet(c);
    },
  });

  cli.command('change-passphrase', {
    description: 'Change the local vault PIN or passphrase.',
    options: emptyOptions,
    outputPolicy: 'agent-only' as const,
    async run(c) {
      return runVaultChangePassphrase(c);
    },
  });

  cli.command('reset', {
    description: 'Remove the local vault database, sidecar, and runtime files.',
    options: resetOptions,
    outputPolicy: 'agent-only' as const,
    async run(c) {
      return runVaultReset(c);
    },
  });

  return cli;
}

/* v8 ignore start */
async function ensureLocalVaultDaemon(options: { rootDirectory?: string } = {}): Promise<LocalVaultClient> {
  const client = new LocalVaultClient(options);
  if (await canReachDaemon(client)) return client;
  const command = daemonCommand();
  const env = {
    ...process.env,
    ...(options.rootDirectory !== undefined ? { INFLOW_VAULT_ROOT: options.rootDirectory } : {}),
  };
  const child = spawn(command.file, command.args, {
    detached: true,
    env,
    stdio: 'ignore',
  });
  child.unref();
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (await canReachDaemon(client)) return client;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new SecureStorageError('secure_storage_unavailable', 'The InFlow vault daemon did not start.');
}

async function canReachDaemon(client: LocalVaultClient): Promise<boolean> {
  try {
    await client.status();
    return true;
  } catch {
    return false;
  }
}

function daemonCommand(): { args: string[]; file: string } {
  const script = process.argv[1];
  if (script !== undefined && script.endsWith('.js')) {
    return { args: [resolve(script), '--daemon', 'vault'], file: process.execPath };
  }
  return { args: ['--daemon', 'vault'], file: process.execPath };
}
/* v8 ignore stop */

/* v8 ignore start */
async function readPassphrase(prompt: string, c: VaultCommandContext): Promise<Buffer> {
  if (process.stdin.isTTY && !c.agent && !c.formatExplicit) {
    return readHiddenLine(prompt);
  }
  const stdin = await readStdin();
  const line = stdin.split(/\r?\n/u).find((value) => value.length > 0);
  if (line === undefined) {
    return c.error({
      code: 'VAULT_PASSPHRASE_REQUIRED',
      message: 'Provide the vault PIN or passphrase on standard input.',
    });
  }
  return Buffer.from(line, 'utf8');
}

function readHiddenLine(prompt: string): Promise<Buffer> {
  process.stderr.write(prompt);
  return new Promise((resolve, reject) => {
    const input = process.stdin;
    const chars: string[] = [];
    const restore = (): void => {
      input.off('data', onData);
      if (typeof input.setRawMode === 'function') input.setRawMode(false);
      input.pause();
      process.stderr.write('\n');
    };
    const finish = (): void => {
      restore();
      resolve(Buffer.from(chars.join(''), 'utf8'));
    };
    const fail = (cause: Error): void => {
      restore();
      reject(cause);
    };
    const onData = (chunk: Buffer): void => {
      const text = chunk.toString('utf8');
      for (const char of text) {
        if (char === '\u0003') {
          fail(new SecureStorageError('secure_storage_unavailable', 'Vault unlock cancelled.'));
          return;
        }
        if (char === '\r' || char === '\n') {
          finish();
          return;
        }
        if (char === '\u007f' || char === '\b') {
          chars.pop();
          continue;
        }
        if (char >= ' ') chars.push(char);
      }
    };
    input.on('data', onData);
    if (typeof input.setRawMode === 'function') input.setRawMode(true);
    input.resume();
  });
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });
    process.stdin.on('error', reject);
    process.stdin.on('end', () => {
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
  });
}
/* v8 ignore stop */

function validatePassphrase(c: VaultCommandContext, passphrase: Buffer): void {
  if (passphrase.toString('utf8').length >= MIN_PASSPHRASE_LENGTH) return;
  passphrase.fill(0);
  c.error({
    code: 'VAULT_PASSPHRASE_TOO_SHORT',
    message: 'The InFlow vault PIN or passphrase must be at least 6 characters.',
  });
}

async function mapSecureStorageError<T>(c: VaultCommandContext, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (cause) {
    if (cause instanceof SecureStorageError) {
      return c.error({ code: cause.secureStorageCode, message: cause.message });
    }
    throw cause;
  }
}

function parsePolicySetOptions(options: Record<string, unknown>) {
  return {
    idleTimeoutSeconds: typeof options['idleTimeoutSeconds'] === 'number' ? options['idleTimeoutSeconds'] : undefined,
    lockOnDaemonExit: typeof options['lockOnDaemonExit'] === 'boolean' ? options['lockOnDaemonExit'] : undefined,
    lockOnExplicitLogout:
      typeof options['lockOnExplicitLogout'] === 'boolean' ? options['lockOnExplicitLogout'] : undefined,
    lockOnSleep: typeof options['lockOnSleep'] === 'boolean' ? options['lockOnSleep'] : undefined,
  };
}

/* v8 ignore start */
function rootOption(): { rootDirectory?: string } {
  const rootDirectory = process.env['INFLOW_VAULT_ROOT'];
  return rootDirectory === undefined ? {} : { rootDirectory };
}
/* v8 ignore stop */

function statusFrame(status: VaultStatus): VaultStatusFrame {
  return {
    daemon_running: status.daemonRunning,
    lock_state: status.lockState,
  };
}

function policyFrame(policy: VaultPolicy): VaultPolicyFrame {
  return {
    idle_timeout_seconds: policy.idleTimeoutSeconds,
    lock_on_daemon_exit: policy.lockOnDaemonExit,
    lock_on_explicit_logout: policy.lockOnExplicitLogout,
    lock_on_sleep: policy.lockOnSleep,
  };
}

function renderStatus(frame: VaultStatusFrame): string {
  return `Vault status: ${frame.lock_state}\nDaemon running: ${frame.daemon_running ? 'yes' : 'no'}\n`;
}

function renderPolicy(frame: VaultPolicyFrame): string {
  return [
    `Idle timeout: ${frame.idle_timeout_seconds === null ? 'disabled' : `${frame.idle_timeout_seconds}s`}`,
    `Lock on daemon exit: ${frame.lock_on_daemon_exit ? 'yes' : 'no'}`,
    `Lock on logout: ${frame.lock_on_explicit_logout ? 'yes' : 'no'}`,
    `Lock on sleep: ${frame.lock_on_sleep ? 'yes' : 'no'}`,
    '',
  ].join('\n');
}

export const __testing = {
  runVaultChangePassphrase,
  runVaultLock,
  runVaultPolicy,
  runVaultPolicySet,
  runVaultReset,
  runVaultStatus,
  runVaultUnlock,
};
