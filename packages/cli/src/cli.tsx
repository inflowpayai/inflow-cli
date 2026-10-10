import process from 'node:process';
import { isMainThread, workerData } from 'node:worker_threads';
import {
  OpenApiCollections,
  createTapFetch,
  Inflow,
  InflowAuthenticationError,
  LocalVaultClient,
  runLinuxTransferredVaultService,
  runLinuxVaultBroker,
  runLocalVaultDaemon,
  isWindowsVaultWorkerData,
  runWindowsVaultService,
  runWindowsVaultWorker,
  Storage,
  SecureStorageError,
  SyncVaultSecretStore,
} from '@inflowpayai/inflow-core';
import { Cli, Errors, Help } from 'incur';
import { createAuthCli } from './commands/auth/index.js';
import { createAepCli } from './commands/aep/index.js';
import { aepCachePartition, createAepAwareFetch } from './commands/aep/runtime.js';
import { createBalancesCli } from './commands/balances/index.js';
import { createDepositAddressesCli } from './commands/deposit-addresses/index.js';
import { createInspectCommand } from './commands/inspect/index.js';
import { createMppCli } from './commands/mpp/index.js';
import { createOdpCli } from './commands/odp/index.js';
import { createOpenApiCli } from './commands/openapi/index.js';
import { createDirectoryCli } from './commands/directory/index.js';
import { createSubscriptionsCli } from './commands/subscriptions/index.js';
import {
  createVaultCli,
  ensureLocalVaultDaemon,
  ensureLocalVaultUnlocked,
  readVaultStatusWithoutStarting,
  type LocalVaultDaemonClientOptions,
} from './commands/vault/index.js';
import { createX402Cli } from './commands/x402/index.js';
import { authenticatedApiError } from './utils/api-error.js';
import { shouldEnsureVaultDaemonForMcpTool } from './mcp-metadata.js';
import {
  formatUpdateNotice,
  makeBackgroundUpdateProbe,
  makeFrozenUpdateProbe,
  type UpdateProbe,
} from './utils/update-probe.js';
import {
  commandPath,
  isAgentInvocation,
  isPublicDocumentInspect,
  normalizeFormatAssignments,
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
  normalizeFormatAssignments(process.argv);
  showDirectorySearchHelpForEmptyInput(process.argv);
  const isAgent = isAgentInvocation(process.argv, process.stdout.isTTY);
  const controlClient = new LocalVaultClient({
    expectedDaemon: { buildId: cliBuildId, cliVersion, executablePath: process.execPath },
  });
  const secretStore = new SyncVaultSecretStore({
    expectedDaemon: { buildId: cliBuildId, cliVersion, executablePath: process.execPath },
  });
  const closeControlClient = (): void => {
    controlClient.dispose();
    secretStore.dispose();
  };
  let activeCommands = 0;
  let inputClosed = false;
  const closeControlInput = (): void => {
    inputClosed = true;
    if (activeCommands === 0) closeControlClient();
  };
  process.once('exit', closeControlClient);
  if (process.argv.includes('--mcp')) {
    process.stdin.once('end', closeControlInput);
    process.stdin.once('close', closeControlInput);
  }
  const vaultOptions: LocalVaultDaemonClientOptions = { buildId: cliBuildId, cliVersion, client: controlClient };
  const apiKeyFromEnv = process.env['INFLOW_API_KEY'];
  const hasDirectApiKey = (apiKeyFromFlag?.length ?? 0) > 0 || (apiKeyFromEnv?.length ?? 0) > 0;
  let hasInitializedVault = true;
  let preparedDaemon: Awaited<ReturnType<typeof ensureLocalVaultDaemon>> | undefined;
  let credentialsPrepared = false;
  if (shouldReconcileVaultDaemon(process.argv, hasDirectApiKey)) {
    const status = await readVaultStatusWithoutStarting(vaultOptions);
    hasInitializedVault = status.lockState !== 'not_initialized';
    if (status.daemonRunning) {
      preparedDaemon = await ensureLocalVaultDaemon(vaultOptions);
    }
  }
  if (
    preparedDaemon === undefined &&
    shouldStartVaultDaemon(process.argv, { hasDirectApiKey, hasInitializedVault, isAgent })
  ) {
    preparedDaemon = await ensureLocalVaultDaemon(vaultOptions);
  }
  if (
    shouldUnlockVault(process.argv, { hasDirectApiKey, isAgent }) &&
    (hasInitializedVault || commandPath(process.argv)[0] === 'auth')
  ) {
    await ensureLocalVaultUnlocked({
      mode: isAgent ? 'agent' : 'human',
      ...(preparedDaemon === undefined ? {} : { preparedClient: preparedDaemon }),
      vaultOptions,
    });
    credentialsPrepared = true;
  }

  const authStorage = new Storage({
    ...(credentialFilePath === undefined ? {} : { configPath: credentialFilePath }),
    secretStore,
  });

  const resetStorage = credentialFilePath === undefined ? authStorage : new Storage({ secretStore });
  vaultOptions.invalidateSessions = () => resetStorage.invalidateSessions();
  vaultOptions.resetLocalState = () => {
    resetStorage.resetLocalState();
    if (resetStorage !== authStorage) authStorage.resetLocalState();
  };

  let credentialReadError: Error | undefined;
  let resetGeneration: string | undefined;
  let resetInvalidated = false;
  if (process.argv.includes('--mcp') && !hasDirectApiKey) {
    try {
      resetGeneration = resetStorage.getResetGeneration();
    } catch (error) {
      credentialReadError = error instanceof Error ? error : new Error(String(error));
    }
  }
  function hasSavedApiKey(): boolean {
    try {
      return (authStorage.getApiKey()?.length ?? 0) > 0;
    } catch (error) {
      if (process.argv.includes('--mcp') || shouldReconcileVaultDaemon(process.argv, hasDirectApiKey)) {
        credentialReadError = error instanceof Error ? error : new Error(String(error));
      }
      return false;
    }
  }
  function assertMcpCredentials(): void {
    if (!process.argv.includes('--mcp') || hasDirectApiKey) return;
    try {
      resetInvalidated ||= resetStorage.getResetGeneration() !== resetGeneration;
    } catch {
      resetInvalidated = true;
    }
    if (resetInvalidated) {
      throw new Errors.IncurError({
        code: 'MCP_RECONNECT_REQUIRED',
        message:
          'The InFlow vault was reset or its saved credentials are unavailable. Reconnect the InFlow MCP server before using saved credentials.',
      });
    }
    if (credentialReadError === undefined) return;
    if (
      credentialReadError instanceof SecureStorageError &&
      ['vault_locked', 'vault_not_initialized', 'secure_storage_unavailable'].includes(
        credentialReadError.secureStorageCode,
      )
    ) {
      throw new Errors.IncurError({
        code: 'MCP_RECONNECT_REQUIRED',
        message: 'Unlock the InFlow vault, then reconnect the InFlow MCP server to load your saved API key.',
      });
    }
    throw credentialReadError;
  }
  async function prepareCredentials(mode: 'agent' | 'human'): Promise<void> {
    const mcp = process.argv.includes('--mcp');
    if (!mcp && credentialsPrepared) return;
    if (!mcp && preparedDaemon !== undefined && hasInitializedVault) {
      await ensureLocalVaultUnlocked({ mode, preparedClient: preparedDaemon, vaultOptions });
    } else if ((await readVaultStatusWithoutStarting(vaultOptions)).lockState !== 'not_initialized') {
      await ensureLocalVaultUnlocked({ mode, vaultOptions });
    }
    if (!mcp) credentialsPrepared = true;
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
  const usesSavedApiKey =
    apiKeyFromFlag !== undefined || apiKeyFromEnv !== undefined || isPublicDocumentInspect(process.argv)
      ? false
      : hasSavedApiKey();
  const apiKey = apiKeyFromFlag ?? apiKeyFromEnv;
  function savedApiKey(): Promise<string> {
    assertMcpCredentials();
    const key = authStorage.getApiKey();
    if (key === null || key.length === 0) {
      throw new InflowAuthenticationError('Not authenticated. Run "inflow auth login" first.');
    }
    return Promise.resolve(key);
  }
  const apiKeySource: 'flag' | 'env' | 'saved' | undefined =
    apiKeyFromFlag !== undefined && apiKeyFromFlag.length > 0
      ? 'flag'
      : apiKeyFromEnv !== undefined && apiKeyFromEnv.length > 0
        ? 'env'
        : usesSavedApiKey
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
    capabilitiesMaxAgeMs: process.argv.includes('--mcp') ? 5 * 60 * 1000 : Number.POSITIVE_INFINITY,
    ...(apiKey !== undefined ? { apiKey } : usesSavedApiKey ? { apiKey: savedApiKey } : {}),
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
      closeControlClient();
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

  cli.use(async (_context, next) => {
    activeCommands += 1;
    try {
      return await next();
    } finally {
      activeCommands -= 1;
      if (inputClosed && activeCommands === 0) closeControlClient();
    }
  });

  cli.use(async (context, next) => {
    const mcp = process.argv.includes('--mcp');
    if (mcp && context.command === 'auth_logout') await ensureLocalVaultDaemon(vaultOptions);
    const needsVault = mcp
      ? context.command !== 'inspect' &&
        !context.command.startsWith('vault_') &&
        context.command !== 'auth_logout' &&
        shouldEnsureVaultDaemonForMcpTool(context.command, hasDirectApiKey)
      : shouldUnlockVault(process.argv, { hasDirectApiKey });
    if (needsVault) assertMcpCredentials();
    if (needsVault) {
      try {
        await prepareCredentials(context.agent || context.formatExplicit ? 'agent' : 'human');
        assertMcpCredentials();
        if (credentialReadError !== undefined) throw credentialReadError;
      } catch (error) {
        const mapped = authenticatedApiError(error);
        if (mapped !== undefined) return context.error(mapped);
        throw error;
      }
    }
    await next();
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
  cli.command(createSubscriptionsCli(inflow.subscriptions, authStorage, inflow));
  cli.command(createVaultCli(vaultOptions));
  cli.command(createX402Cli(inflow, authStorage, resolvedApiBaseUrl));
  cli.command(createMppCli(inflow, authStorage, resolvedApiBaseUrl));
  cli.command(createAepCli(inflow, authStorage));
  let odp = inflow.odp;
  if (shouldConfigureOdpServiceTransport(process.argv) || process.argv.includes('--mcp')) {
    const cachePartition = process.argv.includes('--mcp') ? undefined : await aepCachePartition(authStorage, inflow);
    const tapFetch = createTapFetch({
      capabilities: inflow.capabilities,
      operation: 'odp.browse',
      tap: inflow.tap,
    });
    odp = inflow.odp.withServiceTransport({
      ...(cachePartition === undefined ? {} : { cachePartition }),
      inspectionTransport: tapFetch,
      transport: createAepAwareFetch({
        aepReadFetch: createTapFetch({
          capabilities: inflow.capabilities,
          operation: 'aep.inspect',
          tap: inflow.tap,
        }),
        aepWriteFetch: createTapFetch({
          capabilities: inflow.capabilities,
          operation: 'aep.mutate',
          tap: inflow.tap,
        }),
        authStorage,
        context: {
          agent: isAgent,
          error(error): never {
            throw new Error(error.message);
          },
          formatExplicit: process.argv.includes('--format'),
        },
        fetch: tapFetch,
        inflow,
        timeout: 900,
      }),
    });
  }
  cli.command(createDirectoryCli(odp));
  cli.command(createOdpCli(odp));
  cli.command(createOpenApiCli(undefined, undefined, new OpenApiCollections(resolvedApiBaseUrl)));
  cli.command(
    'inspect',
    createInspectCommand(inflow, authStorage, odp, undefined, async () => {
      assertMcpCredentials();
      await prepareCredentials(isAgent ? 'agent' : 'human');
      assertMcpCredentials();
    }),
  );

  await cli.serve();
  if (!process.argv.includes('--mcp')) {
    closeControlClient();
    process.off('exit', closeControlClient);
  }
}

function showDirectorySearchHelpForEmptyInput(argv: string[]): void {
  const command = argv.slice(2);
  if (command.length === 2 && command[0] === 'directory' && command[1] === 'search') {
    argv.push('--help');
  }
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
