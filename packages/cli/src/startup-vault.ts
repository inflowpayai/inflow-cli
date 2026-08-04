export function commandPath(argv: readonly string[]): string[] {
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
    if (out.length >= 2) break;
  }
  return out;
}

const NON_EXECUTING_FLAGS = ['--bootstrap', '--help', '--llms', '--llms-full', '--schema', '--skill', '--version'];

const VAULT_LOCAL_STATE_COMMANDS = new Set([
  'aep enroll',
  'aep fetch',
  'aep grant',
  'aep revoke',
  'aep status',
  'auth login',
  'auth logout',
  'auth status',
  'inspect',
]);

const VAULT_LOCAL_STATE_UNLOCK_COMMANDS = new Set([
  'aep enroll',
  'aep fetch',
  'aep grant',
  'aep revoke',
  'aep status',
  'auth login',
]);

const VAULT_CREDENTIAL_COMMANDS = new Set([
  'balances list',
  'deposit-addresses list',
  'mpp fetch',
  'mpp pay',
  'mpp status',
  'mpp supported',
  'user get',
  'x402 fetch',
  'x402 pay',
  'x402 status',
  'x402 supported',
]);

function requestedCommand(argv: readonly string[]): string | null {
  if (NON_EXECUTING_FLAGS.some((flag) => argv.includes(flag))) return null;
  const [group, subcommand] = commandPath(argv);
  if (group === 'inspect') return group;
  return group === undefined || subcommand === undefined ? null : `${group} ${subcommand}`;
}

export function shouldStartVaultDaemon(argv: readonly string[], hasDirectApiKey = false): boolean {
  const command = requestedCommand(argv);
  if (command === null) return false;
  return VAULT_LOCAL_STATE_COMMANDS.has(command) || (!hasDirectApiKey && VAULT_CREDENTIAL_COMMANDS.has(command));
}

export function shouldUnlockVault(
  argv: readonly string[],
  options: { hasDirectApiKey?: boolean; isAgent?: boolean } = {},
): boolean {
  if (options.isAgent === true) return false;
  const command = requestedCommand(argv);
  if (command === null) return false;
  return (
    VAULT_LOCAL_STATE_UNLOCK_COMMANDS.has(command) ||
    (options.hasDirectApiKey !== true && VAULT_CREDENTIAL_COMMANDS.has(command))
  );
}
