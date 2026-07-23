import {
  type AuthStorage,
  type Inflow,
  type IUser,
  projectUserPayload,
  type UserAgentPayload,
} from '@inflowpayai/inflow-core';
import { Cli, Errors } from 'incur';
import React from 'react';
import { mcpTool } from '../../mcp-metadata.js';
import { assertSessionGuard } from '../../utils/assert-session.js';
import { authenticatedApiError } from '../../utils/api-error.js';
import { renderInkUntilExit } from '../../utils/render-ink-until-exit.js';
import { UserGet, type UserGetOutcome } from './get.js';
import { getOptions } from './schema.js';

export type { UserAgentPayload };

type ErrorOptions = {
  code: string;
  message: string;
  cta?: { commands: { command: string; description: string }[] };
};

interface UserGetContext {
  agent: boolean;
  formatExplicit: boolean;
  error: (err: ErrorOptions) => never;
}

interface UserGetDeps {
  user: IUser;
  authStorage: AuthStorage;
  inflow: Inflow;
}

const TTY_NO_RESULT_MESSAGE = 'inflow user get exited without producing a result.';

async function runUserGet(c: UserGetContext, deps: UserGetDeps): Promise<UserAgentPayload> {
  assertSessionGuard(c, deps.authStorage, deps.inflow);

  if (!c.agent && !c.formatExplicit) {
    let captured: UserGetOutcome | null = null;
    const outcome = await renderInkUntilExit<UserGetOutcome | null>(
      <UserGet
        userResource={deps.user}
        onComplete={(value) => {
          captured = value;
        }}
      />,
      () => captured,
    );
    if (outcome === null) {
      throw new Errors.IncurError({
        code: 'USER_GET_FAILED',
        message: TTY_NO_RESULT_MESSAGE,
      });
    }
    if (outcome.kind === 'error') {
      throw new Errors.IncurError({
        code: 'USER_GET_FAILED',
        message: outcome.message,
      });
    }
    return projectUserPayload(outcome.user);
  }

  try {
    return await deps.user.get();
  } catch (error) {
    const mapped = authenticatedApiError(error);
    if (mapped !== undefined) return c.error(mapped);
    throw error;
  }
}

export function createUserCli(user: IUser, authStorage: AuthStorage, inflow: Inflow) {
  const cli = Cli.create('user', { description: 'User profile commands' });

  cli.command('get', {
    description: 'Retrieve the current authenticated user',
    mcp: mcpTool('user_get'),
    options: getOptions,
    outputPolicy: 'agent-only' as const,
    async run(c) {
      return runUserGet(c, { user, authStorage, inflow });
    },
  });

  return cli;
}

export const __testing = {
  runUserGet,
};
