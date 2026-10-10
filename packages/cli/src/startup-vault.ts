import { isDocumentInspect } from './commands/inspect/routing.js';
import { shouldEnsureVaultDaemonForMcpTool } from './mcp-metadata.js';

export function commandPath(argv: readonly string[], maxDepth = 2): string[] {
  const out: string[] = [];
  const valueFlags = new Set([
    '--api-base-url',
    '--api-key',
    '--auth',
    '--auth-base-url',
    '--base-url',
    '--environment',
    '--method',
    '--data',
    '--header',
    '--format',
    '--output',
    '--skill',
  ]);
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) continue;
    if (arg === '--') break;
    if (arg.startsWith('-')) {
      if (!arg.includes('=') && valueFlags.has(arg)) {
        const next = argv[index + 1];
        if (next !== undefined && !next.startsWith('-')) index += 1;
      }
      continue;
    }
    out.push(arg);
    if (out.length >= maxDepth) break;
  }
  return out;
}

export function isAgentInvocation(argv: readonly string[], stdoutIsTty: boolean | undefined): boolean {
  return (
    stdoutIsTty !== true ||
    argv.includes('--mcp') ||
    argv.some((argument) => argument === '--format' || argument.startsWith('--format='))
  );
}

export function normalizeFormatAssignments(argv: string[]): void {
  for (let index = 2; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument?.startsWith('--format=') !== true) continue;
    argv.splice(index, 1, '--format', argument.slice('--format='.length));
    index += 1;
  }
}

export function shouldStartVaultDaemon(
  argv: readonly string[],
  options: { hasDirectApiKey?: boolean; hasInitializedVault?: boolean; isAgent?: boolean } = {},
): boolean {
  if (shouldBypassVault(argv)) return false;
  const [group, subcommand] = commandPath(argv);
  if (group === 'auth') {
    return (
      isOneOf(subcommand, 'login', 'logout') ||
      (options.hasDirectApiKey !== true &&
        subcommand === 'status' &&
        (options.isAgent !== true || options.hasInitializedVault !== false))
    );
  }
  if (group === 'vault') return subcommand === 'status';
  if (options.hasInitializedVault === false) return false;
  return commandNeedsVault(argv, options.hasDirectApiKey);
}

export function shouldReconcileVaultDaemon(argv: readonly string[], hasDirectApiKey = false): boolean {
  if (shouldBypassVault(argv)) return false;
  return commandNeedsVault(argv, hasDirectApiKey);
}

export function shouldUnlockVault(
  argv: readonly string[],
  options: { hasDirectApiKey?: boolean; isAgent?: boolean } = {},
): boolean {
  if (options.isAgent === true || shouldBypassVault(argv)) return false;
  const [group, subcommand] = commandPath(argv);
  if (group === 'auth') {
    return subcommand === 'login' || (options.hasDirectApiKey !== true && subcommand === 'status');
  }
  if (group === 'vault') return false;
  return commandNeedsVault(argv, options.hasDirectApiKey);
}

function shouldBypassVault(argv: readonly string[]): boolean {
  return argv.includes('--schema') || argv.includes('--help') || argv.includes('-h');
}

function commandNeedsVault(argv: readonly string[], hasDirectApiKey = false): boolean {
  const [group, subcommand] = commandPath(argv, 3);
  if (group === 'inspect') return subcommand !== undefined && !isPublicDocumentInspect(argv);
  if (group === 'odp') return shouldConfigureOdpServiceTransport(argv);
  const name = [group, subcommand].filter((part) => part !== undefined).join('_');
  return shouldEnsureVaultDaemonForMcpTool(name, hasDirectApiKey);
}

export function shouldConfigureOdpServiceTransport(argv: readonly string[]): boolean {
  if (shouldBypassVault(argv)) return false;
  const [group, subgroup, command] = commandPath(argv, 3);
  if (group === 'inspect') return subgroup !== undefined && !isPublicDocumentInspect(argv);
  if (group !== 'odp' || command === undefined) return false;
  if (subgroup === 'inspect') return true;
  if (subgroup === 'actions') return command === 'resolve';
  if (subgroup === 'collections') return isOneOf(command, 'get', 'list', 'search');
  if (subgroup === 'offerings') return isOneOf(command, 'capabilities', 'discover', 'get', 'list', 'search');
  return false;
}

export function isPublicDocumentInspect(argv: readonly string[]): boolean {
  const [group, target] = commandPath(argv);
  if (group !== 'inspect' || target === undefined) return false;
  if (
    argv.slice(2).some((value) => ['--data', '--header'].some((flag) => value === flag || value.startsWith(`${flag}=`)))
  )
    return false;
  const assignedMethod = argv.find((value) => value.startsWith('--method='))?.slice('--method='.length);
  const methodIndex = argv.indexOf('--method');
  const method = assignedMethod ?? (methodIndex < 0 ? undefined : argv[methodIndex + 1]);
  return isDocumentInspect(target, { method, header: [] });
}

function isOneOf(value: string | undefined, ...choices: readonly string[]): boolean {
  return value !== undefined && choices.includes(value);
}
