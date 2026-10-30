import { z } from 'incur';

export const emptyOptions = z.object({});

export const statusOutput = z.object({
  lock_state: z.enum(['locked', 'not_initialized', 'unlocked']).describe('Current local vault lock state.'),
});

export const policyOutput = z.object({
  idle_timeout_seconds: z.number().nullable().describe('Idle seconds before locking; null disables the idle timeout.'),
  lock_on_sleep: z.boolean().describe('Whether the vault locks when the computer sleeps.'),
});

export const lockOutput = z.object({
  locked: z.literal(true).describe('The vault lock operation completed.'),
});

export const changePassphraseOutput = z.object({
  changed: z.literal(true).describe('The vault PIN or passphrase was changed.'),
});

export const resetOutput = z.object({
  reset: z.literal(true).describe('The vault reset operation completed.'),
});

export const serviceStartOutput = z.object({
  service_state: z.literal('running').describe('The system vault service started and responded to its control client.'),
});

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
  lockOnSleep: z.boolean().optional().describe('Lock the vault when the computer sleeps.'),
});
