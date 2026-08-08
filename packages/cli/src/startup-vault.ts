export function commandPath(argv: readonly string[], maxDepth = 2): string[] {
  const out: string[] = [];
  const valueFlags = new Set([
    '--api-base-url',
    '--api-key',
    '--auth',
    '--auth-base-url',
    '--base-url',
    '--environment',
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

export function shouldStartVaultDaemon(argv: readonly string[], hasDirectApiKey = false): boolean {
  if (shouldBypassVault(argv)) return false;
  const [group, subcommand] = commandPath(argv);
  if (group === 'auth') return subcommand === 'login' || subcommand === 'logout';
  if (group === 'aep') return isOneOf(subcommand, 'enroll', 'fetch', 'grant', 'revoke', 'status');
  if (group === 'odp') return shouldConfigureOdpServiceTransport(argv);
  if (group === 'mpp' || group === 'x402') {
    return !hasDirectApiKey && isOneOf(subcommand, 'fetch', 'pay', 'status', 'supported');
  }
  return false;
}

export function shouldReconcileVaultDaemon(argv: readonly string[], hasDirectApiKey = false): boolean {
  if (shouldBypassVault(argv)) return false;
  const [group, subcommand] = commandPath(argv);
  if (group === 'auth') {
    return isOneOf(subcommand, 'login', 'logout') || (!hasDirectApiKey && subcommand === 'status');
  }
  if (group === 'aep') return isOneOf(subcommand, 'enroll', 'fetch', 'grant', 'revoke', 'status');
  if (group === 'odp') return shouldConfigureOdpServiceTransport(argv);
  if (group === 'mpp' || group === 'x402') {
    return !hasDirectApiKey && isOneOf(subcommand, 'fetch', 'pay', 'status', 'supported');
  }
  if (hasDirectApiKey) return false;
  if (group === 'balances' || group === 'deposit-addresses') return subcommand === 'list';
  return group === 'user' && subcommand === 'get';
}

export function shouldUnlockVault(
  argv: readonly string[],
  options: { hasDirectApiKey?: boolean; isAgent?: boolean } = {},
): boolean {
  if (options.isAgent === true || shouldBypassVault(argv)) return false;
  const [group, subcommand] = commandPath(argv);
  if (group === 'auth') return subcommand === 'login';
  if (group === 'aep') return isOneOf(subcommand, 'enroll', 'fetch', 'grant', 'revoke', 'status');
  if (group === 'odp') return shouldConfigureOdpServiceTransport(argv);
  if (group === 'mpp' || group === 'x402') {
    return options.hasDirectApiKey !== true && isOneOf(subcommand, 'fetch', 'pay', 'status', 'supported');
  }
  if (options.hasDirectApiKey === true) return false;
  if (group === 'balances' || group === 'deposit-addresses') return subcommand === 'list';
  return group === 'user' && subcommand === 'get';
}

function shouldBypassVault(argv: readonly string[]): boolean {
  return argv.includes('--schema') || argv.includes('--help') || argv.includes('-h');
}

export function shouldConfigureOdpServiceTransport(argv: readonly string[]): boolean {
  if (shouldBypassVault(argv)) return false;
  const [group, subgroup, command] = commandPath(argv, 3);
  if (group !== 'odp' || command === undefined) return false;
  if (subgroup === 'actions') return command === 'resolve';
  if (subgroup === 'collections') return isOneOf(command, 'get', 'list', 'search');
  if (subgroup === 'offerings') return isOneOf(command, 'discover', 'get', 'list', 'search');
  return false;
}

function isOneOf(value: string | undefined, ...choices: readonly string[]): boolean {
  return value !== undefined && choices.includes(value);
}
