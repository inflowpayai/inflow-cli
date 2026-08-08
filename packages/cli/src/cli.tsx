import process from 'node:process';
import { isMainThread, workerData } from 'node:worker_threads';
import {
  type AuthStorage,
  Inflow,
  runLinuxTransferredVaultService,
  runLinuxVaultBroker,
  runLocalVaultDaemon,
  isWindowsVaultWorkerData,
  runWindowsVaultService,
  runWindowsVaultWorker,
  Storage,
  SyncVaultSecretStore,
} from '@inflowpayai/inflow-core';
import { Cli, Help } from 'incur';
import { createAuthCli } from './commands/auth/index.js';
import { createAepCli } from './commands/aep/index.js';
import { aepCachePartition, createAepAwareFetch } from './commands/aep/runtime.js';
import { createBalancesCli } from './commands/balances/index.js';
import { createDepositAddressesCli } from './commands/deposit-addresses/index.js';
import { createInspectCommand } from './commands/inspect/index.js';
import { createMppCli } from './commands/mpp/index.js';
import { createOdpCli } from './commands/odp/index.js';
import {
  createVaultCli,
  ensureLocalVaultDaemon,
  ensureLocalVaultUnlocked,
  readVaultStatusWithoutStarting,
  type LocalVaultDaemonClientOptions,
} from './commands/vault/index.js';
import { createX402Cli } from './commands/x402/index.js';
import {
  formatUpdateNotice,
  makeBackgroundUpdateProbe,
  makeFrozenUpdateProbe,
  type UpdateProbe,
} from './utils/update-probe.js';
import {
  shouldConfigureOdpServiceTransport,
  shouldReconcileVaultDaemon,
  shouldStartVaultDaemon,
  shouldUnlockVault,
} from './startup-vault.js';

declare const __CLI_VERSION__: string;
declare const __CLI_BUILD_ID__: string;
declare const __CLI_NAME__: string;
declare const __BOOTSTRAP_BODY__: string;
declare const __SKILL_BODIES__: Record<string, string>;

const cliVersion = __CLI_VERSION__;
const cliBuildId = __CLI_BUILD_ID__;
const cliName = __CLI_NAME__;
const bootstrapBody = __BOOTSTRAP_BODY__;
const skillBodies = __SKILL_BODIES__;

const DEFAULT_SKILL = 'agentic-payments';

Help.registerGlobalFlags([
  { flag: '--bootstrap', desc: 'Print the agent setup guide (install, authenticate, load a playbook)' },
  { flag: '--skill [name]', desc: `Print a skill playbook (default: ${DEFAULT_SKILL})` },
]);

async function printBody(body: string): Promise<never> {
  const text = body.endsWith('\n') ? body : `${body}\n`;
  await new Promise<void>((resolve) => {
    process.stdout.write(text, () => {
      resolve();
    });
  });
  process.exit(0);
}

async function main(): Promise<void> {
  if (!isMainThread && isWindowsVaultWorkerData(workerData)) {
    await runWindowsVaultWorker(workerData, new URL(import.meta.url));
    return;
  }
  const daemonMode = extractHiddenDaemonMode();
  if (daemonMode !== undefined) {
    if (
      daemonMode !== 'vault' &&
      daemonMode !== 'vault-broker' &&
      daemonMode !== 'vault-service' &&
      daemonMode !== 'vault-windows-service'
    ) {
      process.stderr.write(`Unknown daemon mode: ${daemonMode}\n`);
      process.exit(2);
    }
    const daemonOptions = {
      cliVersion,
      buildId: cliBuildId,
    };
    if (daemonMode === 'vault-broker') await runLinuxVaultBroker(daemonOptions);
    else if (daemonMode === 'vault-service') await runLinuxTransferredVaultService(daemonOptions);
    else if (daemonMode === 'vault-windows-service') {
      await runWindowsVaultService(new URL(import.meta.url), daemonOptions);
    } else await runLocalVaultDaemon(daemonOptions);
    return;
  }

  if (process.argv.includes('--bootstrap')) {
    await printBody(bootstrapBody);
  }

  const skillFlagIndex = process.argv.findIndex((arg) => arg === '--skill' || arg.startsWith('--skill='));
  if (skillFlagIndex !== -1) {
    const flagArg = process.argv[skillFlagIndex] as string;
    let name: string;
    if (flagArg.startsWith('--skill=')) {
      const value = flagArg.slice('--skill='.length);
      name = value.length > 0 ? value : DEFAULT_SKILL;
    } else {
      const next = process.argv[skillFlagIndex + 1];
      name = next !== undefined && !next.startsWith('-') ? next : DEFAULT_SKILL;
    }
    const body = skillBodies[name];
    if (body === undefined) {
      process.stderr.write(`Unknown skill '${name}'. Available: ${Object.keys(skillBodies).sort().join(', ')}\n`);
      process.exit(1);
    }
    await printBody(body);
  }

  const CLI_CLIENT_IDS: Record<'production' | 'sandbox', string> = {
    production: '1f4ccbcbddce500e19b37fa0877ba032',
    sandbox: '19ba1cd46402cf2695c3056da0ac03ab',
  };

  const VALID_ENVIRONMENTS = ['production', 'sandbox'] as const;
  type Environment = (typeof VALID_ENVIRONMENTS)[number];

  function extractFlag(name: string): string | undefined {
    const idx = process.argv.indexOf(name);
    if (idx === -1) return undefined;
    const value = process.argv[idx + 1];
    process.argv.splice(idx, value === undefined ? 1 : 2);
    return value;
  }

  function extractBooleanFlag(name: string): boolean {
    const idx = process.argv.indexOf(name);
    if (idx !== -1) {
      process.argv.splice(idx, 1);
      return true;
    }

    const prefix = `${name}=`;
    const assignmentIdx = process.argv.findIndex((arg) => arg.startsWith(prefix));
    if (assignmentIdx === -1) return false;
    const [arg] = process.argv.splice(assignmentIdx, 1);
    const value = arg?.slice(prefix.length) ?? '';
    if (value === 'true') return true;
    if (value === 'false') return false;
    process.stderr.write(`Invalid ${name} value: ${value}. Expected 'true' or 'false'.\n`);
    process.exit(2);
  }

  const credentialFilePath = extractFlag('--auth') ?? process.env['INFLOW_AUTH_FILE'];
  const baseUrlFromFlag = extractFlag('--base-url');
  const apiBaseUrlAliasFromFlag = extractFlag('--api-base-url');
  const apiBaseUrlFromFlag = baseUrlFromFlag ?? apiBaseUrlAliasFromFlag;
  const authBaseUrlFromFlag = extractFlag('--auth-base-url');
  const environmentFromFlag = extractFlag('--environment');
  const sandboxFlag = extractBooleanFlag('--sandbox');
  const apiKeyFromFlag = extractFlag('--api-key');
  const verbose = extractBooleanFlag('--verbose');
  const isAgent = process.argv.includes('--format') || process.argv.includes('--mcp') || !process.stdout.isTTY;
  const vaultOptions: LocalVaultDaemonClientOptions = { buildId: cliBuildId, cliVersion };
  const apiKeyFromEnv = process.env['INFLOW_API_KEY'];
  const hasDirectApiKey = (apiKeyFromFlag?.length ?? 0) > 0 || (apiKeyFromEnv?.length ?? 0) > 0;
  if (shouldReconcileVaultDaemon(process.argv, hasDirectApiKey)) {
    const status = await readVaultStatusWithoutStarting(vaultOptions);
    if (status.daemonRunning) await ensureLocalVaultDaemon(vaultOptions);
  }
  if (shouldStartVaultDaemon(process.argv, hasDirectApiKey)) {
    await ensureLocalVaultDaemon(vaultOptions);
  }
  if (shouldUnlockVault(process.argv, { hasDirectApiKey, isAgent })) {
    await ensureLocalVaultUnlocked({ mode: isAgent ? 'agent' : 'human', vaultOptions });
  }

  const secretStore = new SyncVaultSecretStore(vaultOptions);
  const authStorage: AuthStorage = new Storage({
    ...(credentialFilePath === undefined ? {} : { configPath: credentialFilePath }),
    secretStore,
  });

  function readSavedApiKey(): string | undefined {
    try {
      return authStorage.getApiKey() ?? undefined;
    } catch {
      return undefined;
    }
  }
  function readSavedConnection(): {
    environment?: 'production' | 'sandbox';
    apiBaseUrl?: string;
    authBaseUrl?: string;
  } {
    try {
      return authStorage.getConnection() ?? {};
    } catch {
      return {};
    }
  }
  const apiKeyFromSaved = apiKeyFromFlag !== undefined || apiKeyFromEnv !== undefined ? undefined : readSavedApiKey();
  const apiKey = apiKeyFromFlag ?? apiKeyFromEnv ?? apiKeyFromSaved;
  const apiKeySource: 'flag' | 'env' | 'saved' | undefined =
    apiKeyFromFlag !== undefined && apiKeyFromFlag.length > 0
      ? 'flag'
      : apiKeyFromEnv !== undefined && apiKeyFromEnv.length > 0
        ? 'env'
        : apiKeyFromSaved !== undefined && apiKeyFromSaved.length > 0
          ? 'saved'
          : undefined;

  const savedConnection = readSavedConnection();

  const rawEnvironment =
    environmentFromFlag ??
    (sandboxFlag ? 'sandbox' : undefined) ??
    process.env['INFLOW_ENVIRONMENT'] ??
    savedConnection.environment ??
    'production';

  function isValidEnvironment(value: string): value is Environment {
    return (VALID_ENVIRONMENTS as readonly string[]).includes(value);
  }

  if (!isValidEnvironment(rawEnvironment)) {
    process.stderr.write(
      `Invalid INFLOW_ENVIRONMENT / --environment value: ${rawEnvironment}. Expected 'production' or 'sandbox'.\n`,
    );
    process.exit(2);
  }

  const environment: Environment = rawEnvironment;
  const apiBaseUrl = apiBaseUrlFromFlag ?? process.env['INFLOW_BASE_URL'] ?? savedConnection.apiBaseUrl;
  const authBaseUrl = authBaseUrlFromFlag ?? process.env['INFLOW_AUTH_BASE_URL'] ?? savedConnection.authBaseUrl;
  const cliClientId = process.env['INFLOW_CLI_CLIENT_ID'] ?? CLI_CLIENT_IDS[environment];

  const defaultHeaders = {
    'InFlow-CLI-Version': cliVersion,
    'User-Agent': `inflow/${cliVersion}`,
  };

  const inflow = new Inflow({
    verbose,
    defaultHeaders,
    authStorage,
    environment,
    ...(apiBaseUrl !== undefined ? { apiBaseUrl } : {}),
    ...(authBaseUrl !== undefined ? { authBaseUrl } : {}),
    cliClientId,
    ...(apiKey !== undefined ? { apiKey } : {}),
  });

  if (isAgent) {
    let signaled = false;
    const onSignal = (signal: NodeJS.Signals): void => {
      if (signaled) return;
      signaled = true;
      try {
        authStorage.clearPendingDeviceAuth();
      } catch {
        // best-effort; the slot expires server-side regardless
      }
      process.stderr.write(`\nReceived ${signal}; exiting.\n`);
      process.exit(130);
    };
    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);
  }

  const cli = Cli.create('inflow', {
    description: 'InFlow - agentic discovery, onboarding, and payments from your machine.',
    mcp: { tools: { discovery: 'direct' } },
    version: cliVersion,
  });

  const backgroundUpdateProbe = makeBackgroundUpdateProbe(cliName, cliVersion);
  let updateProbe: UpdateProbe = backgroundUpdateProbe;

  if (!isAgent && process.stdout.isTTY) {
    const snapshot = await backgroundUpdateProbe({ polling: false });
    updateProbe = makeFrozenUpdateProbe(snapshot);
    if (snapshot) {
      process.stderr.write(formatUpdateNotice(snapshot));
    }
  }

  const resolvedApiBaseUrl = inflow.resolvedApiBaseUrl;

  cli.command(
    createAuthCli(inflow.auth, inflow.user, updateProbe, authStorage, {
      apiKey,
      apiKeySource,
      environment,
      ...(apiBaseUrl !== undefined ? { apiBaseUrl } : {}),
      ...(authBaseUrl !== undefined ? { authBaseUrl } : {}),
      resolvedApiBaseUrl,
      verbose,
      vaultOptions,
    }),
  );
  cli.command(createBalancesCli(inflow.balances, authStorage, inflow));
  cli.command(createDepositAddressesCli(inflow.depositAddresses, authStorage, inflow));
  cli.command(createVaultCli(vaultOptions));
  cli.command(createX402Cli(inflow, authStorage, resolvedApiBaseUrl));
  cli.command(createMppCli(inflow, authStorage, resolvedApiBaseUrl));
  cli.command(createAepCli(inflow, authStorage));
  let odp = inflow.odp;
  if (shouldConfigureOdpServiceTransport(process.argv)) {
    const cachePartition = await aepCachePartition(authStorage, inflow);
    odp = inflow.odp.withServiceTransport({
      ...(cachePartition === undefined ? {} : { cachePartition }),
      transport: createAepAwareFetch({
        authStorage,
        context: {
          agent: isAgent,
          error(error): never {
            throw new Error(error.message);
          },
          formatExplicit: process.argv.includes('--format'),
        },
        inflow,
        timeout: 900,
      }),
    });
  }
  cli.command(createOdpCli(odp));
  cli.command('inspect', createInspectCommand(inflow, authStorage));

  await cli.serve();
}

function extractHiddenDaemonMode(): string | undefined {
  const assignmentIndex = process.argv.findIndex((arg) => arg.startsWith('--daemon='));
  if (assignmentIndex !== -1) {
    const [arg] = process.argv.splice(assignmentIndex, 1);
    return arg?.slice('--daemon='.length);
  }

  const index = process.argv.indexOf('--daemon');
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  process.argv.splice(index, value === undefined ? 1 : 2);
  return value ?? '';
}

main().catch((cause: unknown) => {
  const message = cause instanceof Error ? cause.message : String(cause);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
