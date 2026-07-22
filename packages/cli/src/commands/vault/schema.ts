import { z } from 'incur';

export const emptyOptions = z.object({});

export const resetOptions = z.object({
  force: z
    .boolean()
    .default(false)
    .describe('Confirm deletion of the local vault database, sidecar, and runtime files.'),
});

export const policySetOptions = z.object({
  idleTimeoutSeconds: z.coerce
    .number()
    .int()
    .min(0)
    .optional()
    .describe('Lock the vault after this many idle seconds. 0 disables the idle timeout.'),
  lockOnDaemonExit: z.boolean().optional().describe('Lock the vault when the daemon exits.'),
  lockOnExplicitLogout: z.boolean().optional().describe('Lock and remove local vault state during InFlow logout.'),
  lockOnSleep: z.boolean().optional().describe('Lock the vault when the computer sleeps.'),
});
