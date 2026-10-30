import { z } from 'incur';

export const logoutOutput = z.object({
  authenticated: z.literal(false).describe('Local authentication has been cleared.'),
});

export const loginOptions = z.object({
  clientName: z.string().default('InFlow').describe('Agent or app name shown to the user during device authorization.'),
  interval: z.coerce
    .number()
    .default(0)
    .describe(
      'Inline poll cadence in seconds. 0 returns immediately with the verification URL and a follow-up command hint; positive values poll until the device flow terminates.',
    ),
  maxAttempts: z.coerce
    .number()
    .default(0)
    .describe('Hard cap on poll attempts. 0 means unlimited (bounded only by --timeout).'),
  timeout: z.coerce.number().default(300).describe('Polling deadline in seconds.'),
});

export const statusOptions = z.object({
  interval: z.coerce
    .number()
    .default(0)
    .describe(
      'Poll cadence in seconds. 0 returns the current snapshot; positive values yield on every change until terminal.',
    ),
  maxAttempts: z.coerce
    .number()
    .default(0)
    .describe('Hard cap on poll attempts. 0 means unlimited (bounded only by --timeout).'),
  timeout: z.coerce.number().default(300).describe('Polling deadline in seconds.'),
  probe: z.boolean().default(false).describe('Validate the local access token by calling GET /v1/users/self.'),
});
