import process from 'node:process';
import { type AuthStorage, Inflow, Storage, storage } from '@inflowpayai/inflow-core';
import { Cli, Help } from 'incur';
import { createAuthCli } from './commands/auth/index.js';
import { createBalancesCli } from './commands/balances/index.js';
import { createDepositAddressesCli } from './commands/deposit-addresses/index.js';
import { createInspectCommand } from './commands/inspect/index.js';
import { createMppCli } from './commands/mpp/index.js';
import { createUserCli } from './commands/user/index.js';
import { createX402Cli } from './commands/x402/index.js';
import {
  formatUpdateNotice,
  makeBackgroundUpdateProbe,
  makeFrozenUpdateProbe,
  type UpdateProbe,
} from './utils/update-probe.js';

declare const __CLI_VERSION__: string;
declare const __CLI_NAME__: string;
declare const __BOOTSTRAP_BODY__: string;
declare const __SKILL_BODIES__: Record<string, string>;

const cliVersion = __CLI_VERSION__;
const cliName = __CLI_NAME__;
const bootstrapBody = __BOOTSTRAP_BODY__;
const skillBodies = __SKILL_BODIES__;

const DEFAULT_SKILL = 'agentic-payments';

Help.registerGlobalFlags([
  { flag: '--bootstrap', desc: 'Print the agent setup guide (install, authenticate, load a playbook)' },
  { flag: '--skill [name]', desc: `Print a skill playbook (default: ${DEFAULT_SKILL})` },
]);

function printBody(body: string): never {
  process.stdout.write(body.endsWith('\n') ? body : `${body}\n`);
  process.exit(0);
}

if (process.argv.includes('--bootstrap')) {
  printBody(bootstrapBody);
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
  printBody(body);
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

const credentialFilePath = extractFlag('--auth') ?? process.env.INFLOW_AUTH_FILE;
const baseUrlFromFlag = extractFlag('--base-url');
const apiBaseUrlAliasFromFlag = extractFlag('--api-base-url');
const apiBaseUrlFromFlag = baseUrlFromFlag ?? apiBaseUrlAliasFromFlag;
const authBaseUrlFromFlag = extractFlag('--auth-base-url');
const environmentFromFlag = extractFlag('--environment');
const sandboxFlag = extractBooleanFlag('--sandbox');
const apiKeyFromFlag = extractFlag('--api-key');
const verbose = extractBooleanFlag('--verbose');

const authStorage: AuthStorage = credentialFilePath ? new Storage({ configPath: credentialFilePath }) : storage;

const apiKeyFromEnv = process.env.INFLOW_API_KEY;
function readSavedApiKey(): string | undefined {
  try {
    return authStorage.getApiKey() ?? undefined;
  } catch {
    return undefined;
  }
}
function readSavedConnection(): { environment?: 'production' | 'sandbox'; apiBaseUrl?: string; authBaseUrl?: string } {
  try {
    return authStorage.getConnection() ?? {};
  } catch {
    return {};
  }
}
const apiKeyFromSaved = readSavedApiKey();
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

const isAgent = process.argv.includes('--format') || process.argv.includes('--mcp') || !process.stdout.isTTY;

const rawEnvironment =
  environmentFromFlag ??
  (sandboxFlag ? 'sandbox' : undefined) ??
  process.env.INFLOW_ENVIRONMENT ??
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
const apiBaseUrl = apiBaseUrlFromFlag ?? process.env.INFLOW_BASE_URL ?? savedConnection.apiBaseUrl;
const authBaseUrl = authBaseUrlFromFlag ?? process.env.INFLOW_AUTH_BASE_URL ?? savedConnection.authBaseUrl;
const cliClientId = process.env.INFLOW_CLI_CLIENT_ID ?? CLI_CLIENT_IDS[environment];

const defaultHeaders = { 'User-Agent': `inflow/${cliVersion}` };

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
  description: 'InFlow - agentic MPP / x402 payments from your machine.',
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
  }),
);
cli.command(createUserCli(inflow.user, authStorage, inflow));
cli.command(createBalancesCli(inflow.balances, authStorage, inflow));
cli.command(createDepositAddressesCli(inflow.depositAddresses, authStorage, inflow));
cli.command(createX402Cli(inflow, authStorage, resolvedApiBaseUrl));
cli.command(createMppCli(inflow, authStorage, resolvedApiBaseUrl));
cli.command('inspect', createInspectCommand());

await cli.serve();

export default cli;
