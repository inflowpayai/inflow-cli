import type { Mcp } from 'incur';

type ToolName =
  | 'aep_enroll'
  | 'aep_fetch'
  | 'aep_grant'
  | 'aep_inspect'
  | 'aep_revoke'
  | 'aep_status'
  | 'auth_login'
  | 'auth_logout'
  | 'auth_status'
  | 'balances_list'
  | 'deposit-addresses_list'
  | 'inspect'
  | 'mpp_cancel'
  | 'mpp_decode'
  | 'mpp_fetch'
  | 'mpp_inspect'
  | 'mpp_pay'
  | 'mpp_status'
  | 'mpp_subscribe'
  | 'mpp_supported'
  | 'odp_collections_get'
  | 'odp_collections_list'
  | 'odp_collections_search'
  | 'odp_directory_search'
  | 'odp_directory_suggest'
  | 'odp_inspect'
  | 'odp_offerings_capabilities'
  | 'odp_offerings_discover'
  | 'odp_offerings_get'
  | 'odp_offerings_list'
  | 'odp_offerings_search'
  | 'odp_actions_resolve'
  | 'subscriptions_cancel'
  | 'subscriptions_fetch'
  | 'subscriptions_get'
  | 'subscriptions_list'
  | 'vault_change-passphrase'
  | 'vault_lock'
  | 'vault_policy'
  | 'vault_reset'
  | 'vault_set-policy'
  | 'vault_status'
  | 'vault_unlock'
  | 'x402_cancel'
  | 'x402_decode'
  | 'x402_fetch'
  | 'x402_inspect'
  | 'x402_pay'
  | 'x402_status'
  | 'x402_supported';

type ToolMetadata = {
  description: string;
  annotations: Mcp.ToolAnnotations & { title: string };
  vaultAccess: VaultAccess;
};

export type VaultAccess = 'none' | 'required' | 'stored-session';

function read(title: string, description: string, openWorldHint = true): ToolMetadata {
  return {
    description,
    vaultAccess: 'none',
    annotations: {
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint,
      readOnlyHint: true,
      title,
    },
  };
}

function write(
  title: string,
  description: string,
  options: { destructive?: boolean; idempotent?: boolean; openWorld?: boolean } = {},
): ToolMetadata {
  return {
    description,
    vaultAccess: 'none',
    annotations: {
      destructiveHint: options.destructive ?? false,
      idempotentHint: options.idempotent ?? false,
      openWorldHint: options.openWorld ?? true,
      readOnlyHint: false,
      title,
    },
  };
}

function vault(metadata: ToolMetadata, vaultAccess: Exclude<VaultAccess, 'none'>): ToolMetadata {
  return { ...metadata, vaultAccess };
}

const TOOLS: Record<ToolName, ToolMetadata> = {
  aep_enroll: vault(write('AEP: Enroll Service', 'Enroll the local agent with an AEP Service.'), 'required'),
  aep_fetch: vault(
    write('AEP: Fetch Resource', 'Fetch a resource using AEP authentication when the Service requires it.'),
    'required',
  ),
  aep_grant: vault(write('AEP: Grant Credential', 'Request and store an AEP Service credential.'), 'required'),
  aep_inspect: read('AEP: Inspect Service', 'Inspect an AEP Service without authentication.'),
  aep_revoke: vault(
    write('AEP: Revoke Credentials', 'Revoke stored AEP Service credentials.', { destructive: true }),
    'required',
  ),
  aep_status: vault(
    read('AEP: Check Status', 'Read the local and Service lifecycle status for an AEP Service.'),
    'required',
  ),
  auth_login: vault(write('InFlow Account: Log In', 'Authenticate this machine with InFlow.'), 'required'),
  auth_logout: vault(
    write('InFlow Account: Log Out', 'Log out and clear local InFlow state.', { destructive: true }),
    'required',
  ),
  auth_status: vault(
    read('InFlow Account: Check Login', 'Check whether this machine is authenticated with InFlow.', false),
    'stored-session',
  ),
  balances_list: vault(
    read('Balances: List Balances', "List the authenticated user's InFlow balances."),
    'stored-session',
  ),
  'deposit-addresses_list': vault(
    read('Deposit Addresses: List Deposit Addresses', "List the authenticated user's configured deposit addresses."),
    'stored-session',
  ),
  inspect: read(
    'Inspect: Inspect Resource',
    'Inspect a resource for ODP, AEP, MPP, and x402 capabilities and requirements.',
  ),
  mpp_cancel: write('MPP: Cancel Approval', 'Cancel an MPP approval.', { destructive: true, idempotent: true }),
  mpp_decode: read('MPP: Decode Header', 'Decode an MPP Payment header, credential, or receipt.', false),
  mpp_fetch: vault(
    write('MPP: Fetch Resource', 'Complete a ready or pending MPP payment and fetch the seller resource.'),
    'stored-session',
  ),
  mpp_inspect: read('MPP: Inspect Resource', 'Inspect a resource for MPP payment requirements.'),
  mpp_pay: vault(
    write('MPP: Pay Resource', 'Pay for an MPP-protected resource and return the seller response.', {
      destructive: true,
    }),
    'stored-session',
  ),
  mpp_status: vault(read('MPP: Check Payment', 'Poll the status of an MPP payment transaction.'), 'stored-session'),
  mpp_subscribe: vault(
    write('MPP: Subscribe to Resource', 'Subscribe to an MPP-protected resource.', {
      destructive: true,
    }),
    'stored-session',
  ),
  mpp_supported: vault(
    read('MPP: List Payment Methods', 'List MPP payment methods available to the buyer.'),
    'stored-session',
  ),
  odp_collections_get: read('ODP: Get Collection', 'Get full collection details.'),
  odp_collections_list: read('ODP: List Collections', 'List collections from a service.'),
  odp_collections_search: read('ODP: Search Collections', 'Search collections from a service.'),
  odp_directory_search: read('ODP: Search Directory', 'Search the directory for services.'),
  odp_directory_suggest: read('ODP: Suggest Keywords', 'Suggest directory keywords.'),
  odp_inspect: read('ODP: Inspect Service', "Inspect a service's capabilities."),
  odp_offerings_capabilities: read('ODP: Offering Search Capabilities', 'Resolve offering search filters and sorts.'),
  odp_offerings_discover: read(
    'ODP: Discover Offerings',
    'Find offerings across services selected from the directory.',
  ),
  odp_offerings_get: read('ODP: Get Offering', 'Get full offering details.'),
  odp_offerings_list: read('ODP: List Offerings', 'List offerings from a service.'),
  odp_offerings_search: read('ODP: Search Offerings', 'Search offerings from a service.'),
  odp_actions_resolve: read(
    'ODP: Resolve Action',
    "Resolve an offering's action into an executable request without invoking it.",
  ),
  subscriptions_cancel: vault(
    write('Subscriptions: Cancel Subscription', 'Cancel your subscription immediately.', {
      destructive: true,
      idempotent: true,
    }),
    'stored-session',
  ),
  subscriptions_fetch: vault(
    write('Subscriptions: Fetch Resource', 'Fetch a resource using a fresh subscription authorization.', {
      destructive: true,
    }),
    'required',
  ),
  subscriptions_get: vault(
    read('Subscriptions: Get Subscription', 'View your subscription details.'),
    'stored-session',
  ),
  subscriptions_list: vault(read('Subscriptions: List Subscriptions', 'List your subscriptions.'), 'stored-session'),
  'vault_change-passphrase': write('Vault: Change Passphrase', 'Change the local vault PIN or passphrase.', {
    destructive: true,
  }),
  vault_lock: vault(
    write('Vault: Lock Vault', 'Lock the local credential vault.', {
      idempotent: true,
      openWorld: false,
    }),
    'required',
  ),
  vault_policy: vault(read('Vault: Show Policy', 'Show the local vault lock policy.', false), 'required'),
  vault_reset: write('Vault: Reset Vault', 'Remove the local vault database, sidecar, and runtime files.', {
    destructive: true,
    idempotent: true,
    openWorld: false,
  }),
  'vault_set-policy': vault(
    write('Vault: Set Policy', 'Update the local vault lock policy.', { openWorld: false }),
    'required',
  ),
  vault_status: read('Vault: Check Status', 'Check whether the local credential vault is locked.', false),
  vault_unlock: write('Vault: Unlock Vault', 'Unlock or initialize the local credential vault.', {
    openWorld: false,
  }),
  x402_cancel: write('x402: Cancel Approval', 'Cancel an x402 approval.', { destructive: true, idempotent: true }),
  x402_decode: read('x402: Decode Header', 'Decode a PAYMENT-REQUIRED header value.', false),
  x402_fetch: vault(
    write('x402: Fetch Resource', 'Fetch an x402 resource using an existing or pending payment transaction.'),
    'stored-session',
  ),
  x402_inspect: read('x402: Inspect Resource', 'Inspect a resource for x402 payment requirements.'),
  x402_pay: vault(
    write('x402: Pay Resource', 'Pay for an x402-protected resource and return the seller response.', {
      destructive: true,
    }),
    'stored-session',
  ),
  x402_status: vault(read('x402: Check Payment', 'Poll the status of an x402 payment transaction.'), 'stored-session'),
  x402_supported: vault(
    read('x402: List Payment Methods', 'List x402 payment methods available to the buyer.'),
    'stored-session',
  ),
};

export function mcpTool(name: ToolName): ToolMetadata {
  return TOOLS[name];
}

export function mcpVaultAccess(name: string): VaultAccess {
  return isToolName(name) ? TOOLS[name].vaultAccess : 'none';
}

export function shouldEnsureVaultDaemonForMcpTool(name: string, hasDirectApiKey: boolean): boolean {
  const access = mcpVaultAccess(name);
  return access === 'required' || (access === 'stored-session' && !hasDirectApiKey);
}

function isToolName(name: string): name is ToolName {
  return Object.hasOwn(TOOLS, name);
}
