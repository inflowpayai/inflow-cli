import {
  type AuthStorage,
  type Balance,
  type IBalanceResource,
  type Inflow,
  runBalancesList as runBalancesListFlow,
  sanitizeDeep,
} from '@inflowpayai/inflow-core';
import { Cli } from 'incur';
import React from 'react';
import { assertSessionGuard } from '../../utils/assert-session.js';
import { authenticatedApiError } from '../../utils/api-error.js';
import { renderInkUntilExit } from '../../utils/render-ink-until-exit.js';
import { BalancesList } from './list.js';
import { listOptions } from './schema.js';

interface SessionErrorOptions {
  code: string;
  message: string;
  cta?: { commands: { command: string; description: string }[] };
}

interface BalancesListContext {
  agent: boolean;
  formatExplicit: boolean;
  error: (err: SessionErrorOptions) => never;
}

interface BalancesListDeps {
  balanceResource: Pick<IBalanceResource, 'list'>;
  authStorage: AuthStorage;
  inflow: Inflow;
}

async function runBalancesList(c: BalancesListContext, deps: BalancesListDeps): Promise<Balance[]> {
  assertSessionGuard(c, deps.authStorage, deps.inflow);

  if (!c.agent && !c.formatExplicit) {
    let captured: Balance[] | null = null;
    return renderInkUntilExit<Balance[]>(
      <BalancesList
        balanceResource={deps.balanceResource}
        onComplete={(value) => {
          captured = value;
        }}
      />,
      () => captured ?? [],
    );
  }

  try {
    const balances = await runBalancesListFlow({ balanceResource: deps.balanceResource });
    return sanitizeDeep(balances);
  } catch (error) {
    const mapped = authenticatedApiError(error);
    if (mapped !== undefined) return c.error(mapped);
    throw error;
  }
}

export function createBalancesCli(balanceResource: IBalanceResource, authStorage: AuthStorage, inflow: Inflow) {
  const cli = Cli.create('balances', { description: 'Balance commands' });

  cli.command('list', {
    description: "List the authenticated user's balances",
    options: listOptions,
    outputPolicy: 'agent-only' as const,
    async run(c) {
      return runBalancesList(c, { balanceResource, authStorage, inflow });
    },
  });

  return cli;
}

export const __testing = {
  runBalancesList,
};
