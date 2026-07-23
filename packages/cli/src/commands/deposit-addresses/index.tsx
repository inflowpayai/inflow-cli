import {
  type AuthStorage,
  type ConfiguredDepositAddress,
  type IDepositAddressResource,
  type Inflow,
  runDepositAddressesList as runDepositAddressesListFlow,
  sanitizeDeep,
} from '@inflowpayai/inflow-core';
import { Cli } from 'incur';
import React from 'react';
import { mcpTool } from '../../mcp-metadata.js';
import { assertSessionGuard } from '../../utils/assert-session.js';
import { authenticatedApiError } from '../../utils/api-error.js';
import { renderInkUntilExit } from '../../utils/render-ink-until-exit.js';
import { DepositAddressesList } from './list.js';
import { listOptions } from './schema.js';

interface SessionErrorOptions {
  code: string;
  message: string;
  cta?: { commands: { command: string; description: string }[] };
}

interface DepositAddressesListContext {
  agent: boolean;
  formatExplicit: boolean;
  error: (err: SessionErrorOptions) => never;
}

interface DepositAddressesListDeps {
  depositAddressResource: Pick<IDepositAddressResource, 'list'>;
  authStorage: AuthStorage;
  inflow: Inflow;
}

async function runDepositAddressesList(
  c: DepositAddressesListContext,
  deps: DepositAddressesListDeps,
): Promise<ConfiguredDepositAddress[]> {
  assertSessionGuard(c, deps.authStorage, deps.inflow);

  if (!c.agent && !c.formatExplicit) {
    let captured: ConfiguredDepositAddress[] | null = null;
    return renderInkUntilExit<ConfiguredDepositAddress[]>(
      <DepositAddressesList
        depositAddressResource={deps.depositAddressResource}
        onComplete={(value) => {
          captured = value;
        }}
      />,
      () => captured ?? [],
    );
  }

  try {
    const configured = await runDepositAddressesListFlow({ depositAddressResource: deps.depositAddressResource });
    return sanitizeDeep(configured);
  } catch (error) {
    const mapped = authenticatedApiError(error);
    if (mapped !== undefined) return c.error(mapped);
    throw error;
  }
}

export function createDepositAddressesCli(
  depositAddressResource: IDepositAddressResource,
  authStorage: AuthStorage,
  inflow: Inflow,
) {
  const cli = Cli.create('deposit-addresses', {
    description: 'Deposit-address commands',
  });

  cli.command('list', {
    description: "List the authenticated user's configured deposit addresses",
    mcp: mcpTool('deposit-addresses_list'),
    options: listOptions,
    outputPolicy: 'agent-only' as const,
    async run(c) {
      return runDepositAddressesList(c, {
        depositAddressResource,
        authStorage,
        inflow,
      });
    },
  });

  return cli;
}

export const __testing = {
  runDepositAddressesList,
};
