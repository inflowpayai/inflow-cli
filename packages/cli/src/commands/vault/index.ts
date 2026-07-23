import { Buffer } from 'node:buffer';
import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { access } from 'node:fs/promises';
import { resolve } from 'node:path';
import process from 'node:process';
import {
  LocalVaultClient,
  removeVaultLocalState,
  type LocalVaultDaemonInfo,
  SecureStorageError,
  type VaultLockState,
  type VaultPolicy,
  type VaultStatus,
  vaultFilePaths,
} from '@inflowpayai/inflow-core';
import { Cli } from 'incur';
import { mcpTool } from '../../mcp-metadata.js';
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
  readVaultStatus: () => Promise<VaultStatus>;
  write: (text: string) => void;
}

type VaultClientLike = Pick<
  LocalVaultClient,
  'changePassphrase' | 'getPolicy' | 'lock' | 'reset' | 'setPolicy' | 'status' | 'unlock'
>;
type ResetVaultClientLike = Pick<LocalVaultClient, 'info' | 'reset' | 'shutdown' | 'status'>;
type UnlockVaultClientLike = Pick<LocalVaultClient, 'status' | 'unlock'>;
type UnlockVaultDeps = {
  ensureDaemon: () => Promise<UnlockVaultClientLike>;
  readPassphrase: (prompt: string, context: VaultCommandContext) => Promise<Buffer>;
};
type ResetVaultDeps = {
  client: ResetVaultClientLike;
  executablePath: string;
  now: () => number;
  removeLocalState: (paths: ReturnType<typeof vaultFilePaths>) => Promise<void>;
  sleep: (milliseconds: number) => Promise<void>;
};

type VaultStatusFrame = {
  lock_state: VaultLockState;
};

type VaultPolicyFrame = {
  idle_timeout_seconds: number | null;
  lock_on_sleep: boolean;
};

const MIN_PASSPHRASE_LENGTH = 6;

/* v8 ignore start */
function defaultDeps(options: LocalVaultDaemonClientOptions = {}): VaultDeps {
  return {
    ensureDaemon: () => ensureLocalVaultDaemon(options),
    readPassphrase,
    readVaultStatus: () => readVaultStatusWithoutStarting(options),
    write: (text) => {
      process.stdout.write(text);
    },
  };
}
/* v8 ignore stop */

async function runVaultStatus(c: VaultCommandContext, deps: VaultDeps = defaultDeps()): Promise<VaultStatusFrame> {
  const status = await mapSecureStorageError(c, () => deps.readVaultStatus());
  const frame = statusFrame(status);
  if (!c.agent && !c.formatExplicit) deps.write(renderStatus(frame));
  return frame;
}

async function runVaultUnlock(c: VaultCommandContext, deps: VaultDeps = defaultDeps()): Promise<VaultStatusFrame> {
  if (c.agent || c.formatExplicit) {
    const status = await mapSecureStorageError(c, () => deps.readVaultStatus());
    if (status.lockState === 'unlocked') return statusFrame(status);
    return c.error({
      code: 'VAULT_UNLOCK_REQUIRES_HUMAN',
      message: 'A human must run `inflow vault unlock` in a terminal to unlock the local credential vault.',
    });
  }
  const client = await deps.ensureDaemon();
  const before = await mapSecureStorageError(c, () => client.status());
  const passphrase = await deps.readPassphrase(
    before.lockState === 'not_initialized'
      ? 'Create an InFlow vault PIN or passphrase: '
      : 'Enter the InFlow vault PIN or passphrase: ',
    c,
  );
  validatePassphrase(c, passphrase);
  let status: VaultStatus;
  try {
    status = await mapSecureStorageError(c, () => client.unlock(passphrase));
  } finally {
    passphrase.fill(0);
  }
  const frame = statusFrame(status);
  deps.write(before.lockState === 'not_initialized' ? 'Vault initialized and unlocked.\n' : 'Vault unlocked.\n');
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
  if (c.agent || c.formatExplicit) {
    return c.error({
      code: 'VAULT_CHANGE_PASSPHRASE_REQUIRES_HUMAN',
      message: 'A human must run `inflow vault change-passphrase` in a terminal to change the vault passphrase.',
    });
  }
  const client = await deps.ensureDaemon();
  const current = await deps.readPassphrase('Enter the current InFlow vault PIN or passphrase: ', c);
  const next = await deps.readPassphrase('Enter the new InFlow vault PIN or passphrase: ', c);
  validatePassphrase(c, next);
  const confirmation = await deps.readPassphrase('Confirm the new InFlow vault PIN or passphrase: ', c);
  const confirmed = confirmation.equals(next);
  confirmation.fill(0);
  if (!confirmed) {
    current.fill(0);
    next.fill(0);
    return c.error({ code: 'VAULT_PASSPHRASE_MISMATCH', message: 'The passphrases did not match.' });
  }
  try {
    await mapSecureStorageError(c, () => client.changePassphrase(current, next));
  } finally {
    current.fill(0);
    next.fill(0);
  }
  deps.write('Vault passphrase changed.\n');
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

export interface LocalVaultDaemonClientOptions {
  buildId?: string;
  cliVersion?: string;
  rootDirectory?: string;
}

export type LocalVaultUnlockMode = 'agent' | 'human';

/* v8 ignore next */
export async function resetLocalVault(options: LocalVaultDaemonClientOptions = {}): Promise<void> {
  await resetLocalVaultWithDeps(options, {
    client: new LocalVaultClient(options),
    executablePath: process.execPath,
    now: Date.now,
    removeLocalState: removeVaultLocalState,
    sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  });
}

export async function ensureLocalVaultUnlocked(options: {
  mode: LocalVaultUnlockMode;
  vaultOptions?: LocalVaultDaemonClientOptions;
}): Promise<void> {
  await ensureLocalVaultUnlockedWithDeps(options.mode, {
    ensureDaemon: () => ensureLocalVaultDaemon(options.vaultOptions ?? {}),
    readPassphrase,
  });
}

async function ensureLocalVaultUnlockedWithDeps(mode: LocalVaultUnlockMode, deps: UnlockVaultDeps): Promise<void> {
  const client = await deps.ensureDaemon();
  const before = await client.status();
  if (before.lockState === 'unlocked') return;
  if (mode === 'agent') {
    throw new SecureStorageError(
      before.lockState === 'not_initialized' ? 'vault_not_initialized' : 'vault_locked',
      before.lockState === 'not_initialized'
        ? 'The InFlow vault is not initialized. A human must run `inflow vault unlock` first.'
        : 'The InFlow vault is locked. A human must run `inflow vault unlock` first.',
    );
  }
  const passphrase = await deps.readPassphrase(
    before.lockState === 'not_initialized'
      ? 'Create an InFlow vault PIN or passphrase: '
      : 'Enter the InFlow vault PIN or passphrase: ',
    {
      agent: false,
      error(error): never {
        throw new SecureStorageError('secure_storage_unavailable', error.message);
      },
      formatExplicit: false,
      options: {},
    },
  );
  validatePassphrase(
    {
      agent: false,
      error(error): never {
        throw new SecureStorageError('secure_storage_invalid_path', error.message);
      },
      formatExplicit: false,
      options: {},
    },
    passphrase,
  );
  try {
    await client.unlock(passphrase);
  } finally {
    passphrase.fill(0);
  }
}

export function createVaultCli(options: LocalVaultDaemonClientOptions = {}) {
  const cli = Cli.create('vault', { description: 'Local credential vault commands' });

  cli.command('status', {
    description: 'Show local vault status.',
    mcp: mcpTool('vault_status'),
    options: emptyOptions,
    outputPolicy: 'agent-only' as const,
    async run(c) {
      return runVaultStatus(c, defaultDeps(options));
    },
  });

  cli.command('unlock', {
    description: 'Unlock or initialize the local vault.',
    mcp: mcpTool('vault_unlock'),
    options: emptyOptions,
    outputPolicy: 'agent-only' as const,
    async run(c) {
      return runVaultUnlock(c, defaultDeps(options));
    },
  });

  cli.command('lock', {
    description: 'Lock the local vault.',
    mcp: mcpTool('vault_lock'),
    options: emptyOptions,
    outputPolicy: 'agent-only' as const,
    async run(c) {
      return runVaultLock(c, defaultDeps(options));
    },
  });

  cli.command('policy', {
    description: 'Show the local vault lock policy.',
    mcp: mcpTool('vault_policy'),
    options: emptyOptions,
    outputPolicy: 'agent-only' as const,
    async run(c) {
      return runVaultPolicy(c, defaultDeps(options));
    },
  });

  cli.command('set-policy', {
    description: 'Update the local vault lock policy.',
    mcp: mcpTool('vault_set-policy'),
    options: policySetOptions,
    outputPolicy: 'agent-only' as const,
    async run(c) {
      return runVaultPolicySet(c, defaultDeps(options));
    },
  });

  cli.command('change-passphrase', {
    description: 'Change the local vault PIN or passphrase.',
    mcp: mcpTool('vault_change-passphrase'),
    options: emptyOptions,
    outputPolicy: 'agent-only' as const,
    async run(c) {
      return runVaultChangePassphrase(c, defaultDeps(options));
    },
  });

  cli.command('reset', {
    description: 'Remove the local vault database, sidecar, and runtime files.',
    mcp: mcpTool('vault_reset'),
    options: resetOptions,
    outputPolicy: 'agent-only' as const,
    async run(c) {
      return runVaultReset(c, defaultDeps(options));
    },
  });

  return cli;
}

function isCompatibleDaemon(
  info: LocalVaultDaemonInfo,
  options: LocalVaultDaemonClientOptions,
  executablePath: string,
): boolean {
  return (
    executableIdentityPath(info.executablePath) === executableIdentityPath(executablePath) &&
    info.cliVersion === (options.cliVersion ?? null) &&
    info.buildId === (options.buildId ?? null)
  );
}

function executableIdentityPath(executablePath: string): string {
  try {
    return realpathSync.native(executablePath);
  } catch {
    return resolve(executablePath);
  }
}

async function resetLocalVaultWithDeps(options: LocalVaultDaemonClientOptions, deps: ResetVaultDeps): Promise<void> {
  const daemon = await existingDaemonState(options, deps.client, deps.executablePath);
  if (daemon === 'compatible') {
    await deps.client.reset();
    return;
  }
  if (daemon === 'incompatible') await shutdownReachableDaemon(deps);
  await deps.removeLocalState(vaultFilePaths(options.rootDirectory));
}

async function existingDaemonState(
  options: LocalVaultDaemonClientOptions,
  client: ResetVaultClientLike,
  executablePath: string,
): Promise<'compatible' | 'incompatible' | 'none'> {
  try {
    await client.status();
    const info = await client.info();
    return isCompatibleDaemon(info, options, executablePath) ? 'compatible' : 'incompatible';
  } catch (cause) {
    if (isVaultDaemonUnavailable(cause)) return 'none';
    throw cause;
  }
}

async function shutdownReachableDaemon(deps: ResetVaultDeps): Promise<void> {
  try {
    await deps.client.shutdown();
  } catch (cause) {
    if (isVaultDaemonUnavailable(cause)) return;
    throw cause;
  }
  const deadline = deps.now() + 2_000;
  while (deps.now() < deadline) {
    try {
      await deps.client.status();
    } catch (cause) {
      if (isVaultDaemonUnavailable(cause)) return;
      throw cause;
    }
    await deps.sleep(25);
  }
  throw new SecureStorageError('vault_daemon_busy', 'The previous InFlow vault daemon did not stop.');
}

export async function readVaultStatusWithoutStarting(
  options: LocalVaultDaemonClientOptions = {},
): Promise<VaultStatus> {
  const client = new LocalVaultClient(options);
  try {
    return await client.status();
  } catch (cause) {
    if (!isVaultDaemonUnavailable(cause)) throw cause;
  }
  return {
    daemonRunning: false,
    lockState: (await vaultSidecarExists(vaultFilePaths(options.rootDirectory).sidecar)) ? 'locked' : 'not_initialized',
  };
}

async function vaultSidecarExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (cause) {
    if (isMissingPath(cause)) return false;
    throw cause;
  }
}

/* v8 ignore start */
export async function ensureLocalVaultDaemon(options: LocalVaultDaemonClientOptions = {}): Promise<LocalVaultClient> {
  const client = new LocalVaultClient(options);
  if (await canUseDaemon(client, options)) return client;
  await shutdownStaleDaemon(client);
  const command = daemonCommand();
  const child = spawn(command.file, command.args, {
    detached: true,
    env: process.env,
    stdio: 'ignore',
  });
  child.unref();
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (await canUseDaemon(client, options)) return client;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new SecureStorageError('secure_storage_unavailable', 'The InFlow vault daemon did not start.');
}

async function canUseDaemon(client: LocalVaultClient, options: LocalVaultDaemonClientOptions): Promise<boolean> {
  try {
    await client.status();
    const info = await client.info();
    return isCompatibleDaemon(info, options, process.execPath);
  } catch {
    return false;
  }
}

async function shutdownStaleDaemon(client: LocalVaultClient): Promise<void> {
  try {
    await client.shutdown();
  } catch {
    return;
  }
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try {
      await client.status();
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new SecureStorageError('vault_daemon_busy', 'The previous InFlow vault daemon did not stop.');
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
  if (process.stdin.isTTY && process.stdout.isTTY && !c.agent && !c.formatExplicit) {
    return readHiddenLine(prompt);
  }
  return c.error({
    code: 'VAULT_UNLOCK_REQUIRES_HUMAN',
    message: 'A human must run `inflow vault unlock` in a terminal to unlock the local credential vault.',
  });
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
    lockOnSleep: typeof options['lockOnSleep'] === 'boolean' ? options['lockOnSleep'] : undefined,
  };
}

function statusFrame(status: VaultStatus): VaultStatusFrame {
  return {
    lock_state: status.lockState,
  };
}

function policyFrame(policy: VaultPolicy): VaultPolicyFrame {
  return {
    idle_timeout_seconds: policy.idleTimeoutSeconds,
    lock_on_sleep: policy.lockOnSleep,
  };
}

function renderStatus(frame: VaultStatusFrame): string {
  return `Vault status: ${frame.lock_state}\n`;
}

function renderPolicy(frame: VaultPolicyFrame): string {
  return [
    `Idle timeout: ${frame.idle_timeout_seconds === null ? 'disabled' : `${frame.idle_timeout_seconds}s`}`,
    `Lock on sleep: ${frame.lock_on_sleep ? 'yes' : 'no'}`,
    '',
  ].join('\n');
}

function isVaultDaemonUnavailable(cause: unknown): boolean {
  if (cause instanceof SecureStorageError) return cause.secureStorageCode === 'secure_storage_unavailable';
  if (!hasErrorCode(cause)) return false;
  return cause.code === 'ECONNREFUSED' || cause.code === 'EINVAL' || cause.code === 'ENOENT';
}

function isMissingPath(cause: unknown): boolean {
  return hasErrorCode(cause) && cause.code === 'ENOENT';
}

function hasErrorCode(value: unknown): value is { code: unknown } {
  return typeof value === 'object' && value !== null && 'code' in value;
}

export const __testing = {
  runVaultChangePassphrase,
  runVaultLock,
  runVaultPolicy,
  runVaultPolicySet,
  runVaultReset,
  runVaultStatus,
  runVaultUnlock,
  ensureLocalVaultUnlockedWithDeps,
  isCompatibleDaemon,
  readVaultStatusWithoutStarting,
  resetLocalVaultWithDeps,
};
