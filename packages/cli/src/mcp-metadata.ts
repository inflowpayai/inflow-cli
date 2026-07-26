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
  | 'mpp_supported'
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
};

function read(title: string, description: string, openWorldHint = true): ToolMetadata {
  return {
    description,
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
    annotations: {
      destructiveHint: options.destructive ?? false,
      idempotentHint: options.idempotent ?? false,
      openWorldHint: options.openWorld ?? true,
      readOnlyHint: false,
      title,
    },
  };
}

const TOOLS: Record<ToolName, ToolMetadata> = {
  aep_enroll: write('AEP: Enroll Service', 'Enroll the local agent with an AEP Service.'),
  aep_fetch: write('AEP: Fetch Resource', 'Fetch a resource using AEP authentication when the Service requires it.'),
  aep_grant: write('AEP: Grant Credential', 'Request and store an AEP Service credential.'),
  aep_inspect: read('AEP: Inspect Service', 'Inspect an AEP Service without authentication.'),
  aep_revoke: write('AEP: Revoke Credentials', 'Revoke stored AEP Service credentials.', { destructive: true }),
  aep_status: read('AEP: Check Status', 'Read the local and Service lifecycle status for an AEP Service.'),
  auth_login: write('InFlow Account: Log In', 'Authenticate this machine with InFlow.'),
  auth_logout: write('InFlow Account: Log Out', 'Log out and clear local InFlow state.', { destructive: true }),
  auth_status: read('InFlow Account: Check Login', 'Check whether this machine is authenticated with InFlow.', false),
  balances_list: read('Balances: List Balances', "List the authenticated user's InFlow balances."),
  'deposit-addresses_list': read(
    'Deposit Addresses: List Deposit Addresses',
    "List the authenticated user's configured deposit addresses.",
  ),
  inspect: read('Inspect: Inspect Resource', 'Inspect a resource for AEP, MPP, and x402 requirements.'),
  mpp_cancel: write('MPP: Cancel Approval', 'Cancel an MPP approval.', { destructive: true, idempotent: true }),
  mpp_decode: read('MPP: Decode Header', 'Decode an MPP Payment header, credential, or receipt.', false),
  mpp_fetch: write('MPP: Fetch Resource', 'Fetch an MPP resource using an existing or pending payment transaction.'),
  mpp_inspect: read('MPP: Inspect Resource', 'Inspect a resource for MPP payment requirements.'),
  mpp_pay: write('MPP: Pay Resource', 'Pay for an MPP-protected resource and return the seller response.', {
    destructive: true,
  }),
  mpp_status: read('MPP: Check Payment', 'Poll the status of an MPP payment transaction.'),
  mpp_supported: read('MPP: List Payment Methods', 'List MPP payment methods available to the buyer.'),
  'vault_change-passphrase': write('Vault: Change Passphrase', 'Change the local vault PIN or passphrase.', {
    destructive: true,
  }),
  vault_lock: write('Vault: Lock Vault', 'Lock the local credential vault.', {
    idempotent: true,
    openWorld: false,
  }),
  vault_policy: read('Vault: Show Policy', 'Show the local vault lock policy.', false),
  vault_reset: write('Vault: Reset Vault', 'Remove the local vault database, sidecar, and runtime files.', {
    destructive: true,
    idempotent: true,
    openWorld: false,
  }),
  'vault_set-policy': write('Vault: Set Policy', 'Update the local vault lock policy.', { openWorld: false }),
  vault_status: read('Vault: Check Status', 'Check whether the local credential vault is locked.', false),
  vault_unlock: write('Vault: Unlock Vault', 'Unlock or initialize the local credential vault.', {
    openWorld: false,
  }),
  x402_cancel: write('x402: Cancel Approval', 'Cancel an x402 approval.', { destructive: true, idempotent: true }),
  x402_decode: read('x402: Decode Header', 'Decode a PAYMENT-REQUIRED header value.', false),
  x402_fetch: write('x402: Fetch Resource', 'Fetch an x402 resource using an existing or pending payment transaction.'),
  x402_inspect: read('x402: Inspect Resource', 'Inspect a resource for x402 payment requirements.'),
  x402_pay: write('x402: Pay Resource', 'Pay for an x402-protected resource and return the seller response.', {
    destructive: true,
  }),
  x402_status: read('x402: Check Payment', 'Poll the status of an x402 payment transaction.'),
  x402_supported: read('x402: List Payment Methods', 'List x402 payment methods available to the buyer.'),
};

export function mcpTool(name: ToolName): ToolMetadata {
  return TOOLS[name];
}
